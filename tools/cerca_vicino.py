#!/usr/bin/env python3
"""Cerca con la rete neurale lo stallo vero vicino al punto approssimato degli stalli "proposti" da elenchi comunali (open data).

Per ogni stallo scarica l'ortofoto in un quadrato centrato sul punto (raggio 50 m se l'indirizzo ha il civico, 150 m se c'è solo la via),
fa girare la rete come scan_area.py (stessa risoluzione T.RES, stessa soglia di default) e salva il rilevamento migliore con un ritaglio.
NON scrive in Supabase e non scarica nulla da Supabase: legge un export locale (stalli.json).

Uso:
  python3 cerca_vicino.py MODEL.pt --stalli stalli.json --out DIR --wms URL --layer NOME [--crs EPSG:4326]
        [--comuni Chieri,Nichelino] [--campione 20] [--thr 0.05] [--raggio-civico 50] [--raggio-via 150] [--threads 4]
  python3 cerca_vicino.py MODEL.pt --stalli ... --out DIR --solo-report      # solo riepilogo CSV + mosaico dai risultati già salvati

Riprendibile: i progressi sono in DIR/progressi.jsonl (una riga per stallo); rilanciare lo stesso comando salta quelli già fatti.
"""
import argparse, csv, io, json, math, os, re, sys, time, random, statistics
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image, ImageDraw
import torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T
import scan_area as SA

MARG_M = 6.0      # m di contorno oltre il raggio, perché la finestra della rete (6,4 m) abbia contesto sul bordo
CHUNK = 1000      # px per richiesta WMS (100 m a 10 cm/px)
CELL, CMARG = 400, 48  # come scan_area: celle da 40 m con margine
CROP_M = 30.0
RE_CIVICO = re.compile(r'(?:,|\s)\s*(?:n\.?\s*)?\d+(?:\s*[-_]\s*\d+)?\s*(?:/\s*\w+|\s*[A-Za-z](?![A-Za-z]))?\s*$')


def ha_civico(ind):
    return bool(RE_CIVICO.search((ind or '').strip()))


def dist_m(a_lat, a_lon, b_lat, b_lon):
    return SA.dist_m(a_lat, a_lon, b_lat, b_lon)


def carica_rete(path):
    n = Fm.Net(); n.load_state_dict(torch.load(path)); n.eval()
    if not os.environ.get('DP_NO_ONNX'): n.use_onnx(path)
    return n


def scarica(lat, lon, half_m, retries=3):
    """Ortofoto quadrata (lato 2*half_m) centrata su lat/lon a T.RES m/px, in blocchi da CHUNK px. None se manca o fallisce."""
    N = int(round(2 * half_m / T.RES))
    dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(lat)))
    n0 = lat + half_m * dlat; w0 = lon - half_m * dlon
    out = np.zeros((N, N, 3), np.float32)
    for y0 in range(0, N, CHUNK):
        for x0 in range(0, N, CHUNK):
            h = min(CHUNK, N - y0); w = min(CHUNK, N - x0)
            n_ = n0 - y0 * T.RES * dlat; s_ = n0 - (y0 + h) * T.RES * dlat
            w_ = w0 + x0 * T.RES * dlon; e_ = w0 + (x0 + w) * T.RES * dlon
            img = None
            for k in range(retries):
                img = _wms_rect(s_, w_, n_, e_, w, h)
                if img is not None: break
                time.sleep(2 + 3 * k)
            if img is None: return None
            out[y0:y0 + h, x0:x0 + w] = img
    return out


def _wms_rect(s, w, n, e, wpx, hpx):
    import urllib.request, urllib.parse
    if os.environ.get('DP_ARCGIS'):  # servizio ArcGIS (MapServer/export o ImageServer/exportImage): DP_WMS = URL del servizio senza /export
        ep = 'exportImage' if 'ImageServer' in SA.WMS_URL else 'export'
        q = urllib.parse.urlencode({'bbox': f'{w},{s},{e},{n}', 'bboxSR': 4326, 'imageSR': 4326, 'size': f'{wpx},{hpx}', 'format': 'jpg', 'f': 'image'})
        try:
            d = urllib.request.urlopen(f'{SA.WMS_URL.rstrip("/")}/{ep}?{q}', timeout=90).read()
            if d[:2] == b'\xff\xd8': return np.asarray(Image.open(io.BytesIO(d)).convert('RGB'), dtype=np.float32) / 255
        except Exception: pass
        return None
    p = {'SERVICE': 'WMS', 'REQUEST': 'GetMap', 'LAYERS': SA.WMS_LAYER, 'STYLES': '', 'BBOX': f'{w},{s},{e},{n}', 'WIDTH': wpx, 'HEIGHT': hpx, 'FORMAT': 'image/jpeg'}
    p.update({'VERSION': '1.3.0', 'CRS': 'CRS:84'} if SA.WMS_CRS == 'CRS:84' else {'VERSION': '1.1.1', 'SRS': SA.WMS_CRS})
    try:
        d = urllib.request.urlopen(f'{SA.WMS_URL}?{urllib.parse.urlencode(p)}', timeout=90).read()
        if d[:2] == b'\xff\xd8': return np.asarray(Image.open(io.BytesIO(d)).convert('RGB'), dtype=np.float32) / 255
    except Exception: pass
    return None


