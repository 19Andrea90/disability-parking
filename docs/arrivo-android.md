# Avviso all'arrivo (solo app Android): cosa dichiarare su Google Play

Cosa fa: quando l'utente tocca «Portami lì» e va col navigatore esterno, l'app resta in ascolto della posizione **solo da quel momento**. Quando è a meno di 50 m dal posto mostra una notifica «Sei quasi arrivato in {via}. Com'è andata?» con «Ho parcheggiato» e «Occupato». Durante il viaggio non copre la mappa e non fa rumore. L'ascolto si ferma da solo all'arrivo, alla risposta, al rientro nell'app o dopo 60 minuti. Sul sito non fa nulla.

## Componenti scelti

- `@capacitor-community/background-geolocation` 1.3.1 (MIT): servizio in primo piano di tipo `location`. Ritocco al momento dell'installazione (`mobile/scripts/patch-plugin.mjs`): la notifica obbligatoria diventa silenziosa e a priorità minima.
- `@capacitor/local-notifications` 7.0.7 (MIT): notifica d'arrivo con le due azioni.

## Permessi dell'APK (letti con `aapt2` nella build, v. `.github/workflows/android.yml`)

- Posizione precisa e approssimativa (erano già chiesti), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`.
- `RECEIVE_BOOT_COMPLETED` e `WAKE_LOCK` arrivano dal plugin delle notifiche locali: non servono all'avviso d'arrivo, non sono permessi «pericolosi» e non richiedono una dichiarazione a parte.
- **Non c'è** `ACCESS_BACKGROUND_LOCATION`. La build fallisce se compare.

## Play Console, «Contenuti dell'app» > «Servizi in primo piano»

Tipo da dichiarare: **Posizione** (`foregroundServiceType="location"`). Casistica più vicina nell'elenco: «Aggiornamenti della posizione in background, navigazione» oppure inserirne una a mano.

Testo suggerito (da adattare):

> Quando l'utente tocca «Portami lì» per raggiungere un posto auto riservato ai disabili, l'app avvia un servizio in primo piano che legge la posizione finché l'utente guida col navigatore. Serve solo a capire che è arrivato a meno di 50 metri dal posto e a chiedergli, con una notifica, se ha parcheggiato o se il posto era occupato. Si ferma da solo all'arrivo, quando l'utente risponde, quando riapre l'app o dopo 60 minuti. La notifica del servizio è sempre visibile ma silenziosa. La posizione non lascia il telefono e non viene salvata. Se il sistema interrompe il servizio, l'utente vede comunque la domanda alla riapertura dell'app.

Effetto se il servizio è rimandato o interrotto: l'avviso all'arrivo non compare, resta la domanda quando l'utente riapre l'app (funzione già presente senza servizio).

Video (la richiesta di Google è mostrare i passaggi che avviano la funzione): scheda di un posto, «Portami lì», spiegazione e richiesta notifiche, si apre il navigatore, notifica discreta del servizio, notifica d'arrivo con le due azioni, risposta, la notifica sparisce.

## «Sicurezza dei dati»

- Posizione: l'app già legge la posizione. Il servizio non invia nulla in più: non cambia cosa viene raccolto. Va solo ritoccata, se serve, la voce «Posizione precisa»: raccolta «solo mentre l'app è in uso o in primo piano», trattata sul dispositivo, non condivisa.
- Nessun nuovo dato personale: i nuovi eventi `parcheggiato` / `occupato` (migrazione `supabase/14_eventi_arrivo.sql`) hanno la stessa forma degli eventi anonimi già inviati (identificativo anonimo del telefono, comune, id del posto) e rientrano nelle voci «Attività nell'app» già dichiarate.
- Le notifiche non richiedono voci nella Sicurezza dei dati.

## Verificato nella documentazione ufficiale (letta il 19/11/2026)

- Android, tipi di servizio in primo piano: per `location` servono `FOREGROUND_SERVICE` e `FOREGROUND_SERVICE_LOCATION` più un permesso di posizione concesso; il servizio **può partire con l'app in primo piano senza `ACCESS_BACKGROUND_LOCATION`**, che serve solo se parte dallo sfondo.
- Play Console: per Android 14+ ogni tipo di servizio va dichiarato con descrizione, effetto di un'interruzione e video che mostri i passaggi che avviano la funzione.
- Build di prova: l'APK contiene il servizio con `foregroundServiceType=location` e i permessi sopra elencati, senza posizione in sottofondo.

## Presunto, NON verificato su un telefono

- Che il servizio resti vivo e continui a consegnare la posizione a schermo spento per tutto il tragitto (comportamento del WebView in sfondo, risparmio energetico dei singoli produttori).
- Che la notifica del servizio risulti davvero silenziosa e minimale sui vari Android (la priorità minima può farla comparire solo nell'area ridotta).
- Che la riapertura dell'app dall'azione «Occupato» porti al piano B anche con l'app chiusa dal sistema (i dati sono nel telefono, ma non è stato provato con la notifica vera).
- Che Google Play accetti la dichiarazione così com'è: la valutazione è sua.
