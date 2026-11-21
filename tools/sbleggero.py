#!/usr/bin/env python3
"""sbleggero: letture "leggere" da Supabase (piano Free: 5 GB/mese di traffico in uscita, sforato il 15-17/11/2026).

REGOLA: mai scaricare tutti gli stalli (né tutti i candidati). Gli script di servizio leggono da qui:
  - get()        GET paginato con le sole colonne necessarie (select=...), cache su disco facoltativa;
  - conteggio()  numero di righe senza scaricarle (HEAD + Prefer: count=exact);
  - esistono()   controllo mirato (colonna=in.(...)) invece di scaricare l'elenco;
  - rpc()        funzione SQL del database (supabase/21_aggregazioni_servizio.sql): il database aggrega e arriva solo il risultato;
  - pubblico() / lista_storage()  file e liste di Storage con cache su disco e ricerca lato server;
  - a fine esecuzione stampa "Traffico Supabase di questa esecuzione: X MB".

Cache: cartella ~/.cache/sostabile (o DP_CACHE), validità 6 ore (SB_CACHE_ORE). Si salta con --no-cache
(aggiungi_arg / usa_arg) oppure con la variabile SB_NOCACHE=1. In GitHub Actions la cartella si conserva con actions/cache.
Se serve una lettura che non deve MAI essere vecchia (es. prima di scrivere), non usare cache=True: i filtri
lato server (bbox, comune, stato, osm_id=in.(...)) tengono comunque il traffico minimo.
"""
import atexit, gzip, hashlib, json, os, re, time, urllib.error, urllib.parse, urllib.request

SB = os.environ.get('SB_URL', 'https://wwereqrojlwktgwlrsib.supabase.co')
CACHE_DIR = os.environ.get('DP_CACHE') or os.path.join(os.path.expanduser('~'), '.cache', 'sostabile')
ETA_ORE = float(os.environ.get('SB_CACHE_ORE', '6'))
NOCACHE = bool(os.environ.get('SB_NOCACHE'))
_t = {'byte': 0, 'rich': 0, 'cache': 0}


def aggiungi_arg(ap):
    """Aggiunge --no-cache a un argparse."""
    ap.add_argument('--no-cache', action='store_true', help='ignora la cache locale delle letture Supabase (cartella ~/.cache/sostabile)')


def usa_arg(a):
    global NOCACHE
    if getattr(a, 'no_cache', False): NOCACHE = True


def conta(n):
    _t['byte'] += n


def resoconto():
    if _t['rich'] or _t['cache']:
        print(f"Traffico Supabase di questa esecuzione: {_t['byte'] / 1e6:.3f} MB ({_t['rich']} richieste, {_t['cache']} letture dalla cache)", flush=True)


atexit.register(resoconto)


def _url(path):
    if path.startswith('http'): return path
    if path.startswith('/'): return SB + path
    return f'{SB}/rest/v1/{path}'


def richiedi(method, path, key, body=None, ctype='application/json', extra=None, timeout=60, testa=False):
    """Richiesta a Supabase che conta i byte ricevuti (sul filo, compressi se possibile). Ritorna (corpo, intestazioni)."""
    h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Accept-Encoding': 'gzip'}
    if body is not None: h['Content-Type'] = ctype
    if extra: h.update(extra)
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(_url(path), data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(); hd = r.headers
    _t['rich'] += 1; _t['byte'] += len(raw)
    if hd.get('Content-Encoding') == 'gzip': raw = gzip.decompress(raw)
    return raw, hd


def _cache_path(nome):
    return os.path.join(CACHE_DIR, re.sub(r'[^A-Za-z0-9._-]', '_', nome)[:150] + '.json')


def cache_leggi(nome, eta_ore=None):
    """Contenuto in cache se più recente di eta_ore (ore), altrimenti None."""
    if NOCACHE: return None
    p = _cache_path(nome)
    try:
        if time.time() - os.path.getmtime(p) > (ETA_ORE if eta_ore is None else eta_ore) * 3600: return None
        d = json.load(open(p)); _t['cache'] += 1; return d
    except Exception: return None


def cache_scrivi(nome, dati):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True); p = _cache_path(nome); tmp = p + '.tmp'
        json.dump(dati, open(tmp, 'w')); os.replace(tmp, p)
    except Exception: pass


def _con_colonne(path, cols):
    if not cols: return path
    path = re.sub(r'([?&])select=[^&]*&?', r'\1', path).rstrip('?&')
    return path + ('&' if '?' in path else '?') + 'select=' + cols


def get(path, key, cols=None, page=1000, cache=False, eta_ore=None, ordine='id'):
    """GET paginato (max 1000 righe per richiesta). path: 'stalli?stato=eq.verificato&lat=gte.46' oppure '/rest/v1/...'.
    cols: colonne da scaricare ('id,lat,lon'); senza cols e senza select= scarica tutto (da evitare).
    cache=True: riusa il risultato di un'esecuzione precedente se più recente di eta_ore (default 6 h)."""
    path = _con_colonne(path, cols)
    if 'select=*' in path or 'select=' not in path: print(f'  ATTENZIONE sbleggero: lettura senza colonne scelte ({path[:80]})', flush=True)
    nome = 'get-' + hashlib.sha1(path.encode()).hexdigest()[:20]
    if cache:
        c = cache_leggi(nome, eta_ore)
        if c is not None: return c
    q = re.sub(r'[&?](limit|offset)=\d+', '', path)
    if ordine and 'order=' not in q: q += ('&' if '?' in q else '?') + f'order={ordine}'
    out = []
    while True:
        raw, _ = richiedi('GET', f'{q}&limit={page}&offset={len(out)}', key, timeout=120); b = json.loads(raw); out += b
        if len(b) < page: break
    if cache: cache_scrivi(nome, out)
    return out


