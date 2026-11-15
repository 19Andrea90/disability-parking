#!/usr/bin/env python3
"""Geolocalizza gli stalli open data pubblicati con il solo indirizzo (oggi: comuni lombardi su dati.lombardia.it)
usando i numeri civici e le strade di OpenStreetMap (estratto regionale da download.openstreetmap.fr), senza servizi esterni.

  via + civico trovati su OSM          → stallo 'ufficiale' (nota: posizione dal numero civico, ±20 m)
  solo la via (civico assente/non trovato) → caricato solo con --anche-vie, come 'proposto' (posizione approssimata)
  via non trovata                       → saltato (elencato a fine run)

Uso: SUPABASE_SERVICE_KEY=... python3 tools/opendata_geocode.py [--dry-run]
"""
import argparse, json, math, os, re, sys, unicodedata, urllib.request
import osmium

sys.path.insert(0, os.path.dirname(__file__))
import opendata_import as od  # noqa: E402

DATA = os.path.join(os.path.dirname(__file__), '..', 'data', 'opendata')


def piemonte_rows():
    """CSV del Piemonte (api.smartdatanet.it non raggiungibile da qui): scaricati da Andrea il 15/11/2026 in data/opendata/."""
    import csv
    def split(s):  # "VIA TORINO, 79" -> ("VIA TORINO", "79")
        s = (s or '').strip(); m = re.match(r'^(.*?)[,\s]+(?:FR\.?|FRONTE|INT\.?)?\s*(\d+[A-Z]?(?:[/_ -]\d+)?)\b', s)
        return (m.group(1).strip(' ,'), m.group(2)) if m else (re.split(r'\(| ANG\.? | INT\.? ', s)[0].strip(' ,'), None)
    for p in csv.DictReader(open(os.path.join(DATA, 'nichelino_stalli_generici_2025.csv'), encoding='utf-8', errors='replace'), delimiter=';'):
        if not (p.get('localita') or '').strip() or p.get('datarevoca') or p.get('ordrevocata') or (p.get('rif') or '').strip() == '0': continue
        v, c = split(p['localita']); n = (p.get('rif') or '1').strip()
        yield dict(ds='nichelino-gen', id=p['NumProg'], comune='Nichelino', toponimo='', nome_via=v, civico=c, stalli=int(n) if n.isdigit() and int(n) > 0 else 1, tipo='generico')
    for p in csv.DictReader(open(os.path.join(DATA, 'nichelino_stalli_personali_2025.csv'), encoding='utf-8', errors='replace'), delimiter=';'):
        if (p.get('vigenti') or '').strip() != '1' or not (p.get('IndRich') or '').strip(): continue
        v, c = split(p['IndRich'])
        yield dict(ds='nichelino-pers', id=p['NumAut'], comune='Nichelino', toponimo='', nome_via=v, civico=c, stalli=1, tipo='personalizzato')
    for p in csv.DictReader(open(os.path.join(DATA, 'chieri_stalli_disabili.csv'), encoding='utf-8', errors='replace'), delimiter=';'):
        m = re.match(r'^\s*(.*?)\s*\((.*?)\)\s*$', p.get('Indirizzo') or ''); v = f'{m.group(2)} {m.group(1)}' if m else (p.get('Indirizzo') or '').strip()
        civ = (p.get('Civico') or '').strip() or None; nota = (p.get('Annotazioni') or '').strip()
        g = (p.get('stalligenerici') or '').strip(); pr = (p.get('Stalliprivatipubbl') or '').strip()
        if g.isdigit() and int(g) > 0: yield dict(ds='chieri', id=p['N'] + 'g', comune='Chieri', toponimo='', nome_via=v, civico=civ, stalli=int(g), tipo='generico', nota=nota)
        if (p.get('Stallinumerati') or '').strip(): yield dict(ds='chieri', id=p['N'] + 'n', comune='Chieri', toponimo='', nome_via=v, civico=civ, stalli=1, tipo='personalizzato', nota=nota)
        if pr.isdigit() and int(pr) > 0: yield dict(ds='chieri', id=p['N'] + 'p', comune='Chieri', toponimo='', nome_via=v, civico=civ, stalli=int(pr), tipo='generico', nota=('area privata aperta al pubblico; ' + nota).strip('; '))


REGIONI = {'lombardia': lambda: [r for r in od.lombardia_rows() if r['lat'] is None], 'piemonte': lambda: list(piemonte_rows())}
TIPI = {'via', 'viale', 'piazza', 'piazzale', 'corso', 'largo', 'vicolo', 'strada', 'contrada', 'localita', 'loc', 'p', 'za', 'zza', 'pzza', 'pza', 'le', 'v', 'c', 'so',
        'vle', 'pl', 'p.le', 'piazzetta', 'galleria', 'lungo', 'sp', 'ss', 'provinciale', 'statale', 'comunale', 'vic', 'str', 'ex'}
VUOTE = {'di', 'de', 'del', 'della', 'dei', 'degli', 'delle', 'da', 'e', 'la', 'il', 'lo', 'le', 'gli', 'i', 'san', 's', 'santa', 'santo', 'don', 'beato', 'papa', 'g', 'a', 'f'}


def norm(s):
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9 ]+', ' ', s.replace("'", ' '))


