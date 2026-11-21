#!/usr/bin/env python3
"""Scansiona in fila tutti i comuni del FVG preparati dall'admin (foto/contesto/_elenco_fvg.json).

Ogni comune ha il suo file di avanzamento, quindi se il processo si ferma (limite di tempo, errore) basta rilanciarlo:
riparte dal comune e dal blocco in cui era. Un comune finito viene segnato in /home/claude/scan_fvg_fatti.json.

Più macchine possono lavorare insieme (questo ambiente e GitHub Actions) senza pestarsi i piedi:
  - ogni comune finito lascia un segno su Supabase (modelli/scan/fatti/<slug>.json), letto da tutti;
  - un comune il cui avanzamento su Supabase è stato aggiornato da poco da un'altra macchina viene saltato;
  - --rovescio parte dalla fine dell'alfabeto, --parte k/n prende un comune ogni n (per i lavori in parallelo).

REGOLA (traffico Supabase Free 5 GB/mese): mai scaricare tutti gli stalli, leggere con tools/sbleggero.py (vedi tools/README.md); --no-cache forza la rilettura.
Uso: SUPABASE_SERVICE_KEY=... python3 tools/scan_fvg.py [--primi Trieste,Pordenone] [--auto 0] [--scarta 0] [--solo Trieste]
                                                        [--rovescio] [--parte 0/8] [--minuti 300] [--elenco]
Cartella dei file di avanzamento: variabile DP_STATE (di default /home/claude).
"""
import re
import argparse, datetime, json, os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sbleggero as L  # regola: mai scaricare tutti gli stalli; elenchi di Storage mirati e in cache, contatore dei byte

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
MODELS = 'models/stalli_mobilenetv3_ft_v5.pt,models/stalli_mobilenetv3_ft_v2.pt,models/stalli_mobilenetv3_ft_v4.pt'  # votano
DETECTOR = 'models/stalli_mobilenetv3_ft_v1.pt'  # scorre l'immagine: la v5 come rilevatore propone 10 volte più falsi
STATE = os.environ.get('DP_STATE', '/home/claude')
FATTI = f'{STATE}/scan_fvg_fatti.json'
FRESCO_MIN = 40  # un avanzamento aggiornato da meno di così da un'altra macchina = comune in lavorazione altrove
GIA = {'udine', 'gorizia'}  # già scansionati per intero

ap = argparse.ArgumentParser()
ap.add_argument('--primi', default='Trieste', help='comuni da fare per primi, separati da virgola')
ap.add_argument('--solo', default='', help='fai solo questi comuni (virgola)')
ap.add_argument('--auto', type=int, default=0, help='conferma automatica sopra questa soglia (0 = no)')
ap.add_argument('--scarta', type=int, default=0, help='scarto automatico sotto questa soglia (0 = no)')
ap.add_argument('--rovescio', action='store_true', help="parti dalla fine dell'alfabeto")
ap.add_argument('--parte', default='', help='k/n: prendi solo un comune ogni n, a partire dal k-esimo (lavori in parallelo)')
ap.add_argument('--minuti', type=int, default=0, help='non iniziare nuovi comuni dopo questi minuti (0 = senza limite)')
L.aggiungi_arg(ap)
ap.add_argument('--elenco', action='store_true', help='stampa solo cosa farebbe ed esci')
a = ap.parse_args(); L.usa_arg(a)
KEY = os.environ['SUPABASE_SERVICE_KEY']; T0 = time.time()


