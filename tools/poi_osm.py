#!/usr/bin/env python3
"""Punti d'interesse da OpenStreetMap -> file statici a tasselli, serviti dal sito (nessun servizio esterno a pagamento).

Alimenta "Cerca un luogo vicino a te" dell'app (ospedali, stazioni, uffici pubblici, farmacie, supermercati, scuole): l'app scarica
solo i tasselli attorno al punto cercato e ordina per distanza.

Entrata : un estratto OpenStreetMap .osm.pbf (es. https://download.geofabrik.de/europe/italy-latest.osm.pbf).
Uscita  : una cartella (default poi/, che tools/pubblica.py pubblica come app/poi/ nella disposizione "dominio") con
            meta.json            versione (data dell'estratto), griglia, elenco dei tasselli non vuoti, totali, attribuzione ODbL
            <iy>_<ix>.json       un tassello: {"ospedali": [[lat, lon, "nome"], ...], "farmacie": [...], ...}
          iy = floor(lat * D), ix = floor(lon * D) con D = tasselli per grado (in meta.json, "d"); coordinate a 5 decimali.
          Un punto senza nome ha "" come nome: l'app mostra l'etichetta della categoria.

Dipendenze: pip install osmium   (pyosmium >= 4)
Uso: python3 -I tools/poi_osm.py ESTRATTO.osm.pbf [CARTELLA_USCITA] [--d 4] [--data AAAA-MM-GG]
Le categorie (chiavi) sono le stesse di CATEGORIE in mobile/www/app.js: se ne aggiungi una, aggiungila in entrambi.
Dati © OpenStreetMap contributors, licenza ODbL (https://www.openstreetmap.org/copyright).
"""
import argparse, collections, datetime, glob, json, math, os, sys, time
import osmium

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# categoria -> etichetta del singolo luogo (usata dall'app quando manca il nome)
CATEGORIE = collections.OrderedDict([
    ('ospedali', 'Ospedale'), ('stazioni', 'Stazione'), ('uffici', 'Ufficio pubblico'),
    ('farmacie', 'Farmacia'), ('supermercati', 'Supermercato'), ('scuole', 'Scuola'),
])
# coppie chiave=valore che interessano (il filtro C++ di osmium scarta subito tutto il resto)
COPPIE = [('amenity', 'hospital'), ('railway', 'station'), ('railway', 'halt'), ('public_transport', 'station'),
          ('amenity', 'townhall'), ('office', 'government'), ('amenity', 'post_office'), ('amenity', 'pharmacy'),
          ('shop', 'supermarket'), ('amenity', 'school'), ('amenity', 'university'), ('amenity', 'college')]


def categoria(t):
    """Tag di un oggetto -> chiave di categoria (o None)."""
    for k in ('disused', 'abandoned', 'demolished', 'construction', 'proposed'):  # luoghi non più in funzione
        if t.get(k) == 'yes': return None
    if 'disused:amenity' in t or 'disused:shop' in t: return None
    a = t.get('amenity')
    if a == 'hospital': return 'ospedali'
    if a == 'pharmacy': return 'farmacie'
    if a in ('townhall', 'post_office') or t.get('office') == 'government': return 'uffici'
    if a in ('school', 'university', 'college'): return 'scuole'
    if t.get('shop') == 'supermarket': return 'supermercati'
    r = t.get('railway')
    if r in ('station', 'halt') or (t.get('public_transport') == 'station' and t.get('train') == 'yes'): return 'stazioni'
    return None


def nome_di(tags):
    return (tags.get('name') or tags.get('official_name') or tags.get('short_name') or '').strip()


def raccogli(pbf):
    """Tre letture dell'estratto, senza indice delle coordinate di tutti i nodi (in memoria non starebbe): 1) i contorni (way) che
    interessano e i loro nodi; 2) i nodi con tag che interessano; 3) le coordinate dei soli nodi dei contorni. Il filtro è in C++ (veloce)."""
    punti = []; scartati = collections.Counter(); vie = []; servono = set()
    for w in osmium.FileProcessor(pbf, osmium.osm.WAY).with_filter(osmium.filter.TagFilter(*COPPIE)):
        c = categoria(w.tags)
        if not c: continue
        rifs = [n.ref for n in w.nodes]
        if not rifs: scartati['way senza nodi'] += 1; continue
        vie.append((c, nome_di(w.tags), rifs)); servono.update(rifs)
    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.TagFilter(*COPPIE)):
        c = categoria(n.tags)
        if not c: continue
        if not n.location.valid(): scartati['nodo senza coordinate'] += 1; continue
        punti.append((c, round(n.location.lat, 5), round(n.location.lon, 5), nome_di(n.tags)))
    loc = {}
    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(servono)):
        if n.location.valid(): loc[n.id] = (n.location.lat, n.location.lon)
    for c, nome, rifs in vie:
        ll = [loc[r] for r in rifs if r in loc]
        if not ll: scartati['way senza coordinate'] += 1; continue
        la = [x[0] for x in ll]; lo = [x[1] for x in ll]
        punti.append((c, round((min(la) + max(la)) / 2, 5), round((min(lo) + max(lo)) / 2, 5), nome))   # centro del riquadro del contorno
    ok = [p for p in punti if -90 <= p[1] <= 90 and -180 <= p[2] <= 180]
    if len(ok) != len(punti): scartati['coordinate non valide'] += len(punti) - len(ok)
    return ok, scartati


