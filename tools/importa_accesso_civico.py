#!/usr/bin/env python3
"""Carica i dati ricevuti con l'accesso civico (data/opendata/<comune>_accesso_civico_2026.json, chiave 'record').

A differenza di opendata_import.py non accorpa niente: molti di questi posti hanno solo la posizione della via (stato 'proposto',
nota «posizione approssimata»). Un record viene saltato se nello stesso comune c'è già uno stallo non opendata entro ~25 m.
Uso: SUPABASE_SERVICE_KEY=... python3 tools/importa_accesso_civico.py oristano trapani lecco vibovalentia [--dry-run]
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sbleggero as L

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('file', nargs='+'); ap.add_argument('--dry-run', action='store_true'); a = ap.parse_args()
    key = os.environ['SUPABASE_SERVICE_KEY']
    for f in a.file:
        recs = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'data', 'opendata', f'{f}_accesso_civico_2026.json'), encoding='utf-8'))['record']
        com = recs[0]['comune']; pad = 0.003
        S, N = min(r['lat'] for r in recs) - pad, max(r['lat'] for r in recs) + pad; W, E = min(r['lon'] for r in recs) - pad, max(r['lon'] for r in recs) + pad
        act = L.get(f'/rest/v1/stalli?select=id,lat,lon,osm_id,stato&stato=in.(proposto,verificato,ufficiale)&lat=gte.{S}&lat=lte.{N}&lon=gte.{W}&lon=lte.{E}', key, ordine=None)
        altri = [s for s in act if not (s.get('osm_id') or '').startswith('opendata:')]
        nuovi = [r for r in recs if not any(abs(s['lat'] - r['lat']) < 0.0002 and abs(s['lon'] - r['lon']) < 0.00028 for s in altri)]
        print(f'{com}: {len(recs)} record, {len(recs) - len(nuovi)} saltati (stallo già vicino), {len(nuovi)} da inserire ({sum(r["posti"] for r in nuovi)} posti)', flush=True)
        if not a.dry_run:
            for i in range(0, len(nuovi), 200):
                L.richiedi('POST', '/rest/v1/stalli?on_conflict=osm_id', key, nuovi[i:i + 200], extra={'Prefer': 'resolution=ignore-duplicates,return=minimal'}, timeout=120)
    L.resoconto()

if __name__ == '__main__': main()
