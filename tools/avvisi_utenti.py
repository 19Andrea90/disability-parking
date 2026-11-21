#!/usr/bin/env python3
"""Avvisi via email agli utenti di SostAbile (una volta al giorno, .github/workflows/avvisi-utenti.yml).

Due avvisi, entrambi a scelta dell'utente nell'app (dati in auth user_metadata):
  1. Scadenza del contrassegno: user_metadata.avvisi.email_scadenza = true. Un'email quando mancano i giorni scelti
     (user_metadata.dp.profilo.giorni, la stessa scelta della notifica sul telefono) e una il giorno prima della scadenza
     (user_metadata.dp.profilo.scadenza, formato AAAA-MM-GG).
  2. Nuovi posti vicino a Casa e Lavoro: user_metadata.avvisi.nuovi_vicino = true. Un'email riassuntiva con gli stalli attivi
     (verificato/ufficiale) aggiunti o approvati dall'ultimo invio, entro 500 m da Casa o Lavoro (user_metadata.dp.luoghi).
     Le ricerche le fa il database con public.stalli_nuovi_vicino (supabase/22_avvisi_utenti.sql): non si scaricano gli stalli.

Registro degli invii: user_metadata.avvisi_inviati (scritto SOLO da questo script con l'API admin di GoTrue; è una chiave a parte
perché l'app riscrive user_metadata.avvisi quando l'utente cambia un interruttore e il registro andrebbe perso):
  {"scadenza:2027-02-14:60": "2026-12-16", "scadenza:2027-02-14:1": "2027-02-13", "vicino": "2026-11-21T06:21:00+00:00"}
  "vicino" = fino a quando i posti nuovi sono già stati coperti (ISO UTC).

Limite Resend (100 email al giorno sul piano gratuito): al massimo --max-invii (80) per esecuzione. Le scadenze hanno la precedenza;
chi resta fuori viene rimandato al giorno dopo (lo si scrive nel log).

Uso:  python3 tools/avvisi_utenti.py --dry-run     non invia e non scrive nulla: stampa destinatari mascherati e oggetti
      python3 tools/avvisi_utenti.py               invio vero
      --mock FILE.json    utenti e stalli finti (sempre dry-run, niente rete)   --oggi AAAA-MM-GG / --ora ISO  per le prove
Variabili: SUPABASE_SERVICE_KEY, RESEND_KEY (non serve in dry-run), NOTIFICHE_DA (mittente, lo stesso di tools/notifiche.py).
"""
import argparse, datetime as dt, html, json, math, os, sys, time, urllib.error, urllib.request
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sbleggero as L

APP = 'https://sostabile.it/app/'
RAGGIO_M = 500
MAX_POSTI_EMAIL = 10
FINESTRA_PRIMA_ORE = 26        # per chi non ha mai ricevuto l'avviso: un po' più di 24 h, così un cron in ritardo non perde nulla
FINESTRA_MAX_ORE = 72          # tetto: se per qualche giorno non si è mandato nulla non si riempie l'email di roba vecchia
MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']
ROMA = ZoneInfo('Europe/Rome')
e = html.escape


def maschera(mail):
    n, _, d = (mail or '').partition('@')
    return (n[:1] + '***@' + d) if d else '***'


def data_it(d):
    return f'{d.day} {MESI[d.month - 1]} {d.year}'


def giorni_txt(n):
    return '1 giorno' if n == 1 else f'{n} giorni'


# ---------- email ----------
def pagina(titolo, corpo, pulsante=None, piede_avviso=''):
    """Stessa grafica di supabase/email_reset_password.html: intestazione blu, pulsante giallo, fondo grigio."""
    btn = (f'<tr><td style="padding:4px 24px 24px"><a href="{e(pulsante[1])}" style="display:inline-block;background:#ffcc00;color:#2b2300;font-size:17px;'
           f'font-weight:700;text-decoration:none;padding:16px 28px;border-radius:14px">{e(pulsante[0])}</a></td></tr>') if pulsante else ''
    return f'''<!doctype html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{e(titolo)}</title></head>
<body style="margin:0;padding:0;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#0b1f44">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden">
        <tr><td style="background:#0b2a5b;padding:22px 24px;color:#ffffff;font-size:22px;font-weight:700">SostAbile</td></tr>
        <tr><td style="padding:28px 24px 8px;font-size:22px;line-height:1.25;font-weight:700">{e(titolo)}</td></tr>
        {corpo}
        {btn}
        <tr><td style="padding:0 24px 24px;font-size:14px;line-height:1.5;color:#4a5668">Non vuoi più ricevere questi avvisi? Disattivali da <a href="{APP}" style="color:#0b2a5b">Il mio account</a> nell'app{e(piede_avviso)}.</td></tr>
        <tr><td style="background:#f3f5f9;padding:16px 24px;font-size:13px;color:#4a5668">SostAbile · i posti riservati alle persone con disabilità, in una mappa</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
'''


