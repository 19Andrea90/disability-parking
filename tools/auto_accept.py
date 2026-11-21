#!/usr/bin/env python3
"""Conferma in automatico i candidati della rete con punteggio molto alto (creati come stalli 'verificato').

Gli stalli creati così hanno nelle note il marcatore AUTO, quindi si possono ritrovare e annullare in blocco:
  python3 auto_accept.py --undo     (rimette i candidati a 'nuovo' e marca gli stalli come 'rimosso')

Uso: SUPABASE_SERVICE_KEY=... python3 auto_accept.py [--min 98] [--dry-run]
     python3 auto_accept.py --scarta-sotto 30 [--dry-run]   (scarta i candidati con punteggio basso; --undo-scarto li rimette a 'nuovo')
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
import urllib.parse
from scan_area import sb, sb_all
import sbleggero as L  # regola: mai scaricare tutti gli stalli/candidati, filtri lato server

AUTO = 'Confermato in automatico dalla rete'
SCARTO = 'scartato in automatico'  # marcatore aggiunto alla classe dei candidati scartati sotto soglia (non usati per l'addestramento)


def _fc(comune):
    """Filtro lato server sul comune (prima si scaricavano i candidati di tutta Italia a ogni blocco di scansione)."""
    return f"&comune=eq.{urllib.parse.quote(comune, safe='')}" if comune else ''


def run(key, min_score=98, dry=False, log=print, comune=None):
    rows = sb_all('/rest/v1/candidati?select=id,classe,lat,lon,comune&fonte=eq.satellite&stato=eq.nuovo&classe=like.*media%20di*' + _fc(comune) + '&order=id', key)
    if comune: rows = [c for c in rows if c.get('comune') == comune]  # solo il comune appena scansionato
    todo = []
    for c in rows:
        m = re.search(r'media di \d+\) · punteggio (\d+)%', c['classe'] or '')
        if m and int(m.group(1)) >= min_score: todo.append((int(m.group(1)), c))
    n = linked = 0
    import math
    near_r = 30.0  # entro 30 m da uno stallo attivo non ne creo un altro: collego il candidato a quello (un pin per zona)
    act = []
    if todo:  # solo gli stalli attivi attorno ai candidati da confermare (bbox + margine di 0,001° ≈ 100 m), non tutta Italia
        la_, lo_ = [c['lat'] for _, c in todo], [c['lon'] for _, c in todo]
        act = sb_all(f'/rest/v1/stalli?select=id,lat,lon,tipo&stato=in.(proposto,verificato,ufficiale)&tipo=neq.personalizzato&lat=gte.{min(la_) - .001}&lat=lte.{max(la_) + .001}&lon=gte.{min(lo_) - .001}&lon=lte.{max(lo_) + .001}&order=id', key)
    def nearest(la, lo):
        best = None
        for x in act:
            d = math.hypot((x['lat'] - la) * 111320, (x['lon'] - lo) * 111320 * math.cos(math.radians(la)))
            if d <= near_r and (best is None or d < best[0]): best = (d, x)
        return best
    for s, c in todo:
        if dry: n += 1; continue
        nb = nearest(c['lat'], c['lon'])
        if nb:
            sb('PATCH', f"/rest/v1/candidati?id=eq.{c['id']}", key, {'stato': 'accettato', 'stallo_id': nb[1]['id']}, extra={'Prefer': 'return=minimal'})
            linked += 1; continue
        st = sb('POST', '/rest/v1/stalli', key, {'lat': c['lat'], 'lon': c['lon'], 'tipo': 'generico', 'posti': 1, 'comune': c['comune'], 'stato': 'verificato',
                                                  'fonte': 'satellite', 'note': f'{AUTO} (punteggio {s}%)'}, extra={'Prefer': 'return=representation'})
        sb('PATCH', f"/rest/v1/candidati?id=eq.{c['id']}", key, {'stato': 'accettato', 'stallo_id': st[0]['id']}, extra={'Prefer': 'return=minimal'})
        act.append({'id': st[0]['id'], 'lat': c['lat'], 'lon': c['lon'], 'tipo': 'generico'})
        n += 1
    log(f'  conferma automatica (≥{min_score}%): {n} stalli {"da creare" if dry else "creati"}' + (f', {linked} collegati a uno stallo già presenti entro 30 m' if linked else ''))
    return n


def reject_low(key, max_score=30, dry=False, log=print, comune=None):
    """Scarta (in modo reversibile) i candidati 'nuovo' della rete con punteggio sotto max_score."""
    rows = sb_all('/rest/v1/candidati?select=id,classe,comune&fonte=eq.satellite&stato=eq.nuovo&classe=like.*media%20di*' + _fc(comune) + '&order=id', key)
    if comune: rows = [c for c in rows if c.get('comune') == comune]
    n = 0
    for c in rows:
        m = re.search(r'media di \d+\) · punteggio (\d+)%', c['classe'] or '')
        if not m or int(m.group(1)) >= max_score: continue
        n += 1
        if not dry:
            sb('PATCH', f"/rest/v1/candidati?id=eq.{c['id']}", key, {'stato': 'scartato', 'classe': f"{c['classe']} · {SCARTO} (<{max_score}%)"}, extra={'Prefer': 'return=minimal'})
    if n: log(f'  scarto automatico (<{max_score}%): {n} candidati {"da scartare" if dry else "scartati"}')
    return n


def undo_low(key):
    rows = sb_all(f"/rest/v1/candidati?select=id,classe&stato=eq.scartato&classe=like.*{SCARTO.replace(' ', '%20')}*&order=id", key)
    for c in rows:
        sb('PATCH', f"/rest/v1/candidati?id=eq.{c['id']}", key, {'stato': 'nuovo', 'classe': re.sub(r' · ' + SCARTO + r' \(<\d+%\)', '', c['classe'])}, extra={'Prefer': 'return=minimal'})
    print(f'ripristinati {len(rows)} candidati scartati in automatico')


def undo(key):
    st = sb_all(f"/rest/v1/stalli?select=id&note=like.{AUTO.replace(' ', '%20')}*&stato=eq.verificato&order=id", key)
    for r in st:
        sb('PATCH', f"/rest/v1/stalli?id=eq.{r['id']}", key, {'stato': 'rimosso'}, extra={'Prefer': 'return=minimal'})
        sb('PATCH', f"/rest/v1/candidati?stallo_id=eq.{r['id']}", key, {'stato': 'nuovo', 'stallo_id': None}, extra={'Prefer': 'return=minimal'})
    print(f'annullati {len(st)} stalli automatici')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--min', type=int, default=98); ap.add_argument('--dry-run', action='store_true'); ap.add_argument('--undo', action='store_true'); ap.add_argument('--scarta-sotto', type=int, default=0); ap.add_argument('--undo-scarto', action='store_true')
    a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']
    if a.undo: undo(key)
    elif a.undo_scarto: undo_low(key)
    elif a.scarta_sotto: reject_low(key, a.scarta_sotto, a.dry_run)
    else: run(key, a.min, a.dry_run)
