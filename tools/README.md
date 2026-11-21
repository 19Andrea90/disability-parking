# tools/ - script di servizio

## Regola: mai scaricare tutti gli stalli, usa `sbleggero`

Supabase Free ha 5 GB/mese di traffico in uscita (egress). Il 15-17/11/2026 lo abbiamo sforato (8,47 GB) con script che
rileggevano interi elenchi di stalli/candidati a ogni blocco, comune o rilancio. Per ogni lettura da Supabase negli script:

- usa `tools/sbleggero.py` (`get`, `conteggio`, `esistono`, `pubblico`, `lista_storage`): colonne scelte, filtri lato server, cache, contatore;
- `select=` solo con le colonne che servono (mai `select=*`); filtri per bbox/comune/stato lato server, non in Python;
- una sola lettura per esecuzione (cache in `~/.cache/sostabile`, 6 h; in Actions con `actions/cache`); `--no-cache` o `SB_NOCACHE=1` per forzare la rilettura;
- controlli di esistenza/duplicati con `osm_id=in.(...)` o `conteggio()` (HEAD + `count=exact`), non scaricando l'elenco;
- se esiste un file statico gia' pubblicato (copertura.json, riepilogo.json) leggi quello;
- a fine esecuzione viene stampato "Traffico Supabase di questa esecuzione: X MB": controllalo dopo ogni modifica.

Le letture che precedono una scrittura sulle stesse righe (auto_accept, merge_stalli, indirizzi) non usano la cache,
ma restano mirate: comune/bbox lato server.