def p(testo):
    return f'<tr><td style="padding:0 24px 16px;font-size:16px;line-height:1.5">{testo}</td></tr>'


def email_scadenza(scad, rimasti):
    if rimasti <= 0: oggetto, titolo = 'Il tuo contrassegno scade oggi', 'Il tuo contrassegno scade oggi'
    elif rimasti == 1: oggetto, titolo = 'Il tuo contrassegno scade domani', 'Il tuo contrassegno scade domani'
    else: oggetto, titolo = f'Il tuo contrassegno scade tra {rimasti} giorni', f'Il tuo contrassegno scade tra {rimasti} giorni'
    quando = 'scade oggi' if rimasti <= 0 else 'scade domani' if rimasti == 1 else f'scade tra {rimasti} giorni'
    corpo = p(f'Ciao, il tuo contrassegno {quando}: la data di scadenza che hai indicato nell\'app è <b>{data_it(scad)}</b>.') \
        + p('Il rinnovo si chiede al tuo Comune: meglio muoversi per tempo, perché i tempi cambiano da un Comune all\'altro.')
    testo = f'Il tuo contrassegno {quando} ({data_it(scad)}). Il rinnovo si chiede al tuo Comune.\n\nNon vuoi più ricevere questi avvisi? Disattivali da Il mio account nell\'app: {APP}\n'
    return oggetto, pagina(titolo, corpo, ('Apri SostAbile', APP), ' (Il mio contrassegno, interruttore Email)'), testo


def email_vicino(posti, totale):
    """posti: [{id, indirizzo, comune, nome, distanza_m, vicino_a: 'Casa'|'Lavoro'|'Casa e Lavoro'}], già ordinati."""
    n = totale
    oggetto = f'Un nuovo posto vicino a {posti[0]["vicino_a"]}' if n == 1 else f'{n} nuovi posti vicino a Casa e Lavoro' if len({x['vicino_a'] for x in posti}) > 1 else f'{n} nuovi posti vicino a {posti[0]["vicino_a"]}'
    righe, testi = [], []
    for x in posti:
        titolo = x.get('indirizzo') or x.get('nome') or ('Posto riservato' + (f' a {x["comune"]}' if x.get('comune') else ''))
        sotto = ' · '.join(y for y in [x.get('comune') if x.get('indirizzo') else '', f'a {x["distanza_m"]} m da {x["vicino_a"]}'] if y)
        link = f'{APP}#posto={x["id"]}'
        righe.append(f'<tr><td style="padding:10px 14px;border:1px solid #dde3ee;border-radius:12px;font-size:15px;line-height:1.4"><a href="{e(link)}" style="color:#0b2a5b;font-weight:700;text-decoration:none">{e(titolo)}</a><br><span style="color:#4a5668;font-size:14px">{e(sotto)}</span></td></tr>')
        testi.append(f'- {titolo} ({sotto}): {link}')
    lista = '<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="border-collapse:separate">' + ''.join(righe) + '</table></td></tr>'
    altri = n - len(posti)
    intro = 'Ciao, abbiamo aggiunto un posto riservato' if n == 1 else f'Ciao, abbiamo aggiunto {n} posti riservati'
    corpo = p(f'{intro} entro {RAGGIO_M} m da Casa o Lavoro. Tocca un indirizzo per aprirlo.') + lista + (p(f'… e altri {altri}: li trovi sulla mappa.') if altri > 0 else '')
    testo = intro + f' entro {RAGGIO_M} m da Casa o Lavoro:\n' + '\n'.join(testi) + (f'\n... e altri {altri} sulla mappa.' if altri > 0 else '') + f'\n\nNon vuoi più ricevere questi avvisi? Disattivali da Il mio account nell\'app: {APP}\n'
    return oggetto, pagina(oggetto, corpo, ('Apri la mappa', APP), ' (interruttore "Nuovi posti vicino a Casa e Lavoro")'), testo


# ---------- utenti ----------
def valida_punto(l):
    try:
        la, lo = float(l['lat']), float(l['lon'])
    except Exception:
        return None
    return (la, lo) if 35 <= la <= 48 and 6 <= lo <= 19 and not (la == 0 and lo == 0) else None  # solo Italia: scarta valori corrotti


