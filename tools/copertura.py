#!/usr/bin/env python3
"""Copertura comune per comune: quanti stalli attivi abbiamo in ciascuno dei comuni italiani (confini ISTAT).

Scarica (una volta) confini comunali generalizzati ed elenco comuni ISTAT, assegna ogni stallo attivo al suo comune
e scrive:
  - un riepilogo per regione e l'elenco dei capoluoghi più scoperti (a video);
  - foto/copertura/copertura.json su Supabase (per una futura pagina dell'admin);
  - foto/copertura/comuni.geojson (confini semplificati + conteggi, per la mappa di copertura).

Uso: SUPABASE_SERVICE_KEY=... python3 tools/copertura.py
"""
import csv, io, json, os, sys, time, urllib.request, zipfile
from collections import Counter, defaultdict
import shapefile
from shapely.geometry import shape, Point, mapping
from shapely.strtree import STRtree
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(__file__))
from scan_area import sb_all  # noqa: E402

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
DIR = '/home/claude/istat'
ANNO = time.strftime('%Y')
LIM = f'https://www.istat.it/storage/cartografia/confini_amministrativi/generalizzati/{ANNO}/Limiti0101{ANNO}_g.zip'
ELENCO = 'https://www.istat.it/storage/codici-unita-amministrative/Elenco-comuni-italiani.csv'


def scarica():
    os.makedirs(DIR, exist_ok=True)
    if not os.path.exists(f'{DIR}/elenco.csv'): urllib.request.urlretrieve(ELENCO, f'{DIR}/elenco.csv')
    shp = [os.path.join(r, f) for r, _, fs in os.walk(DIR) for f in fs if f.startswith('Com') and f.endswith('_WGS84.shp')]
    if not shp:
        z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(LIM, timeout=600).read()))
        for n in z.namelist():
            if n.startswith('Com'): z.extract(n, DIR)
        shp = [os.path.join(r, f) for r, _, fs in os.walk(DIR) for f in fs if f.startswith('Com') and f.endswith('_WGS84.shp')]
    return shp[0][:-4]


