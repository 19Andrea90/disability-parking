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
import argparse, io, json, math, os, re, sys, urllib.request, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sbleggero as L  # regola: mai scaricare tutti gli stalli: select + bbox lato server, contatore dei byte

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'


def get(url, tries=4):  # alcuni server comunali chiudono la connessione a caso: riprovo
    import time
    for t in range(tries):
        try: return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (disability-parking)'}), timeout=180).read()
        except Exception:
            if t == tries - 1: raise
            time.sleep(5 * (t + 1))


def rec(comune, key, la, lo, posti=1, ind=None, note='', tipo='generico', src=None):
    return dict(osm_id=f'opendata:{src or comune.lower()}:{key}', lat=round(la, 7), lon=round(lo, 7), tipo=tipo, posti=max(1, int(posti or 1)), nome=None,
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


def wfs_json(base, typename):
    u = f'{base}?service=WFS&version=1.1.0&request=GetFeature&typename={typename}&outputFormat=application/json&srsName=EPSG:4326'
    return json.loads(get(u))['features']


def via(*parts): return ' '.join(str(x).strip() for x in parts if x is not None and str(x).strip() and 'prossimo caricamento' not in str(x)).title() or None


def cesena():  # Comune di Cesena (Unione Valle Savio), copre ~80% del comune; coordinate a 4 decimali (~10 m)
    for f in wfs_json('https://servizisit.unionevallesavio.it/geoserverckan/Cesena/OD_SOSTA_DISABILI_SDO_preview/wfs', 'Cesena_public:OD_SOSTA_DISABILI_SDO_preview'):
        if not f.get('geometry'): continue
        lo, la = f['geometry']['coordinates'][:2]; p = f['properties']
        r = rec('Cesena', p['OBJECTID'], la, lo, p.get('NR_POSTI') or 1, via(p.get('NOME_VIA'), p.get('CIVICO')), (p.get('NOTE') or '').strip())
        if p.get('FOTO_CART'): r['foto_url'] = p['FOTO_CART']
        r['segnale_verticale'] = True if p.get('SEGNALE') else None
        yield r


def ferrara():
    DISP = {'P': 'a pettine', 'L': 'in linea', 'S': 'a spina', 'P doppia': 'a pettine, doppio', 'S doppia': 'a spina, doppio'}
    for f in wfs_json('https://sit.comune.fe.it/geoserverckan/Ferrara/Aree_di_sosta_disabili_generiche_attive_preview/wfs', 'Ferrara_public:Aree_di_sosta_disabili_generiche_attive_preview'):
        if not f.get('geometry'): continue
        lo, la = f['geometry']['coordinates'][:2]; p = f['properties']; d = (p.get('disp') or '').strip()
        yield rec('Ferrara', p['gid'], la, lo, 2 if 'doppia' in d else 1, via(p.get('via'), p.get('num'), p.get('esp')), ('disposizione ' + DISP[d]) if d in DISP else '')


def _3003():
    from pyproj import Transformer
    return Transformer.from_crs('EPSG:3003', 'EPSG:4326', always_xy=True)


def siena():  # poligoni degli stalli in Monte Mario / Gauss-Boaga fuso Ovest (EPSG:3003)
    tr = _3003()
    for f in json.loads(get('https://siena.ldpgis.it/metarepo2/api/datasets/stalli_disabili/resources/1011/GeoJSON'))['features']:
        g = f['geometry']; ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
        x = sum(c[0] for c in ring) / len(ring); y = sum(c[1] for c in ring) / len(ring); lo, la = tr.transform(x, y); p = f['properties']
        yield rec('Siena', p['id'], la, lo, 1, via(p.get('toponimo')), '', 'personalizzato' if p.get('tipo') == 'Riservato' else 'generico')


def livorno():
    tr = _3003(); z = zipfile.ZipFile(io.BytesIO(get('https://livornosit.ldpgis.it/metarepo2/api/datasets/parcheggi_riservati_disabili/download')))
    n = [n for n in z.namelist() if n.endswith('.geojson')][0]
    for i, f in enumerate(json.loads(z.read(n))['features']):
        x, y = f['geometry']['coordinates'][:2]; lo, la = tr.transform(x, y); p = f['properties']
        yield rec('Livorno', f'{la:.6f},{lo:.6f}', la, lo, 1, via(p.get('indirizzo'), p.get('civ. rif.')), ('ordinanza ' + p['ordinanza']) if p.get('ordinanza') else '')


def verona():
    import csv
    txt = get('https://dati.veneto.it/SpodCkanApi/api/2/rest/dataset/326ac525-f39e-4ca6-8645-5397dabb401e.csv').decode('utf-8-sig')
    for p in csv.DictReader(io.StringIO(txt), delimiter=';'):
        try: la, lo = float(p['Latitudine']), float(p['Longitudine'])
        except (ValueError, KeyError): continue
        nota = '; '.join(x for x in ((p.get('ZONA_RILIE') or '').lower(), (p.get('NOTE_AGGIU') or '').strip(), 'rilievo del Comune ancora da verificare' if p.get('TIPO_STALL') == 'DA VERIFICARE' else '') if x)
        yield rec('Verona', p['ID_STALLO'], la, lo, 1, None, nota)


LOMB_IDS = ['68hz-vx9p', 'b52k-cgdh', '5uim-nb47', 'mjcz-jihd', 'q7w9-tym4', 'meft-5adk', 'th66-84j3', 'cm98-up5c', 'dzsy-x6ad', 'a3cf-zc7n', 'd9ac-b79y',
            'pvft-hrrh', 'gvkd-vxjb', 'nxs3-uv2s', 'd5ah-i6rb', '5c5x-kzhw', '2bv9-i9yd', '4kza-a9ik', 'au6a-ke3h', '5zhp-cxy2', 'k548-qax4', 'abin-nwpu',
            'ksw9-cy2a', '57x9-eb7h', 'fasa-35dd', 'mf65-yzqa', 'js6m-82mq', 'vz24-xvvc', '7x8u-wbk8', 'kg3x-mk7b', '42tn-gm6z', 'uuhb-8p3t', 'bmxa-nmtm',
            'dccx-a8k2', 'yaqj-2z6p', 'vqqm-cx9y', 'izuj-jvsg']  # trovati il 15/11/2026; la ricerca qui sotto aggiunge quelli nuovi


def lombardia_rows():
    """Righe dei dataset "aree di sosta per disabili" dei comuni lombardi (dati.lombardia.it, Socrata), normalizzate:
    dict(ds, comune, toponimo, nome_via, civico, stalli, lat, lon) con lat/lon None se il comune non le ha messe."""
    import re, urllib.parse
    ids = {i: '' for i in LOMB_IDS}
    for q in ('disabili', 'invalidi', 'diversamente', 'handicap'):
        try: res = json.loads(get(f'https://www.dati.lombardia.it/api/search/views.json?q={urllib.parse.quote(q)}&limit=200')).get('results', [])
        except Exception as e: print(f'  ricerca "{q}" non riuscita ({e}), uso l\'elenco noto'); continue
        for x in res:
            v = x['view']
            if v.get('displayType') == 'table' and re.search('sosta|stall|parchegg|posti|aree', v['name'], re.I) and re.search('disab|invalid|divers|handic', v['name'], re.I): ids[v['id']] = v['name']
    bad = lambda x: x is None or not str(x).strip() or re.search(r'obbligatorio|prossimo caricamento|^snc$|^s\.?n\.?c?\.?$', str(x).strip(), re.I)
    for i in ids:
        meta = json.loads(get(f'https://www.dati.lombardia.it/api/views/{i}.json')); name = meta.get('name', '')
        dcom = re.sub(r'(?i)^.*?(comune( di)?|ucl|unione)\s+', '', name); dcom = re.split(r'(?i)\s+(-|sosta|aree|area|mappa)\b', dcom)[0].strip(' #-').title()
        for p in json.loads(get(f'https://www.dati.lombardia.it/resource/{i}.json?$limit=50000')):
            ub = p.get('ubicazione') or ''
            if 'Indirizzo:' in ub or 'Comune:' in ub:
                kv = dict(x.split(':', 1) for x in [y.strip() for y in ub.split(',')] if ':' in x)
                com, top, nv, civ = kv.get('Comune'), '', kv.get('Indirizzo'), kv.get('Civico')
            elif ub.count(',') >= 4:
                u = [x.strip() for x in ub.split(',')]; com, top, nv, civ = u[1], u[3], u[4], u[5] if len(u) > 5 else None
            else:
                com = p.get('comune') or p.get('ubicazione_comune'); top = p.get('toponimo') or p.get('ubicazione_toponimo') or ''
                nv = p.get('indirizzo') or p.get('ubicazione_indirizzo') or (ub or None); civ = p.get('civico') or p.get('ubicazione_civico')
            if bad(nv): continue
            com = (com if not bad(com) else dcom).strip().title()
            try: la, lo = float(p['latitude']), float(p['longitude']); assert 44.6 < la < 46.7 and 8.4 < lo < 11.5
            except Exception: la = lo = None
            st = str(p.get('stalli') or '1').split('.')[0]
            yield dict(ds=i, id=p.get('id_area') or p.get('id'), comune=com, toponimo='' if bad(top) else top, nome_via=nv, civico=None if bad(civ) else str(civ).strip(),
                       stalli=int(st) if st.isdigit() else 1, lat=la, lon=lo)


def lombardia():  # solo le righe con coordinate; quelle con il solo indirizzo le geolocalizza tools/opendata_geocode.py
    for r in lombardia_rows():
        if r['lat'] is None: continue
        yield rec(r['comune'], f'{r["ds"]}:{r["id"]}:{r["lat"]:.6f},{r["lon"]:.6f}', r['lat'], r['lon'], r['stalli'],
                  via(r['toponimo'], r['nome_via'], r['civico']), '', src='lombardia')


def torino():  # stalli generici di maggio 2019 (Monte Mario fuso Ovest, EPSG:3003), in un .7z
    import tempfile, py7zr, shapefile
    tr = _3003(); d = tempfile.mkdtemp()
    py7zr.SevenZipFile(io.BytesIO(get('https://risorse.comune.torino.it/opendata/geodata/StalliDisabiliGenerici.7z'))).extractall(d)
    shp = [os.path.join(d, n) for n in os.listdir(d) if n.endswith('.shp')][0]
    r = shapefile.Reader(shp, encoding='latin-1')
    for sr in r.iterShapeRecords():
        if not sr.shape.points: continue
        x, y = sr.shape.points[0]; lo, la = tr.transform(x, y); f = list(sr.record)
        yield rec('Torino', f[0], la, lo, f[2] if isinstance(f[2], int) and f[2] > 0 else 1, via(f[5], f[6]), (f[4] or '').strip())


def prato():  # posti generici e riservati (a targa); i revocati ("...REV") esclusi
    import csv
    tr = _3003(); txt = get('https://odn.comune.prato.it/dataset/634c11db-1216-4f6a-81eb-7010a1868f2f/resource/08a023f2-b697-491f-b507-c611d4d27afe/download/stalli-di-sosta-diversamente-abili.csv').decode('utf-8', 'replace')
    for p in csv.DictReader(io.StringIO(txt)):
        t = (p.get('TIPOLOGIA') or '').lower()
        if t.endswith('rev'): continue
        try: lo, la = tr.transform(float(p['X_COORD']), float(p['Y_COORD']))
        except ValueError: continue
        yield rec('Prato', p['ID'], la, lo, 1, (p.get('TOPONIMO') or '').strip() or None, (p.get('NOTE') or '').strip(), 'personalizzato' if t == 'riservato' else 'generico')


def matera():
    d = json.loads(get('https://dati.comune.matera.it/dataset/291b73f8-29b6-4178-9427-bced8347f361/resource/a08868ff-1ce7-4588-9b20-d07cb1927b08/download/stalli_diversamente_abili.geojson'))
    for f in d['features']:
        if not f.get('geometry'): continue
        lo, la = f['geometry']['coordinates'][:2]; p = f['properties']
        civ = re.sub(r'(?i)^civ\.?\s*', '', p.get('CIVICO') or '')
        yield rec('Matera', p.get('ID') or f'{la:.6f},{lo:.6f}', la, lo, 1, via('Via', p.get('VIA'), civ) if p.get('VIA') else None, '')


def modena():  # il server di Modena chiude le connessioni da qui: uso lo zip scaricato da Andrea il 15/11/2026 (data/opendata/), dati "fino al 2024"
    import tempfile, shapefile
    tr = _3003(); d = tempfile.mkdtemp()
    zipfile.ZipFile(os.path.join(os.path.dirname(__file__), '..', 'data', 'opendata', 'modena_parcheggi_disabili.zip')).extractall(d)
    r = shapefile.Reader([os.path.join(d, n) for n in os.listdir(d) if n.endswith('.shp')][0])
    for sr in r.iterShapeRecords():
        if not sr.shape.points: continue
        x, y = sr.shape.points[0]; lo, la = tr.transform(x, y); f = sr.record.as_dict()
        yield rec('Modena', int(f['GID']), la, lo, 1, via(f.get('NOME_VIA'), int(f['CIVICO']) if f.get('CIVICO') else None, f.get('ESPONENTE')), '')


def latina():  # risposta del Comune a un accesso civico (novembre 2026): rilievo PUMS in shapefile + ordinanze; già elaborati in data/opendata/
    return json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'opendata', 'latina_accesso_civico_2026.json'), encoding='utf-8'))



