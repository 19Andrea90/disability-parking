# Verifica anti-bot (predisposta, SPENTA)

Oggi il limite d'uso dei dati (`_limite_dati`, file 11) è per indirizzo IP: chi ruota molti IP lo aggira. Il «passo» aggiunge una seconda barriera: i dati si servono solo a chi presenta un passo valido, rilasciato a chi dimostra di essere un browser reale (Cloudflare Turnstile, web) o l'app vera (Play Integrity, Android: **non ancora fatto**).

## Come funziona
1. Il web, se `CFG.TURNSTILE` è valorizzata e `app_config().anti_bot_modo` è `osserva` o `obbliga`, carica lo script Turnstile e ottiene una prova.
2. La prova va alla funzione Edge `passo` (`supabase/functions/passo/index.ts`), che la verifica con Cloudflare (`siteverify`, segreto `TURNSTILE_SECRET`), genera un token casuale di 32 byte, lo salva in `public.passi` con scadenza a 30 minuti e lo restituisce.
3. L'app tiene il passo solo in memoria e lo manda nell'intestazione `x-dp-passo` a `stalli_zona`, `stalli_conteggi`, `stallo`. Lo rinnova quando mancano meno di 2 minuti alla scadenza o dopo un 401 (una sola ripetizione; poi «Non riesco a verificare il dispositivo. Ricarica la pagina.»).
4. `_limite_dati` legge l'intestazione: `_passo_valido()` controlla che il token esista e non sia scaduto. Modi (chiave `anti_bot` di `app_config_valori`, `{"modo": ...}`): `spento` (nessun controllo, stato attuale), `osserva` (serve tutti, conta `con_passo` / `senza_passo` in `accessi_dati`), `obbliga` (senza passo valido: HTTP 401 e corpo `[]`). Admin sempre esenti; modo sconosciuto = spento. Il limite per IP e il 429 restano com'erano.

Con `CFG.TURNSTILE` vuota, su Android o con modo `spento` l'app si comporta come prima: nessuno script esterno, nessuna chiamata alla funzione, nessuna intestazione.

## Accensione, passo per passo (titolare)
1. **Turnstile**: su Cloudflare, Turnstile, crea un widget per i domini `sostabile.it` e `19andrea90.github.io` (tipo Managed). Prendi la *site key* (pubblica) e la *secret key*.
2. **Segreto**: `supabase secrets set TURNSTILE_SECRET=...` (progetto `wwereqrojlwktgwlrsib`). `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` li fornisce Supabase.
3. **Deploy** della funzione: `supabase functions deploy passo` (lascia attiva la verifica JWT: l'app manda già la chiave anon).
4. **SQL**: esegui a mano `supabase/13_passo_anti_bot.sql` nell'editor SQL (dopo il 11; rieseguibile). Non cambia nulla: il modo parte da `spento`. Controllo: `select public.app_config();` mostra `anti_bot_modo: "spento"`.
5. **App**: metti la site key in `CFG.TURNSTILE` (`mobile/www/app.js`), `python3 -I tools/web.py`, pubblica il web. Finché il modo è `spento` non cambia nulla.
6. **Osserva**: `update public.app_config_valori set valore = '{"modo":"osserva"}' where chiave = 'anti_bot';` Dopo qualche giorno: `select giorno, sum(con_passo) con, sum(senza_passo) senza from accessi_dati group by 1 order by 1 desc;`. Il web deve risultare quasi tutto «con»; «senza» sono Android, versioni vecchie e bot.
7. **Obbliga**: solo quando web **e** Android sono pronti (vedi avvertenza). `... '{"modo":"obbliga"}' ...`. Per tornare indietro: `'{"modo":"spento"}'`.

**Cosa permettere (CSP / firewall / service worker).** Nel repository non c'è una Content-Security-Policy (`_headers` di `tools/pubblica.py` non ne ha); se ne aggiungi una serve `script-src`, `frame-src` e `connect-src` per `https://challenges.cloudflare.com`, e `connect-src` per `https://wwereqrojlwktgwlrsib.supabase.co`. Il service worker (`sw.js`) ora esclude `challenges.cloudflare.com` dalla cache. Verifica CORS: la richiesta con `x-dp-passo` fa un preflight verso Supabase REST: da provare in prova reale (da verificare).

## AVVERTENZA FONDAMENTALE
Finché Android non ha il suo passo, il modo `obbliga` **blocca l'app Android** (e quella web se Turnstile è giù). Quindi: (1) `obbliga` si accende solo quando entrambe le piattaforme sono pronte; (2) prima si obbligano le versioni vecchie ad aggiornarsi: `update public.app_config_valori set valore = '"X.Y.Z"' where chiave = 'versione_minima_android';` e si aspetta che la quota di vecchie sia trascurabile (guarda le statistiche d'uso); (3) si prova prima in `osserva`. Il web non ha altro fallback: se Turnstile non carica, in `obbliga` non si vedono posti.

