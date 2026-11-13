#!/usr/bin/env python3
"""Scansiona in fila tutti i comuni del FVG preparati dall'admin (foto/contesto/_elenco_fvg.json).

Ogni comune ha il suo file di avanzamento, quindi se il processo si ferma (limite di tempo, errore) basta rilanciarlo:
riparte dal comune e dal blocco in cui era. Un comune finito viene segnato in /home/claude/scan_fvg_fatti.json.

Uso: SUPABASE_SERVICE_KEY=... python3 tools/scan_fvg.py [--primi Trieste,Pordenone] [--auto 0] [--solo Trieste]
"""
import argparse, json, os, subprocess, sys, urllib.request

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
MODELS = 'models/stalli_mobilenetv3_ft_v1.pt,models/stalli_mobilenetv3_ft_v2.pt,models/stalli_mobilenetv3_ft_v4.pt'
FATTI = '/home/claude/scan_fvg_fatti.json'
GIA = {'udine', 'gorizia'}  # già scansionati per intero

ap = argparse.ArgumentParser()
ap.add_argument('--primi', default='Trieste', help='comuni da fare per primi, separati da virgola')
ap.add_argument('--solo', default='', help='fai solo questi comuni (virgola)')
ap.add_argument('--auto', type=int, default=0, help='conferma automatica sopra questa soglia (0 = no)')
a = ap.parse_args()

lst = json.loads(urllib.request.urlopen(f'{SB}/storage/v1/object/public/foto/contesto/_elenco_fvg.json', timeout=60).read())
lst = [c for c in lst if c.get('pronto')]
fatti = set(json.load(open(FATTI))) if os.path.exists(FATTI) else set()
primi = [x.strip().lower() for x in a.primi.split(',') if x.strip()]
solo = [x.strip().lower() for x in a.solo.split(',') if x.strip()]
key = lambda c: (0, primi.index(c['nome'].lower())) if c['nome'].lower() in primi else (1, c['nome'])
todo = [c for c in sorted(lst, key=key) if c['slug'] not in fatti | GIA and (not solo or c['nome'].lower() in solo)]
print(f'Comuni pronti {len(lst)} · già fatti {len(fatti | GIA)} · da fare {len(todo)}', flush=True)

for c in todo:
    print(f'=== {c["nome"]} ({c["slug"]}) ===', flush=True)
    cmd = [sys.executable, '-I', '-u', 'tools/scan_area.py', MODELS, '--bbox', c['bbox'], '--thr', '0.2', '--context', c['slug'],
           '--label', c['nome'], '--batch', '150', '--progress', f'/home/claude/scan_progress_{c["slug"]}.json']
    if a.auto: cmd += ['--auto', str(a.auto)]
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f'  {c["nome"]}: uscito con codice {r.returncode}, lo riprendo al prossimo lancio', flush=True); sys.exit(r.returncode)
    fatti.add(c['slug']); json.dump(sorted(fatti), open(FATTI, 'w'))
    print(f'=== {c["nome"]} finito ===', flush=True)
print('Tutti i comuni fatti.', flush=True)