def leggi_utenti(key):
    """Tutti gli utenti dell'API admin GoTrue (paginata) ridotti ai soli campi necessari; si tengono solo quelli con un avviso acceso."""
    out, pag, per = [], 1, 1000
    while True:
        raw, _ = L.richiedi('GET', f'/auth/v1/admin/users?page={pag}&per_page={per}', key, timeout=120)
        j = json.loads(raw); lista = j.get('users', j) if isinstance(j, dict) else j
        out += lista
        if len(lista) < per: break
        pag += 1
    return out


def riduci(u):
    m = u.get('user_metadata') or {}; av = m.get('avvisi') or {}; dp = m.get('dp') or {}; pr = dp.get('profilo') or {}; lu = dp.get('luoghi') or {}
    ban = u.get('banned_until')
    return {'id': u.get('id'), 'email': u.get('email') or '', 'ok': bool(u.get('email') and u.get('email_confirmed_at') and not u.get('is_anonymous') and not ban),
            'email_scadenza': av.get('email_scadenza') is True, 'nuovi_vicino': av.get('nuovi_vicino') is True,
            'scadenza': pr.get('scadenza') or '', 'giorni': pr.get('giorni') if isinstance(pr.get('giorni'), int) else 60,
            'luoghi': {k: valida_punto(lu.get(k) or {}) for k in ('casa', 'lavoro')}, 'inviati': dict(m.get('avvisi_inviati') or {})}


def decidi_scadenza(u, oggi):
    """(chiave, scadenza, giorni_rimasti) se oggi va mandata un'email di scadenza, altrimenti None."""
    if not (u['email_scadenza'] and u['scadenza']): return None
    try: scad = dt.date.fromisoformat(u['scadenza'])
    except ValueError: return None
    rimasti = (scad - oggi).days; giorni = max(1, min(365, u['giorni']))
    if rimasti < 0: return None
    pre = f'scadenza:{scad.isoformat()}:'
    if rimasti <= 1:                       # "il giorno prima" (e, se il cron ha saltato un giorno, anche il giorno stesso)
        chiave = pre + '1'
    elif rimasti <= giorni:                # i giorni scelti; chi attiva l'avviso già dentro la finestra lo riceve il giorno dopo
        if any(k.startswith(pre) and k != pre + '1' for k in u['inviati']): return None  # già avvisato (anche se ha cambiato i giorni)
        chiave = pre + str(giorni)
    else:
        return None
    return None if chiave in u['inviati'] else (chiave, scad, rimasti)


def pulisci_registro(inv, oggi):
    """Toglie le voci di scadenze passate da più di 30 giorni."""
    out = {}
    for k, v in inv.items():
        if k.startswith('scadenza:'):
            try:
                if dt.date.fromisoformat(k.split(':')[1]) < oggi - dt.timedelta(days=30): continue
            except ValueError: pass
        out[k] = v
    return out


# ---------- posti nuovi ----------
def dist_m(a, b, c, d):
    x = math.sin(math.radians(c - a) / 2) ** 2 + math.cos(math.radians(a)) * math.cos(math.radians(c)) * math.sin(math.radians(d - b) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(min(1, x)))


def finta_funzione(stalli, punti, ore, ora):
    """Stesso risultato di public.stalli_nuovi_vicino, per le prove con dati finti."""
    out = []
    for pt in punti:
        v = []
        for s in stalli:
            if s.get('stato') not in ('verificato', 'ufficiale') or s.get('tipo') == 'personalizzato': continue
            if dt.datetime.fromisoformat(s['novita_il']) < ora - dt.timedelta(hours=ore): continue
            d = dist_m(pt['lat'], pt['lon'], s['lat'], s['lon'])
            if d <= RAGGIO_M: v.append(dict(s, k=pt['k'], distanza_m=round(d)))
        out += sorted(v, key=lambda r: r['distanza_m'])[:30]
    return out


