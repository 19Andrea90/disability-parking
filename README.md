# SostAbile

App per trovare e segnalare gli stalli di sosta riservati alle persone con disabilità. PWA installabile, dati su Supabase.

**App:** https://19andrea90.github.io/disability-parking/ · **Admin:** https://19andrea90.github.io/disability-parking/admin.html

## Struttura
- `index.html`, `app.js`, `app.css` — app principale (mappa, ricerca destinazione, scheda stallo, segnalazioni, preferiti, offline)
- `admin.html`, `admin.js` — pannello di approvazione (login Supabase, solo email presenti in `admins`)
- `config.js` — URL e chiave pubblica Supabase, vista iniziale
- `sw.js`, `manifest.json`, `icons/` — PWA
- `supabase/schema.sql` — schema del database (eseguire nel SQL Editor)
- `tools/import_osm.py` — importa gli stalli da OpenStreetMap

## Importare i dati OSM
```
set SUPABASE_SERVICE_KEY=...   (Windows)   /   export SUPABASE_SERVICE_KEY=...   (Linux/Mac)
python tools/import_osm.py --area Udine --area Gorizia
```

## Stati di uno stallo
`proposto` (segnalato da un utente) → `verificato` (approvato) → `ufficiale` (confermato da fonte comunale). `rifiutato` / `rimosso` non vengono mostrati.

## Licenze dati
I dati importati da OpenStreetMap sono © OpenStreetMap contributors, ODbL.

## Pubblicazione
Il sito per Cloudflare Pages si prepara con:
```
python3 tools/pubblica.py dist
```
La cartella di uscita è `dist` (ignorata da git, ricreata da zero a ogni esecuzione): contiene solo web app, pannello admin e `sito/`, più `_headers` e `robots.txt`. Restano fuori dati, modelli, strumenti, SQL e sorgenti mobile. Lo script segue i riferimenti reali dei file e si ferma se ne manca uno.

Per il dominio `sostabile.it` (sito in radice, app in `/app/`, admin in `/admin/`): `python3 tools/pubblica.py dist --disposizione dominio`. Cosa cambiare nei servizi esterni: `docs/passaggio-dominio.md`.

## Tema scuro e segnaposto (app)
L'app segue da sola il tema del telefono o del browser (`prefers-color-scheme`), senza interruttore: colori in variabili CSS (`mobile/www/app.css`, blocco `:root` e `@media (prefers-color-scheme:dark)`), mappa con stile OpenFreeMap `dark` (la vista satellitare resta com'è). Palette scura: fondi `#1b2230` / `#222a39`, testi `#eef2f8` / `#b9c3d3`, bordi `#333d50`, azzurro `#8fb4ff`. Contrasti minimi misurati: 5,2:1 (azzurro sui riquadri chiari) e almeno 6:1 per il testo normale. Sui segnaposto: pieno = ufficiale o verificato, bianco con bordo spesso = da verificare, giallo = posto scelto; la legenda sta nella «i» della mappa. Il pannello admin resta sempre in tema chiaro.
