#!/usr/bin/env python3
"""Versione web = la stessa app del telefono. Genera index.html (radice del sito) da mobile/www/index.html.

Le pagine di GitHub servono il deposito così com'è: la radice carica direttamente i file di mobile/www, senza copie.
Va rieseguito a ogni modifica di mobile/www (lo fa da solo l'aggancio pre-commit, vedi tools/web.py --aggancio).

Uso: python3 tools/web.py            rigenera index.html e aggiorna la versione nel service worker
     python3 tools/web.py --aggancio installa l'aggancio git che lo esegue prima di ogni commit
"""
import hashlib, os, re, stat, sys

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = os.path.join(R, 'mobile', 'www')
FILES = ['vendor/maplibre-gl.css', 'app.css', 'vendor/maplibre-gl.js', 'chiavi.js', 'app.js']

if '--aggancio' in sys.argv:
    p = os.path.join(R, '.git', 'hooks', 'pre-commit')
    open(p, 'w').write('#!/bin/sh\npython3 -I "$(git rev-parse --show-toplevel)/tools/web.py" && git add index.html sw.js\n')
    os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC); print('Aggancio installato:', p); sys.exit(0)

h = hashlib.sha1()
for f in FILES + ['index.html']: h.update(open(os.path.join(W, f), 'rb').read())
v = h.hexdigest()[:8]
s = open(os.path.join(W, 'index.html'), encoding='utf-8').read()
for f in FILES:
    n = len(re.findall(r'(href|src)="%s"' % re.escape(f), s)); assert n == 1, (f, n)
    s = re.sub(r'(href|src)="%s"' % re.escape(f), r'\1="mobile/www/%s?v=%s"' % (f, v), s)
testa = '''<meta name="description" content="Tutti i posti riservati d'Italia, in una mappa: trova il parcheggio per persone con disabilità più vicino e fatti portare lì.">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
'''
assert s.count('<title>') == 1
s = s.replace('<title>', testa + '<title>')
coda = "<script>window.DP_VERSIONE = window.DP_VERSIONE || 'web %s'; if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});</script>\n</body>" % v
assert s.count('</body>') == 1
s = s.replace('</body>', coda)
s = s.replace('<!doctype html>', '<!doctype html>\n<!-- GENERATO da tools/web.py a partire da mobile/www/index.html: non modificare a mano -->', 1)
out = os.path.join(R, 'index.html')
if not os.path.exists(out) or open(out, encoding='utf-8').read() != s: open(out, 'w', encoding='utf-8').write(s); print('index.html rigenerato', v)
sw = os.path.join(R, 'sw.js'); t = open(sw, encoding='utf-8').read()
t2 = re.sub(r"const WEB = '[^']*';", "const WEB = '%s';" % v, t)
if t2 != t: open(sw, 'w', encoding='utf-8').write(t2)