def cerca_nuovi(utenti, ora, key, stalli_finti=None):
    """{id utente: [posti]} per gli utenti con l'avviso acceso. Una sola chiamata SQL (a blocchi) per tutti i punti."""
    da = {}  # id -> inizio della finestra
    for u in utenti:
        try: ult = dt.datetime.fromisoformat(u['inviati']['vicino'])
        except Exception: ult = None
        da[u['id']] = max(ult, ora - dt.timedelta(hours=FINESTRA_MAX_ORE)) if ult else ora - dt.timedelta(hours=FINESTRA_PRIMA_ORE)
    punti = [{'k': f'{u["id"]}|{n}', 'lat': pt[0], 'lon': pt[1]} for u in utenti for n, pt in u['luoghi'].items() if pt]
    if not punti: return {}, da
    ore = min(FINESTRA_MAX_ORE, math.ceil((ora - min(da.values())).total_seconds() / 3600) + 1)
    righe = []
    if stalli_finti is not None: righe = finta_funzione(stalli_finti, punti, ore, ora)
    else:
        for i in range(0, len(punti), 1000):
            righe += L.rpc('stalli_nuovi_vicino', {'p_punti': punti[i:i + 1000], 'p_ore': ore, 'p_raggio_m': RAGGIO_M}, key)
    nomi = {'casa': 'Casa', 'lavoro': 'Lavoro'}; per = {}
    for r in righe:
        uid, luogo = r['k'].split('|')
        if dt.datetime.fromisoformat(r['novita_il'].replace('Z', '+00:00')) <= da[uid]: continue  # già coperto dall'invio precedente
        d = per.setdefault(uid, {}).setdefault(r['id'], dict(r, vicino_a=set()))
        d['vicino_a'].add(nomi[luogo]); d['distanza_m'] = min(d['distanza_m'], r['distanza_m'])
    ris = {}
    for uid, ds in per.items():
        lst = sorted(ds.values(), key=lambda x: x['distanza_m'])
        for x in lst: x['vicino_a'] = ' e '.join(sorted(x['vicino_a']))
        ris[uid] = lst
    return ris, da


# ---------- invio ----------
def invia_resend(mittente, a, oggetto, html_, testo):
    msg = {'from': mittente, 'to': [a], 'subject': oggetto, 'html': html_, 'text': testo}
    req = urllib.request.Request('https://api.resend.com/emails', method='POST', data=json.dumps(msg).encode(),
                                 headers={'Authorization': 'Bearer ' + os.environ['RESEND_KEY'], 'Content-Type': 'application/json', 'User-Agent': 'disability-parking-avvisi'})
    with urllib.request.urlopen(req, timeout=60) as r: return r.status