def stor(method, path, body=None):
    req = urllib.request.Request(f'{SB}/storage/v1/object/{path}', method=method, data=body,
                                 headers={'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'x-upsert': 'true'})
    return urllib.request.urlopen(req, timeout=60).read()


def _eta_min(o, ora):
    return (ora - datetime.datetime.fromisoformat(o['updated_at'].replace('Z', '+00:00'))).total_seconds() / 60


def remoto():
    """Solo all'avvio: comuni finiti segnati su Supabase (un elenco, ~300 byte per comune)."""
    fin = set()
    try:
        for o in L.lista_storage('modelli', 'scan/fatti/', KEY, limite=2000):
            if o['name'].endswith('.json'): fin.add(o['name'][:-5])
    except Exception as ex: print('  stato condiviso non leggibile:', ex, flush=True)
    return fin, {}


def remoto_uno(slug):
    """(finito?, minuti dall'ultimo avanzamento salvato o None) per UN comune: HEAD + ricerca lato server, niente elenchi da 2000 oggetti."""
    try:
        fin = L.esiste_oggetto(f'modelli/scan/fatti/{slug}.json', KEY); eta = None
        for o in L.lista_storage('modelli', 'scan/', KEY, cerca=f'scan_progress_{slug}', limite=10):
            if o['name'] == f'scan_progress_{slug}.json' and o.get('updated_at'): eta = _eta_min(o, datetime.datetime.now(datetime.timezone.utc))
        return fin, eta
    except Exception as ex: print('  stato condiviso non leggibile:', ex, flush=True); return False, None


def segna(slug):
    try: stor('POST', f'modelli/scan/fatti/{slug}.json', json.dumps({'finito': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'da': os.environ.get('DP_CHI', 'cloud')}).encode())
    except Exception as ex: print(f'  segno di fine non salvato per {slug}:', ex, flush=True)


lst = L.pubblico('foto/contesto/_elenco_fvg.json', nome_cache='elenco_fvg', eta_ore=1, timeout=60)
# un comune è pronto se esiste il suo file di contesto (il flag "pronto" dell'elenco può essere vecchio)
files = {re.sub(r'-\d{12}\.json$', '', o['name']) for o in L.lista_storage('foto', 'contesto/', KEY, limite=2000, nome_cache='contesto_tutti', eta_ore=3) if re.search(r'-\d{12}\.json$', o['name'])}
lst = [c for c in lst if c['slug'] in files]
fatti = set(json.load(open(FATTI))) if os.path.exists(FATTI) else set()
fin_remoti, _ = remoto()
if not a.elenco:
    for slug in sorted(fatti - fin_remoti): segna(slug)  # i comuni finiti qui diventano visibili alle altre macchine
fatti |= fin_remoti
primi = [x.strip().lower() for x in a.primi.split(',') if x.strip()]
solo = [x.strip().lower() for x in a.solo.split(',') if x.strip()]
key = lambda c: (0, primi.index(c['nome'].lower())) if c['nome'].lower() in primi else (1, c['nome'])
todo = [c for c in sorted(lst, key=key) if c['slug'] not in fatti | GIA and (not solo or c['nome'].lower() in solo)]
if a.rovescio: todo.reverse()
if a.parte:
    k, n = map(int, a.parte.split('/')); todo = todo[k::n]
print(f'Comuni pronti {len(lst)} · già fatti {len(fatti | GIA)} · da fare {len(todo)}', flush=True)

if a.elenco:
    print(', '.join(c['nome'] for c in todo)); sys.exit(0)

for c in todo:
    if a.minuti and time.time() - T0 > a.minuti * 60:
        print(f'Tempo a disposizione finito ({a.minuti} min): mi fermo qui, il resto al prossimo lancio.', flush=True); break
    fin_c, eta_c = remoto_uno(c['slug'])
    if fin_c:
        print(f'  {c["nome"]}: già finito da un\'altra macchina, salto', flush=True); fatti.add(c['slug']); continue
    if not os.path.exists(f'{STATE}/scan_progress_{c["slug"]}.json') and (eta_c if eta_c is not None else 1e9) < FRESCO_MIN:
        print(f'  {c["nome"]}: in lavorazione su un\'altra macchina ({eta_c:.0f} min fa), salto', flush=True); continue
    print(f'=== {c["nome"]} ({c["slug"]}) ===', flush=True)
    cmd = [sys.executable, '-I', '-u', 'tools/scan_area.py', MODELS, '--detector', DETECTOR, '--bbox', c['bbox'], '--thr', '0.2', '--context', c['slug'],
           '--label', c['nome'], '--batch', '150', '--progress', f'{STATE}/scan_progress_{c["slug"]}.json']
    if L.NOCACHE: cmd += ['--no-cache']
    if a.auto: cmd += ['--auto', str(a.auto)]
    if a.scarta: cmd += ['--scarta', str(a.scarta)]
    for prova in range(4):  # un errore di rete non deve fermare la macchina: riprovo, il comune riparte dal blocco salvato
        r = subprocess.run(cmd)
        if r.returncode == 0: break
        print(f'  {c["nome"]}: uscito con codice {r.returncode} (tentativo {prova + 1} di 4)', flush=True); time.sleep(60 * (prova + 1))
    if r.returncode != 0:
        print(f'  {c["nome"]}: non riesco a finirlo, passo al prossimo e lo riprendo a un altro lancio', flush=True); continue
    fatti.add(c['slug']); json.dump(sorted(fatti), open(FATTI, 'w')); segna(c['slug'])
    try:  # un pin per zona: accorpo gli stalli entro 30 m anche dopo ogni comune
        sys.path.insert(0, 'tools'); import merge_stalli; merge_stalli.run(KEY, 30.0, bbox=c['bbox'])  # solo il comune appena fatto, mai tutta Italia
    except Exception as ex: print('  accorpamento non riuscito:', ex, flush=True)
    print(f'=== {c["nome"]} finito ===', flush=True)
else: print('Tutti i comuni fatti.', flush=True)
