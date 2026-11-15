#!/usr/bin/env python3
"""Importa gli stalli per disabili pubblicati come open data dai comuni, come stalli 'ufficiale' con fonte 'opendata'.

Fonti (una funzione per comune, vedi FONTI):
  bologna  https://opendata.comune.bologna.it/explore/dataset/sosta-veicoli-a-servizio-di-persone-disabili-h/  (CC BY)
  firenze  https://opendata.comune.fi.it/page_dataset_show?id=c27abf04-33c0-44ba-ad74-ef8272af90d2            (CC BY)
  trento   https://dati.trentino.it/dataset/parcheggi-disabili-open-data                                       (CC BY)

Chiave di deduplica in osm_id: 'opendata:<comune>:<id o lat,lon>', quindi rilanciarlo non crea doppioni.
Dopo l'import, gli stalli non ufficiali (OSM, rete, proposti) entro --raggio m da uno ufficiale dello stesso comune
vengono accorpati (stato 'rimosso', nota 'Accorpato in …'), come fa il pulsante "Raggruppa" dell'admin.

Uso: SUPABASE_SERVICE_KEY=... python3 tools/opendata_import.py bologna firenze trento [--raggio 15] [--dry-run]
"""
import argparse, io, json, math, os, urllib.request, zipfile

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'


def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'disability-parking/1.0'}), timeout=180).read()


def rec(comune, key, la, lo, posti=1, ind=None, note='', tipo='generico'):
    return dict(osm_id=f'opendata:{comune.lower()}:{key}', lat=round(la, 7), lon=round(lo, 7), tipo=tipo, posti=max(1, int(posti or 1)), nome=None,
                indirizzo=ind, comune=comune, note='; '.join(x for x in (note, f'Dato ufficiale Comune di {comune} (open data, CC BY)') if x),
                stato='ufficiale', fonte='opendata')


def bologna():
    rows = json.loads(get('https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/sosta-veicoli-a-servizio-di-persone-disabili-h/exports/json'))
    for r in rows:
        g = r.get('geo_point_2d') or {}
        if g.get('lat') is None: continue
        loc = (r.get('localizzazione') or ' '.join(x for x in (r.get('via'), r.get('civico')) if x) or '').title() or None
        d, s = (r.get('disposti') or '').lower(), (r.get('subcat') or '').lower()
        yield rec('Bologna', f'{g["lat"]:.6f},{g["lon"]:.6f}', g['lat'], g['lon'], r.get('numero'), loc, '; '.join(x for x in ((f'disposizione a {d}' if d else ''), s) if x))


FI_SHIFT = (0.000539, 0.000633)  # il file del Comune risulta spostato di ~60 m a nord e ~51 m a est: misurato su 189 stalli OSM (15/11/2026)


def firenze():
    for f in json.loads(get('https://datigis.comune.fi.it/json/sosta_disabili.json'))['features']:
        lo, la = f['geometry']['coordinates'][:2]; la -= FI_SHIFT[0]; lo -= FI_SHIFT[1]; p = f['properties']; st = (p.get('stallo') or '').lower()
        yield rec('Firenze', p['id'], la, lo, 1, (p.get('strada') or '').title() or None, '; '.join(x for x in ((f'disposizione a {st}' if st else ''), p.get('quartiere')) if x))


def trento():
    from pyproj import Transformer
    tr = Transformer.from_crs('EPSG:25832', 'EPSG:4326', always_xy=True)
    z = zipfile.ZipFile(io.BytesIO(get('https://gis.comune.trento.it/dbexport?db=base&sc=mobilita&ly=parcheggi_disabili&fr=geojson')))
    d = json.loads(z.read([n for n in z.namelist() if n.endswith('.geojson')][0]))
    for f in d['features']:
        x, y = f['geometry']['coordinates'][:2]; lo, la = tr.transform(x, y); p = f['properties']
        ind = ' '.join(str(v) for v in (p.get('indirizzo'), p.get('civico')) if v) or None
        nota = '; '.join(x for x in (p.get('loc_frazione'), 'a pagamento' if p.get('a_pagamento') else '', 'a tempo' if p.get('a_tempo') else '', p.get('note')) if x)
        r = rec(p.get('comune') or 'Trento', p['pk'], la, lo, 1, ind, nota, 'personalizzato' if p.get('riservato') else 'generico')
        r['segnale_verticale'] = bool(p.get('segnaletica_verticale')) if p.get('segnaletica_verticale') is not None else None
        yield r


FONTI = {'bologna': bologna, 'firenze': firenze, 'trento': trento}


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
    ap = argparse.ArgumentParser(); ap.add_argument('comuni', nargs='+', choices=sorted(FONTI)); ap.add_argument('--raggio', type=float, default=15)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']
    for c in a.comuni:
        recs = list({r['osm_id']: r for r in FONTI[c]()}.values())
        print(f'{c.capitalize()}: {len(recs)} stalli ufficiali ({sum(r["posti"] for r in recs)} posti)', flush=True)
        if not a.dry_run:
            for i in range(0, len(recs), 200): sb('POST', '/rest/v1/stalli?on_conflict=osm_id', key, recs[i:i + 200], prefer='resolution=ignore-duplicates,return=minimal')
        pad = 0.004; S, N = min(r['lat'] for r in recs) - pad, max(r['lat'] for r in recs) + pad; W, E = min(r['lon'] for r in recs) - pad, max(r['lon'] for r in recs) + pad
        act = sb_all(f'/rest/v1/stalli?select=id,lat,lon,fonte,tipo,osm_id&stato=in.(proposto,verificato,ufficiale)&lat=gte.{S}&lat=lte.{N}&lon=gte.{W}&lon=lte.{E}&order=id', key)
        pref = f'opendata:{c}:'; uff = [s for s in act if (s['osm_id'] or '').startswith(pref)] or recs
        altri = [s for s in act if s['fonte'] != 'opendata' and s['tipo'] != 'personalizzato']; osm = [s for s in altri if s['fonte'] == 'osm']
        cell = {}
        for u in uff: cell.setdefault((round(u['lat'] / 0.0005), round(u['lon'] / 0.0007)), []).append(u)
        def near(s):
            best = (1e9, None); i, j = round(s['lat'] / 0.0005), round(s['lon'] / 0.0007)
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for u in cell.get((i + di, j + dj), []):
                        d = dist(s['lat'], s['lon'], u['lat'], u['lon'])
                        if d < best[0]: best = (d, u)
            return best
        nn = [(s, *near(s)) for s in altri]
        print(f'  OSM nella zona: {len(osm)}, di cui entro {a.raggio:.0f} m da uno ufficiale: {sum(1 for s, d, u in nn if s["fonte"] == "osm" and d <= a.raggio)}')
        todo = [(s, d, u) for s, d, u in nn if d <= a.raggio and u.get('id')]
        print(f'  da accorpare negli ufficiali: {len(todo)}', flush=True)
        if a.dry_run: continue
        for s, d, u in todo:
            sb('PATCH', f'/rest/v1/stalli?id=eq.{s["id"]}', key, {'stato': 'rimosso', 'note': f'Accorpato in {u["id"]} ({d:.0f} m, dato ufficiale Comune di {c.capitalize()}). '})
    print('Fatto.')


if __name__ == '__main__':
    main()
