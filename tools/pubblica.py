#!/usr/bin/env python3
"""Prepara la cartella da pubblicare (Cloudflare Pages): solo i file che servono al sito, niente dati, modelli, strumenti o SQL.

L'elenco non è scritto a mano: parte da index.html, admin.html, manifest.json, sw.js e dalle pagine di sito/ e segue i
riferimenti reali (src, href, url() nei CSS, icone del manifest, SHELL del service worker). Se un file referenziato manca,
lo script si ferma con un messaggio. I file di partenza non vengono mai spostati: GitHub Pages continua a servire la radice.

Uso: python3 tools/pubblica.py [cartella]      (default: dist; viene ricreata da zero)
"""
import json, os, re, shutil, sys
from urllib.parse import urlsplit, unquote

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USCITA = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'dist')

# Punti di partenza: pagine e file di primo livello. Tutto il resto lo trova seguendo i riferimenti.
PARTENZA = ['index.html', 'sw.js', 'manifest.json', 'admin.html', 'config.js']
CARTELLE_INTERE = ['sito']          # pubblicata per intero (e comunque controllata)
SOLO_FILE_STATICI = ('.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.woff', '.woff2', '.txt', '.webmanifest')
VIETATI = ('.pt', '.onnx', '.sql', '.py', '.md', '.keystore')
AI_BOT = ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'PerplexityBot', 'Bytespider', 'Amazonbot', 'Applebot-Extended']

errori = []
copiati = {}   # percorso relativo (con /) -> percorso assoluto
da_vedere = []

def aggiungi(rel, origine):
    rel = os.path.normpath(rel).replace(os.sep, '/')
    if rel.startswith('..'): errori.append('%s: riferimento fuori dal deposito (%s)' % (origine, rel)); return
    if rel in copiati: return
    p = os.path.join(R, rel)
    if os.path.isdir(p): return
    if not os.path.isfile(p): errori.append('%s: file referenziato mancante: %s' % (origine, rel)); return
    if rel.lower().endswith(VIETATI): errori.append('%s: referenzia un file che non deve essere pubblicato: %s' % (origine, rel)); return
    copiati[rel] = p; da_vedere.append(rel)

def locale(rif):
    """Riferimento -> percorso relativo alla pagina, oppure None se esterno, ancora, mailto, data:..."""
    rif = rif.strip()
    if not rif or rif.startswith(('#', 'data:', 'mailto:', 'tel:', 'javascript:', 'blob:', '//')): return None
    if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', rif): return None
    return unquote(urlsplit(rif).path) or None

def risolvi(base, rif, origine):
    r = locale(rif)
    if r is None: return
    if r.endswith('/') or r == '.': r = r + 'index.html'
    base_dir = os.path.dirname(base)
    rel = r.lstrip('/') if r.startswith('/') else os.path.join(base_dir, r)
    aggiungi(rel, origine)

def riferimenti(rel):
    t = open(os.path.join(R, rel), encoding='utf-8', errors='replace').read()
    e = rel.lower()
    if e.endswith(('.html', '.htm')):
        for m in re.finditer(r'<(?:script|img|source|link|a|iframe|video|audio)\b[^>]*>', t, re.I):
            for a in re.finditer(r'\b(?:src|href|poster)\s*=\s*["\']([^"\']*)["\']', m.group(0), re.I):
                if m.group(0)[:2].lower() == '<a' and not re.search(r'\.(html?|png|jpe?g|svg|pdf|txt)([?#]|$)|/$', a.group(1)): 
                    continue
                risolvi(rel, a.group(1), rel)
        for a in re.finditer(r'url\(\s*["\']?([^)"\']+)["\']?\s*\)', t): risolvi(rel, a.group(1), rel)   # style inline / <style>
    elif e.endswith('.css'):
        for a in re.finditer(r'url\(\s*["\']?([^)"\']+)["\']?\s*\)', t): risolvi(rel, a.group(1), rel)
        for a in re.finditer(r'@import\s+["\']([^"\']+)["\']', t): risolvi(rel, a.group(1), rel)
    elif e == 'manifest.json' or e.endswith('.webmanifest'):
        j = json.loads(t)
        for i in j.get('icons', []) + j.get('screenshots', []): risolvi(rel, i.get('src', ''), rel)
        if j.get('start_url'): risolvi(rel, j['start_url'], rel)
    elif e == 'sw.js':
        m = re.search(r"const W = '([^']*)'", t); w = m.group(1) if m else ''
        s = re.search(r'const SHELL = \[(.*?)\];', t, re.S)
        if not s: errori.append('sw.js: elenco SHELL non trovato'); return
        for a in re.finditer(r"""(W\s*\+\s*)?'([^']*)'""", s.group(1)):
            risolvi(rel, (w if a.group(1) else '') + a.group(2), 'sw.js (SHELL)')