def conteggio(path, key):
    """Numero di righe che corrispondono (nessuna riga scaricata)."""
    p = re.sub(r'[&?](select|limit|offset|order)=[^&]*', '', path)
    p += ('&' if '?' in p else '?') + 'select=id&limit=0'
    _, hd = richiedi('HEAD', p, key, extra={'Prefer': 'count=exact'})
    return int((hd.get('content-range') or '*/0').split('/')[-1])


class FunzioneAssente(Exception):
    """La funzione SQL non esiste (ancora) nel database: va eseguito il file .sql che la crea."""


def rpc(nome, args, key, cache=False, eta_ore=None, timeout=180):
    """Chiama public.<nome>(args) con POST /rest/v1/rpc/<nome> (chiave service per le funzioni 21_aggregazioni_servizio.sql).
    I byte ricevuti entrano nel contatore. Argomenti None vengono omessi (valgono i default della funzione).
    Se la funzione non esiste solleva FunzioneAssente: chi chiama ricade sul vecchio metodo con un avviso."""
    corpo = json.dumps({k: v for k, v in args.items() if v is not None}, separators=(',', ':'), sort_keys=True)
    nome_c = f'rpc-{nome}-' + hashlib.sha1(corpo.encode()).hexdigest()[:20]
    if cache:
        c = cache_leggi(nome_c, eta_ore)
        if c is not None: return c
    try: raw, _ = richiedi('POST', f'/rest/v1/rpc/{nome}', key, corpo.encode(), timeout=timeout)
    except urllib.error.HTTPError as e:
        raw = e.read()
        if raw[:2] == b'\x1f\x8b': raw = gzip.decompress(raw)  # anche il corpo degli errori arriva compresso
        det = raw.decode('utf-8', 'replace')
        if e.code == 404 and ('PGRST202' in det or 'find the function' in det): raise FunzioneAssente(nome) from None
        raise RuntimeError(f'rpc {nome}: HTTP {e.code} {det[:300]}') from None
    d = json.loads(raw)
    if cache: cache_scrivi(nome_c, d)
    return d


def esistono(tabella, colonna, valori, key, cols=None, extra_filtri='', blocco=80):
    """Righe con colonna in (valori), cercate a blocchi: per controlli di esistenza/duplicati (es. osm_id) senza scaricare l'elenco."""
    valori = [str(v) for v in valori]; out = []
    for i in range(0, len(valori), blocco):
        lista = ','.join('"' + v.replace('"', '') + '"' for v in valori[i:i + blocco])
        enc = urllib.parse.quote(lista, safe=',():"')
        q = f'{tabella}?{colonna}=in.({enc}){extra_filtri}'
        out += get(q, key, cols=cols or f'id,{colonna}', ordine=None)
    return out


def pubblico(percorso, nome_cache=None, eta_ore=None, timeout=120, json_=True):
    """File pubblico di Storage (percorso tipo 'foto/contesto/x.json'). Con nome_cache viene riusato dal disco
    (se il nome del file contiene già una data/versione, eta_ore=1e6 lo tiene per sempre)."""
    if nome_cache:
        c = cache_leggi('pub-' + nome_cache, eta_ore)
        if c is not None: return c
    req = urllib.request.Request(f'{SB}/storage/v1/object/public/{percorso}', headers={'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=timeout) as r: raw = r.read(); hd = r.headers
    _t['rich'] += 1; _t['byte'] += len(raw)
    if hd.get('Content-Encoding') == 'gzip': raw = gzip.decompress(raw)
    d = json.loads(raw) if json_ else raw
    if nome_cache and json_: cache_scrivi('pub-' + nome_cache, d)
    return d


def lista_storage(bucket, prefisso, key, cerca='', limite=1000, nome_cache=None, eta_ore=None):
    """Elenco oggetti di Storage; 'cerca' filtra lato server PER PREFISSO del nome (ogni oggetto elencato pesa ~300 byte: non chiedere 2000 righe per vederne 3)."""
    if nome_cache:
        c = cache_leggi('lst-' + nome_cache, eta_ore)
        if c is not None: return c
    body = {'prefix': prefisso, 'limit': limite, 'sortBy': {'column': 'name', 'order': 'asc'}}
    if cerca: body['search'] = cerca
    raw, _ = richiedi('POST', f'/storage/v1/object/list/{bucket}', key, body)
    d = json.loads(raw)
    if nome_cache: cache_scrivi('lst-' + nome_cache, d)
    return d


def esiste_oggetto(percorso, key):
    """HEAD su un oggetto privato di Storage (es. 'modelli/scan/fatti/udine.json'): niente corpo scaricato."""
    try: richiedi('HEAD', f'/storage/v1/object/authenticated/{percorso}', key); return True
    except urllib.error.HTTPError as e:
        if e.code in (400, 404): return False
        raise
