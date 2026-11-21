#!/usr/bin/env python3
"""Importa in Supabase gli stalli per disabili mappati su OpenStreetMap, regione per regione, per tutta Italia.

Scarica l'estratto regionale da download.openstreetmap.fr (Overpass e Geofabrik non sono raggiungibili da qui),
lo legge in due passate a bassa memoria (niente indice delle posizioni, così può girare accanto alla scansione FVG),
converte gli elementi come fa l'admin (osmConvert in admin.js) e li carica con upsert su osm_id
(quelli già presenti non vengono toccati). Il file .pbf viene cancellato a fine regione.

Uso: SUPABASE_SERVICE_KEY=... python3 tools/osm_import_italia.py [--regioni veneto,lombardia] [--dry-run]
Le regioni finite vengono segnate in /home/claude/osm_import_fatte.json.

Traffico Supabase: questo script NON scarica l'elenco degli stalli. La deduplica la fa il database (upsert su osm_id con
ignore-duplicates e risposta minima: dal database non torna nulla) e le righe OSM si contano con una HEAD (count=exact, nessun
corpo) tramite sbleggero, che le somma nel resoconto finale. Per questo non serve nessuna funzione SQL (vedi 21_aggregazioni_servizio.sql).
"""
import argparse, json, os, re, time, urllib.request
import osmium
import sys
sys.path.insert(0, os.path.dirname(__file__))
import sbleggero as L  # noqa: E402

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
BASE = 'https://download.openstreetmap.fr/extracts/europe/italy/'
REGIONI = ['valle_aosta', 'molise', 'basilicata', 'umbria', 'trentino_alto_adige', 'liguria', 'marche', 'abruzzo', 'friuli_venezia_giulia',
           'calabria', 'sardegna', 'puglia', 'campania', 'sicilia', 'toscana', 'lazio', 'emilia_romagna', 'piemonte', 'veneto', 'lombardia']
NOMI = {'valle_aosta': "Valle d'Aosta", 'trentino_alto_adige': 'Trentino-Alto Adige', 'friuli_venezia_giulia': 'Friuli Venezia Giulia', 'emilia_romagna': 'Emilia-Romagna'}
FATTE = '/home/claude/osm_import_fatte.json'
DIR = '/home/claude/osm'


def is_disabled(t):
    """Schema del progetto OSM Italia aprile 2026: amenity=parking + capacity:disabled (numero o yes)
    oppure parking_space=disabled (anche senza amenity=parking_space, errore frequente)."""
    a = t.get('amenity')
    if t.get('parking_space') == 'disabled': return True
    if a == 'parking_space': return t.get('disabled') in ('yes', 'designated', 'private')
    if a == 'parking':
        cd = (t.get('capacity:disabled') or '').strip().lower()
        if cd: return cd == 'yes' or (cd.split(';')[0].isdigit() and int(cd.split(';')[0]) > 0)
        return t.get('disabled') in ('yes', 'designated')
    return False


def toint(x):
    try: return int(str(x).strip())
    except Exception: return None


def convert(kind, oid, lat, lon, t):  # come osmConvert in admin.js
    cap = toint(t.get('capacity:disabled'))
    if t.get('amenity') == 'parking':
        posti = cap or 1; nome = t.get('name') or 'Parcheggio con posti riservati'; note = "Area di parcheggio: i posti riservati sono all'interno."
    else:
        posti = cap or toint(t.get('capacity')) or 1; nome = t.get('name'); note = t.get('description') or t.get('note')
    desc = ' '.join(str(t.get(k, '')) for k in ('description', 'note', 'access:note', 'ref')).lower()
    tipo = 'personalizzato' if t.get('disabled') == 'private' or re.search(r'contrassegno|personalizz|nominativ|ad personam', desc) else 'generico'
    ind = ' '.join(x for x in (t.get('addr:street'), t.get('addr:housenumber')) if x) or None
    return dict(osm_id=f'{kind}/{oid}', lat=round(lat, 7), lon=round(lon, 7), tipo=tipo, posti=max(1, posti), nome=nome, indirizzo=ind,
                comune=t.get('addr:city') or t.get('is_in:city'), note=note, orari=t.get('opening_hours') or t.get('access:conditional'),
                segnale_verticale=True if t.get('traffic_sign') else None, coperto=t.get('covered') == 'yes' or t.get('parking') in ('multi-storey', 'underground'),
                stato='verificato', fonte='osm', osm_url=f'https://www.openstreetmap.org/{kind}/{oid}')


