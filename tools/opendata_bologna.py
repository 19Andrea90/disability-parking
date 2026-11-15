#!/usr/bin/env python3
"""Importa gli stalli per disabili ufficiali del Comune di Bologna (open data, CC BY) come stalli 'ufficiale', fonte 'opendata'.

Dataset: https://opendata.comune.bologna.it/explore/dataset/sosta-veicoli-a-servizio-di-persone-disabili-h/
Chiave di deduplica in osm_id: 'opendata:bologna:<lat>,<lon>' (il dataset non ha un id proprio), quindi rilanciarlo non crea doppioni.
Poi gli stalli OSM/satellite/proposti entro --raggio m da uno ufficiale vengono accorpati (stato 'rimosso', nota 'Accorpato in …').

Uso: SUPABASE_SERVICE_KEY=... python3 tools/opendata_bologna.py [--raggio 15] [--dry-run]
"""
import argparse, json, math, os, urllib.request

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
SRC = 'https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/sosta-veicoli-a-servizio-di-persone-disabili-h/exports/json'
BB = (44.42, 11.22, 44.56, 11.44)  # S, W, N, E del comune


def sb(method, path, key, body=None, prefer='return=minimal'):
    req = urllib.request.Request(SB + path, data=None if body is None else json.dumps(body).encode(), method=method,
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': prefer})
    r = urllib.request.urlopen(req, timeout=120).read(); return json.loads(r) if r else None


def sb_all(path, key):
    out, off = [], 0
    while True:
        b = sb('GET', f'{path}&offset={off}&limit=1000', key); out += b; off += 1000
        if len(b) < 1000: return out


def dist(a, b, c, d): return math.hypot((a - c) * 111320, (b - d) * 111320 * math.cos(math.radians(a)))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--raggio', type=float, default=15); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    key = os.environ['SUPABASE_SERVICE_KEY']
    rows = json.load(urllib.request.urlopen(SRC, timeout=120)); recs = {}
    for r in rows:
        g = r.get('geo_point_2d') or {}; la, lo = g.get('lat'), g.get('lon')
        if la is None: continue
        loc = (r.get('localizzazione') or ' '.join(x for x in (r.get('via'), r.get('civico')) if x) or '').title() or None
        dispo = (r.get('disposti') or '').lower(); sub = (r.get('subcat') or '').lower()
        note = '; '.join(x for x in ((f'disposizione a {dispo}' if dispo else ''), sub, 'Dato ufficiale Comune di Bologna (open data, CC BY)') if x)
        k = f'opendata:bologna:{la:.6f},{lo:.6f}'
        recs[k] = dict(osm_id=k, lat=round(la, 7), lon=round(lo, 7), tipo='generico', posti=max(1, int(r.get('numero') or 1)), nome=None,
                       indirizzo=loc, comune='Bologna', note=note, stato='ufficiale', fonte='opendata')
    recs = list(recs.values()); print(f'Bologna open data: {len(rows)} righe → {len(recs)} stalli ({sum(r["posti"] for r in recs)} posti)')
    if not a.dry_run:
        for i in range(0, len(recs), 200):
            sb('POST', '/rest/v1/stalli?on_conflict=osm_id', key, recs[i:i + 200], prefer='resolution=ignore-duplicates,return=minimal')
    S, W, N, E = BB
    act = sb_all(f'/rest/v1/stalli?select=id,lat,lon,stato,fonte,tipo,osm_id&stato=in.(proposto,verificato,ufficiale)&lat=gte.{S}&lat=lte.{N}&lon=gte.{W}&lon=lte.{E}&order=id', key)
    uff = [s for s in act if s['fonte'] == 'opendata']; altri = [s for s in act if s['fonte'] != 'opendata' and s['tipo'] != 'personalizzato']
    osm = [s for s in altri if s['fonte'] == 'osm']
    near = lambda s, R: min(((dist(s['lat'], s['lon'], u['lat'], u['lon']), u) for u in uff), key=lambda x: x[0], default=(1e9, None))
    for R in (10, 15, 25, 50):
        print(f'  stalli OSM a Bologna entro {R} m da uno ufficiale: {sum(near(s, R)[0] <= R for s in osm)}/{len(osm)}')
    todo = [(s, *near(s, a.raggio)) for s in altri]; todo = [(s, d, u) for s, d, u in todo if d <= a.raggio]
    print(f'  da accorpare entro {a.raggio:.0f} m in uno ufficiale: {len(todo)}')
    if a.dry_run: return
    for s, d, u in todo:
        sb('PATCH', f'/rest/v1/stalli?id=eq.{s["id"]}', key, {'stato': 'rimosso', 'note': f'Accorpato in {u["id"]} ({d:.0f} m, dato ufficiale Comune di Bologna). '})
    print('Fatto.')


if __name__ == '__main__':
    main()
