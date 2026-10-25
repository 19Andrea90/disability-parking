#!/usr/bin/env python3
"""Scansiona un'area con la rete addestrata e carica i candidati in Supabase (tabella candidati, con ritaglio di prova).

Uso: SUPABASE_SERVICE_KEY=... python3 scan_area.py MODEL.pt --bbox S,W,N,E [--thr 0.05] [--tta] [--label "Udine centro"] [--dry-run]
"""
import argparse, io, json, math, os, sys, time, urllib.request, urllib.parse
import numpy as np
from PIL import Image, ImageDraw
import torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
TILE = 120.0   # m
OVER = 10.0    # m di sovrapposizione tra riquadri
MAX_PER_TILE = 12  # più rilevamenti di così in un riquadro di 120 m = immagine anomala, non stalli
EXCL = 12.0    # m: niente candidati vicino a stalli o candidati già presenti


def sb(method, path, key, body=None, ctype='application/json', extra=None):
    h = {'apikey': key, 'Authorization': f'Bearer {key}'}
    if body is not None: h['Content-Type'] = ctype
    if extra: h.update(extra)
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(f'{SB}{path}', data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read(); return json.loads(t) if t and r.headers.get('content-type', '').startswith('application/json') else t


def sb_all(path, key, page=1000):
    """GET paginato: il server restituisce al massimo 1000 righe per richiesta."""
    out = []; sep = '&' if '?' in path else '?'
    while True:
        b = sb('GET', f'{path}{sep}limit={page}&offset={len(out)}', key); out += b
        if len(b) < page: return out


def wms(s, w, n, e, px):
    q = urllib.parse.urlencode({'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap', 'LAYERS': 'trueorto_FVG_1720', 'STYLES': '', 'SRS': 'EPSG:4326',
                                'BBOX': f'{w},{s},{e},{n}', 'WIDTH': px, 'HEIGHT': px, 'FORMAT': 'image/jpeg'})
    for k in range(3):
        try:
            d = urllib.request.urlopen(f'https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows?{q}', timeout=90).read()
            if d[:2] == b'\xff\xd8': return np.asarray(Image.open(io.BytesIO(d)).convert('RGB'), dtype=np.float32) / 255
        except Exception: time.sleep(3 + 3 * k)
    return None


def dist_m(a_lat, a_lon, b_lat, b_lon):
    return math.hypot((a_lat - b_lat) * 111320, (a_lon - b_lon) * 111320 * math.cos(math.radians(a_lat)))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('model', help='uno o più file .pt separati da virgola (media dei punteggi)'); ap.add_argument('--bbox', required=True); ap.add_argument('--thr', type=float, default=0.05)
    ap.add_argument('--auto', type=int, default=0, help='conferma in automatico i candidati con punteggio >= N%% (0 = no)')
    ap.add_argument('--tta', action='store_true'); ap.add_argument('--label', default=''); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--context', default='', help='comune (es. udine): usa edifici/strade salvati dall\'admin')
    ap.add_argument('--batch', type=int, default=150); ap.add_argument('--exclude', default='', help='S,W,N,E;S,W,N,E aree già scansionate'); ap.add_argument('--progress', default='')
    a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']; t0 = time.time()
    S0, W0, N0, E0 = map(float, a.bbox.split(','))
    class Ensemble:  # media dei punteggi di più reti (stessa griglia)
        def __init__(self, paths):
            self.nets = []
            for pth in paths:
                n_ = Fm.Net(); n_.load_state_dict(torch.load(pth)); n_.eval(); self.nets.append(n_)
        def dense(self, img):  # scansione densa solo con la prima rete (veloce)
            return self.nets[0].dense(img)
        def rescore(self, img, x, y, v0):  # le altre reti valutano solo un ritaglio di 24 m attorno al candidato
            if len(self.nets) == 1: return v0
            r = 120; h, w_, _ = img.shape; x0, y0 = int(max(0, min(w_ - 2 * r, x - r))), int(max(0, min(h - 2 * r, y - r)))
            sub = np.ascontiguousarray(img[y0:y0 + 2 * r, x0:x0 + 2 * r]); vals = [v0]
            for n_ in self.nets[1:]:
                s_, cx_, cy_ = n_.dense(sub); gx, gy = np.meshgrid(cx_ + x0, cy_ + y0); m_ = np.hypot(gx - x, gy - y) * T.RES <= 2.5
                vals.append(float(s_[m_].max()) if m_.any() else 0.0)
            return sum(vals) / len(vals)
    net = Ensemble(a.model.split(','))
    print(f'Reti in media: {len(net.nets)}', flush=True)
    ctx = None
    if a.context:
        from shapely.geometry import Polygon, LineString, Point, box
        from shapely.strtree import STRtree
        objs = sb('POST', '/storage/v1/object/list/foto', key, {'prefix': 'contesto/', 'limit': 1000})
        names = sorted(o['name'] for o in objs if o['name'].startswith(a.context.lower() + '-'))
        if not names: raise SystemExit(f'Nessun contesto per "{a.context}": usa il pulsante nell\'admin')
        data = json.loads(urllib.request.urlopen(f'{SB}/storage/v1/object/public/foto/contesto/{names[-1]}', timeout=120).read())
        P = lambda pts: [(lo, la) for la, lo in pts]
        bld = [Polygon(P(p)) for p in data['edifici'] if len(p) >= 4]; bld = [g if g.is_valid else g.buffer(0) for g in bld]
        lines = [LineString(P(p)) for p in data['strade'] if len(p) >= 2] + [Polygon(P(p)) for p in data['parcheggi'] if len(p) >= 4]
        ctx = dict(bld=STRtree(bld), bldg=bld, lines=STRtree(lines))
        print(f"Contesto {names[-1]}: {len(bld)} edifici, {len(lines)} strade/parcheggi", flush=True)
    dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians((S0 + N0) / 2)))
    px = int(round(TILE / T.RES)); px += (16 - (px - 64) % 16) % 16  # griglia simmetrica per la media sulle rotazioni
    step_lat, step_lon = (TILE - OVER) * dlat, (TILE - OVER) * dlon
    tiles = [(round(la, 6), round(lo, 6)) for la in np.arange(S0, N0, step_lat) for lo in np.arange(W0, E0, step_lon)]
    excl = [tuple(map(float, x.split(','))) for x in a.exclude.split(';') if x]  # aree già scansionate
    tiles = [(la, lo) for la, lo in tiles if not any(es <= la and la + TILE * dlat <= en and ew <= lo and lo + TILE * dlon <= ee for es, ew, en, ee in excl)]
    tot0 = len(tiles)
    if ctx is not None:  # tengo solo i riquadri con strade/parcheggi, dai più densi ai meno densi
        dens = [len(ctx['lines'].query(box(lo - 10 * dlon, la - 10 * dlat, lo + (TILE + 10) * dlon, la + (TILE + 10) * dlat))) for la, lo in tiles]
        tiles = [t_ for t_, d_ in sorted(zip(tiles, dens), key=lambda z: -z[1]) if d_ > 0]
    prog = a.progress or f'/home/claude/scan_progress_{(a.label or "area").lower()}.json'
    remote = f"/storage/v1/object/modelli/scan/{os.path.basename(prog)}"
    if not os.path.exists(prog):  # ripresa dopo un riavvio: copia salvata su Supabase
        try:
            got = sb('GET', remote.replace('/object/', '/object/authenticated/'), key)
            got = got if isinstance(got, list) else json.loads(got)
            json.dump(got, open(prog, 'w')); print(f'Ripresa: {len(got)} riquadri già fatti (copia da Supabase)', flush=True)
        except Exception: pass
    done_set = set(map(tuple, json.load(open(prog)))) if os.path.exists(prog) else set()
    todo = [t_ for t_ in tiles if t_ not in done_set]
    print(f'Area {(N0 - S0) / dlat / 1000:.1f} × {(E0 - W0) / dlon / 1000:.1f} km · {tot0} riquadri, {len(tiles)} con strade/parcheggi, già fatti {len(tiles) - len(todo)} · soglia {a.thr}', flush=True)
    from concurrent.futures import ThreadPoolExecutor
    pool = ThreadPoolExecutor(3); fetch = lambda t_: wms(t_[0], t_[1], t_[0] + TILE * dlat, t_[1] + TILE * dlon, px)
    tag = f"rete neurale{' (media di ' + str(len(net.nets)) + ')' if len(net.nets) > 1 else ''}"
    total_up = 0; in_bld = 0; n_dark = 0; n_anom = 0
    for bi in range(0, len(todo), a.batch):
        batch = todo[bi:bi + a.batch]; futs = [pool.submit(fetch, t_) for t_ in batch[:3]]; found = []
        for j, (la, lo) in enumerate(batch):
            if j + 3 < len(batch): futs.append(pool.submit(fetch, batch[j + 3]))  # scarico in anticipo mentre la rete calcola
            img = futs[j].result(); s, w, n, e = la, lo, la + TILE * dlat, lo + TILE * dlon
            if img is None: continue
            gray = img.mean(2)
            if (gray < 0.12).mean() > 0.5: n_dark += 1; continue  # ortofoto mancante (zona nera): la rete vedrebbe solo rumore
            sc, cx, cy = net.dense(img); m = OVER / 2 / T.RES; im = None; tile_found = []
            for v, x, y in T.nms(sc, cx, cy, a.thr if len(net.nets) == 1 else a.thr / 2):
                if not (m <= x <= px - m and m <= y <= px - m): continue
                lat = n - (y / px) * (n - s); lon = w + (x / px) * (e - w)
                v = net.rescore(img, x, y, v)
                if v < a.thr: continue
                yi, xi = int(y), int(x); w8 = int(4 / T.RES)
                if gray[max(0, yi - w8):yi + w8, max(0, xi - w8):xi + w8].mean() < 0.12: n_dark += 1; continue  # punto in zona nera
                if ctx is not None:
                    pt = Point(lon, lat)
                    if any(ctx['bldg'][i].contains(pt) for i in ctx['bld'].query(pt)): in_bld += 1; continue  # sopra un edificio: è un tetto
                if im is None: im = Image.fromarray((img * 255).astype(np.uint8))
                r = 140; crop = im.crop((int(x - r), int(y - r), int(x + r), int(y + r))); dr = ImageDraw.Draw(crop); dr.ellipse([r - 22, r - 22, r + 22, r + 22], outline=(255, 40, 40), width=3)
                buf = io.BytesIO(); crop.save(buf, 'JPEG', quality=85); tile_found.append(dict(score=float(v), lat=lat, lon=lon, jpg=buf.getvalue()))
            if len(tile_found) > MAX_PER_TILE: print(f'  riquadro anomalo {la:.5f},{lo:.5f}: {len(tile_found)} rilevamenti, scartato', flush=True); n_anom += 1; continue
            found.extend(tile_found)
        # fine blocco: confronto con ciò che è già in database (anche quanto caricato nei blocchi precedenti) e carico
        known = [(r['lat'], r['lon']) for r in sb_all('/rest/v1/stalli?select=lat,lon&stato=neq.rifiutato&order=id', key) + sb_all('/rest/v1/candidati?select=lat,lon&order=id', key)]
        kl = np.array(known) if known else np.zeros((0, 2))
        found.sort(key=lambda f: -f['score']); keep = []
        for f in found:
            if any(dist_m(f['lat'], f['lon'], k['lat'], k['lon']) < T.NMS for k in keep): continue
            if len(kl):
                dd = np.hypot((kl[:, 0] - f['lat']) * 111320, (kl[:, 1] - f['lon']) * 111320 * math.cos(math.radians(f['lat'])))
                if dd.min() < EXCL: continue
            keep.append(f)
        if not a.dry_run:
            for f in sorted(keep, key=lambda f: f['score']):  # l'admin mostra prima i più recenti: carico per ultimi i più probabili
                path = f"nn/{f['lat']:.6f}_{f['lon']:.6f}.jpg"
                try: sb('POST', f'/storage/v1/object/foto/{path}', key, f['jpg'], 'image/jpeg', {'x-upsert': 'true'})
                except Exception as ex: print('  foto non caricata:', ex)
                sb('POST', '/rest/v1/candidati?on_conflict=ext_id', key, {'ext_id': f"nn/{f['lat']:.6f},{f['lon']:.6f}", 'fonte': 'satellite', 'classe': f"{tag} · punteggio {round(f['score'] * 100)}%",
                                                                       'lat': round(f['lat'], 6), 'lon': round(f['lon'], 6), 'comune': a.label or None, 'note': f'{SB}/storage/v1/object/public/foto/{path}', 'stato': 'nuovo'},
                   extra={'Prefer': 'resolution=ignore-duplicates,return=minimal'})
            if a.auto:
                try:
                    import auto_accept; auto_accept.run(key, a.auto)
                except Exception as ex: print('  conferma automatica non riuscita:', ex)
            done_set.update(batch); json.dump(sorted(done_set), open(prog, 'w'))
            try: sb('POST', remote, key, open(prog, 'rb').read(), 'application/json', {'x-upsert': 'true'})
            except Exception as ex: print('  avanzamento non salvato su Supabase:', ex)
        total_up += len(keep)
        print(f'  blocco {bi // a.batch + 1}/{math.ceil(len(todo) / a.batch)}: riquadri {min(bi + a.batch, len(todo))}/{len(todo)} · nuovi candidati {len(keep)} (totale {total_up}) · scartati sui tetti {in_bld} · zone nere {n_dark} · riquadri anomali {n_anom} · {(time.time() - t0) / 60:.0f} min', flush=True)
    print(f'Fatto in {(time.time() - t0) / 60:.0f} min: {total_up} candidati caricati.')


if __name__ == '__main__':
    main()
