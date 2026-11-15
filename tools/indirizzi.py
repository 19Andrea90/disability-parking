#!/usr/bin/env python3
"""Riempie una volta per tutte indirizzo e comune degli stalli attivi che non li hanno.

  comune    : dal confine ISTAT in cui cade lo stallo (stessi file di tools/copertura.py)
  indirizzo : dal numero civico OSM più vicino (entro 25 m) oppure dal nome della strada OSM più vicina (entro 70 m),
              leggendo gli estratti regionali di download.openstreetmap.fr (cancellati dopo l'uso)

Non tocca gli indirizzi già presenti. Uso: SUPABASE_SERVICE_KEY=... python3 tools/indirizzi.py [--regioni a,b] [--dry-run]
"""
import argparse, concurrent.futures as cf, json, math, os, sys, time, urllib.parse, urllib.request
from collections import defaultdict
import osmium

sys.path.insert(0, os.path.dirname(__file__))
from scan_area import sb_all  # noqa: E402
from osm_import_italia import REGIONI, BASE, NOMI  # noqa: E402

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
DIR = '/home/claude/osm'
CY, CX = 0.001, 0.0014  # celle di circa 110 m
cell = lambda la, lo: (int(la / CY), int(lo / CX))


def dist(a, b, c, d): return math.hypot((a - c) * 111320, (b - d) * 111320 * math.cos(math.radians(a)))


def patch(key, ids, body):
    for i in range(0, len(ids), 60):
        q = urllib.parse.quote('(' + ','.join(ids[i:i + 60]) + ')')
        req = urllib.request.Request(f'{SB}/rest/v1/stalli?id=in.{q}', data=json.dumps(body).encode(), method='PATCH',
                                     headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=minimal'})
        for t in range(4):
            try: urllib.request.urlopen(req, timeout=120).read(); break
            except Exception:
                if t == 3: raise
                time.sleep(3 * (t + 1))


def scrivi(key, campo, valori, dry):  # valori: {valore: [id, ...]}
    if dry or not valori: return
    with cf.ThreadPoolExecutor(6) as ex: list(ex.map(lambda kv: patch(key, kv[1], {campo: kv[0]}), valori.items()))


class H(osmium.SimpleHandler):
    def __init__(self, need): super().__init__(); self.need = need; self.road = defaultdict(list); self.addr = defaultdict(list)
    def node(self, n):
        t = n.tags
        if 'addr:housenumber' in t and 'addr:street' in t and n.location.valid():
            c = cell(n.location.lat, n.location.lon)
            if c in self.need: self.addr[c].append((n.location.lat, n.location.lon, f"{t['addr:street']} {t['addr:housenumber']}"))
    def way(self, w):
        t = w.tags
        if 'highway' not in t or 'name' not in t or t['highway'] in ('footway', 'path', 'cycleway', 'steps', 'track', 'bus_stop', 'platform'): return
        name = t['name']
        try:
            for n in w.nodes:
                if n.location.valid():
                    c = cell(n.location.lat, n.location.lon)
                    if c in self.need: self.road[c].append((n.location.lat, n.location.lon, name))
        except osmium.InvalidLocationError: pass


def comuni(st, key, dry):
    import shapefile
    from shapely.geometry import shape, Point
    from shapely.strtree import STRtree
    from pyproj import Transformer
    base = [os.path.join(r, f)[:-4] for r, _, fs in os.walk('/home/claude/istat') for f in fs if f.startswith('Com') and f.endswith('_WGS84.shp')][0]
    r = shapefile.Reader(base); geoms, nomi = [], []
    for sr in r.iterShapeRecords(): geoms.append(shape(sr.shape.__geo_interface__)); nomi.append(sr.record.as_dict()['COMUNE'])
    tree = STRtree(geoms); utm = Transformer.from_crs('EPSG:4326', 'EPSG:32632', always_xy=True); out = defaultdict(list)
    for s in st:
        p = Point(*utm.transform(s['lon'], s['lat']))
        for i in tree.query(p):
            if geoms[i].contains(p): out[nomi[i]].append(s['id']); break
    print(f'Comune: assegnato a {sum(map(len, out.values()))} stalli su {len(st)} ({len(out)} comuni)', flush=True)
    scrivi(key, 'comune', out, dry)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--regioni', default=''); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--salta-comuni', action='store_true')
    a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']; os.makedirs(DIR, exist_ok=True)
    q = '/rest/v1/stalli?select=id,lat,lon&stato=in.(proposto,verificato,ufficiale)&order=id'
    if not a.salta_comuni: comuni(sb_all(q + '&comune=is.null', key), key, a.dry_run)
    todo = {s['id']: s for s in sb_all(q + '&indirizzo=is.null', key)}; print(f'Senza indirizzo: {len(todo)}', flush=True)
    for reg in (a.regioni.split(',') if a.regioni else REGIONI):
        if not todo: break
        t0 = time.time(); need = set()
        for s in todo.values():
            i, j = cell(s['lat'], s['lon']); need.update((i + di, j + dj) for di in (-1, 0, 1) for dj in (-1, 0, 1))
        pbf = f'{DIR}/{reg}.osm.pbf'; scaricato = not os.path.exists(pbf)
        if scaricato: urllib.request.urlretrieve(BASE + reg + '.osm.pbf', pbf + '.part'); os.replace(pbf + '.part', pbf)
        idx = f'{DIR}/{reg}.ind.idx'; h = H(need); h.apply_file(pbf, locations=True, idx=f'sparse_file_array,{idx}')
        if os.path.exists(idx): os.remove(idx)
        if scaricato or reg != 'trentino_alto_adige': os.remove(pbf)
        out = defaultdict(list); n_civ = 0
        for s in list(todo.values()):
            i, j = cell(s['lat'], s['lon']); best = None; civ = None
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for la, lo, nm in h.addr.get((i + di, j + dj), ()):
                        d = dist(s['lat'], s['lon'], la, lo)
                        if d <= 25 and (civ is None or d < civ[0]): civ = (d, nm)
                    for la, lo, nm in h.road.get((i + di, j + dj), ()):
                        d = dist(s['lat'], s['lon'], la, lo)
                        if d <= 70 and (best is None or d < best[0]): best = (d, nm)
            v = civ[1] if civ else (best[1] if best else None)
            if v: out[v].append(s['id']); n_civ += bool(civ); del todo[s['id']]
        scrivi(key, 'indirizzo', out, a.dry_run)
        print(f'{NOMI.get(reg, reg.capitalize())}: indirizzo a {sum(map(len, out.values()))} stalli ({n_civ} con civico) · restano {len(todo)} · {time.time() - t0:.0f} s', flush=True)
    print(f'Fatto. Senza indirizzo restano {len(todo)}.', flush=True)


if __name__ == '__main__':
    main()