class P1(osmium.SimpleHandler):  # nodi disabili + vie disabili (con i riferimenti ai nodi)
    def __init__(self): super().__init__(); self.recs = []; self.ways = []; self.need = set()
    def node(self, n):
        if n.tags and is_disabled(n.tags) and n.location.valid():
            self.recs.append(convert('node', n.id, n.location.lat, n.location.lon, dict(n.tags)))
    def way(self, w):
        if is_disabled(w.tags):
            refs = [n.ref for n in w.nodes]; self.ways.append((w.id, refs, dict(w.tags))); self.need.update(refs)


class P2(osmium.SimpleHandler):  # posizioni dei soli nodi che servono
    def __init__(self, need): super().__init__(); self.need = need; self.loc = {}
    def node(self, n):
        if n.id in self.need and n.location.valid(): self.loc[n.id] = (n.location.lat, n.location.lon)


def upsert(recs, key):
    for i in range(0, len(recs), 200):
        req = urllib.request.Request(f'{SB}/rest/v1/stalli?on_conflict=osm_id', data=json.dumps(recs[i:i + 200]).encode(), method='POST',
                                     headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                                              'Prefer': 'resolution=ignore-duplicates,return=minimal'})
        urllib.request.urlopen(req, timeout=120).read()


def count_osm(key):  # HEAD con count=exact: nessuna riga scaricata
    return L.conteggio('stalli?fonte=eq.osm', key)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--regioni', default=''); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    key = os.environ['SUPABASE_SERVICE_KEY']; os.makedirs(DIR, exist_ok=True)
    fatte = set(json.load(open(FATTE))) if os.path.exists(FATTE) else set()
    todo = [r for r in (a.regioni.split(',') if a.regioni else REGIONI) if r not in fatte]
    print(f'Regioni da fare: {len(todo)} · stalli OSM già in mappa: {count_osm(key)}', flush=True)
    for r in todo:
        t0 = time.time(); pbf = f'{DIR}/{r}.osm.pbf'
        if not os.path.exists(pbf) or os.path.getsize(pbf) < 1000:
            tmp = pbf + '.part'; urllib.request.urlretrieve(BASE + r + '.osm.pbf', tmp); os.replace(tmp, pbf)
        mb = os.path.getsize(pbf) / 1e6
        p1 = P1(); p1.apply_file(pbf); p2 = P2(p1.need); p2.apply_file(pbf); recs = p1.recs
        for wid, refs, tags in p1.ways:
            pts = [p2.loc[x] for x in refs if x in p2.loc]
            if pts: recs.append(convert('way', wid, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), tags))
        before = count_osm(key)
        if not a.dry_run: upsert(recs, key)
        after = count_osm(key) if not a.dry_run else before
        print(f'{NOMI.get(r, r.capitalize())}: {len(recs)} stalli su OSM · nuovi in mappa {after - before} · {mb:.0f} MB · {time.time() - t0:.0f} s', flush=True)
        if not a.dry_run:
            fatte.add(r); json.dump(sorted(fatte), open(FATTE, 'w'))
            if r != 'trentino_alto_adige': os.remove(pbf)
    print(f'Fatto. Stalli OSM in mappa: {count_osm(key)}', flush=True)


if __name__ == '__main__':
    main()
