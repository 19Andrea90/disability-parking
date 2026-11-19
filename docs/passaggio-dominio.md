# Passaggio al dominio sostabile.it

Disposizione finale: `https://sostabile.it/` = sito vetrina, `/app/` = web app, `/admin/` = pannello admin.
Nel deposito i file restano dove sono (GitHub Pages continua a funzionare uguale finché non viene spento): la nuova disposizione la produce `tools/pubblica.py --disposizione dominio`, che riscrive i collegamenti tra le parti (elenco in cima allo script, `SOSTITUZIONI_DOMINIO`; se una voce non trova riscontro lo script si ferma).

Da fare FUORI dal repository, in quest'ordine, quando il dominio è attivo:

1. **Cloudflare Pages, impostazioni di build**
   - Comando di build: `python3 tools/pubblica.py dist --disposizione dominio`
   - Cartella di output: `dist`
   - Dominio personalizzato: `sostabile.it` (e, se serve, redirect di `www.sostabile.it` verso `sostabile.it`).
   - Il file `_redirects` generato porta `/sito/*` → `/:splat` e `/admin.html` → `/admin/` (301). Cloudflare Pages serve anche `/privacy.html` come `/privacy` (redirect automatico): gli indirizzi con `.html` continuano a funzionare.
   - Valore attuale: non presente nel repository, da verificare nel servizio (oggi si usa solo `tools/pubblica.py dist`, vedi `README.md:28`).

2. **Supabase, Authentication → URL Configuration** (progetto `wwereqrojlwktgwlrsib`)
   - Site URL: `https://sostabile.it/app/`
   - Redirect URLs da AGGIUNGERE: `https://sostabile.it/app/**` e `https://www.sostabile.it/app/**` (se si usa www). Il web chiede `redirect_to = location.origin + location.pathname` (`mobile/www/app.js:736`), cioè `https://sostabile.it/app/` (o `/app/index.html` se aperta così: coperto da `**`).
   - Tenere `it.disabilityparking.app://login` (Android, `mobile/www/app.js:736` e `:751`) e, finché serve, l'indirizzo github.io attuale.
   - Valori attuali: non presenti nel repository, da verificare nel servizio.

3. **Google Cloud, OAuth (client usato da Supabase per «Accedi con Google»)**
   - Il flusso passa da Supabase (`${CFG.SB}/auth/v1/authorize`, `mobile/www/app.js:738`): l'URI di reindirizzamento autorizzato resta quello di Supabase (`https://wwereqrojlwktgwlrsib.supabase.co/auth/v1/callback`), invariato.
   - Origini JavaScript autorizzate: servono solo se in futuro si usa Google Identity direttamente nel browser; oggi non risulta. Se il client le ha, aggiungere `https://sostabile.it` (e `https://www.sostabile.it`).
   - Schermata di consenso OAuth: dominio dell'app, pagina iniziale `https://sostabile.it/`, informativa `https://sostabile.it/privacy.html`, condizioni `https://sostabile.it/condizioni.html`; aggiungere `sostabile.it` ai domini autorizzati.
   - Non presente nel repository, da verificare nel servizio.

4. **Google Play Console, scheda dello store**
   - URL informativa sulla privacy: `https://sostabile.it/privacy.html`
   - Sito web: `https://sostabile.it/`
   - Link di cancellazione account (se richiesto dal modulo «Sicurezza dei dati»): `https://sostabile.it/privacy.html`
   - ID dell'app nel link di Play: `mobile/www/app.js:20` (non cambia).
   - Non presente nel repository, da verificare nel servizio.

5. **Costante `SITO_ANDROID` nell'app Android**
   - `mobile/www/app.js:6`: cambiare `https://19andrea90.github.io/disability-parking/sito/` in `https://sostabile.it/` (c'è già il commento). Poi `python3 -I tools/web.py` e nuova build Android/Play: finché non esce la nuova versione i telefoni continuano a usare l'indirizzo vecchio.
   - È usata per i link a fonti e condizioni (`mobile/www/app.js:803`) e per «Invita un amico» sul web (`:826`; su Android lì c'è il link di Play).
   - Sul web `CFG.SITO` si adatta da solo (`sitoBase()`, `mobile/www/app.js:7`): con hostname `sostabile.it`/`www.sostabile.it` usa `https://sostabile.it/`.

6. **Workflow GitHub: secret e variabili con indirizzi**
   - Nei workflow non c'è nessun indirizzo del sito (verificato con ricerca di `github.io` in `.github/`). Gli unici indirizzi sono Supabase (`android.yml:84`) e i link ai release GitHub nei commenti (`android.yml:4`, `play.yml:5`), che non cambiano.
   - `tools/notifiche.py:14` (`ADMIN`, link al pannello nelle email di notifica, usato da `notifiche.yml`): cambiare in `https://sostabile.it/admin/` (commento già presente).
   - Se le email passano a un mittente `@sostabile.it`: secret `NOTIFICHE_DA` (`notifiche.yml:33`) e verifica del dominio su Resend (`email-verifica.yml`); `NOTIFICHE_A` (`notifiche.yml:32`) è un indirizzo email, non cambia per forza.
   - Valore attuale dei secret: non presente nel repository, da verificare nel servizio.

7. **Testi delle PEC di accesso civico**
   - Il testo delle PEC non è nel repository (il pannello admin ne tiene solo lo stato: `admin.html:108`, `admin.js:147`): se cita il sito o l'app, aggiornare l'indirizzo a `https://sostabile.it/` nei modelli usati. Da verificare dove si trovano i modelli.

8. **Altri riferimenti nel repository (non bloccanti)**
   - `sito/index.html:10` (`og:image` github.io): in `dominio` è riscritto da `pubblica.py` (con `og:url` e `canonical`); quando GitHub Pages sarà spento si può cambiare anche nel sorgente.
   - `README.md:5`: indirizzi di app e admin da aggiornare a fine passaggio.
   - Dopo il passaggio, spegnere GitHub Pages e valutare se togliere da `pubblica.py` la disposizione `attuale`.