def rileva(net, img, thr, cx0, cy0, rpx):
    """Scansione a celle come scan_area.Ensemble.detect, ma solo le celle che toccano il cerchio (cx0,cy0,rpx)."""
    h, w, _ = img.shape; got = []
    for y0 in range(0, h, CELL):
        for x0 in range(0, w, CELL):
            # la cella interseca il cerchio di ricerca?
            nx = min(max(cx0, x0), x0 + CELL); ny = min(max(cy0, y0), y0 + CELL)
            if math.hypot(nx - cx0, ny - cy0) > rpx + 20: continue
            ya, xa = max(0, y0 - CMARG), max(0, x0 - CMARG); yb, xb = min(h, y0 + CELL + CMARG), min(w, x0 + CELL + CMARG)
            s_, cx_, cy_ = net.dense(np.ascontiguousarray(img[ya:yb, xa:xb]))
            for v, x, y in T.nms(s_, cx_, cy_, thr):
                X, Y = x + xa, y + ya
                if x0 <= X < x0 + CELL and y0 <= Y < y0 + CELL: got.append((float(v), X, Y))
    got.sort(reverse=True); k = []
    for v, x, y in got:
        if all(math.hypot(x - a_, y - b_) * T.RES > T.NMS for _, a_, b_ in k): k.append((v, x, y))
    return k


def ritaglio(img, x, y, ox, oy):
    """30x30 m centrati sul rilevamento (x,y in px), cerchio rosso sul rilevamento, crocetta bianca sul punto originale (ox,oy)."""
    r = int(CROP_M / 2 / T.RES); h, w, _ = img.shape
    pad = np.pad(img, ((r, r), (r, r), (0, 0)), mode='constant')
    xi, yi = int(round(x)) + r, int(round(y)) + r
    c = Image.fromarray((pad[yi - r:yi + r, xi - r:xi + r] * 255).astype(np.uint8)).resize((600, 600), Image.BICUBIC)
    d = ImageDraw.Draw(c); k = 600 / (2 * r); R = 3.0 / T.RES * k
    d.ellipse([300 - R, 300 - R, 300 + R, 300 + R], outline=(255, 40, 40), width=3)
    px_, py_ = 300 + (ox - x) * k, 300 + (oy - y) * k
    if 8 < px_ < 592 and 8 < py_ < 592:
        d.line([px_ - 8, py_, px_ + 8, py_], fill=(255, 255, 255), width=2); d.line([px_, py_ - 8, px_, py_ + 8], fill=(255, 255, 255), width=2)
    return c