def toks(s):
    return frozenset(t for t in norm(s).split() if t not in TIPI and t not in VUOTE and not t.isdigit() and len(t) > 1)


def num(s):
    m = re.match(r'\s*(\d+)', str(s or '')); return m.group(1) if m else None


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.addr = {}; self.streets = {}; self.places = {}

    def _pt(self, w):
        pts = [(n.location.lat, n.location.lon) for n in w.nodes if n.location.valid()]
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) if pts else None

    def node(self, n):
        t = n.tags
        if 'addr:housenumber' in t and 'addr:street' in t and n.location.valid():
            self.addr.setdefault((toks(t['addr:street']), num(t['addr:housenumber'])), []).append((n.location.lat, n.location.lon))
        if t.get('place') in ('city', 'town', 'village', 'hamlet', 'suburb') and 'name' in t and n.location.valid():
            self.places.setdefault(norm(t['name']).strip(), []).append((n.location.lat, n.location.lon))

    def way(self, w):
        t = w.tags
        try:
            if 'addr:housenumber' in t and 'addr:street' in t:
                p = self._pt(w)
                if p: self.addr.setdefault((toks(t['addr:street']), num(t['addr:housenumber'])), []).append(p)
            if 'highway' in t and 'name' in t:
                p = self._pt(w)
                if p: self.streets.setdefault(toks(t['name']), []).append(p)
        except osmium.InvalidLocationError:
            pass


def dist(a, b): return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('regione', nargs='?', default='lombardia', choices=sorted(REGIONI)); ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--anche-vie', action='store_true', help='carica anche quelli trovati solo sulla via, come proposti (posizione imprecisa)'); a = ap.parse_args(); key = os.environ['SUPABASE_SERVICE_KEY']
    rows = REGIONI[a.regione](); print(f'Righe con il solo indirizzo: {len(rows)}', flush=True)
    PBF = f'/home/claude/osm/{a.regione}.osm.pbf'; URL = f'https://download.openstreetmap.fr/extracts/europe/italy/{a.regione}.osm.pbf'
    if not os.path.exists(PBF): urllib.request.urlretrieve(URL, PBF + '.part'); os.replace(PBF + '.part', PBF)
    h = H(); h.apply_file(PBF, locations=True, idx=f'sparse_file_array,/home/claude/osm/{a.regione}.idx')
    os.remove(f'/home/claude/osm/{a.regione}.idx'); os.remove(PBF)
    print(f'OSM: {len(h.addr)} civici, {len(h.streets)} nomi di via, {len(h.places)} località', flush=True)
    inv_a, inv_s = {}, {}
    for k in h.addr:
        for t in k[0]: inv_a.setdefault(t, []).append(k)
    for k in h.streets:
        for t in k: inv_s.setdefault(t, []).append(k)
    out, miss, n_civ, n_via = [], [], 0, 0
    for r in rows:
        c = h.places.get(norm(r['comune']).strip())
        if not c: miss.append((r['comune'], r['nome_via'], 'comune non trovato')); continue
        cen = c[0]; T = toks(r['nome_via']) or toks(r['toponimo'] + ' ' + r['nome_via'])
        if not T: miss.append((r['comune'], r['nome_via'], 'via vuota')); continue
        def best(cands, R):
            ok = [p for p in cands if dist(p, cen) <= R]; return min(ok, key=lambda p: dist(p, cen)) if ok else None
        def look(table, inv, k2=None):
            hits = []
            for k in inv.get(min(T, key=lambda t: len(inv.get(t, ()))), ()):
                kt = k[0] if k2 is not None else k
                if (k2 is None or k[1] == k2) and kt and (kt == T or (T <= kt and len(kt) - len(T) <= 1)): hits += table[k]
            return hits
        p = None; n = num(r['civico'])
        if n: p = best(look(h.addr, inv_a, n), 6000)
        how = 'civico'
        if not p: p = best(look(h.streets, inv_s), 6000); how = 'via'
        if not p: miss.append((r['comune'], r['nome_via'], 'via non trovata')); continue
        ind = od.via(r['toponimo'], r['nome_via'], r['civico'])
        nota = 'posizione dal numero civico (±20 m)' if how == 'civico' else 'posizione approssimata sulla via: da verificare'
        rec = od.rec(r['comune'], f'{r["ds"]}:{r["id"]}:{norm(ind).replace(" ", "")[:40]}', p[0], p[1], r['stalli'], ind, '; '.join(x for x in (r.get('nota'), nota) if x), r.get('tipo', 'generico'), src=a.regione)
        if how == 'via': rec['stato'] = 'proposto'
        out.append(rec); n_civ += how == 'civico'; n_via += how == 'via'
    print(f'Trovati: {n_civ} dal civico (ufficiali), {n_via} solo sulla via (da verificare), {len(miss)} non trovati', flush=True)
    for m in miss[:40]: print('   ', *m)
    if a.dry_run: return
    recs = list({r['osm_id']: r for r in out if a.anche_vie or r['stato'] != 'proposto'}.values())
    for i in range(0, len(recs), 200): od.sb('POST', '/rest/v1/stalli?on_conflict=osm_id', key, recs[i:i + 200], prefer='resolution=ignore-duplicates,return=minimal')
    print('Caricati.')


if __name__ == '__main__':
    main()
