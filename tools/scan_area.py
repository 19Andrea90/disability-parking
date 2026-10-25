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
EXCL = 12.0    # m: niente candidati vicino a stalli o candidati già presenti


def sb(method, path, key, body=None, ctype='application/json', extra=None):
    h = {'apikey': key, 'Authorization': f'Bearer {key}'}
    if body is not None: h['Content-Type'] = ctype
    if extra: h.update(extra)
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(f'{SB}{path}', data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read(); return json.loads(t) if t and r.headers.get('content-type', '').startswith('application/json') else t


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
    ap.add_argument('--tta', action='store_true'); ap.add_argument('--label', default=''); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--context', default='', help='comune (es. udine): usa edifici/strade salvati dall\'admin')
    a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']; t0 = time.time()
    S0, W0, N0, E0 = map(float, a.bbox.split(','))
    class Ensemble:  # media dei punteggi di più reti (stessa griglia)
        def __init__(self, paths):
            self.nets = []
            for pth in paths:
                n_ = Fm.Net(); n_.load_state_dict(torch.load(pth)); n_.eval(); self.nets.append(n_)
        def dense(self, img):
            outs = [n_.dense(img) for n_ in self.nets]; return sum(o[0] for o in outs) / len(outs), outs[0][1], outs[0][2]
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
    stalli = sb('GET', '/rest/v1/stalli?select=lat,lon&stato=neq.rifiutato&limit=20000', key)
    cands = sb('GET', '/rest/v1/candidati?select=lat,lon&limit=20000', key)
    known = [(r['lat'], r['lon']) for r in stalli + cands]
    dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians((S0 + N0) / 2)))
    px = int(round(TILE / T.RES)); px += (16 - (px - 64) % 16) % 16  # griglia simmetrica per la media sulle rotazioni
    step_lat, step_lon = (TILE - OVER) * dlat, (TILE - OVER) * dlon
    lats = np.arange(S0, N0, step_lat); lons = np.arange(W0, E0, step_lon); tot = len(lats) * len(lons)
    print(f'Area {(N0 - S0) / dlat / 1000:.1f} × {(E0 - W0) / dlon / 1000:.1f} km · {tot} riquadri da {TILE:.0f} m · soglia {a.thr}{" · media su 4 rotazioni" if a.tta else ""}', flush=True)
    found = []; done = 0; im_tile = None; im = None; skipped = 0; in_bld = 0
    for la in lats:
        for lo in lons:
            s, w = la, lo; n, e = la + TILE * dlat, lo + TILE * dlon; done += 1
            if ctx is not None and not len(ctx['lines'].query(box(w - 10 * dlon, s - 10 * dlat, e + 10 * dlon, n + 10 * dlat))):
                skipped += 1; continue  # nessuna strada o parcheggio: campi, boschi
            img = wms(s, w, n, e, px)
            if img is None: continue
            if a.tta:
                acc = None
                for k in range(4):
                    sk, cx, cy = net.dense(np.ascontiguousarray(np.rot90(img, k))); sk = np.rot90(sk, -k)
                    acc = sk if acc is None else acc + sk
                sc = acc / 4
            else:
                sc, cx, cy = net.dense(img)
            m = OVER / 2 / T.RES  # tengo solo la parte centrale (il resto lo copre il riquadro vicino)
            for v, x, y in T.nms(sc, cx, cy, a.thr):
                if not (m <= x <= px - m and m <= y <= px - m): continue
                lat = n - (y / px) * (n - s); lon = w + (x / px) * (e - w)
                if ctx is not None:
                    pt = Point(lon, lat)
                    if any(ctx['bldg'][i].contains(pt) for i in ctx['bld'].query(pt)): in_bld += 1; continue  # sopra un edificio: è un tetto
                if im_tile is not img: im = Image.fromarray((img * 255).astype(np.uint8))
                im_tile = img; r = 140  # ritaglio di 28 m, salvato subito per non tenere in memoria il riquadro
                crop = im.crop((int(x - r), int(y - r), int(x + r), int(y + r))); dr = ImageDraw.Draw(crop); dr.ellipse([r - 22, r - 22, r + 22, r + 22], outline=(255, 40, 40), width=3)
                buf = io.BytesIO(); crop.save(buf, 'JPEG', quality=85)
                found.append(dict(score=float(v), lat=lat, lon=lon, jpg=buf.getvalue()))
            if done % 25 == 0: print(f'  {done}/{tot} riquadri · candidati grezzi {len(found)} · saltati {skipped} · sui tetti {in_bld} · {time.time() - t0:.0f} s', flush=True)
    # NMS globale + esclusione dei punti già noti
    found.sort(key=lambda f: -f['score']); keep = []
    for f in found:
        if any(dist_m(f['lat'], f['lon'], k['lat'], k['lon']) < T.NMS for k in keep): continue
        if any(dist_m(f['lat'], f['lon'], kl, ko) < EXCL for kl, ko in known): continue
        keep.append(f)
    print(f'Candidati nuovi: {len(keep)} (scartati perché vicini a stalli/candidati noti: {len(found) - len(keep)})', flush=True)
    if a.dry_run: return
    keep.sort(key=lambda f: f['score'])  # l'admin mostra prima i più recenti: carico per ultimi i più probabili
    for i, f in enumerate(keep):
        path = f"nn/{f['lat']:.6f}_{f['lon']:.6f}.jpg"
        try: sb('POST', f'/storage/v1/object/foto/{path}', key, f['jpg'], 'image/jpeg', {'x-upsert': 'true'})
        except Exception as ex: print('  foto non caricata:', ex)
        url = f'{SB}/storage/v1/object/public/foto/{path}'
        sb('POST', '/rest/v1/candidati?on_conflict=ext_id', key, {'ext_id': f"nn/{f['lat']:.6f},{f['lon']:.6f}", 'fonte': 'satellite', 'classe': f"rete neurale{' (media di ' + str(len(net.nets)) + ')' if len(net.nets) > 1 else ''} · punteggio {round(f['score'] * 100)}%",
                                                               'lat': round(f['lat'], 6), 'lon': round(f['lon'], 6), 'comune': a.label or None, 'note': url, 'stato': 'nuovo'},
           extra={'Prefer': 'resolution=ignore-duplicates,return=minimal'})
        if (i + 1) % 25 == 0: print(f'  caricati {i + 1}/{len(keep)}', flush=True)
    print(f'Fatto in {time.time() - t0:.0f} s.')


if __name__ == '__main__':
    main()
