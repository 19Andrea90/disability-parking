#!/usr/bin/env python3
"""Prepara la cartella da pubblicare (Cloudflare Pages): solo i file che servono al sito, niente dati, modelli, strumenti o SQL.

L'elenco non è scritto a mano: parte da index.html, admin.html, manifest.json, sw.js e dalle pagine di sito/ e segue i
riferimenti reali (src, href, url() nei CSS, icone del manifest, SHELL del service worker). Se un file referenziato manca,
lo script si ferma con un messaggio. I file di partenza non vengono mai spostati: GitHub Pages continua a servire la radice.

Due disposizioni della cartella di uscita (i sorgenti nel deposito non cambiano mai):
  attuale  (default) come il deposito: radice = web app, sito/ = vetrina, admin.html = pannello admin (GitHub Pages).
  dominio  per https://sostabile.it/: radice = sito vetrina, app/ = web app, admin/ = pannello admin (admin/index.html).
           I collegamenti tra le parti si riscrivono con SOSTITUZIONI_DOMINIO (sotto); se una non trova riscontro, errore.

File di copertura: a ogni build scarica UNA volta (URL pubblico, nessuna chiave) il riepilogo dei totali per regione/provincia/comune
da Supabase Storage e lo pubblica come file statico accanto all'app (dominio: app/copertura.json; attuale: copertura.json), così l'app
non lo scarica da Supabase a ogni avvio (vedi app.js, COPERTURA_STATICA). Se il download fallisce la build NON si rompe: il file manca
e l'app usa la riserva su Supabase. Chi aggiorna il file su Supabase è tools/copertura.py (a mano, nessun workflow): dopo ogni
aggiornamento della copertura serve una nuova pubblicazione del sito (nuovo deploy Cloudflare Pages) per aggiornare la copia.
Per le prove si può cambiare l'indirizzo con la variabile d'ambiente COPERTURA_URL (anche file:///percorso), o disattivare il download con COPERTURA_URL=-.

Uso: python3 tools/pubblica.py [cartella] [--disposizione attuale|dominio]      (default: dist; viene ricreata da zero)
"""
import argparse, json, os, re, shutil, sys, urllib.request
from urllib.parse import urlsplit, unquote

_ap = argparse.ArgumentParser(description='Prepara la cartella da pubblicare su Cloudflare Pages.')
_ap.add_argument('cartella', nargs='?', default='dist')
_ap.add_argument('--disposizione', choices=('attuale', 'dominio'), default='attuale')
_args = _ap.parse_args()
DOMINIO = _args.disposizione == 'dominio'
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USCITA = os.path.abspath(_args.cartella)

# Collegamenti tra le parti che nella disposizione "dominio" cambiano. Ogni voce: (file sorgente, testo atteso, sostituto, quante volte).
# Se il testo non compare esattamente quel numero di volte, lo script si ferma: vuol dire che un sorgente è cambiato.
# Tutto il resto (manifest start_url/scope, registrazione del service worker, ritorno dell'accesso Google, CFG.SITO) funziona
# già in entrambe le disposizioni perché usa percorsi relativi o l'indirizzo della pagina corrente.
SITO_DOM = 'https://sostabile.it/'
def _canon(pagina): return '<link rel="canonical" href="%s%s">\n<link rel="icon" href="icona.png">' % (SITO_DOM, pagina)
SOSTITUZIONI_DOMINIO = [
    # sito -> app: "../" (la radice del deposito) diventa app/
    ('sito/index.html', 'href="../">Apri la versione web', 'href="app/">Apri la versione web', 1),
    ('sito/index.html', 'href="../">Versione web', 'href="app/">Versione web', 1),
    # sito: og:image assoluta e canonical sul dominio
    ('sito/index.html', '<meta property="og:image" content="https://19andrea90.github.io/disability-parking/sito/icona.png">',
     '<meta property="og:image" content="%sicona.png">\n<meta property="og:url" content="%s">\n<link rel="canonical" href="%s">' % (SITO_DOM, SITO_DOM, SITO_DOM), 1),
    ('sito/privacy.html', '<link rel="icon" href="icona.png">', _canon('privacy.html'), 1),
    ('sito/fonti.html', '<link rel="icon" href="icona.png">', _canon('fonti.html'), 1),
    ('sito/condizioni.html', '<link rel="icon" href="icona.png">', _canon('condizioni.html'), 1),
    ('sito/novita.html', '<link rel="icon" href="icona.png">', _canon('novita.html'), 1),
    # admin -> app: l'admin sta in admin/ e riusa foglio di stile e icona della web app in ../app/
    ('admin.html', 'href="index.html">← App', 'href="../app/">← App', 1),
    ('admin.html', '<link rel="stylesheet" href="app.css">', '<link rel="stylesheet" href="../app/app.css">', 1),
    ('admin.html', '<link rel="icon" href="icons/icon-192.png">', '<link rel="icon" href="../app/icons/icon-192.png">', 1),
    # service worker dell'app (ambito /app/): admin.html, admin.js e config.js non stanno sotto app/, addAll() fallirebbe
    ('sw.js', "'./admin.html', ", '', 1),
    ('sw.js', "'./admin.js', ", '', 1),
    ('sw.js', "'./config.js', ", '', 1),
]
# Percorsi (nel deposito) che nella disposizione "dominio" vanno in admin/ e in radice; tutto il resto va in app/.
ADMIN_FILE = {'admin.html': 'admin/index.html', 'admin.js': 'admin/admin.js', 'config.js': 'admin/config.js'}
# Unico file pubblicato in cui l'indirizzo github.io può restare (costante SITO_ANDROID, finché il dominio non è attivo).
RESIDUO_GITHUB_OK = {'app/mobile/www/app.js'}

