#!/usr/bin/env python3
"""Importa gli stalli per disabili da OpenStreetMap (Overpass) nel database Supabase.

Uso:
  SUPABASE_SERVICE_KEY=... python3 import_osm.py [--area "Udine" --area "Gorizia"] [--dry-run]

Non richiede librerie esterne. Gli oggetti OSM già presenti (stessa osm_id) vengono aggiornati, non duplicati.
"""
import argparse, json, os, sys, time, urllib.request, urllib.parse

SUPABASE_URL = 'https://wwereqrojlwktgwlrsib.supabase.co'
OVERPASS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter']

# Aree: nome comune OSM (admin_level 8) -> usato nel campo "comune"
DEFAULT_AREAS = ['Udine', 'Gorizia', 'Tavagnacco']

def overpass(query):
    body = urllib.parse.urlencode({'data': query}).encode()
    last = None
    for url in OVERPASS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=body, headers={'User-Agent': 'disability-parking-import/0.1'})
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.load(r)
            except Exception as e:
                last = e; print(f'  {url}: {e}', file=sys.stderr); time.sleep(3)
    raise SystemExit(f'Overpass non raggiungibile: {last}')

def query_for(area):
    return f"""[out:json][timeout:180];
area["name"="{area}"]["boundary"="administrative"]["admin_level"~"^(8|6)$"]->.a;
(
  nwr["amenity"="parking_space"]["parking_space"="disabled"](area.a);
  nwr["amenity"="parking_space"]["disabled"~"^(yes|designated)$"](area.a);
  nwr["amenity"="parking"]["capacity:disabled"](area.a);
  nwr["amenity"="parking"]["disabled"~"^(yes|designated)$"](area.a);
);
out center tags;"""

def to_int(v):
    try: return int(str(v).strip())
    except: return None

def convert(el, comune):
    t = el.get('tags', {})
    lat = el.get('lat') or el.get('center', {}).get('lat'); lon = el.get('lon') or el.get('center', {}).get('lon')
    if lat is None: return None
    cap_dis = to_int(t.get('capacity:disabled'))
    if t.get('amenity') == 'parking':
        if t.get('capacity:disabled') is not None and not (cap_dis and cap_dis > 0): return None  # capacity:disabled=0/no
        posti = cap_dis or 1
        nome = t.get('name') or 'Parcheggio con posti riservati'
        note = 'Area di parcheggio: i posti riservati sono all\'interno.'
    else:
        posti = cap_dis or to_int(t.get('capacity')) or 1
        nome = t.get('name'); note = None
    # tipo: OSM non distingue bene i personalizzati; se c'è un riferimento a un contrassegno lo consideriamo personalizzato
    tipo = 'generico'
    desc = ' '.join(str(t.get(k, '')) for k in ('description', 'note', 'access:note', 'ref')).lower()
    if any(k in desc for k in ('contrassegno', 'personalizz', 'nominativ', 'ad personam')): tipo = 'personalizzato'
    orari = t.get('opening_hours') or t.get('access:conditional')
    return {
        'osm_id': f"{el['type']}/{el['id']}", 'lat': lat, 'lon': lon, 'tipo': tipo, 'posti': max(1, posti), 'nome': nome,
        'indirizzo': ' '.join(filter(None, [t.get('addr:street'), t.get('addr:housenumber')])) or None,
        'comune': comune, 'note': note or t.get('description') or t.get('note'), 'orari': orari,
        'segnale_verticale': True if t.get('traffic_sign') else None,
        'coperto': t.get('covered') == 'yes' or t.get('parking') in ('multi-storey', 'underground'),
        'stato': 'verificato', 'fonte': 'osm', 'osm_url': f"https://www.openstreetmap.org/{el['type']}/{el['id']}",
    }

def upsert(rows, key, dry):
    if dry: print(json.dumps(rows[:3], indent=1, ensure_ascii=False)); return
    url = f'{SUPABASE_URL}/rest/v1/stalli?on_conflict=osm_id'
    for i in range(0, len(rows), 200):
        chunk = json.dumps(rows[i:i+200]).encode()
        req = urllib.request.Request(url, data=chunk, method='POST', headers={
            'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal'})
        with urllib.request.urlopen(req, timeout=60) as r:
            if r.status >= 300: raise SystemExit(f'Supabase {r.status}: {r.read()[:300]}')
        print(f'  caricati {min(i+200, len(rows))}/{len(rows)}')

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--area', action='append'); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    key = os.environ.get('SUPABASE_SERVICE_KEY')
    if not key and not a.dry_run: raise SystemExit('Imposta SUPABASE_SERVICE_KEY')
    total = 0
    for area in (a.area or DEFAULT_AREAS):
        print(f'[{area}] interrogo Overpass…')
        data = overpass(query_for(area))
        rows = [r for r in (convert(el, area) for el in data.get('elements', [])) if r]
        print(f'[{area}] {len(rows)} stalli trovati')
        if rows: upsert(rows, key, a.dry_run)
        total += len(rows); time.sleep(2)
    print(f'Fatto: {total} stalli importati/aggiornati.')

if __name__ == '__main__': main()