for f in PARTENZA: aggiungi(f, 'punto di partenza')
for c in CARTELLE_INTERE:
    for d, _, fs in os.walk(os.path.join(R, c)):
        for f in sorted(fs):
            rel = os.path.relpath(os.path.join(d, f), R).replace(os.sep, '/')
            if f.lower().endswith(SOLO_FILE_STATICI) and not f.startswith('.'): aggiungi(rel, 'cartella ' + c)
while da_vedere: riferimenti(da_vedere.pop())

# I file caricati a runtime da app.js/admin.js non si vedono leggendo i sorgenti (oggi non ce ne sono di locali: i json arrivano da Supabase)

if errori:
    print('ERRORE: la cartella di pubblicazione NON è stata creata.', file=sys.stderr)
    for e in errori: print('  - ' + e, file=sys.stderr)
    sys.exit(1)

# robots.txt: se esiste già (radice o sito/) si integra, altrimenti si parte da zero
def robots():
    esistente = ''
    for p in ('robots.txt', 'sito/robots.txt'):
        if os.path.isfile(os.path.join(R, p)): esistente = open(os.path.join(R, p), encoding='utf-8').read().rstrip() + '\n'; break
    if not esistente:
        esistente = '# Il sito vetrina (sito/) è indicizzabile; il pannello admin no.\n'
    righe = esistente.splitlines()
    ua = [l.split(':', 1)[1].strip().lower() for l in righe if l.lower().startswith('user-agent:')]
    out = esistente
    if '*' not in ua: out += '\nUser-agent: *\nDisallow: /admin.html\n'
    elif not re.search(r'^disallow:\s*/admin\.html\s*$', esistente, re.I | re.M):
        # aggiunge la regola nel gruppo "*" esistente
        out = re.sub(r'(?im)^(user-agent:\s*\*\s*)$', r'\1\nDisallow: /admin.html', out, count=1)
    for b in AI_BOT:
        if b.lower() not in ua: out += '\n# Crawler per l\'addestramento di modelli AI\nUser-agent: %s\nDisallow: /\n' % b
    return out

HEADERS = """# Intestazioni per Cloudflare Pages (generato da tools/pubblica.py)
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

# L'app si aggiorna da sola solo se pagina e service worker non restano in cache a lungo
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/manifest.json
  Cache-Control: no-cache

# Pannello admin: non da indicizzare
/admin.html
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-cache
"""

if os.path.exists(USCITA):
    if os.path.abspath(USCITA) in (R, os.path.dirname(R), '/') or os.path.exists(os.path.join(USCITA, '.git')): sys.exit('Cartella di uscita non valida: ' + USCITA)
    shutil.rmtree(USCITA)
os.makedirs(USCITA)
tot = 0
print('Copio in %s:' % USCITA)
for rel in sorted(copiati):
    dst = os.path.join(USCITA, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(copiati[rel], dst); n = os.path.getsize(dst); tot += n
    print('  %8.1f KB  %s' % (n / 1024, rel))
for nome, testo in (('_headers', HEADERS), ('robots.txt', robots())):
    with open(os.path.join(USCITA, nome), 'w', encoding='utf-8', newline='\n') as f: f.write(testo)
    n = os.path.getsize(os.path.join(USCITA, nome)); tot += n; print('  %8.1f KB  %s (generato)' % (n / 1024, nome))
print('Totale: %d file, %.2f MB' % (len(copiati) + 2, tot / 1048576))