def metri(la1, lo1, la2, lo2):
    k = 111320.0; return math.hypot((la2 - la1) * k, (lo2 - lo1) * k * math.cos(math.radians((la1 + la2) / 2)))


def senza_doppioni(punti):
    """Nodo e contorno dello stesso edificio, o due inserimenti vicini: se ne tiene uno solo. Stessa categoria e (stesso nome entro 400 m
    oppure qualunque entro 40 m). Prima i punti con nome, così si tiene quello."""
    punti = sorted(punti, key=lambda p: (p[0], p[3] == '', p[3], p[1], p[2]))
    celle = collections.defaultdict(list); out = []; doppi = 0
    for p in punti:
        c, la, lo, nome = p; ix, iy = int(lo / 0.006), int(la / 0.006); n = nome.casefold(); dup = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in celle[(c, ix + dx, iy + dy)]:
                    d = metri(la, lo, q[1], q[2])
                    if d < 40 or (n and n == q[3].casefold() and d < 400): dup = True; break
                if dup: break
            if dup: break
        if dup: doppi += 1; continue
        celle[(c, ix, iy)].append(p); out.append(p)
    return out, doppi


def data_estratto(percorso):
    try:
        with osmium.io.Reader(percorso, osmium.osm.osm_entity_bits.NOTHING) as r:
            t = r.header().get('osmosis_replication_timestamp')
            if t: return t[:10]
    except Exception: pass
    return datetime.date.fromtimestamp(os.path.getmtime(percorso)).isoformat()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('pbf'); ap.add_argument('uscita', nargs='?', default=os.path.join(R, 'poi'))
    ap.add_argument('--d', type=int, default=4, help='tasselli per grado (4 = 0,25 gradi)'); ap.add_argument('--data', help="data dell'estratto AAAA-MM-GG (default: dall'intestazione del file)")
    a = ap.parse_args()
    data = a.data or data_estratto(a.pbf); t0 = time.time()
    grezzi, scartati = raccogli(a.pbf)
    print('letti %d oggetti in %.0f s' % (len(grezzi), time.time() - t0))
    punti, doppi = senza_doppioni(grezzi)
    print('doppioni tolti: %d; scartati: %s' % (doppi, dict(scartati) or '-'))
    tasselli = collections.defaultdict(lambda: collections.defaultdict(list)); totali = collections.Counter(); senza_nome = collections.Counter()
    for c, la, lo, nome in sorted(punti, key=lambda p: (p[1], p[2], p[3])):
        tasselli['%d_%d' % (math.floor(la * a.d), math.floor(lo * a.d))][c].append([la, lo, nome]); totali[c] += 1
        if not nome: senza_nome[c] += 1
    os.makedirs(a.uscita, exist_ok=True)
    for f in glob.glob(os.path.join(a.uscita, '*.json')): os.remove(f)   # via i tasselli vecchi: l'uscita è sempre quella nuova, intera
    dim = []
    for k in sorted(tasselli):
        txt = json.dumps({c: tasselli[k][c] for c in CATEGORIE if tasselli[k][c]}, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(a.uscita, k + '.json'), 'w', encoding='utf-8', newline='\n') as f: f.write(txt)
        dim.append(len(txt.encode('utf-8')))
    meta = {'v': data, 'estratto': data, 'd': a.d, 'categorie': {c: {'n': totali[c], 'senza_nome': senza_nome[c]} for c in CATEGORIE},
            'attribuzione': '© OpenStreetMap contributors', 'licenza': 'ODbL 1.0 - https://www.openstreetmap.org/copyright',
            'tasselli': sorted(tasselli)}
    with open(os.path.join(a.uscita, 'meta.json'), 'w', encoding='utf-8', newline='\n') as f: f.write(json.dumps(meta, ensure_ascii=False, separators=(',', ':')))
    print('punti per categoria: ' + ', '.join('%s %d' % (c, totali[c]) for c in CATEGORIE) + ' (totale %d)' % sum(totali.values()))
    print('file: %d tasselli + meta.json; %.2f MB; tassello più grande %.0f KB, medio %.1f KB' % (len(dim), (sum(dim) + os.path.getsize(os.path.join(a.uscita, 'meta.json'))) / 1048576, max(dim) / 1024, sum(dim) / len(dim) / 1024))


if __name__ == '__main__': main()
