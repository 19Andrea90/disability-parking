# Disability Parking

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
