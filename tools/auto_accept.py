#!/usr/bin/env python3
"""Conferma in automatico i candidati della rete con punteggio molto alto (creati come stalli 'verificato').

Gli stalli creati così hanno nelle note il marcatore AUTO, quindi si possono ritrovare e annullare in blocco:
  python3 auto_accept.py --undo     (rimette i candidati a 'nuovo' e marca gli stalli come 'rimosso')

Uso: SUPABASE_SERVICE_KEY=... python3 auto_accept.py [--min 98] [--dry-run]
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from scan_area import sb, sb_all

AUTO = 'Confermato in automatico dalla rete'


def run(key, min_score=98, dry=False, log=print):
    rows = sb_all('/rest/v1/candidati?select=id,classe,lat,lon,comune&fonte=eq.satellite&stato=eq.nuovo&order=id', key)
    todo = []
    for c in rows:
        m = re.search(r'media di \d+\) · punteggio (\d+)%', c['classe'] or '')
        if m and int(m.group(1)) >= min_score: todo.append((int(m.group(1)), c))
    n = 0
    for s, c in todo:
        if dry: n += 1; continue
        st = sb('POST', '/rest/v1/stalli', key, {'lat': c['lat'], 'lon': c['lon'], 'tipo': 'generico', 'posti': 1, 'comune': c['comune'], 'stato': 'verificato',
                                                  'fonte': 'satellite', 'note': f'{AUTO} (punteggio {s}%)'}, extra={'Prefer': 'return=representation'})
        sb('PATCH', f"/rest/v1/candidati?id=eq.{c['id']}", key, {'stato': 'accettato', 'stallo_id': st[0]['id']}, extra={'Prefer': 'return=minimal'})
        n += 1
    log(f'  conferma automatica (≥{min_score}%): {n} stalli {"da creare" if dry else "creati"}')
    return n


def undo(key):
    st = sb_all(f"/rest/v1/stalli?select=id&note=like.{AUTO.replace(' ', '%20')}*&stato=eq.verificato&order=id", key)
    for r in st:
        sb('PATCH', f"/rest/v1/stalli?id=eq.{r['id']}", key, {'stato': 'rimosso'}, extra={'Prefer': 'return=minimal'})
        sb('PATCH', f"/rest/v1/candidati?stallo_id=eq.{r['id']}", key, {'stato': 'nuovo', 'stallo_id': None}, extra={'Prefer': 'return=minimal'})
    print(f'annullati {len(st)} stalli automatici')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--min', type=int, default=98); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--undo', action='store_true')
    a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']
    undo(key) if a.undo else run(key, a.min, a.dry_run)