def salva_registro(key, uid, inv):
    """Aggiorna user_metadata.avvisi_inviati (l'API admin unisce le chiavi di primo livello: dp e avvisi non si toccano)."""
    L.richiedi('PUT', f'/auth/v1/admin/users/{uid}', key, {'user_metadata': {'avvisi_inviati': inv}})


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dry-run', action='store_true', help='non invia e non scrive: stampa destinatari mascherati e oggetti')
    ap.add_argument('--max-invii', type=int, default=80, help='tetto di email per esecuzione (Resend: 100 al giorno)')
    ap.add_argument('--mock', help='file JSON con utenti e stalli finti (implica --dry-run, nessuna rete)')
    ap.add_argument('--oggi', help='data di oggi AAAA-MM-GG (prove)'); ap.add_argument('--ora', help='istante ISO (prove)')
    ap.add_argument('--ignora-sql-mancante', action='store_true', help='solo con --dry-run: se la funzione SQL manca conta comunque gli utenti e salta i posti nuovi')
    L.aggiungi_arg(ap); a = ap.parse_args(); L.usa_arg(a)
    dry = a.dry_run or bool(a.mock)
    ora = dt.datetime.fromisoformat(a.ora) if a.ora else dt.datetime.now(dt.timezone.utc)
    oggi = dt.date.fromisoformat(a.oggi) if a.oggi else ora.astimezone(ROMA).date()
    mock = json.load(open(a.mock)) if a.mock else None
    key = os.environ.get('SUPABASE_SERVICE_KEY', '') if not mock else ''
    if not mock and not key: sys.exit('Manca SUPABASE_SERVICE_KEY')
    if not dry and not os.environ.get('RESEND_KEY'): sys.exit('Manca RESEND_KEY')
    mittente = os.environ.get('NOTIFICHE_DA') or 'SostAbile <onboarding@resend.dev>'

    sql_ok = True
    if not mock:  # la funzione SQL deve esistere (supabase/22_avvisi_utenti.sql): finché manca, non si fa nulla e non è un errore
        try: L.rpc('stalli_nuovi_vicino', {'p_punti': [], 'p_ore': 1, 'p_raggio_m': RAGGIO_M}, key)
        except L.FunzioneAssente:
            print('AVVISO: la funzione public.stalli_nuovi_vicino non esiste ancora: eseguire supabase/22_avvisi_utenti.sql nell\'editor SQL di Supabase.')
            if not (dry and a.ignora_sql_mancante): print('Nessun avviso inviato oggi.'); return
            sql_ok = False; print('(prova: si contano comunque gli utenti, i posti nuovi sono saltati)')

    grezzi = mock['utenti'] if mock else leggi_utenti(key)
    utenti = [riduci(u) for u in grezzi]
    attivi = [u for u in utenti if u['ok'] and (u['email_scadenza'] or u['nuovi_vicino'])]
    print(f'{oggi} · utenti: {len(utenti)}, con un avviso acceso: {len(attivi)} (scadenza {sum(u["email_scadenza"] for u in attivi)}, nuovi posti {sum(u["nuovi_vicino"] for u in attivi)})'
          + (' · DRY-RUN: niente invii, niente scritture' if dry else ''))

    coda = []  # (priorità, utente, chiave registro, oggetto, html, testo, valore da registrare)
    for u in attivi:
        d = decidi_scadenza(u, oggi)
        if d:
            ch, scad, rim = d; ogg, h, t = email_scadenza(scad, rim); coda.append((0, u, ch, ogg, h, t, oggi.isoformat()))
    cand = [u for u in attivi if u['nuovi_vicino'] and any(u['luoghi'].values())]
    nuovi, da = ({}, {})
    if sql_ok and cand: nuovi, da = cerca_nuovi(cand, ora, key, mock.get('stalli') if mock else None)
    senza_luoghi = sum(1 for u in attivi if u['nuovi_vicino'] and not any(u['luoghi'].values()))
    if senza_luoghi: print(f'{senza_luoghi} utenti con l\'avviso sui nuovi posti non hanno ancora impostato Casa o Lavoro: saltati')
    for u in cand:
        lst = nuovi.get(u['id'])
        if lst:
            ogg, h, t = email_vicino(lst[:MAX_POSTI_EMAIL], len(lst)); coda.append((1, u, 'vicino', ogg, h, t, ora.isoformat()))
    coda.sort(key=lambda x: x[0])
    print(f'Email da mandare oggi: {len(coda)} (scadenza {sum(1 for c in coda if c[0] == 0)}, nuovi posti {sum(1 for c in coda if c[0] == 1)})')

    inviate = errori = 0; rimandati = []
    for _, u, ch, ogg, h, t, val in coda:
        if inviate >= a.max_invii: rimandati.append((u, ch)); continue
        if dry:
            print(f'  [dry-run] a {maschera(u["email"])} · {ogg}'); inviate += 1; continue
        try:
            invia_resend(mittente, u['email'], ogg, h, t); inviate += 1
        except urllib.error.HTTPError as ex:
            errori += 1; print(f'  ERRORE invio a {maschera(u["email"])}: HTTP {ex.code}')
            if ex.code == 429: rimandati.append((u, ch)); inviate = a.max_invii  # limite Resend raggiunto: si ferma e rimanda il resto
            continue
        except Exception as ex:
            errori += 1; print(f'  ERRORE invio a {maschera(u["email"])}: {type(ex).__name__}'); continue
        inv = pulisci_registro(u['inviati'], oggi); inv[ch] = val; u['inviati'] = inv
        for tent in (1, 2):
            try: salva_registro(key, u['id'], inv); break
            except Exception as ex: print(f'  ATTENZIONE: registro non salvato per {maschera(u["email"])} (tentativo {tent}): {type(ex).__name__}'); time.sleep(1)
        time.sleep(0.6)  # Resend accetta al massimo 2 richieste al secondo
    if rimandati:
        print(f'LIMITE: {len(rimandati)} email rimandate a domani (tetto {a.max_invii} al giorno per i 100 del piano Resend).')
        if not dry:  # chi non ha mai ricevuto l'avviso sui posti: si ricorda da dove ripartire, altrimenti domani perderebbe il giorno di oggi
            for u, ch in rimandati:
                if ch == 'vicino' and 'vicino' not in u['inviati']:
                    inv = dict(u['inviati']); inv['vicino'] = da[u['id']].isoformat()
                    try: salva_registro(key, u['id'], inv)
                    except Exception as ex: print(f'  ATTENZIONE: registro non salvato ({type(ex).__name__})')
    print(f'Fatto: {inviate} {"simulate" if dry else "inviate"}, {errori} errori, {len(rimandati)} rimandate.')
    if errori: sys.exit(1)


if __name__ == '__main__':
    main()
