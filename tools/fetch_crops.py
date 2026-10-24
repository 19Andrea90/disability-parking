#!/usr/bin/env python3
"""Scarica dall'ortofoto FVG un ritaglio attorno a ogni stallo del database (stessa inquadratura della modalità Etichetta).

Uso: SUPABASE_SERVICE_KEY=... python3 fetch_crops.py OUT_DIR
Crea OUT_DIR/<stallo_id>.jpg (400 px, 40 m oppure 60 m per i "parcheggi con posti") e OUT_DIR/stalli.json.
"""
import json, math, os, sys, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
WMS = 'https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows'


def sb_get(path, key):
    req = urllib.request.Request(f'{SB}/rest/v1/{path}', headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    return json.load(urllib.request.urlopen(req, timeout=60))


def bbox(lat, lon, side):
    dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(lat))); h = side / 2
    return lat - h * dlat, lon - h * dlon, lat + h * dlat, lon + h * dlon


def fetch(lat, lon, side, px, path):
    if os.path.exists(path) and os.path.getsize(path) > 2000:
        return True
    s, w, n, e = bbox(lat, lon, side)
    q = urllib.parse.urlencode({'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap', 'LAYERS': 'trueorto_FVG_1720', 'STYLES': '', 'SRS': 'EPSG:4326',
                                'BBOX': f'{w},{s},{e},{n}', 'WIDTH': px, 'HEIGHT': px, 'FORMAT': 'image/jpeg'})
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(f'{WMS}?{q}', timeout=60).read()
            if data[:2] == b'\xff\xd8':
                open(path, 'wb').write(data); return True
        except Exception:
            time.sleep(2 + attempt * 3)
    return False


def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True); key = os.environ['SUPABASE_SERVICE_KEY']
    rows = sb_get('stalli?select=id,lat,lon,nome,comune,fonte,stato,tipo,posti&stato=in.(verificato,ufficiale)&limit=10000', key)
    json.dump(rows, open(os.path.join(out, 'stalli.json'), 'w'))
    jobs = []
    for r in rows:
        side = 60 if 'Parcheggio con posti' in (r.get('nome') or '') else 40
        jobs.append((r['lat'], r['lon'], side, 400, os.path.join(out, f"{r['id']}.jpg")))
    t0 = time.time(); ok = 0
    with ThreadPoolExecutor(4) as ex:
        for i, res in enumerate(ex.map(lambda j: fetch(*j), jobs)):
            ok += res
            if (i + 1) % 100 == 0: print(f'{i + 1}/{len(jobs)} · ok {ok} · {time.time() - t0:.0f} s', flush=True)
    print(f'Fatto: {ok}/{len(jobs)} ritagli in {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