def elabora(net, st, img, a, outdir):
    lat, lon = st['lat'], st['lon']; civ = ha_civico(st.get('indirizzo'))
    R = a.raggio_civico if civ else a.raggio_via
    rec = dict(id=st['id'], comune=st.get('comune'), indirizzo=st.get('indirizzo'), civico=civ, raggio_m=R, lat=lat, lon=lon, stato='ok',
               trovato=False, n_rilevamenti=0, migliore=None, altri=[], ritaglio=None)
    if img is None: rec['stato'] = 'foto_non_scaricata'; return rec
    gray = img.mean(2)
    if (gray < 0.12).mean() > 0.5 or (gray > 0.95).mean() > 0.5: rec['stato'] = 'foto_mancante'; return rec
    N = img.shape[0]; c = N / 2; rpx = R / T.RES
    dets = rileva(net, img, a.thr, c, c, rpx); res = []
    for v, x, y in dets:
        if math.hypot(x - c, y - c) > rpx: continue
        yi, xi = int(y), int(x); w8 = int(4 / T.RES); win = gray[max(0, yi - w8):yi + w8, max(0, xi - w8):xi + w8]
        if win.mean() < 0.09 or (win.mean() > 0.93 and win.std() < 0.02): continue  # zona nera/bianca, come scan_area
        d_lat = -(y - c) * T.RES / 111320; d_lon = (x - c) * T.RES / (111320 * math.cos(math.radians(lat)))
        res.append(dict(score=round(v, 4), lat=round(lat + d_lat, 7), lon=round(lon + d_lon, 7), dist_m=round(math.hypot(x - c, y - c) * T.RES, 1), _xy=(x, y)))
    rec['n_rilevamenti'] = len(res); rec['trovato'] = bool(res)
    if res:
        best = max(res, key=lambda r: r['score']); x, y = best.pop('_xy'); rec['migliore'] = best
        rec['altri'] = [{k: v for k, v in r.items() if k != '_xy'} for r in sorted(res, key=lambda r: -r['score']) if r is not best][:9]
        fn = f"{st['id']}.jpg"; os.makedirs(os.path.join(outdir, 'ritagli'), exist_ok=True)
        ritaglio(img, x, y, c, c).save(os.path.join(outdir, 'ritagli', fn), 'JPEG', quality=88); rec['ritaglio'] = f'ritagli/{fn}'
    return rec