def trani():  # risposta del Comune a un accesso civico (novembre 2026): elenco dei cartelli fig. II 79/a con coordinate WGS84; elaborato in data/opendata/
    return json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'opendata', 'trani_accesso_civico_2026.json'), encoding='utf-8'))


def trieste():  # risposta del Comune a un accesso civico (novembre 2026): 665 punti baricentrici degli stalli (EPSG 32633), convertiti in WGS84 in data/opendata/
    return json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'opendata', 'trieste_accesso_civico_2026.json'), encoding='utf-8'))


FONTI = {'bologna': bologna, 'firenze': firenze, 'trento': trento, 'cesena': cesena, 'ferrara': ferrara, 'siena': siena, 'livorno': livorno,
         'verona': verona, 'lombardia': lombardia, 'torino': torino, 'prato': prato, 'matera': matera, 'modena': modena, 'latina': latina, 'trani': trani, 'trieste': trieste}


def sb(method, path, key, body=None, prefer='return=minimal'):
    r = L.richiedi(method, path, key, body, extra={'Prefer': prefer}, timeout=120)[0]; return json.loads(r) if r else None


def sb_all(path, key):
    return L.get(path, key, ordine=None)  # sempre con select=colonne e bbox lato server (vedi main)


def dist(a, b, c, d): return math.hypot((a - c) * 111320, (b - d) * 111320 * math.cos(math.radians(a)))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('comuni', nargs='+', choices=sorted(FONTI)); ap.add_argument('--raggio', type=float, default=15)
    ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']
    for c in a.comuni:
        recs = list({r['osm_id']: r for r in FONTI[c]() if 35.4 < r['lat'] < 47.2 and 6.5 < r['lon'] < 18.6}.values())  # scarto le coordinate vuote (0,0)
        ks = set().union(*recs) if recs else set(); recs = [{k: r.get(k) for k in ks} for r in recs]  # PostgREST vuole le stesse chiavi in ogni riga
        if not recs: print(f'{c}: nessuno stallo'); continue
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
            sb('PATCH', f'/rest/v1/stalli?id=eq.{s["id"]}', key, {'stato': 'rimosso', 'note': f'Accorpato in {u["id"]} ({d:.0f} m, dato ufficiale open data). '})
    print('Fatto.')


if __name__ == '__main__':
    main()