def main():
    key = os.environ['SUPABASE_SERVICE_KEY']; base = scarica()
    info, per_nome, regioni = {}, {}, {}
    for row in csv.reader(io.StringIO(open(f'{DIR}/elenco.csv', encoding='latin1').read()), delimiter=';'):
        if row and row[4].isdigit():
            info[row[4]] = dict(regione=row[10], provincia=row[14], capoluogo=row[13] == '1', prov_nome=row[11]); per_nome[row[6].lower()] = info[row[4]]; regioni[int(row[0])] = row[10]
    r = shapefile.Reader(base); geoms, meta = [], []
    for sr in r.iterShapeRecords():
        d = sr.record.as_dict(); geoms.append(shape(sr.shape.__geo_interface__)); i0 = info.get(d['PRO_COM_T']) or per_nome.get(d['COMUNE'].lower()) or dict(regione=regioni.get(int(d['COD_REG']), '?'), provincia='', capoluogo=False, prov_nome=regioni.get(int(d['COD_REG']), '?'))
        meta.append(dict(cod=d['PRO_COM_T'], nome=d['COMUNE'], **i0))
    tree = STRtree(geoms); utm = Transformer.from_crs('EPSG:4326', 'EPSG:32632', always_xy=True)
    st = sb_all('/rest/v1/stalli?select=lat,lon,fonte,stato,tipo&stato=in.(proposto,verificato,ufficiale)&order=id', key)
    cnt = defaultdict(Counter)
    for s in st:
        x, y = utm.transform(s['lon'], s['lat']); p = Point(x, y)
        for i in tree.query(p):
            if geoms[i].contains(p): cnt[i]['tot'] += 1; cnt[i][s['fonte']] += 1; cnt[i][s['stato']] += 1; cnt[i]['vis'] += s['tipo'] != 'personalizzato'; break
    out = []
    for i, m in enumerate(meta):
        c = cnt.get(i, Counter()); out.append(dict(m, stalli=c['tot'], ufficiali=c['opendata'], osm=c['osm'], rete=c['satellite'], utenti=c['utente'], da_verificare=c['proposto']))
    reg = defaultdict(lambda: Counter())
    for o in out:
        g = reg[o.get('regione', '?')]; g['comuni'] += 1; g['con_stalli'] += o['stalli'] > 0; g['con_ufficiali'] += o['ufficiali'] > 0; g['stalli'] += o['stalli']
    tot = Counter(); [tot.update(v) for v in reg.values()]
    print(f'Comuni: {tot["comuni"]} · con almeno uno stallo: {tot["con_stalli"]} ({100 * tot["con_stalli"] / tot["comuni"]:.0f}%) · con dati ufficiali: {tot["con_ufficiali"]} · stalli assegnati: {tot["stalli"]} su {len(st)}')
    for k, v in sorted(reg.items(), key=lambda kv: -kv[1]['con_stalli'] / kv[1]['comuni']):
        print(f'  {k:28s} {v["con_stalli"]:5d}/{v["comuni"]:<5d} ({100 * v["con_stalli"] / v["comuni"]:3.0f}%)  stalli {v["stalli"]:6d}  comuni con dati ufficiali {v["con_ufficiali"]}')
    cap = sorted([o for o in out if o.get('capoluogo')], key=lambda o: o['stalli'])
    print('\nCapoluoghi più scoperti (stalli in mappa):')
    for o in cap[:40]: print(f'  {o["nome"]:28s} {o["provincia"]:3s} {o["stalli"]:5d}  (ufficiali {o["ufficiali"]}, OSM {o["osm"]})')
    body = json.dumps(dict(creato=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), comuni=out), ensure_ascii=False).encode()
    req = urllib.request.Request(f'{SB}/storage/v1/object/foto/copertura/copertura.json', data=body, method='POST',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'x-upsert': 'true'})
    urllib.request.urlopen(req, timeout=120).read()
    wgs = Transformer.from_crs('EPSG:32632', 'EPSG:4326', always_xy=True)
    # riepilogo per la mappa dell'app vista da lontano: quanti posti (visibili nell'app) per regione, provincia e comune
    com, gr, gp = [], defaultdict(lambda: [0, 0.0, 0.0]), defaultdict(lambda: [0, 0.0, 0.0])
    for i, m in enumerate(meta):
        t = cnt.get(i, Counter())['vis']
        if not t: continue
        pt = geoms[i].representative_point(); lo, la = wgs.transform(pt.x, pt.y); com.append(dict(n=m['nome'], lat=round(la, 4), lon=round(lo, 4), t=t))
        for g, k in ((gr, m.get('regione', '?')), (gp, m.get('prov_nome') or m.get('regione', '?'))): g[k][0] += t; g[k][1] += la * t; g[k][2] += lo * t
    gruppo = lambda g: [dict(n=k.split('/')[0], lat=round(v[1] / v[0], 4), lon=round(v[2] / v[0], 4), t=v[0]) for k, v in g.items() if v[0]]
    rie = json.dumps(dict(creato=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), totale=sum(c['t'] for c in com), regioni=gruppo(gr), province=gruppo(gp), comuni=com), ensure_ascii=False).encode()
    req = urllib.request.Request(f'{SB}/storage/v1/object/foto/copertura/riepilogo.json', data=rie, method='POST',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'x-upsert': 'true', 'Cache-Control': 'max-age=3600'})
    urllib.request.urlopen(req, timeout=120).read(); print(f'Caricato riepilogo.json ({len(rie) / 1e3:.0f} KB)')
    # L'app legge una COPIA STATICA di riepilogo.json, scaricata da tools/pubblica.py a ogni build del sito (per non pesare su Supabase):
    # per aggiornarla serve una nuova pubblicazione del sito (nuovo deploy Cloudflare Pages). Nel frattempo l'app mostra la copia precedente.
    print('Ricorda: per aggiornare la copia usata dall\'app serve un nuovo deploy del sito (Cloudflare Pages).')
    from shapely.ops import transform
    feats = [dict(type='Feature', properties=dict(c=o['cod'], n=o['nome'], s=o['stalli'], u=o['ufficiali']),
                  geometry=mapping(transform(wgs.transform, geoms[i].simplify(150)))) for i, o in enumerate(out)]
    gj = json.dumps(dict(type='FeatureCollection', features=feats), separators=(',', ':'))
    import re
    gj = re.sub(r'(\d+\.\d{4})\d+', r'\1', gj).encode()
    req = urllib.request.Request(f'{SB}/storage/v1/object/foto/copertura/comuni.geojson', data=gj, method='POST',
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'x-upsert': 'true'})
    urllib.request.urlopen(req, timeout=300).read(); print(f'\nCaricati copertura.json e comuni.geojson ({len(gj) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
