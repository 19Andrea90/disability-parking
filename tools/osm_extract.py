#!/usr/bin/env python3
"""Estrae da un file OpenStreetMap (.osm.pbf, es. da download.openstreetmap.fr) i dati che servono alla scansione,
senza Overpass e senza il browser dell'admin.

  contesto  : edifici, strade e parcheggi di un rettangolo → foto/contesto/<slug>-<AAAAMMGGhhmm>.json
              (stesso formato del pulsante "Prepara edifici e strade" dell'admin)
  stalli    : stalli riservati ai disabili già mappati su OSM nel rettangolo → file JSON (verità per le prove)

Uso: SUPABASE_SERVICE_KEY=... python3 tools/osm_extract.py regione.osm.pbf --bbox S,W,N,E --slug bolzano --label Bolzano
         [--stalli stalli.json] [--no-upload]
"""
import argparse, json, os, re, time, urllib.request
import osmium

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
HIGHWAY = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian',
           'road', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}  # come in admin.js buildContext
r5 = lambda x: round(x * 1e5) / 1e5


def is_disabled(t):
    a = t.get('amenity')
    if a == 'parking_space': return t.get('parking_space') == 'disabled' or t.get('disabled') in ('yes', 'designated')
    if a == 'parking':
        cd = t.get('capacity:disabled')
        if cd is not None: return cd.isdigit() and int(cd) > 0
        return t.get('disabled') in ('yes', 'designated')
    return False


class H(osmium.SimpleHandler):
    def __init__(self, bb):
        super().__init__(); self.S, self.W, self.N, self.E = bb
        self.out = dict(edifici=[], strade=[], parcheggi=[]); self.stalli = []

    def inside(self, la, lo): return self.S <= la <= self.N and self.W <= lo <= self.E

    def stallo(self, kind, oid, la, lo, t):
        if self.inside(la, lo):
            self.stalli.append({'osm_id': f'{kind}/{oid}', 'lat': la, 'lon': lo, 'amenity': t.get('amenity'), 'capacity_disabled': t.get('capacity:disabled')})

    def node(self, n):
        if n.tags and is_disabled(n.tags) and n.location.valid(): self.stallo('node', n.id, n.location.lat, n.location.lon, n.tags)

    def way(self, w):
        t = w.tags; b = 'building' in t; hw = t.get('highway') in HIGHWAY; pk = t.get('amenity') == 'parking'; dis = is_disabled(t)
        if not (b or hw or pk or dis): return
        try: pts = [(n.location.lat, n.location.lon) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError: return
        if not pts or not any(self.inside(la, lo) for la, lo in pts): return
        if dis:
            la = sum(p[0] for p in pts) / len(pts); lo = sum(p[1] for p in pts) / len(pts); self.stallo('way', w.id, la, lo, t)
        g = [[r5(la), r5(lo)] for la, lo in pts]
        if b: self.out['edifici'].append(g)
        elif pk: self.out['parcheggi'].append(g)
        elif hw: self.out['strade'].append(g)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('pbf'); ap.add_argument('--bbox', required=True); ap.add_argument('--slug', required=True); ap.add_argument('--label', required=True)
    ap.add_argument('--stalli', default=''); ap.add_argument('--no-upload', action='store_true')
    a = ap.parse_args(); bb = tuple(map(float, a.bbox.split(','))); t0 = time.time()
    h = H(bb); h.apply_file(a.pbf, locations=True, idx='flex_mem')
    o = h.out; print(f'{a.label}: {len(o["edifici"])} edifici, {len(o["strade"])} strade, {len(o["parcheggi"])} parcheggi, {len(h.stalli)} stalli OSM ({time.time() - t0:.0f} s)')
    if a.stalli: json.dump(h.stalli, open(a.stalli, 'w')); print('  stalli →', a.stalli)
    if a.no_upload: return
    doc = dict(comune=a.label, bbox=','.join(f'{x:.7f}' for x in bb), creato=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **o)
    body = json.dumps(doc).encode(); path = f'contesto/{a.slug}-{time.strftime("%Y%m%d%H%M", time.gmtime())}.json'; key = os.environ['SUPABASE_SERVICE_KEY']
    req = urllib.request.Request(f'{SB}/storage/v1/object/foto/{path}', data=body, method='POST',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'x-upsert': 'true'})
    urllib.request.urlopen(req, timeout=120).read(); print(f'  contesto caricato: {path} ({len(body) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
