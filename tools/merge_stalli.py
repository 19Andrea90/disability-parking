#!/usr/bin/env python3
"""Accorpa gli stalli attivi vicini: entro RAGGIO metri ne resta uno solo (un pin = "qui c'è uno o più posti riservati").

Regole:
- si accorpano solo stalli della stessa famiglia: i "personalizzati" (riservati a una targa) restano a parte
  dai generici/sconosciuti, perché sono informazioni diverse;
- raggruppamento a partire dallo stallo più affidabile (ufficiale > verificato a mano > verificato in automatico > proposto,
  a parità il più vecchio): prende tutti quelli entro RAGGIO metri da lui, poi si ripete con i rimasti
  (niente "catene": una fila lunga 100 m diventa più pin, non uno solo);
- si tiene la posizione dello stallo scelto (è un punto reale, utile per navigare);
- gli altri passano a stato 'rimosso' con la nota "Accorpato in <id>" (reversibile), e i candidati che puntavano a loro
  vengono collegati allo stallo tenuto.

Uso: SUPABASE_SERVICE_KEY=... python3 tools/merge_stalli.py [--raggio 30] [--dry-run] [--comune Trieste]
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from scan_area import sb, sb_all

ACC = 'Accorpato in '


def famiglia(s): return 'personalizzato' if s['tipo'] == 'personalizzato' else 'generico'


def rank(s):
    auto = (s.get('note') or '').startswith('Confermato in automatico')
    r = {'ufficiale': 4, 'verificato': 2 if auto else 3, 'proposto': 1}.get(s['stato'], 0)
    return (-r, s.get('created_at') or '')


def dist(a, b):
    return math.hypot((a['lat'] - b['lat']) * 111320, (a['lon'] - b['lon']) * 111320 * math.cos(math.radians(a['lat'])))


def run(key, raggio=30.0, dry=False, comune=None, log=print, bbox=None):
    """bbox 'S,W,N,E': accorpa solo dentro quel rettangolo (la scansione passa quello del comune appena fatto)."""
    q = '/rest/v1/stalli?select=id,lat,lon,tipo,stato,note,created_at,comune&stato=in.(proposto,verificato,ufficiale)&order=id'
    if bbox:
        S, W, N, E = map(float, bbox.split(',')); q += f'&lat=gte.{S}&lat=lte.{N}&lon=gte.{W}&lon=lte.{E}'
    st = sb_all(q, key)
    if comune: st = [s for s in st if (s.get('comune') or '').lower() == comune.lower()]
    merges = []  # (tenuto, [assorbiti])
    for fam in ('generico', 'personalizzato'):
        rest = sorted([s for s in st if famiglia(s) == fam], key=rank)
        # griglia per cercare i vicini in fretta (celle di ~raggio)
        cell = lambda s: (int(s['lat'] * 111320 // raggio), int(s['lon'] * 111320 * math.cos(math.radians(46)) // raggio))
        grid = {}
        for s in rest: grid.setdefault(cell(s), []).append(s)
        used = set()
        for s in rest:
            if s['id'] in used: continue
            used.add(s['id']); cy, cx = cell(s); grp = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for t in grid.get((cy + dy, cx + dx), []):
                        if t['id'] not in used and dist(s, t) <= raggio: grp.append(t)
            for t in grp: used.add(t['id'])
            if grp: merges.append((s, grp))
    n = sum(len(g) for _, g in merges)
    log(f'  accorpamento entro {raggio:.0f} m: {len(st)} stalli attivi → {len(st) - n} ({len(merges)} gruppi, {n} assorbiti){" [simulazione]" if dry else ""}')
    if dry: return merges
    for keep, grp in merges:
        ids = ','.join(t['id'] for t in grp)
        sb('PATCH', f'/rest/v1/candidati?stallo_id=in.({ids})', key, {'stallo_id': keep['id']}, extra={'Prefer': 'return=minimal'})
        for t in grp:
            sb('PATCH', f"/rest/v1/stalli?id=eq.{t['id']}", key,
               {'stato': 'rimosso', 'note': f"{ACC}{keep['id']} ({dist(keep, t):.0f} m). " + (t.get('note') or '')}, extra={'Prefer': 'return=minimal'})
    return merges


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--raggio', type=float, default=30); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--comune'); ap.add_argument('--bbox', help='S,W,N,E')
    a = ap.parse_args(); run(os.environ['SUPABASE_SERVICE_KEY'], a.raggio, a.dry_run, a.comune, bbox=a.bbox)