# Punti di partenza: pagine e file di primo livello. Tutto il resto lo trova seguendo i riferimenti.
PARTENZA = ['index.html', 'sw.js', 'manifest.json', 'admin.html', 'config.js']
CARTELLE_INTERE = ['sito', 'poi']   # pubblicate per intero (e comunque controllate); poi/ = punti d'interesse OSM a tasselli (tools/poi_osm.py), caricati a runtime dall'app
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
    if DOMINIO:
        out = "# Il sito vetrina (radice) e l'app sono indicizzabili; il pannello admin no.\nUser-agent: *\nDisallow: /admin/\nDisallow: /admin\n"
        for b in AI_BOT: out += "\n# Crawler per l'addestramento di modelli AI\nUser-agent: %s\nDisallow: /\n" % b
        return out
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

# Copia statica del riepilogo di copertura: cambia solo a ogni nuova pubblicazione
/copertura.json
  Cache-Control: public, max-age=3600

# Pannello admin: non da indicizzare
/admin.html
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-cache

# Punti d'interesse OpenStreetMap a tasselli: l'app Android (altra origine) li scarica da qui; l'indice si rilegge sempre, i tasselli hanno la versione nell'indirizzo
/poi/*
  Access-Control-Allow-Origin: *
/poi/meta.json
  Cache-Control: no-cache
"""

HEADERS_DOMINIO = """# Intestazioni per Cloudflare Pages, disposizione "dominio" (generato da tools/pubblica.py)
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

# L'app si aggiorna da sola solo se pagina e service worker non restano in cache a lungo
/app/
  Cache-Control: no-cache
/app/index.html
  Cache-Control: no-cache
/app/sw.js
  Cache-Control: no-cache
/app/manifest.json
  Cache-Control: no-cache

# Copia statica del riepilogo di copertura: cambia solo a ogni nuova pubblicazione
/app/copertura.json
  Cache-Control: public, max-age=3600

# Pannello admin: non da indicizzare
/admin/
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-cache
/admin/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-cache

# Punti d'interesse OpenStreetMap a tasselli: l'app Android (altra origine) li scarica da qui; l'indice si rilegge sempre, i tasselli hanno la versione nell'indirizzo
/app/poi/*
  Access-Control-Allow-Origin: *
/app/poi/meta.json
  Cache-Control: no-cache
"""
# Cloudflare Pages: vecchi indirizzi (GitHub Pages) -> nuovi. La vecchia web app in radice non serve più (la radice è la vetrina).
REDIRECTS_DOMINIO = """# Generato da tools/pubblica.py (disposizione "dominio")
/sito /  301
/sito/* /:splat 301
/admin.html /admin/ 301
"""

def scarica_copertura():
    """Scarica il riepilogo di copertura (file pubblico di Supabase Storage). Ritorna il testo, o None se non riesce (la build continua)."""
    url = os.environ.get('COPERTURA_URL')
    if url == '-': print('Copertura: download disattivato (COPERTURA_URL=-)'); return None
    if not url:
        m = re.search(r"SB: '(https://[^']+)'", open(os.path.join(R, 'mobile', 'www', 'app.js'), encoding='utf-8').read())
        if not m: print('ATTENZIONE: indirizzo Supabase non trovato in app.js, copertura.json non incluso (l\'app usa la riserva)'); return None
        url = m.group(1) + '/storage/v1/object/public/foto/copertura/riepilogo.json'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'sostabile-build'}), timeout=30) as r: testo = r.read().decode('utf-8')
        if not json.loads(testo).get('regioni'): raise ValueError('manca "regioni"')
        return json.dumps(json.loads(testo), ensure_ascii=False, separators=(',', ':'))   # compatto
    except Exception as e:
        print('ATTENZIONE: copertura.json non scaricato (%s): la build continua, l\'app userà la riserva su Supabase' % e); return None

def sostituzioni(rel, testo):
    """Applica a un file le voci di SOSTITUZIONI_DOMINIO che lo riguardano, verificando i conteggi."""
    for f, vecchio, nuovo, n in SOSTITUZIONI_DOMINIO:
        if f != rel: continue
        c = testo.count(vecchio)
        if c != n: errori.append('sostituzione "dominio" in %s: attese %d occorrenze di %r, trovate %d' % (rel, n, vecchio, c)); continue
        testo = testo.replace(vecchio, nuovo)
    return testo

def destinazione(rel):
    if not DOMINIO: return rel
    if rel in ADMIN_FILE: return ADMIN_FILE[rel]
    if rel.startswith('sito/'): return rel[len('sito/'):]
    return 'app/' + rel

def verifica_dominio(radice):
    """Controlla la cartella finita: riferimenti locali esistenti, SHELL del service worker, nessun github.io fuori dal consentito."""
    ko = []
    for d, _, fs in os.walk(radice):
        for f in fs:
            ab = os.path.join(d, f); rel = os.path.relpath(ab, radice).replace(os.sep, '/')
            if not rel.lower().endswith(('.html', '.css', '.js', '.json', '.txt')) and rel not in ('_headers', '_redirects'): continue
            t = open(ab, encoding='utf-8', errors='replace').read()
            if '19andrea90.github.io' in t and rel not in RESIDUO_GITHUB_OK: ko.append('%s: contiene ancora un indirizzo github.io' % rel)
            rifs = []
            if rel.endswith('.html'):
                for m in re.finditer(r'<(?:script|img|source|link|a|iframe)\b[^>]*>', t, re.I):
                    for a in re.finditer(r'\b(?:src|href)\s*=\s*["\']([^"\']*)["\']', m.group(0), re.I):
                        if m.group(0)[:2].lower() == '<a' and not re.search(r'\.(html?|png|jpe?g|svg|pdf|txt)([?#]|$)|/$', a.group(1)): continue
                        rifs.append(a.group(1))
            if rel.endswith(('.html', '.css')): rifs += [a.group(1) for a in re.finditer(r'url\(\s*["\']?([^)"\']+)["\']?\s*\)', t)]
            if rel.endswith('sw.js'):
                m = re.search(r"const W = '([^']*)'", t); w = m.group(1) if m else ''
                sh = re.search(r'const SHELL = \[(.*?)\];', t, re.S)
                rifs += [(w if a.group(1) else '') + a.group(2) for a in re.finditer(r"""(W\s*\+\s*)?'([^']*)'""", sh.group(1))] if sh else []
            if rel.endswith('manifest.json'):
                j = json.loads(t); rifs += [i.get('src', '') for i in j.get('icons', [])] + [j.get('start_url', '')]
            for r in rifs:
                l = locale(r)
                if l is None: continue
                if l.endswith('/') or l == '.': l += 'index.html'
                dst = l.lstrip('/') if l.startswith('/') else os.path.normpath(os.path.join(os.path.dirname(rel), l)).replace(os.sep, '/')
                if dst.startswith('..') or not os.path.isfile(os.path.join(radice, dst)): ko.append('%s: riferimento che non porta a un file: %s' % (rel, r))
    return ko

if os.path.exists(USCITA):
    if os.path.abspath(USCITA) in (R, os.path.dirname(R), '/') or os.path.exists(os.path.join(USCITA, '.git')): sys.exit('Cartella di uscita non valida: ' + USCITA)
    shutil.rmtree(USCITA)
os.makedirs(USCITA)
tot = 0
print('Copio in %s:' % USCITA)
altri = [('_headers', HEADERS_DOMINIO if DOMINIO else HEADERS), ('robots.txt', robots())] + ([('_redirects', REDIRECTS_DOMINIO)] if DOMINIO else [])
_cop = scarica_copertura()
if _cop: altri.append(('app/copertura.json' if DOMINIO else 'copertura.json', _cop))
for rel in sorted(copiati):
    dst = os.path.join(USCITA, destinazione(rel)); os.makedirs(os.path.dirname(dst), exist_ok=True)
    if DOMINIO and rel.lower().endswith(('.html', '.js', '.json')):
        t = open(copiati[rel], encoding='utf-8').read(); t2 = sostituzioni(rel, t)
        with open(dst, 'w', encoding='utf-8', newline='') as f: f.write(t2)
    else: shutil.copyfile(copiati[rel], dst)
    n = os.path.getsize(dst); tot += n
    print('  %8.1f KB  %s' % (n / 1024, destinazione(rel) if DOMINIO else rel))
if DOMINIO:
    for f in {f for f, _, _, _ in SOSTITUZIONI_DOMINIO}:
        if f not in copiati: errori.append('sostituzione "dominio": il file %s non è tra quelli pubblicati' % f)
for nome, testo in altri:
    os.makedirs(os.path.dirname(os.path.join(USCITA, nome)), exist_ok=True)
    with open(os.path.join(USCITA, nome), 'w', encoding='utf-8', newline='\n') as f: f.write(testo)
    n = os.path.getsize(os.path.join(USCITA, nome)); tot += n; print('  %8.1f KB  %s (generato)' % (n / 1024, nome))
if DOMINIO:
    errori.extend(verifica_dominio(USCITA))
    if errori:
        shutil.rmtree(USCITA)
        print('ERRORE: la cartella di pubblicazione NON è stata creata.', file=sys.stderr)
        for e in errori: print('  - ' + e, file=sys.stderr)
        sys.exit(1)
print('Totale: %d file, %.2f MB' % (len(copiati) + len(altri), tot / 1048576))
