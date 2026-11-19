#!/usr/bin/env python3
"""Email all'admin quando arrivano suggerimenti, segnalazioni di posti o errori dell'app.

Gira ogni 15 minuti su GitHub Actions (.github/workflows/notifiche.yml). Ricorda fin dove ha già guardato in
Supabase Storage (modelli/scan/notifiche.json), così non manda mai due volte la stessa cosa.

Variabili: SUPABASE_SERVICE_KEY, RESEND_KEY, NOTIFICHE_A (destinatario), NOTIFICHE_DA (mittente, facoltativo).
Con --prova manda comunque un'email di prova.
"""
import datetime as dt, html, json, os, sys, urllib.parse, urllib.request

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
# Da cambiare in https://sostabile.it/admin/ quando il dominio è attivo (vedi docs/passaggio-dominio.md)
ADMIN = 'https://sostabile.it/admin/'
STATO = '/storage/v1/object/modelli/scan/notifiche.json'
KEY = os.environ['SUPABASE_SERVICE_KEY']
H = {'apikey': KEY, 'Authorization': 'Bearer ' + KEY}


def sb(path, method='GET', body=None, headers=None):
    req = urllib.request.Request(SB + path, method=method, data=None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode()),
                                 headers=dict(H, **(headers or {})))
    with urllib.request.urlopen(req, timeout=60) as r:
        d = r.read()
        return json.loads(d) if d else None


def leggi_stato():
    try: return sb(STATO.replace('/object/', '/object/authenticated/'))
    except Exception: return {}


def main():
    prova = '--prova' in sys.argv
    adesso = dt.datetime.now(dt.timezone.utc)
    st = leggi_stato(); da = st.get('ultimo') or (adesso - dt.timedelta(hours=1)).isoformat()
    q = urllib.parse.quote(da)
    sugg = sb(f'/rest/v1/suggerimenti?select=creato,categoria,testo,email,piattaforma&creato=gt.{q}&order=creato')
    segn = sb(f'/rest/v1/stalli?select=created_at,comune,indirizzo,tipo,foto_url&fonte=eq.utente&created_at=gt.{q}&order=created_at')
    err = sb(f'/rest/v1/eventi?select=creato,dettaglio,piattaforma,versione&tipo=eq.errore&creato=gt.{q}&order=creato')
    print(f'Dal {da}: {len(sugg)} suggerimenti, {len(segn)} segnalazioni, {len(err)} errori')
    if not (sugg or segn or err or prova):
        sb(STATO, 'POST', {'ultimo': adesso.isoformat()}, {'Content-Type': 'application/json', 'x-upsert': 'true'}); return

    e = html.escape; CAT = {'manca': 'Manca una funzione', 'errore': 'Qualcosa non va', 'idea': 'Idea', 'altro': 'Altro'}
    parti, oggetto = [], []
    if sugg:
        oggetto.append(f'{len(sugg)} suggeriment{"o" if len(sugg) == 1 else "i"}')
        parti.append('<h3>Suggerimenti</h3>' + ''.join(f'<p><b>{e(CAT.get(x["categoria"], x["categoria"]))}</b> · {e(x.get("piattaforma") or "")}'
                     f'{" · " + e(x["email"]) if x.get("email") else ""}<br>{e(x["testo"]).replace(chr(10), "<br>")}</p>' for x in sugg))
    if segn:
        oggetto.append(f'{len(segn)} segnalazion{"e" if len(segn) == 1 else "i"}')
        parti.append('<h3>Posti segnalati dagli utenti</h3><ul>' + ''.join(f'<li>{e(x.get("indirizzo") or "posto")} · {e(x.get("comune") or "")} · {e(x.get("tipo") or "")}'
                     f'{" · con foto" if x.get("foto_url") else ""}</li>' for x in segn) + '</ul>')
    if err:
        gruppi = {}
        for x in err: gruppi.setdefault(x.get('dettaglio') or '?', []).append(x)
        oggetto.append(f'{len(err)} error{"e" if len(err) == 1 else "i"} dell\'app')
        parti.append('<h3>Errori dell\'app</h3><ul>' + ''.join(f'<li><code>{e(m)}</code> · {len(v)} volt{"a" if len(v) == 1 else "e"} · {e(", ".join(sorted({(y.get("piattaforma") or "?") + " " + (y.get("versione") or "") for y in v})))}</li>'
                     for m, v in sorted(gruppi.items(), key=lambda kv: -len(kv[1]))[:15]) + '</ul>')
    if prova and not parti: parti.append('<p>Email di prova: le notifiche funzionano.</p>'); oggetto.append('prova notifiche')
    corpo = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.45">' + ''.join(parti) + f'<p><a href="{ADMIN}">Apri il pannello admin</a></p></div>'
    msg = {'from': os.environ.get('NOTIFICHE_DA') or 'SostAbile <onboarding@resend.dev>', 'to': [os.environ['NOTIFICHE_A']],
           'subject': 'SostAbile: ' + ', '.join(oggetto), 'html': corpo}
    req = urllib.request.Request('https://api.resend.com/emails', method='POST', data=json.dumps(msg).encode(),
                                 headers={'Authorization': 'Bearer ' + os.environ['RESEND_KEY'], 'Content-Type': 'application/json', 'User-Agent': 'disability-parking-notifiche'})
    with urllib.request.urlopen(req, timeout=60) as r: print('Email inviata:', r.status, r.read()[:200])
    tempi = [x['creato'] for x in sugg] + [x['created_at'] for x in segn] + [x['creato'] for x in err]
    sb(STATO, 'POST', {'ultimo': max(tempi) if tempi else adesso.isoformat()}, {'Content-Type': 'application/json', 'x-upsert': 'true'})


if __name__ == '__main__':
    main()