## Progetto per Android (Play Integrity) — NON implementato
**Verificato** (consultato oggi):
- [Play Integrity, richieste standard](https://developer.android.com/google/play/integrity/standard): `prepareIntegrityToken()` con il numero del progetto Google Cloud (al massimo 5 volte al minuto per istanza), poi `request()` con un `requestHash`; il server decifra con `playintegrity.googleapis.com/v1/PACKAGE_NAME:decodeIntegrityToken` usando un service account del progetto collegato (scope `playintegrity`), controlla `requestHash`, e il token si decifra una sola volta (protezione da replay).
- [Richieste classiche](https://developer.android.com/google/play/integrity/classic): stessa decodifica, con `nonce` al posto di `requestHash`.
- Plugin Capacitor [`@capacitor-community/play-integrity`](https://www.npmjs.com/package/@capacitor-community/play-integrity) (letto con `npm view`): versioni 6.x, 7.x, 8.0.0; la 7.x richiede `@capacitor/core >= 7` (il progetto usa `^7.4.0`, la 8.0.0 richiede Capacitor 8). Espone solo `requestIntegrityToken({ nonce, googleCloudProjectNumber })` → `{ token }`, cioè **solo richieste classiche** (non standard).

**Da verificare** (non controllabile dal sandbox): quote giornaliere di richieste e come chiedere aumenti; nomi esatti dei campi del verdetto (`requestDetails`, `appIntegrity`, `deviceIntegrity`); costo/limiti di un service account; se la versione 7.x del plugin compila con il Capacitor/Gradle del workflow.

**Cosa serve**
1. *Google Cloud*: un progetto, abilitare la «Play Integrity API», un service account con permesso di decodifica e la sua chiave JSON come segreto della funzione (`GOOGLE_SA_JSON`); collegare il progetto in Play Console (Test e rilascio → Integrità dell'app).
2. *Play Console*: app pubblicata almeno in test interno su Play (il verdetto «app riconosciuta» vale per le build distribuite da Google Play). **L'APK di prova firmato in debug scaricabile dal sito non è riconosciuto da Play: con `obbliga` non otterrebbe il passo** (comportamento atteso, da verificare in prova). Va deciso se continuare a offrirlo o accettare un verdetto più debole.
3. *App*: `npm i @capacitor-community/play-integrity@7`, nel flusso nativo: `nonce` = valore casuale ricevuto dalla funzione (la funzione lo registra per usarlo una volta sola) → `requestIntegrityToken` → POST a `passo` con `{origine:'android', prova: token, nonce}` → passo in memoria e intestazione `x-dp-passo`, come sul web (il codice di `rpc()` è già pronto: basta `ottieniPasso` nativa e togliere `!NATIVO()`).
4. *Funzione Edge `passo`*: nel ramo `android` (oggi 501) ottenere un token OAuth del service account, chiamare `decodeIntegrityToken`, controllare il `nonce`, `appIntegrity.appRecognitionVerdict == PLAY_RECOGNIZED`, il nome del pacchetto `it.disabilityparking.app`, `deviceIntegrity` almeno `MEETS_DEVICE_INTEGRITY`, e solo allora rilasciare il passo con `origine='android'`.