def mosaico(recs, outdir, n_top=40, n_dubbi=20, cols=6, cell=300):
    """Foglio di contatto: i migliori trovati (punteggio più alto) e i casi dubbi (punteggio basso o molti rilevamenti)."""
    trov = [r for r in recs if r['trovato'] and r['ritaglio']]
    top = sorted(trov, key=lambda r: -r['migliore']['score'])[:n_top]
    rest = [r for r in trov if r not in top]
    dub = sorted(rest, key=lambda r: (r['migliore']['score'] >= 0.5, -r['n_rilevamenti'] if r['migliore']['score'] >= 0.5 else r['migliore']['score']))
    random.Random(1).shuffle(dub); dub = sorted(dub[:max(n_dubbi * 3, n_dubbi)], key=lambda r: r['migliore']['score'])
    dub = [r for r in dub if r['migliore']['score'] < 0.5][:n_dubbi] or dub[:n_dubbi]
    def foglio(items, titolo, fn):
        if not items: return
        rows = math.ceil(len(items) / cols); H = 30; lab = 34
        S = Image.new('RGB', (cols * cell, H + rows * (cell + lab)), (30, 30, 30)); d = ImageDraw.Draw(S); d.text((6, 8), titolo, fill=(255, 255, 255))
        for i, r in enumerate(items):
            im = Image.open(os.path.join(outdir, r['ritaglio'])).resize((cell, cell)); x, y = (i % cols) * cell, H + (i // cols) * (cell + lab)
            S.paste(im, (x, y)); m = r['migliore']
            d.text((x + 3, y + cell + 2), f"{r['comune']} · {r['indirizzo']}"[:48], fill=(255, 255, 255))
            d.text((x + 3, y + cell + 16), f"{round(m['score'] * 100)}% · {m['dist_m']:.0f} m · {r['n_rilevamenti']} ril. · {'civ' if r['civico'] else 'via'}", fill=(255, 220, 0))
        S.save(os.path.join(outdir, fn), 'JPEG', quality=85)
    foglio(top, f'Migliori {len(top)} rilevamenti (cerchio rosso = rilevamento, croce bianca = punto approssimato del Comune)', 'mosaico_migliori.jpg')
    foglio(dub, f'Casi dubbi ({len(dub)}): punteggio basso', 'mosaico_dubbi.jpg')


def riepilogo(recs, outdir):
    os.makedirs(outdir, exist_ok=True)
    json.dump(recs, open(os.path.join(outdir, 'risultati.json'), 'w'), ensure_ascii=False, indent=1)
    by = {}
    for r in recs: by.setdefault(r['comune'], []).append(r)
    with open(os.path.join(outdir, 'riepilogo_comuni.csv'), 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['comune', 'totale', 'trovati', 'percentuale_trovati', 'distanza_mediana_m', 'trovati_con_civico', 'totale_con_civico', 'trovati_solo_via', 'totale_solo_via', 'foto_mancanti'])
        for c, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
            tr = [r for r in rs if r['trovato']]; med = statistics.median(r['migliore']['dist_m'] for r in tr) if tr else ''
            cv = [r for r in rs if r['civico']]; sv = [r for r in rs if not r['civico']]
            w.writerow([c, len(rs), len(tr), f'{100 * len(tr) / len(rs):.1f}', med, sum(r['trovato'] for r in cv), len(cv), sum(r['trovato'] for r in sv), len(sv), sum(r['stato'] != 'ok' for r in rs)])
    mosaico(recs, outdir)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('model'); ap.add_argument('--stalli', required=True, help='export locale stalli.json'); ap.add_argument('--out', required=True)
    ap.add_argument('--wms', default=''); ap.add_argument('--layer', default=''); ap.add_argument('--crs', default=''); ap.add_argument('--arcgis', action='store_true', help='--wms è un servizio ArcGIS (.../MapServer o .../ImageServer) invece di un WMS')
    ap.add_argument('--comuni', default='', help='elenco separato da virgole (default: tutti)'); ap.add_argument('--campione', type=int, default=0, help='solo N stalli (distribuiti in modo regolare)')
    ap.add_argument('--thr', type=float, default=0.05, help='soglia, come scan_area'); ap.add_argument('--raggio-civico', type=float, default=50); ap.add_argument('--raggio-via', type=float, default=150)
    ap.add_argument('--threads', type=int, default=3, help='scaricamenti in parallelo (max 4)'); ap.add_argument('--solo-report', action='store_true')
    a = ap.parse_args(); a.threads = max(1, min(4, a.threads))
    if a.arcgis: os.environ['DP_ARCGIS'] = '1'
    if a.wms: SA.WMS_URL = a.wms
    if a.layer: SA.WMS_LAYER = a.layer
    if a.crs: SA.WMS_CRS = a.crs
    os.makedirs(a.out, exist_ok=True); prog = os.path.join(a.out, 'progressi.jsonl')
    fatti = {}
    if os.path.exists(prog):
        for l in open(prog):
            try: r = json.loads(l); fatti[r['id']] = r
            except Exception: pass
    if not a.solo_report:
        tutti = [r for r in json.load(open(a.stalli)) if r.get('stato') == 'proposto' and r.get('fonte') == 'opendata' and 'approssimata' in (r.get('note') or '')]
        if a.comuni: ok = {c.strip().lower() for c in a.comuni.split(',')}; tutti = [r for r in tutti if (r.get('comune') or '').lower() in ok]
        tutti.sort(key=lambda r: (r.get('comune') or '', r['id']))
        if a.campione: step = len(tutti) / a.campione; tutti = [tutti[int(i * step)] for i in range(a.campione)]
        todo = [s for s in tutti if s['id'] not in fatti]
        print(f'{len(tutti)} stalli selezionati, {len(tutti) - len(todo)} già fatti, {len(todo)} da fare · {SA.WMS_URL} {SA.WMS_LAYER} · soglia {a.thr}', flush=True)
        if todo:
            net = carica_rete(a.model); t0 = time.time(); half = lambda s: (a.raggio_civico if ha_civico(s.get('indirizzo')) else a.raggio_via) + MARG_M
            pool = ThreadPoolExecutor(a.threads); fut = {}
            for s in todo[:a.threads * 2]: fut[s['id']] = pool.submit(scarica, s['lat'], s['lon'], half(s))
            for i, s in enumerate(todo):
                j = i + a.threads * 2
                if j < len(todo): fut[todo[j]['id']] = pool.submit(scarica, todo[j]['lat'], todo[j]['lon'], half(todo[j]))
                try: img = fut.pop(s['id']).result()
                except Exception as ex: print('  errore foto', s['id'], ex, flush=True); img = None
                try: rec = elabora(net, s, img, a, a.out)
                except Exception as ex: rec = dict(id=s['id'], comune=s.get('comune'), indirizzo=s.get('indirizzo'), civico=ha_civico(s.get('indirizzo')), stato=f'errore: {ex}', trovato=False, n_rilevamenti=0, migliore=None, altri=[], ritaglio=None)
                del img
                fatti[rec['id']] = rec; open(prog, 'a').write(json.dumps(rec, ensure_ascii=False) + '\n')
                if (i + 1) % 10 == 0 or i + 1 == len(todo):
                    print(f'  {i + 1}/{len(todo)} · trovati {sum(r["trovato"] for r in fatti.values())}/{len(fatti)} · {(time.time() - t0) / 60:.1f} min', flush=True)
        sel = {s['id'] for s in tutti}; recs = [fatti[i] for i in sorted(sel) if i in fatti]
    else: recs = list(fatti.values())
    riepilogo(recs, a.out)
    print(f'Fatto: {len(recs)} stalli, trovati {sum(r["trovato"] for r in recs)}. Risultati in {a.out}')


if __name__ == '__main__':
    main()
