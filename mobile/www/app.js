/* SostAbile · app Android (Capacitor). Passo 1: primo avvio, mappa, posto più vicino, scheda del posto. */
(() => {
  'use strict';
  // Indirizzo base del sito vetrina (con / finale). Sul web aperto da sostabile.it (o www.) è il dominio; altrove (GitHub Pages,
  // prove in locale) e su Android resta quello provvisorio. È l'unico punto dell'app dove compare un indirizzo del sito.
  const SITO_ANDROID = 'https://sostabile.it/'; // sito vetrina (dominio attivo dal 19/11/2026)
  const sitoBase = (host, nativo) => (!nativo && /^(www\.)?sostabile\.it$/i.test(host || '')) ? 'https://sostabile.it/' : SITO_ANDROID;
  const SITO_NATIVO = () => { const cap = window.Capacitor; return !!(cap && cap.isNativePlatform && cap.isNativePlatform()); };
  const CFG = {
    SB: 'https://wwereqrojlwktgwlrsib.supabase.co',
    // chiave "anon": è pubblica per natura, i permessi li decide il database
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3ZXJlcXJvamx3a3Rnd2xyc2liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MjMzMjYsImV4cCI6MjEwODM5OTMyNn0.vOaCaVc8kaqsRT_o_TP01CbyX9SN-Af1fKjSZ3NxQys',
    STYLE: 'https://tiles.openfreemap.org/styles/positron',
    STYLE_SCURO: 'https://tiles.openfreemap.org/styles/dark', // tema scuro del telefono: stessa sorgente OpenStreetMap, colori scuri
    HOME: [13.236, 46.063], // Udine, finché non c'è la posizione
    MIN_ZOOM_DATI: 12,      // sotto questo zoom si vedono i totali per regione, provincia e comune (file statico)
    MAX_H: 0.03,            // vista più alta di così (circa 3 km) o più larga di MAX_W: niente singoli posti, solo conteggi a griglia
    MAX_W: 0.07,            // il server accetta riquadri fino a 0,05° x 0,075° (stalli_zona): vedi il margine in caricaVista()
    VICINO_M: 80,           // entro questa distanza si può confermare "c'è / non c'è più"
    ARRIVO_M: 50,           // al rientro nell'app, entro questa distanza dal posto si chiede "Hai parcheggiato qui?" (deciso da Andrea)
    GOOGLE: true,           // accesso con Google: fornitore configurato su Supabase il 19/11/2026
    PLAY: 'https://play.google.com/store/apps/details?id=it.disabilityparking.app',
    TURNSTILE: '0x4AAAAAAGVzj8VvrCjB4I81',        // chiave pubblica (sitekey) di Cloudflare Turnstile per il web; VUOTA = passo anti-bot spento (vedi docs/anti-bot.md)
    PASSO_URL: 'https://wwereqrojlwktgwlrsib.supabase.co/functions/v1/passo', // funzione Edge che scambia la prova Turnstile con un passo
    SITO: sitoBase(location.hostname, SITO_NATIVO()), // indirizzo base del sito vetrina (con / finale): vedi sitoBase() qui sopra
  };
  const $ = (s) => document.querySelector(s);
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* spazio pieno o navigazione privata */ } },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  // Stati vuoti: disegno semplice (SVG in linea, nascosto agli screen reader), titolo, frase e un'azione utile. Colori dal tema (classi v-*, in app.css).
  const DIS_VUOTO = {
    pin: '<svg aria-hidden="true" width="88" height="72" viewBox="0 0 88 72" fill="none"><ellipse class="v-ombra" cx="44" cy="62" rx="30" ry="6"/><path class="v-fondo v-tr" d="M44 8c-11 0-19 8-19 18 0 13 19 32 19 32s19-19 19-32C63 16 55 8 44 8z" stroke-width="3" stroke-dasharray="6 5"/><circle class="v-tr" cx="44" cy="26" r="7" stroke-width="3"/></svg>',
    segn: '<svg aria-hidden="true" width="88" height="64" viewBox="0 0 88 64" fill="none"><rect class="v-gl v-tr" x="20" y="10" width="48" height="44" rx="8" stroke-width="3"/><path class="v-tr" d="M44 22v20M34 32h20" stroke-width="3" stroke-linecap="round"/></svg>',
    salv: '<svg aria-hidden="true" width="88" height="64" viewBox="0 0 88 64" fill="none"><path class="v-bl v-tr" d="M32 8h24v46l-12-9-12 9z" stroke-width="3" stroke-linejoin="round"/></svg>',
    cerca: '<svg aria-hidden="true" width="88" height="64" viewBox="0 0 88 64" fill="none"><ellipse class="v-ombra" cx="44" cy="57" rx="28" ry="5"/><circle class="v-fondo v-tr" cx="40" cy="26" r="16" stroke-width="3"/><path class="v-tr" d="M52 38l14 14" stroke-width="3" stroke-linecap="round"/><path class="v-tr" d="M33 26h14" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 7"/></svg>',
  };
  // az: [[testo, data-v, 'v-1'|'v-2'], ...]
  const vuoto = (dis, titolo, frase, az, compatto) => `<div class="stv${compatto ? ' compatto' : ''}" role="status">${DIS_VUOTO[dis] || ''}<b class="v-t">${titolo}</b>${frase ? `<p>${frase}</p>` : ''}${az && az.length ? `<div class="v-az">${az.map((x) => `<button class="${x[2] || 'v-1'}" data-v="${x[1]}">${x[0]}</button>`).join('')}</div>` : ''}</div>`;

  // ---------- dimensione del carattere ----------
  // I testi sono in rem: la dimensione base della pagina segue «Dimensione carattere» del telefono. Sul web è il browser a deciderla (impostazioni e zoom
  // del browser). Sull'app la WebView di Capacitor non la applica da sola: la legge il plugin nativo SostAbile (fontScale) e, per non avere un salto
  // all'apertura, l'ultimo valore noto si applica subito. La WebView ha textZoom fisso a 100 (MainActivity.java), così non si scala due volte.
  // Sull'app lo zoom a pinch della pagina resta spento (la mappa gestisce da sola il suo): il viewport sul web, invece, lo consente.
  (function () {
    const cap = window.Capacitor; if (!(cap && cap.isNativePlatform && cap.isNativePlatform())) return;
    const mv = document.querySelector('meta[name=viewport]'); if (mv) mv.setAttribute('content', 'width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover,user-scalable=no');
    const metti = (k) => { k = Math.min(2, Math.max(0.85, +k || 1)); document.documentElement.style.fontSize = (Math.round(k * 1000) / 10) + '%'; return k; };
    const noto = ls.get('dp.fs', 0); if (noto) metti(noto);
    let pl = null; try { pl = (cap.Plugins && cap.Plugins.SostAbile) || (cap.registerPlugin && cap.registerPlugin('SostAbile')); } catch (e) { pl = null; }
    if (pl && typeof pl.fontScale === 'function') {
      const leggi = () => { try { Promise.resolve(pl.fontScale()).then((r) => { if (r && r.scala) { const k = metti(r.scala); if (k !== noto) ls.set('dp.fs', k); } }, () => {}); } catch (e) { /* si resta com'è */ } };
      leggi(); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') leggi(); });
    }
  })();

  let deviceId = ls.get('dp.device', null);
  if (!deviceId) { deviceId = 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36); ls.set('dp.device', deviceId); }

  // ---------- statistiche d'uso anonime ----------
  // Solo il codice casuale del telefono, il tipo di azione e al massimo il comune: niente posizione, niente dati personali.
  // Servono al cruscotto del pannello admin (quante persone usano l'app, quante si fanno portare a un posto, dove mancano posti).
  const PIATTAFORMA = (() => { const cap = window.Capacitor; if (cap && cap.isNativePlatform && cap.isNativePlatform()) return (cap.getPlatform && cap.getPlatform()) === 'ios' ? 'ios' : 'android'; return window.matchMedia('(min-width:900px)').matches ? 'pc' : 'web'; })();
  const statAttive = () => ls.get('dp.stat', true) !== false;
  // Dispositivo INTERNO (Andrea, Giulia, controlli dello sviluppatore): ogni evento porta interno:true e il pannello admin lo toglie dai conteggi
  // (supabase/20_dispositivi_interni.sql). Si attiva da solo con l'accesso di un account admin (controllaAdmin), dal pannello admin
  // (stessa origine: scrive lo stesso 'dp.interno') o a mano con 7 tocchi sulla versione in "I tuoi posti". Finché il database non ha la
  // colonna l'inserimento con interno viene rifiutato (400): si rimanda UNA volta senza il campo e per 24 ore non lo si rimanda.
  const eInterno = () => !!ls.get('dp.interno', 0);
  const internoRifiutato = () => Date.now() - ls.get('dp.evInternoNo', 0) < 864e5;
  // Dispositivi di prova di Google Play (Firebase Test Lab, rapporto di pre-lancio): il plugin nativo locale TestLab (mobile/android-extra/) lo dice
  // e in quel caso l'app non manda MAI statistiche. Senza plugin (versioni vecchie) nessun errore: si va avanti come sempre.
  let provaGoogle = false, provaNota = true, provaAttesa = [];
  (function () {
    const cap = window.Capacitor; if (!(cap && cap.isNativePlatform && cap.isNativePlatform())) return;
    let pl = null; try { pl = (cap.Plugins && cap.Plugins.TestLab) || (cap.registerPlugin && cap.registerPlugin('TestLab')); } catch (e) { pl = null; }
    if (!pl || typeof pl.isTestLab !== 'function') return;
    provaNota = false;
    const fine = (t) => { if (provaNota) return; provaGoogle = !!t; provaNota = true; const q = provaAttesa; provaAttesa = []; if (!provaGoogle) q.forEach((f) => f()); };
    setTimeout(() => fine(false), 3000); // se il plugin non risponde si va avanti come dispositivo normale
    try { Promise.resolve(pl.isTestLab()).then((r) => fine(r && (r.value === true || r.value === 'true')), () => fine(false)); } catch (e) { fine(false); }
  })();
  // 'parcheggiato' e 'occupato' sono tipi nuovi (supabase/14_eventi_arrivo.sql). Finché il database non li ammette l'inserimento viene
  // rifiutato (400): in quel caso lo stesso evento si rimanda UNA volta nel formato vecchio (tipo 'conferma', dettaglio 'tipo:posto'), e per
  // le 24 ore successive si manda subito così, senza ritentare ogni volta.
  const TIPI_ARRIVO = ['parcheggiato', 'occupato'];
  // 'categoria' (richiesta a TomTom Search) e 'satellite' (vista satellitare attivata) servono al pannello "Consumi e limiti gratuiti": sono tipi nuovi di supabase/18_consumi.sql.
  // Finché il database non li ammette, l'inserimento viene rifiutato (400) e l'evento si perde in silenzio: l'app non ne risente.
  const arrivoRifiutato = () => Date.now() - ls.get('dp.evArrivoNo', 0) < 864e5;
  const comeConferma = (c) => Object.assign({}, c, { tipo: 'conferma', dettaglio: (c.tipo + ':' + (c.dettaglio || '')).slice(0, 80) });
  function traccia(tipo, x, sempre) {
    // Niente statistiche da test automatici (Playwright/Selenium: navigator.webdriver) né da localhost e anteprime *.pages.dev: ogni origine
    // nuova crea un device_id nuovo e gonfiava i "nuovi telefoni". L'app nativa Capacitor ha hostname 'localhost' ma è un'app vera: non si blocca.
    if (!SITO_NATIVO() && (navigator.webdriver || /^(localhost|127\.0\.0\.1|\[::1\])$|\.pages\.dev$/i.test(location.hostname))) return;
    if (provaGoogle) return;
    if (!provaNota) { provaAttesa.push(() => traccia(tipo, x, sempre)); return; } // il plugin sta ancora rispondendo (pochi millisecondi)
    if (!sempre && !statAttive()) return;
    try {
      let corpo = Object.assign({ device_id: deviceId, tipo, piattaforma: PIATTAFORMA, versione: String(window.DP_VERSIONE || '').slice(0, 40) || null }, x || {});
      if (corpo.comune) corpo.comune = String(corpo.comune).slice(0, 80);
      const nuovo = TIPI_ARRIVO.includes(tipo); if (nuovo && arrivoRifiutato()) corpo = comeConferma(corpo);
      if (eInterno() && !internoRifiutato()) corpo.interno = true;
      const invia = (c) => fetch(CFG.SB + '/rest/v1/eventi', { method: 'POST', keepalive: true, headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(c) });
      const senza = (c) => { const n = Object.assign({}, c); delete n.interno; return n; };
      invia(corpo).then((r) => {
        if (r.status !== 400) return;
        // 400: o manca la colonna 'interno' (20) o il tipo nuovo (14/18). Prima si toglie 'interno' (una sola volta, poi 24 ore di pausa)...
        const p = corpo.interno ? invia(senza(corpo)).then((r2) => { if (r2.status !== 400) ls.set('dp.evInternoNo', Date.now()); return r2; }) : Promise.resolve(r);
        return p.then((r2) => { if (r2.status === 400 && nuovo && corpo.tipo === tipo) { ls.set('dp.evArrivoNo', Date.now()); return invia(comeConferma(senza(corpo))); } });
      }).catch(() => {});
    } catch (e) { /* le statistiche non devono mai disturbare l'app */ }
  }
  (function () { // errori dell'app: arrivano nel pannello admin (al massimo 5 per apertura, senza ripetizioni)
    const visti = new Set();
    const manda = (m) => { m = String(m || 'errore sconosciuto').replace(/https?:\/\/[^\s)]+\/(?=[^/\s)]+)/g, '').slice(0, 300); if (visti.size >= 5 || visti.has(m)) return; visti.add(m); traccia('errore', { dettaglio: m }); };
    window.addEventListener('error', (e) => { if (e && e.message) manda(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno || 0}`); });
    window.addEventListener('unhandledrejection', (e) => { const r = e && e.reason; if (r && r.name === 'AbortError') return; manda('promessa: ' + (r && (r.message || r)) ); });
  })();
  (function () { // "online adesso": un segnale ogni 2 minuti mentre l'app è aperta e in primo piano
    let nascosta = 0;
    setTimeout(() => traccia('avvio'), 1500); // dopo che la pagina ha scritto il numero di versione
    setInterval(() => { if (document.visibilityState === 'visible') traccia('attivo'); }, 120000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') nascosta = Date.now();
      else if (nascosta) { traccia(Date.now() - nascosta > 30 * 60000 ? 'avvio' : 'attivo'); nascosta = 0; }
    });
  })();

  // ---------- stato ----------
  const stalli = new Map();           // id -> stallo
  const filtri = { ver: false, cop: false, multi: false };
  let me = null;                      // {lat, lon}
  let seguo = true;                   // al primo fix la mappa va sulla posizione, finché non la sposti tu
  let selId = null;
  const salvati = new Map(ls.get('dp.salvati', []).map((x) => typeof x === 'string' ? [x, { id: x }] : [x.id, x])); // id -> {id, lat, lon, t, c}
  let aggiungo = false;               // sto segnalando un posto nuovo
  let dest = null;                    // destinazione scelta dalla ricerca: {t, sub, lat, lon}
  let raggio = ls.get('dp.raggio', 300);
  const occupati = new Set();         // id dei posti segnati occupati in questa sessione (non si salvano: alla riapertura sono di nuovo liberi)

  // ---------- utilità ----------
  function dist(a, b, c, d) { const R = 6371000, p = Math.PI / 180, x = (d - b) * p * Math.cos((a + c) * p / 2), y = (c - a) * p; return Math.sqrt(x * x + y * y) * R; }
  function fmtDist(m) { return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
  function fmtWalk(m) { return m > 2500 ? '' : Math.max(1, Math.round(m / 80)) + ' min a piedi'; }
  function quando(iso) { const g = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5); return g <= 0 ? 'oggi' : g === 1 ? 'ieri' : g < 60 ? g + ' giorni fa' : Math.round(g / 30) + ' mesi fa'; }
  const nomeVero = (s) => s.nome && !/^Parcheggio con posti riservati$/i.test(s.nome) ? s.nome : '';
  function titolo(s) { return nomeVero(s) || s.indirizzo || s._via || 'Posto riservato'; }
  // i posti senza indirizzo (molti arrivano da OpenStreetMap) lo ricevono dalla via più vicina, solo quando servono a schermo
  async function trovaVia(s) {
    if (s.indirizzo || nomeVero(s) || s._chiesto) return; s._chiesto = true;
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${s.lat}&lon=${s.lon}`); if (!r.ok) return;
      const p = ((await r.json()).features[0] || {}).properties || {};
      const via = p.street ? p.street + (p.housenumber ? ' ' + p.housenumber : '') : (p.type === 'street' ? p.name : '');
      if (via) { s._via = via; vicini(); if (dest) arrivo(false); if (selId === s.id) $('#c-title').textContent = titolo(s); fgRinfresca(); }
    } catch (e) { /* senza rete resta "Posto riservato" */ }
  }
  // computer: pannello fisso a sinistra e mappa a tutto schermo; telefono: pannelli dal basso
  const LARGO = () => window.matchMedia('(min-width:900px)').matches, COL = 448;
  const padPC = (m) => ({ top: 30 + (m || 0), bottom: 30 + (m || 0), left: COL + (m || 0), right: 30 + (m || 0) });
  const padHome = () => LARGO() ? padPC() : (aggiungo ? { top: 90, bottom: $('#add .sheet').offsetHeight || 0, left: 0, right: 0 } : { top: dest ? 90 : 150 + ($('#b-auto').hidden ? 0 : 58), bottom: $(dest ? '#arrivo' : '#home').offsetHeight || 0, left: 0, right: 0 });
  function mostra() { setTimeout(posizionaOffline, 0); const c = !!selId, d = !!dest, n = aggiungo; $('#card').hidden = !c; $('#add').hidden = !n || c; $('#home').hidden = c || d || n; $('#top').hidden = c || d || n; $('#destbar').hidden = c || !d || n; $('#arrivo').hidden = c || !d || n; }
  window.addEventListener('resize', () => { if (!pronta) return; map.resize(); if (LARGO()) espandi(true); if (!selId) map.setPadding(padHome()); });
  function affidabilita(s) { return s.stato === 'ufficiale' ? ['uff', 'Ufficiale'] : s.stato === 'verificato' ? ['ver', 'Verificato'] : ['prop', 'Da verificare']; }
  function posti(n) { return n === 1 ? '1 posto' : n + ' posti'; }
  let toastT;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 2600); }
  // Avviso fisso «Sei offline»: compare quando il telefono dice di non avere rete (eventi offline/online) o quando una richiesta dati fallisce per la rete,
  // e sparisce da solo al ritorno della rete. Sta sopra al pannello in basso (la sua altezza cambia: vedi posizionaOffline).
  const offline = $('#offline'); let reteKO = false;
  const TESTO_OFFLINE = 'Sei offline: vedi solo i posti già caricati';
  function aggiornaOffline() {
    const si = !navigator.onLine || reteKO; if (offline.hidden === !si) return;
    offline.hidden = !si; if (si) { offline.textContent = TESTO_OFFLINE; posizionaOffline(); $('#fg-live').textContent = TESTO_OFFLINE; } else { offline.textContent = ''; $('#fg-live').textContent = 'Sei di nuovo online'; }
  }
  function segnalaRete(ko) { if (reteKO !== ko) { reteKO = ko; aggiornaOffline(); } }
  function posizionaOffline() {
    if (offline.hidden || LARGO()) { offline.style.bottom = ''; return; }
    const vis = ['#fg-sheet', '#arrivo', '#card .sheet', '#add .sheet', '#home'].map((q) => document.querySelector(q)).find((el) => el && el.getClientRects().length);
    offline.style.bottom = (vis ? Math.round(window.innerHeight - vis.getBoundingClientRect().top) + 8 : 16) + 'px';
  }
  window.addEventListener('offline', aggiornaOffline);
  window.addEventListener('online', () => { reteKO = false; aggiornaOffline(); if (pronta) caricaVista(); });
  window.addEventListener('resize', posizionaOffline);
  if (window.ResizeObserver) { const ro = new ResizeObserver(posizionaOffline); ['#home', '#arrivo', '#card .sheet', '#add .sheet', '#fg-sheet'].forEach((q) => { const el = document.querySelector(q); if (el) ro.observe(el); }); }
  function apri(url) { window.open(url, '_blank'); }
  function passa(s) { return !(filtri.ver && s.stato === 'proposto') && !(filtri.cop && !s.coperto) && !(filtri.multi && !(s.posti >= 2)); }

  // ---------- dati ----------
  // I posti si chiedono al server solo per una zona piccola (funzione stalli_zona, al massimo 0,05° x 0,075°) e c'è un limite
  // di richieste per indirizzo: a mappa larga si chiedono solo conteggi a griglia (stalli_conteggi).
  const H = { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY };
  let ctl, pausa429 = 0;
  // Passo anti-bot (DORMIENTE: con CFG.TURNSTILE vuota, su Android o con modo "spento" non cambia nulla, non carica nulla e non
  // aggiunge intestazioni). Quando il database è in "osserva" o "obbliga", il web dimostra di essere un browser vero con
  // Turnstile, la funzione Edge «passo» lo cambia in un passo (30 minuti) che si manda in x-dp-passo. Resta solo in memoria.
  let passo = null, passoP = null, modoAB = null, tsScript = null;
  // modo letto dal database una volta per sessione: 'spento' | 'osserva' | 'obbliga' (errore = 'spento', si riprova alla prossima)
  const modoAntiBot = () => modoAB || (modoAB = fetch(`${CFG.SB}/rest/v1/rpc/app_config`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: '{}' })
    .then((r) => r.ok ? r.json() : null).then((c) => (c && (c.anti_bot_modo === 'osserva' || c.anti_bot_modo === 'obbliga')) ? c.anti_bot_modo : 'spento').catch(() => { modoAB = null; return 'spento'; }));
  const caricaTurnstile = () => tsScript || (tsScript = new Promise((ok, ko) => {
    const el = document.createElement('script'); el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; el.async = true;
    el.onload = () => ok(window.turnstile); el.onerror = () => { tsScript = null; ko(new Error('turnstile')); }; document.head.appendChild(el);
  }));
  async function provaTurnstile() { // un widget nuovo per ogni prova (la prova vale una volta sola); si vede solo se serve un gesto
    const ts = await caricaTurnstile(), box = document.createElement('div'); box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999'; document.body.appendChild(box);
    let id = null, timer;
    try { // la prova parte da sola al render; se dopo 45 secondi non è arrivata si rinuncia (mai bloccare l'app all'infinito)
      return await new Promise((ok, ko) => {
        timer = setTimeout(() => ko(new Error('turnstile')), 45000);
        id = ts.render(box, { sitekey: CFG.TURNSTILE, appearance: 'interaction-only', callback: ok,
          'error-callback': () => ko(new Error('turnstile')), 'timeout-callback': () => ko(new Error('turnstile')) });
      });
    } finally { clearTimeout(timer); try { if (id != null) ts.remove(id); } catch (e) {} box.remove(); }
  }
  function ottieniPasso(rinnova) { // rinnovo anche quando mancano meno di 2 minuti alla scadenza
    if (!rinnova && passo && passo.scade - Date.now() > 120000) return Promise.resolve(passo.t);
    if (passoP) return passoP;
    return passoP = (async () => {
      try {
        const prova = await provaTurnstile();
        const r = await fetch(CFG.PASSO_URL, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify({ origine: 'web', prova }) });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json(); passo = { t: j.passo, scade: Date.parse(j.scade) || Date.now() + 25 * 60000 }; return passo.t;
      } catch (e) { passo = null; return null; } finally { passoP = null; }
    })();
  }
  async function rpc(nome, args, signal) { // chiama una funzione del database; 429 = troppe richieste, non si ripete da soli
    const limite = () => Object.assign(new Error('429'), { status: 429 });
    if (Date.now() < pausa429) throw limite(); // già bloccati da poco: inutile insistere (si riprova da soli dopo 30 secondi, solo se l'utente muove la mappa)
    const web = !!CFG.TURNSTILE && !NATIVO();
    let modo = web ? await modoAntiBot() : 'spento', ab = modo !== 'spento';
    for (let giro = 0; ; giro++) {
      const h = Object.assign({ 'Content-Type': 'application/json' }, H);
      if (modo === 'obbliga' || giro > 0) { const t = await ottieniPasso(giro > 0); if (t) h['x-dp-passo'] = t; }
      else if (modo === 'osserva') { // in osserva non si aspetta mai: si manda il passo se c'è già, intanto lo si chiede in sottofondo
        if (passo && passo.scade - Date.now() > 120000) h['x-dp-passo'] = passo.t; else ottieniPasso(false);
      }
      let r; try { r = await fetch(`${CFG.SB}/rest/v1/rpc/${nome}`, { method: 'POST', headers: h, body: JSON.stringify(args), signal }); }
      catch (e) { if (e.name !== 'AbortError') segnalaRete(true); throw e; } // senza rete: avviso fisso «Sei offline»
      segnalaRete(false);
      if (r.status === 401 && web && giro === 0) { if (!ab) { modoAB = null; modo = await modoAntiBot(); ab = modo !== 'spento'; } if (ab) continue; } // 401: il database ha acceso il controllo o il passo è scaduto, una sola ripetizione
      if (r.status === 401 && ab) { toast('Non riesco a verificare il dispositivo. Ricarica la pagina.', 5000); throw Object.assign(new Error('401'), { status: 401, avvisato: true }); }
      if (r.status === 429) { pausa429 = Date.now() + 30000; throw limite(); }
      if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status });
      return r.json();
    }
  }
  const troppe = () => toast('Troppe richieste in poco tempo. Riprova tra qualche minuto.', 4500);
  const erroreDati = (err) => { if (err.name === 'AbortError' || err.avvisato) return; if (err.status === 429) troppe(); else if (err instanceof TypeError && !offline.hidden) { /* senza rete c'è già l'avviso fisso */ } else toast('Non riesco a caricare i posti. Controlla la connessione.'); };
  async function carica(s, w, n, e, annullabile) {
    if (annullabile) { if (ctl) ctl.abort(); ctl = new AbortController(); }
    const ZH = 0.049, ZW = 0.074; // il riquadro non può superare 0,05° x 0,075: se è più grande si stringe attorno al centro
    if (n - s > ZH) { const m = (n + s) / 2; s = m - ZH / 2; n = m + ZH / 2; }
    if (e - w > ZW) { const m = (e + w) / 2; w = m - ZW / 2; e = m + ZW / 2; }
    try {
      const rows = await rpc('stalli_zona', { p_s: s, p_w: w, p_n: n, p_e: e }, annullabile ? ctl.signal : undefined);
      if (stalli.size > 30000) stalli.clear();
      for (const x of rows) { const v = stalli.get(x.id); if (v && v._via) x._via = v._via; stalli.set(x.id, x); }
      disegna(); return rows;
    } catch (err) { erroreDati(err); return []; }
  }
  // Tre modi, secondo la vista: 'lontano' (sotto MIN_ZOOM_DATI: totali statici), 'conteggi' (mappa larga: cerchi con i numeri,
  // nessun singolo posto) e 'posti' (vista stretta: i singoli posti, come prima).
  let modo = 'lontano', conteggi = null, ctlC;
  function vediPosti(si) { if (!pronta) return; for (const l of ['gruppi', 'gruppi-n', 'pin', 'pin-i']) map.setLayoutProperty(l, 'visibility', si ? 'visible' : 'none'); }
  function passaA(m) {
    if (m === modo) return; modo = m; vediPosti(m === 'posti');
    if (m !== 'conteggi') { if (ctlC) ctlC.abort(); conteggi = null; if (pronta) map.getSource('conteggi').setData(VUOTO); }
  }
  function caricaVista() {
    zone();
    if (map.getZoom() < CFG.MIN_ZOOM_DATI) { passaA('lontano'); vicini(); return; }
    const b = map.getBounds(), h = b.getNorth() - b.getSouth(), w = b.getEast() - b.getWest();
    if (h <= CFG.MAX_H && w <= CFG.MAX_W) { // vista stretta: i posti con un margine del 25% (ridotto se serve per restare nel limite del server)
      passaA('posti'); const dy = h * 0.25, dx = Math.min(w * 0.25, (0.074 - w) / 2);
      carica(b.getSouth() - dy, b.getWest() - dx, b.getNorth() + dy, b.getEast() + dx, true); return;
    }
    passaA('conteggi'); if (ctl) ctl.abort(); caricaConteggi(b); vicini();
  }
  async function caricaConteggi(b) {
    if (ctlC) ctlC.abort(); ctlC = new AbortController(); const mio = ctlC;
    try {
      const rows = await rpc('stalli_conteggi', { p_s: b.getSouth(), p_w: b.getWest(), p_n: b.getNorth(), p_e: b.getEast() }, mio.signal);
      if (modo !== 'conteggi' || ctlC !== mio) return;
      conteggi = { celle: rows, b: { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() } };
      map.getSource('conteggi').setData({ type: 'FeatureCollection', features: rows.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: { n: c.stalli, p: c.posti, t: num(c.posti), r: Math.round(Math.min(46, 15 + 2.4 * Math.sqrt(c.posti))) } })) });
      vicini();
    } catch (err) { erroreDati(err); }
  }
  function avvicinaA(centro) { // dal cerchio alla zona: si avvicina finché la vista è abbastanza stretta da mostrare i posti
    const b = map.getBounds(), z = map.getZoom(), k = Math.max((b.getNorth() - b.getSouth()) / (CFG.MAX_H * 0.8), (b.getEast() - b.getWest()) / (CFG.MAX_W * 0.8));
    seguo = false; map.easeTo({ center: centro, zoom: Math.min(17, Math.max(z + 0.6, z + Math.log2(k))), duration: 500 });
  }

  // ---------- mappa ----------
  let chiaveEsri = ''; // la dà il database (app_config.chiave_esri), mai scritta nel codice; vuota = niente vista satellitare
  const ESRI_HOST = /^https:\/\/[^/]*\.arcgis\.com\//;
  const map = new maplibregl.Map({ container: 'map', style: window.matchMedia('(prefers-color-scheme: dark)').matches ? CFG.STYLE_SCURO : CFG.STYLE,
    transformRequest: (url) => (chiaveEsri && ESRI_HOST.test(url) && !/[?&]token=/.test(url)) ? { url: url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(chiaveEsri) } : undefined, center: CFG.HOME, zoom: 14.5, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
  map.touchZoomRotate.disableRotation();
  // Accessibilità: la mappa ha un nome in italiano per i lettori di schermo; i posti si raggiungono anche dall'elenco «Il più vicino in questa zona»
  try { const cv = map.getCanvas(); cv.setAttribute('aria-label', 'Mappa dei posti per disabili. L\'elenco dei posti vicini è sotto la mappa.'); cv.setAttribute('role', 'region'); } catch (e) {}
  // Chi ha chiesto meno animazioni (impostazioni di sistema) non vede voli e scorrimenti della mappa
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { map.flyTo = map.jumpTo.bind(map); map.easeTo = map.jumpTo.bind(map); }
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  { const at = document.querySelector('.maplibregl-ctrl-attrib'), slot = document.getElementById('slot-i'); if (at && slot) slot.appendChild(at); } // la «i» sta nella colonna dei pulsanti, subito sopra la vista satellitare
  (function () { // «Come leggere la mappa»: la legenda dei segnaposto sta nel pannello della «i» della mappa, sopra i crediti
    const at = document.querySelector('.maplibregl-ctrl-attrib'), inner = at && at.querySelector('.maplibregl-ctrl-attrib-inner'); if (!at || !inner) return;
    const riga = (cls, b, t) => `<div class="leg-r"><span class="leg-p ${cls}" aria-hidden="true">${icon('wc')}</span><span><b>${b}</b><span>${t}</span></span></div>`;
    const d = document.createElement('div'); d.className = 'legenda';
    d.innerHTML = `<h2>Come leggere la mappa</h2>${riga('pieno', 'Pieno: affidabile', 'Dato ufficiale del Comune o confermato da chi c\'è stato')}${riga('dav', 'Vuoto: da verificare', 'Probabile, ma nessuno l\'ha ancora confermato')}${riga('giallo', 'Giallo: il posto scelto', 'Quello che hai aperto o il più vicino')}<p class="leg-n">Il numero sui cerchi grandi è quanti posti ci sono in quel gruppo.</p>`;
    at.insertBefore(d, inner);
    const cont = at.closest('.maplibregl-ctrl-bottom-right'); if (cont) document.body.appendChild(cont); // fuori da #map: la legenda aperta sta sopra pulsanti e pannelli
    const sm = at.querySelector('summary'); if (sm) { sm.setAttribute('aria-label', 'Come leggere la mappa e crediti'); sm.setAttribute('title', 'Come leggere la mappa e crediti'); }
  })();
  window.__dp = { map, stalli }; // per le prove

  function glifo(colore) { // il simbolo disegnato su un quadratino trasparente, per i pin
    const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
    x.scale(2, 2); x.strokeStyle = colore; x.lineWidth = 2.3; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.arc(10, 4.5, 1.8, 0, Math.PI * 2); x.stroke();
    x.stroke(new Path2D('M10 8.5v5.5h5l2.5 5')); x.stroke(new Path2D('M7.5 11.5a5.5 5.5 0 1 0 7.5 7'));
    return x.getImageData(0, 0, 48, 48);
  }
  function glifoX(colore) { // la X dei posti occupati, su un quadratino trasparente
    const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
    x.scale(2, 2); x.strokeStyle = colore; x.lineWidth = 3; x.lineCap = 'round'; x.beginPath(); x.moveTo(7, 7); x.lineTo(17, 17); x.moveTo(17, 7); x.lineTo(7, 17); x.stroke();
    return x.getImageData(0, 0, 48, 48);
  }
  const VUOTO = { type: 'FeatureCollection', features: [] };
  // ---------- vista da lontano: quanti posti per regione, provincia, comune ----------
  let riepilogo = null, livello = '';
  const LIVELLI = [['regioni', 7.2, 8.4], ['province', 9.6, 10.6], ['comuni', CFG.MIN_ZOOM_DATI, 14.2]]; // nome, fino a che zoom, zoom dopo il tocco (14,2: la vista è abbastanza stretta per i singoli posti)
  const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, '.');
  function fondoZona(P) { // fondo blu arrotondato che si allarga attorno al testo
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    x.beginPath(); x.roundRect(3, 3, 58, 58, 22); x.fillStyle = P.zonaFondo; x.fill(); x.lineWidth = 4; x.strokeStyle = P.zonaBordo; x.stroke();
    return x.getImageData(0, 0, 64, 64);
  }
  function zone() {
    if (!pronta || !riepilogo) return;
    const z = map.getZoom(), l = (LIVELLI.find((v) => z < v[1]) || [''])[0];
    if (l === livello) return; livello = l;
    map.getSource('zone').setData(l ? { type: 'FeatureCollection', features: riepilogo[l].map((v) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] }, properties: { n: v.n, t: v.t, tl: num(v.t) } })) } : VUOTO);
  }
  // Totali per regione/provincia/comune: prima la copia statica servita dal sito (Cloudflare, vedi tools/pubblica.py, che la scarica
  // a ogni build), solo se manca o non è valida la riserva sullo storage di Supabase (che consuma traffico). Dopo ogni aggiornamento
  // della copertura (tools/copertura.py) serve una nuova pubblicazione del sito per aggiornare la copia.
  // Sul web è accanto alla pagina (app/copertura.json); nell'app Android sta sul sito: CFG.SITO + 'app/copertura.json'
  // (finché CFG.SITO è l'indirizzo provvisorio la copia non c'è e si usa la riserva).
  const COPERTURA_STATICA = SITO_NATIVO() ? CFG.SITO + 'app/copertura.json' : 'copertura.json';
  const copertura = (url) => fetch(url).then((r) => r.ok ? r.json() : null).then((j) => j && j.regioni ? j : null).catch(() => null);
  copertura(COPERTURA_STATICA).then((j) => j || copertura(CFG.SB + '/storage/v1/object/public/foto/copertura/riepilogo.json')).then((j) => { if (j) { riepilogo = j; zone(); vicini(); } });
  let baseVis = null; // i livelli della mappa stradale e come erano: servono per nasconderli in vista satellitare
  // Tema: segue il telefono/browser (prefers-color-scheme), nessun interruttore. I colori dei pin e dei cerchi sulla mappa vengono da qui.
  const TEMA_SCURO = window.matchMedia('(prefers-color-scheme: dark)');
  const scuro = () => TEMA_SCURO.matches;
  const PAL = () => scuro()
    ? { pieno: '#8fb4ff', icPieno: '#0b1f44', dav: '#1b2230', davBordo: '#8fb4ff', icDav: '#8fb4ff', anello: '#1b2230', occ: '#6b7686', gruppo: '#8fb4ff', testoG: '#0b1f44', zonaFondo: '#8fb4ff', zonaBordo: '#1b2230', selBordo: '#1b2230' }
    : { pieno: '#0b2a5b', icPieno: '#ffffff', dav: '#ffffff', davBordo: '#0b2a5b', icDav: '#0b2a5b', anello: '#ffffff', occ: '#6b7686', gruppo: '#0b2a5b', testoG: '#ffffff', zonaFondo: '#0b2a5b', zonaBordo: '#ffffff', selBordo: '#0b1f44' };
  // Affidabilità sulla mappa: pieno = ufficiale o verificato; bianco con bordo spesso = da verificare (proposto); giallo = il posto scelto. La legenda sta nella «i» della mappa.
  function aggiungiLivelli() { // immagini, sorgenti e livelli nostri: si rifanno da capo se la mappa cambia stile (tema chiaro/scuro)
    const P = PAL(), img = (n, im, o) => { if (map.hasImage(n)) map.removeImage(n); map.addImage(n, im, Object.assign({ pixelRatio: 2 }, o)); };
    img('wc-w', glifo(P.icPieno)); img('wc-b', glifo(P.icDav)); img('wc-d', glifo('#2b2300')); img('x-w', glifoX('#ffffff'));
    map.addSource('stalli', { type: 'geojson', data: VUOTO, cluster: true, clusterRadius: 42, clusterMaxZoom: 15 });
    map.addSource('sel', { type: 'geojson', data: VUOTO }); map.addSource('conteggi', { type: 'geojson', data: VUOTO });
    map.addSource('zone', { type: 'geojson', data: VUOTO }); img('zona', fondoZona(P), { stretchX: [[26, 38]], stretchY: [[26, 38]], content: [16, 11, 48, 53] });
    map.addLayer({ id: 'zone', type: 'symbol', source: 'zone', maxzoom: CFG.MIN_ZOOM_DATI, layout: { 'icon-image': 'zona', 'icon-text-fit': 'both', 'symbol-sort-key': ['-', ['get', 't']], 'text-field': ['format', ['get', 'n'], { 'font-scale': 0.8 }, '\n', {}, ['get', 'tl'], { 'text-font': ['literal', ['Noto Sans Bold']] }], 'text-font': ['Noto Sans Regular'], 'text-size': 15, 'text-line-height': 1.25, 'text-max-width': 9, 'text-padding': 6 }, paint: { 'text-color': P.testoG } });
    map.addLayer({ id: 'gruppi', type: 'circle', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['has', 'point_count'], paint: { 'circle-color': P.gruppo, 'circle-radius': ['step', ['get', 'point_count'], 17, 10, 21, 50, 25], 'circle-stroke-color': P.anello, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'gruppi-n', type: 'symbol', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': P.testoG } });
    const dav = ['==', ['get', 'stato'], 'proposto'];
    map.addLayer({ id: 'pin', type: 'circle', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['!', ['has', 'point_count']], paint: {
      'circle-radius': ['case', ['get', 'occ'], 16, dav, 14.5, 17], 'circle-color': ['case', ['get', 'occ'], P.occ, dav, P.dav, P.pieno],
      'circle-stroke-color': ['case', ['get', 'occ'], P.anello, dav, P.davBordo, P.anello], 'circle-stroke-width': ['case', ['get', 'occ'], 3, dav, 3, 2] } });
    map.addLayer({ id: 'pin-i', type: 'symbol', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['!', ['has', 'point_count']], layout: { 'icon-image': ['case', ['get', 'occ'], 'x-w', dav, 'wc-b', 'wc-w'], 'icon-size': 0.8, 'icon-allow-overlap': true } });
    map.addLayer({ id: 'conteggi', type: 'circle', source: 'conteggi', paint: { 'circle-color': P.gruppo, 'circle-radius': ['get', 'r'], 'circle-stroke-color': P.anello, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'conteggi-n', type: 'symbol', source: 'conteggi', layout: { 'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': P.testoG } });
    map.addLayer({ id: 'sel', type: 'circle', source: 'sel', paint: { 'circle-radius': 23, 'circle-color': '#ffcc00', 'circle-stroke-color': P.selBordo, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'sel-i', type: 'symbol', source: 'sel', layout: { 'icon-image': 'wc-d', 'icon-size': 1.15, 'icon-allow-overlap': true } });
  }
  // Mappa scura: stile «dark» di OpenFreeMap (stesse sorgenti e caratteri di «positron»), con qualche colore ritoccato perché strade e nomi restino leggibili
  function ritoccaScuro() {
    const c = (id, prop, v) => { try { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); } catch (e) { /* livello assente in questo stile */ } };
    c('background', 'background-color', '#1b2230'); c('water', 'fill-color', '#141a26'); c('waterway', 'line-color', '#141a26');
    c('landuse_residential', 'fill-color', '#1d2534'); c('landcover_wood', 'fill-color', '#1f2c33'); c('landuse_park', 'fill-color', '#1f2c33'); c('building', 'fill-color', '#232c3b');
    c('highway_path', 'line-color', '#3a4559'); c('highway_minor', 'line-color', '#313b4d'); c('highway_major_casing', 'line-color', '#3d4960'); c('highway_major_inner', 'line-color', '#3a4559'); c('highway_major_subtle', 'line-color', '#3a4559');
    c('highway_motorway_casing', 'line-color', '#3d4960'); c('highway_motorway_inner', 'line-color', '#4a5873'); c('highway_motorway_subtle', 'line-color', '#313b4d');
    c('railway', 'line-color', '#3f4a5f'); c('railway_minor', 'line-color', '#3f4a5f'); c('railway_transit', 'line-color', '#3f4a5f');
    c('highway_name_other', 'text-color', '#b9c3d3'); c('highway_name_other', 'text-halo-color', '#1b2230'); c('highway_name_motorway', 'text-color', '#b9c3d3');
    ['place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_city_large', 'place_state', 'place_country_other', 'place_country_minor', 'place_country_major'].forEach((id) => { c(id, 'text-color', '#c9d2e0'); c(id, 'text-halo-color', 'rgba(27,34,48,.85)'); });
    c('water_name', 'text-color', '#8d9bb0'); c('water_name', 'text-halo-color', '#141a26');
  }
  map.on('load', () => {
    if (scuro()) ritoccaScuro();
    baseVis = map.getStyle().layers.map((l) => [l.id, (l.layout && l.layout.visibility) || 'visible']);
    aggiungiLivelli();
    map.on('click', 'zone', (e) => { const f = e.features[0], v = LIVELLI.find((x) => x[0] === livello); seguo = false; map.easeTo({ center: f.geometry.coordinates, zoom: v ? v[2] : 13 }); });
    map.on('click', 'conteggi', (e) => avvicinaA(e.features[0].geometry.coordinates));
    map.on('mouseenter', 'conteggi', () => { map.getCanvas().style.cursor = 'pointer'; }); map.on('mouseleave', 'conteggi', () => { map.getCanvas().style.cursor = ''; });
    // Posti e gruppi si toccano con un'area di almeno 44 x 44 px attorno al dito, anche se il disegno è più piccolo (pin 36 px): vince il più vicino al tocco
    map.on('click', (e) => {
      if (!pronta || modo !== 'posti') return;
      const R = 22, p = e.point, fs = map.queryRenderedFeatures([[p.x - R, p.y - R], [p.x + R, p.y + R]], { layers: ['pin', 'gruppi'] }); if (!fs.length) return;
      let best = null, bd = 1e9; for (const f of fs) { const q = map.project(f.geometry.coordinates), d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = f; } }
      if (best.properties.cluster_id != null) Promise.resolve(map.getSource('stalli').getClusterExpansionZoom(best.properties.cluster_id)).then((z) => map.easeTo({ center: best.geometry.coordinates, zoom: Math.min(z, 18) }));
      else apriScheda(best.properties.id);
    });
    const at = document.querySelector('.maplibregl-ctrl-attrib'); if (at) { at.classList.remove('maplibregl-compact-show'); at.removeAttribute('open'); } // i crediti della mappa partono chiusi (si aprono dalla i)
    pronta = true; vediPosti(false); if (LARGO()) { map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right'); espandi(true); }
    map.setPadding(padHome()); disegna(); zone(); caricaVista();
  });
  // Il telefono cambia tema mentre l'app è aperta: lo stile della mappa si cambia al volo (in vista satellitare si aspetta di tornare alla stradale)
  let stileDa = scuro(), stilePendente = false;
  function applicaTema() {
    if (!pronta || stileDa === scuro()) { stilePendente = false; return; }
    if (sat) { stilePendente = true; return; }
    stilePendente = false; stileDa = scuro();
    map.setStyle(scuro() ? CFG.STYLE_SCURO : CFG.STYLE, { diff: false }); // diff:false: niente confronto tra stili, scatta sempre style.load e i nostri livelli si ricreano
    map.once('style.load', () => {
      if (scuro()) ritoccaScuro();
      baseVis = map.getStyle().layers.map((l) => [l.id, (l.layout && l.layout.visibility) || 'visible']); satIds = null; livello = '';
      aggiungiLivelli(); vediPosti(modo === 'posti'); disegna(); zone(); caricaVista();
    });
  }
  (TEMA_SCURO.addEventListener ? TEMA_SCURO.addEventListener('change', applicaTema) : TEMA_SCURO.addListener(applicaTema));

  // ---------- vista satellitare (immagini Esri) ----------
  // Il database dà la chiave (app_config, una sola chiamata per avvio, anche per l'aggiornamento obbligatorio). Senza chiave il pulsante non c'è.
  // Lo stile Esri ("Basemap Styles", v2, arcgis/imagery) si scarica SOLO alla prima attivazione: immagini + nomi di strade e luoghi in italiano.
  // Si aggiunge alla mappa SOTTO i nostri livelli e si nascondono quelli stradali: i pin, i cerchi e le etichette restano sopra.
  // Con la vista stradale i livelli Esri sono nascosti, quindi non si chiede nessun riquadro a Esri.
  const configApp = fetch(`${CFG.SB}/rest/v1/rpc/app_config`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: '{}' })
    .then((r) => r.ok ? r.json() : null).catch(() => null);
  const ESRI_STILI = 'https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/', ESRI_ERR = [401, 403, 429, 498, 499];
  let sat = false, satKO = false, satIds = null, satOcc = false;
  const btnSat = $('#b-sat');
  const fontEsri = (f) => { const t = JSON.stringify(f || ''); return [/bold/i.test(t) ? 'Noto Sans Bold' : /italic/i.test(t) ? 'Noto Sans Italic' : 'Noto Sans Regular']; }; // i caratteri dei nomi sono quelli già usati dalla mappa
  function adattaEsri(stile, pre) { // rinomina sorgenti e livelli per non incrociarsi con i nostri; niente icone (lo sprite è un altro)
    const src = {}, lay = [], testi = [];
    for (const [k, v] of Object.entries(stile.sources || {})) { const c = Object.assign({}, v), t = c.attribution || c.copyrightText; if (t) testi.push(String(t)); delete c.copyrightText; delete c.attribution; src[pre + k] = c; }
    for (const l of stile.layers || []) {
      const c = JSON.parse(JSON.stringify(l)); c.id = pre + l.id; if (c.source) c.source = pre + c.source;
      if (c.type === 'symbol') { c.layout = c.layout || {}; c.layout['text-font'] = fontEsri(c.layout['text-font']); delete c.layout['icon-image']; }
      lay.push(c);
    }
    return { src, lay, testi };
  }
  async function caricaStiliEsri() { // un solo stile: «arcgis/imagery» contiene già le immagini e i nomi (chiesti in italiano). Caricare anche «imagery/labels» raddoppiava nomi e livelli e appesantiva lo zoom sul telefono
    const r = await fetch(ESRI_STILI + 'arcgis/imagery?language=it&token=' + encodeURIComponent(chiaveEsri));
    if (!r.ok) { const e = new Error('esri'); e.status = r.status; throw e; }
    const A = adattaEsri(await r.json(), 'esri-i-');
    const primo = Object.keys(A.src)[0]; if (!primo || !A.lay.length) throw new Error('esri: stile vuoto');
    // crediti: «Powered by Esri» e le fonti delle immagini stanno nei crediti della mappa (la «i»), come quelli di OpenStreetMap
    A.src[primo].attribution = '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a> | ' + [...new Set(A.testi.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' · ');
    for (const k of Object.keys(A.src)) map.addSource(k, A.src[k]);
    for (const l of A.lay) map.addLayer(l, 'zone');
    satIds = A.lay.map((l) => l.id);
  }
  function togliEsri() { // a metà caricamento qualcosa non è andato: via ogni pezzo di Esri, così non resta nulla di mezzo visibile
    satIds = null; try { map.getStyle().layers.filter((l) => l.id.startsWith('esri-')).forEach((l) => map.removeLayer(l.id)); Object.keys(map.getStyle().sources).filter((k) => k.startsWith('esri-')).forEach((k) => map.removeSource(k)); } catch (e) { /* già tolto */ }
  }
  function mostraVista() {
    if (!baseVis) return;
    const imp = (id, v) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v); };
    baseVis.forEach(([id, v]) => imp(id, sat ? 'none' : v)); (satIds || []).forEach((id) => imp(id, sat ? 'visible' : 'none'));
    $('#map').classList.toggle('sat', sat); document.body.classList.toggle('sat', sat);
    const at = document.querySelector('.maplibregl-ctrl-attrib'); if (at) { at.classList.remove('maplibregl-compact-show'); at.removeAttribute('open'); } // i crediti restano chiusi nella «i» anche con la vista satellitare, come sulla mappa stradale
    btnSat.hidden = !chiaveEsri || satKO; btnSat.setAttribute('aria-pressed', String(sat)); btnSat.setAttribute('aria-label', 'Vista satellitare, ' + (sat ? 'attiva' : 'non attiva'));
  }
  function satErrore() { // chiave scaduta, quota finita o servizio giù: si torna da soli alla mappa stradale, senza riprovare fino al prossimo avvio
    if (satKO) return; satKO = true; sat = false; mostraVista(); toast('La vista satellitare non è disponibile in questo momento', 4000);
  }
  async function passaVista(on, salva) {
    if (satOcc || satKO || !pronta) return;
    if (on && !chiaveEsri) return;
    if (on && !satIds) { satOcc = true; try { await caricaStiliEsri(); } catch (e) { satOcc = false; togliEsri(); satErrore(); return; } satOcc = false; }
    sat = on; mostraVista(); if (on) traccia('satellite'); if (salva) ls.set('dp.vista', on ? 'sat' : ''); if (!on && stilePendente) applicaTema();
  }
  map.on('error', (e) => { if (sat && e && e.sourceId && String(e.sourceId).startsWith('esri-') && e.error && ESRI_ERR.includes(e.error.status)) satErrore(); });
  btnSat.onclick = () => passaVista(!sat, true);
  configApp.then((c) => {
    chiaveEsri = c && typeof c.chiave_esri === 'string' && c.chiave_esri.length > 8 ? c.chiave_esri : ''; if (!chiaveEsri) return;
    const via = () => { btnSat.hidden = false; if (ls.get('dp.vista', '') === 'sat') passaVista(true, false); };
    if (pronta) via(); else map.once('load', via);
  });
  // Stile della mappa che non si carica: al posto del pannello vuoto e di un toast, un messaggio fisso nel pannello in basso con «Riprova» (ricarica lo stile).
  let stileOk = false;
  map.on('style.load', () => { stileOk = true; });
  map.on('error', (e) => { if (!pronta && !stileOk && e && !e.sourceId) erroreStile(); });
  function erroreStile() {
    $('#near-body').innerHTML = `<div class="eyebrow">Mappa non disponibile</div><div class="empty" role="alert">La mappa non si carica. Controlla la connessione e riprova.</div><button class="primary" data-riprova="1">${icon('locate')}<span>Riprova</span></button>`;
    $('#fg-live').textContent = 'La mappa non si carica. Controlla la connessione e riprova.';
  }
  function riprovaStile() {
    $('#near-body').innerHTML = '<div class="eyebrow">Mappa</div><div class="empty" role="status">Carico la mappa…</div>';
    stileOk = false; try { map.setStyle(CFG.STYLE); } catch (err) { erroreStile(); }
  }
  let pronta = false, moveT;
  map.on('dragstart', () => { seguo = false; });
  map.on('moveend', () => { clearTimeout(moveT); moveT = setTimeout(caricaVista, 300); if (aggiungo) qui(); });

  function disegna() {
    if (!pronta) return;
    const feats = [];
    for (const s of stalli.values()) if (passa(s)) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, stato: s.stato, occ: occupati.has(s.id) } });
    map.getSource('stalli').setData({ type: 'FeatureCollection', features: feats });
    const s = selId && stalli.get(selId);
    map.getSource('sel').setData(s ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: {} }] } : VUOTO);
    vicini();
  }

  // ---------- posizione ----------
  let meMarker = null, ultimoCarico = null;
  let meVecchia = false; // la prima posizione mostrata è l'ultima nota al telefono (subito), in attesa di quella precisa
  function setMe(lat, lon, vecchia) {
    if (vecchia && me) return;
    const primo = !me, affina = !!me && meVecchia && !vecchia && dist(lat, lon, me.lat, me.lon) > 30; meVecchia = !!vecchia; me = { lat, lon };
    if (!meMarker) { const el = document.createElement('div'); el.className = 'me'; el.setAttribute('role', 'img'); el.setAttribute('aria-label', 'La tua posizione'); el.innerHTML = '<i></i>'; meMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map); } else meMarker.setLngLat([lon, lat]);
    if (primo && seguo && !selId) map.jumpTo({ center: [lon, lat], zoom: 16, padding: padHome() });
    else if (affina && seguo && !selId) map.easeTo({ center: [lon, lat], duration: 400 }); // la posizione precisa è lontana da quella mostrata subito: la mappa la segue, senza cambiare lo zoom
    if (!ultimoCarico || dist(lat, lon, ultimoCarico.lat, ultimoCarico.lon) > 300) { ultimoCarico = { lat, lon }; carica(lat - 0.024, lon - 0.035, lat + 0.024, lon + 0.035, false); }
    vicini(); if (selId) aggiornaConferma(); aggiornaPillAuto(); fgAggiornaAuto();
  }
  async function attivaPosizione(chiedi) {
    const cap = window.Capacitor, G = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Geolocation;
    try {
      if (G) {
        let p = await G.checkPermissions();
        if (p.location !== 'granted') { if (!chiedi) return false; p = await G.requestPermissions(); if (p.location !== 'granted') return false; }
        // subito l'ultima posizione nota (fino a 5 minuti fa), senza aspettare il GPS: la mappa si apre già nel posto giusto, poi arriva quella precisa
        Promise.resolve(G.getCurrentPosition({ enableHighAccuracy: false, maximumAge: 300000, timeout: 3000 })).then((pos) => { if (pos && pos.coords) setMe(pos.coords.latitude, pos.coords.longitude, true); }).catch(() => {});
        await G.watchPosition({ enableHighAccuracy: true, timeout: 20000 }, (pos) => { if (pos && pos.coords) setMe(pos.coords.latitude, pos.coords.longitude); });
        return true;
      }
      if (!navigator.geolocation) return false;
      if (!chiedi && navigator.permissions) { const st = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null); if (st && st.state !== 'granted') return false; }
      navigator.geolocation.getCurrentPosition((pos) => setMe(pos.coords.latitude, pos.coords.longitude, true), () => {}, { enableHighAccuracy: false, maximumAge: 300000, timeout: 3000 });
      navigator.geolocation.watchPosition((pos) => setMe(pos.coords.latitude, pos.coords.longitude), () => { if (chiedi) toast('Posizione non disponibile. Puoi comunque muovere la mappa.'); }, { enableHighAccuracy: true, maximumAge: 5000 });
      return true;
    } catch (e) { return false; }
  }

  // ---------- pannello "il più vicino" ----------
  // ---------- distanze e tempi su strada ----------
  // In auto da dove sei tu, a piedi dalla destinazione. Per ora dal servizio gratuito di OpenStreetMap (senza traffico);
  // se non risponde restano le distanze in linea d'aria.
  const cacheT = new Map(); let pausaT = 0;
  const kT = (o, s, prof) => `${prof}${o.lat.toFixed(3)},${o.lon.toFixed(3)}>${s.id}`;
  const suStrada = (o, s, prof) => cacheT.get(kT(o, s, prof)) || null;
  const fmtMin = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
  async function tempi(o, arr, prof) {
    if (Date.now() < pausaT) return false;
    const manca = arr.filter((x) => !cacheT.has(kT(o, x.s, prof))).slice(0, 15); if (!manca.length) return false;
    manca.forEach((x) => cacheT.set(kT(o, x.s, prof), null)); // prenotati: niente doppie richieste
    try {
      const coords = [o].concat(manca.map((x) => x.s)).map((q) => `${q.lon},${q.lat}`).join(';');
      const r = await fetch(`https://routing.openstreetmap.de/routed-${prof}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`);
      if (!r.ok) throw new Error(r.status); const j = await r.json();
      manca.forEach((x, i) => { const m = j.distances && j.distances[0][i + 1], sec = j.durations && j.durations[0][i + 1]; if (m != null && sec != null) cacheT.set(kT(o, x.s, prof), { m, sec }); });
      if (cacheT.size > 4000) cacheT.clear();
      return true;
    } catch (e) { manca.forEach((x) => cacheT.delete(kT(o, x.s, prof))); pausaT = Date.now() + 60000; return false; }
  }

  // Traffico reale (TomTom Routing, piano gratuito a quota mensile): la richiesta parte SOLO quando si apre la scheda di un posto,
  // mai in automatico per l'elenco dei vicini (lì vale la stima senza traffico di suStrada). Una richiesta per posto e per posizione:
  // la risposta vale 10 minuti e finché ci si sposta di meno di 300 m dal punto in cui è stata chiesta; riaprire lo stesso posto non richiama TomTom.
  const TT = window.DP_TOMTOM || '', cacheTT = new Map();
  const VALIDITA_TT = 600000; // 10 minuti
  const fresco = (c) => c && me && Date.now() - c.t < VALIDITA_TT && dist(me.lat, me.lon, c.lat, c.lon) < 300;
  function traffico(s) { const c = cacheTT.get(s.id); return fresco(c) && c.sec != null ? c : null; }
  async function chiediTraffico(s) {
    if (!TT || !me || fresco(cacheTT.get(s.id))) return false;
    const c = { t: Date.now(), lat: me.lat, lon: me.lon }; cacheTT.set(s.id, c); // prenotata subito: niente doppie richieste in parallelo
    if (cacheTT.size > 300) cacheTT.delete(cacheTT.keys().next().value);
    try {
      const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${me.lat},${me.lon}:${s.lat},${s.lon}/json?key=${TT}&traffic=true&travelMode=car&routeType=fastest`);
      if (!r.ok) throw new Error(r.status); const su = (await r.json()).routes[0].summary;
      c.m = su.lengthInMeters; c.sec = su.travelTimeInSeconds; c.rit = su.trafficDelayInSeconds || 0; return true;
    } catch (e) { c.t = Date.now() - VALIDITA_TT + 60000; return false; } // errore: si può riprovare dopo 1 minuto, non di continuo
  }
  const inAuto = (r) => `${fmtDist(r.m)} · ${fmtMin(r.sec)} in auto${r.rit >= 120 ? ` (traffico +${Math.round(r.rit / 60)} min)` : ''}`;

  let espanso = false; // pannello tirato su: mostra fino a 15 posti invece di 3
  function elencoVicini() {
    const c = map.getCenter(); const usoMe = me && dist(me.lat, me.lon, c.lat, c.lng) < 1500;
    const ref = usoMe ? me : { lat: c.lat, lon: c.lng };
    const tutti = []; for (const s of stalli.values()) if (passa(s)) { const d = dist(ref.lat, ref.lon, s.lat, s.lon); if (d < 5000) tutti.push({ s, d }); }
    tutti.sort((a, b) => a.d - b.d);
    let out = []; const quanti = espanso ? 15 : 3; // niente doppioni a pochi metri l'uno dall'altro
    for (const x of tutti) { if (!out.some((y) => dist(x.s.lat, x.s.lon, y.s.lat, y.s.lon) < 25)) out.push(x); if (out.length === Math.max(quanti, 8)) break; }
    if (usoMe) { // in auto conta la strada, non la linea d'aria: riordino con i tempi di guida appena arrivano
      out.forEach((x) => { x.r = suStrada(me, x.s, 'car'); });
      out.sort((a, b) => (a.r ? a.r.sec : a.d / 7) - (b.r ? b.r.sec : b.d / 7));
      tempi(me, out, 'car').then((ok) => { if (ok) { vicini(); if (selId) sottotitolo(); } });
    }
    return { usoMe, out: out.slice(0, quanti) };
  }
  const quanto = (x) => x.r ? inAuto(x.r) : fmtDist(x.d);
  function vicini() {
    if (!pronta || dest) return;
    const el = $('#near-body');
    if (map.getZoom() < CFG.MIN_ZOOM_DATI) {
      el.innerHTML = riepilogo ? `<div class="eyebrow">In tutta Italia</div><div class="italia"><b>${num(riepilogo.totale)}</b> posti riservati in ${num(riepilogo.comuni.length)} comuni</div><div class="empty">Tocca una zona sulla mappa per avvicinarti.</div>`
        : '<div class="eyebrow">Mappa troppo lontana</div><div class="empty">Avvicinati con due dita per vedere i posti della zona.</div>';
      return;
    }
    if (modo === 'conteggi') {
      const c = conteggi, dentro = c && c.celle.filter((x) => x.lat >= c.b.s && x.lat <= c.b.n && x.lon >= c.b.w && x.lon <= c.b.e), d = c && (dentro.length ? dentro : c.celle), tot = d ? d.reduce((a, x) => a + x.posti, 0) : 0; // le celle con il centro nella vista (se nessuna, tutte)
      el.innerHTML = `<div class="eyebrow">Mappa larga</div><div class="italia">${!c ? 'Cerco i posti della zona…' : tot ? `<b>${num(tot)}</b> ${tot === 1 ? 'posto riservato' : 'posti riservati'} in questa zona` : 'Nessun posto riservato in questa zona'}</div>
        <div class="empty">Avvicinati o cerca un indirizzo per vedere i singoli posti</div>
        <button class="primary" data-me="1">${icon('locate')}<span>Mostra i posti vicino a me</span></button>`;
      return;
    }
    const { usoMe, out } = elencoVicini();
    if (!out.length) { const fl = filtri.ver || filtri.cop || filtri.multi; el.innerHTML = `<div class="eyebrow">${usoMe ? 'Vicino a te' : 'In questa zona'}</div>` + vuoto('pin', fl ? 'Nessun posto con questi filtri' : 'Nessun posto riservato qui', fl ? 'Sposta la mappa o togli un filtro.' : 'Sposta la mappa o cerca un indirizzo. Ne conosci uno qui vicino? Segnalalo.', fl ? [['Togli i filtri', 'filtri', 'v-1']] : [['Segnala un posto', 'segnala', 'v-1']], true); return; }
    const a = out[0], [cls, lab] = affidabilita(a.s);
    el.innerHTML = `<div class="eyebrow">${usoMe ? 'Il più vicino a te' : 'Il più vicino in questa zona'}</div>
      <button class="first" data-id="${esc(a.s.id)}"><span class="tile">${icon('wc')}</span><span class="t"><b>${esc(titolo(a.s))}</b><span>${[quanto(a), posti(a.s.posti)].join(' · ')}</span></span><span class="badge ${cls}">${lab}</span></button>
      <button class="primary" data-nav="${esc(a.s.id)}">${icon('nav')}<span>Portami lì</span></button>
      <div class="others">${out.slice(1).map((x) => `<button class="other" data-id="${esc(x.s.id)}"><span class="t"><b>${esc(titolo(x.s))}</b><span>${affidabilita(x.s)[1]} · ${posti(x.s.posti)}</span></span><span class="d">${x.r ? `${fmtMin(x.r.sec)}<small>${fmtDist(x.r.m)}</small>` : fmtDist(x.d)}</span>${icon('chev')}</button>`).join('')}</div>`;
  }
  // Dopo un trascinamento o un tocco sulla maniglia il pannello cambia altezza e sotto il dito finiscono le righe dell'elenco: il "click" che
  // il browser genera dopo il tocco cadrebbe su una di loro e aprirebbe la scheda di un posto. Per 350 ms dopo ogni gesto o cambio di altezza i click
  // sulle righe dei pannelli si ignorano (vedi cliccaDopoGesto).
  let gestoT = 0;
  const gestoRecente = () => Date.now() - gestoT < 350;
  const interattivo = (t) => !!(t && t.closest && t.closest('button:not(.handle),a,select,input,label,textarea'));
  // il tocco parte dalla maniglia o dalla fascia alta del pannello (44 px) dove non c'è un controllo
  function sullaManiglia(e, pannello) {
    const t = e.target, y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.changedTouches[0].clientY), r = pannello.getBoundingClientRect();
    return !!(t.closest && t.closest('.handle')) || (y >= r.top && y <= r.top + 44 && !interattivo(t));
  }
  function bloccaClickDopoGesto(pannello) { pannello.addEventListener('click', (e) => { if (gestoRecente() && !e.target.closest('.handle')) { e.stopPropagation(); e.preventDefault(); } }, true); }
  function espandi(si) {
    if (LARGO()) si = true; // sul computer l'elenco è sempre completo
    if (espanso === si) return; espanso = si; gestoT = Date.now(); $('#near').classList.toggle('exp', si); $('#near .handle').setAttribute('aria-expanded', si); vicini();
    const o = document.querySelector('#near .others'); if (o) o.scrollTop = 0;
    if (!selId && !dest) map.setPadding(padHome());
  }
  (function () { // trascina il pannello: su per vedere più posti, giù per richiuderlo; un tocco sulla maniglia fa lo stesso
    const el = $('#near'); let y0 = null, daLista = false, daManiglia = false;
    bloccaClickDopoGesto(el);
    el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; daManiglia = sullaManiglia(e, el); const o = e.target.closest('.others'); daLista = !!(o && espanso && o.scrollTop > 0); }, { passive: true });
    let tocco = 0;
    el.addEventListener('touchend', (e) => {
      if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; let fatto = false;
      if (dy < -40 && !espanso) { espandi(true); fatto = true; } else if (dy > 40 && espanso && !daLista) { espandi(false); fatto = true; }
      else if (Math.abs(dy) < 10 && daManiglia) { tocco = Date.now(); espandi(!espanso); fatto = true; }
      if (fatto) { gestoT = Date.now(); if (e.cancelable) e.preventDefault(); } // niente click dopo il gesto
    }, { passive: false });
    $('#near .handle').addEventListener('click', () => { if (Date.now() - tocco > 700) espandi(!espanso); }); // con il mouse o la tastiera
  })();
  $('#near-body').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]'); if (v) { if (v.dataset.v === 'filtri') { Object.keys(filtri).forEach((k) => { filtri[k] = false; }); document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false')); disegna(); } else if (v.dataset.v === 'segnala') apriAggiungi(); return; }
    const n = e.target.closest('[data-nav]'); if (n) { naviga(stalli.get(n.dataset.nav)); return; }
    if (e.target.closest('[data-me]')) { vaiAMe(); return; }
    if (e.target.closest('[data-riprova]')) { riprovaStile(); return; }
    const b = e.target.closest('[data-id]'); if (b) apriScheda(b.dataset.id);
  });
  // Navigatore scelto in «I tuoi posti» > Impostazioni: 'google' (predefinito, come prima), 'waze' o 'chiedi' (si chiede a ogni «Portami lì»).
  // Si salva con le altre preferenze del profilo (localStorage 'dp.profilo', campo nav): con un account viaggia con gli altri dati.
  const navPref = () => { const n = profilo().nav; return n === 'waze' || n === 'chiedi' ? n : 'google'; };
  const urlNav = (app, s) => app === 'waze' ? `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes` : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`;
  function chiediNavigatore() { // finestra «Con quale navigatore?»: risolve 'google', 'waze' o null (annulla)
    return new Promise((ok) => {
      const v = $('#velo-nav'), fuoco = document.activeElement; v.hidden = false; $('#vnv-h').focus({ preventScroll: true });
      const fine = (a) => { v.hidden = true; v.onclick = null; if (fuoco && fuoco.isConnected && fuoco.focus) { try { fuoco.focus({ preventScroll: true }); } catch (e) { /* ignora */ } } ok(a); };
      v.onclick = (e) => { const b = e.target.closest('[data-app]'); if (b) fine(b.dataset.app); else if (e.target === v || e.target.closest('#vnv-no')) fine(null); };
    });
  }
  function naviga(s, da, nPiano) {
    if (!s) return;
    const parti = (app) => {
      traccia('naviga', { comune: s.comune || null }); ls.set('dp.nav', ls.get('dp.nav', 0) + 1); ls.set('dp.navT', Date.now()); navigazioneAvviata(s, da, nPiano);
      const url = urlNav(app, s), vai = () => apri(url);
      if (SITO_NATIVO()) { avviaAscolto(navPend()).then(vai, vai); } else vai(); // sull'app, prima i permessi e l'ascolto (con la frase di spiegazione), poi il navigatore
    };
    const p = navPref(); if (p === 'chiedi') chiediNavigatore().then((a) => { if (a) parti(a); }); else parti(p);
  }

  // ---------- scheda del posto ----------
  function apriScheda(id) {
    const s = stalli.get(id); if (!s) return;
    const eraAperta = !!selId, prima = selId; selId = id; disegna(); trovaVia(s); if (prima !== id) traccia('scheda', { comune: s.comune || null });
    const [cls, lab] = affidabilita(s);
    $('#c-title').textContent = titolo(s);
    sottotitolo(); if (me) { tempi(me, [{ s }], 'car').then((ok) => { if (ok && selId === id) sottotitolo(); }); chiediTraffico(s).then((ok) => { if (ok && selId === id) sottotitolo(); }); }
    const fonte = s.stato === 'ufficiale' ? (s.fonte === 'opendata' ? 'Dato ufficiale del Comune' : 'Ufficiale') : lab;
    $('#c-badges').innerHTML = `<span class="badge ${cls}">${cls === 'uff' ? icon('shield') : ''}${fonte}</span><span class="badge">${posti(s.posti)}</span><span class="badge">Per tutti i contrassegni</span>${s.coperto ? '<span class="badge">Coperto</span>' : ''}`;
    // posti degli elenchi comunali con il solo indirizzo: pin messo sulla via (o presso un punto noto) finché non viene riposizionato
    const indicativa = /posizione approssimata/i.test(s.note || '');
    if (indicativa) $('#c-badges').insertAdjacentHTML('beforeend', '<span class="badge">Posizione indicativa</span>');
    let nota = (s.note || '').replace(/;?\s*Dato ufficiale[^;]*\(open data[^)]*\)/i, '').replace(/^Accorpato in [^.]*\.\s*/i, '')
      .replace(/\s*[;·]?\s*posizione approssimata[^;·]*/i, '').replace(/\s*[;·]?\s*elenco per via\s*/i, '').replace(/[\s;·]+$/, '').trim();
    if (indicativa) nota = (nota ? nota + '. ' : '') + 'Posizione indicativa: il Comune indica la via, il punto esatto non è ancora stato verificato.';
    $('#c-note').hidden = !nota; $('#c-note').textContent = nota ? nota.charAt(0).toUpperCase() + nota.slice(1) : '';
    $('#c-ind').hidden = !indicativa;
    $('#c-save').setAttribute('aria-pressed', salvati.has(id)); $('#c-save').querySelector('span').textContent = salvati.has(id) ? 'Salvato' : 'Salva';
    aggiornaConferma();
    mostra();
    if (indicativa && !indVisto && !ls.get('dp.indMai', false)) avvisoInd(false);
    seguo = false; map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16.5), padding: LARGO() ? padPC() : { top: 90, bottom: $('#card .sheet').offsetHeight + 20, left: 0, right: 0 }, duration: 500 });
  }
  // Avviso «Posizione indicativa»: al primo tocco su uno di questi posti (una volta per sessione); con la spunta non compare più.
  // Dal link nella scheda si riapre sempre, senza la spunta già messa.
  let indVisto = false;
  function avvisoInd(daLink) {
    indVisto = true; const v = $('#velo-ind'); $('#vi-mai').checked = false; $('#vi-chk-l').hidden = !!daLink && !!ls.get('dp.indMai', false);
    v.hidden = false; $('#vi-h').focus({ preventScroll: true });
  }
  function chiudiAvvisoInd() {
    if ($('#vi-mai').checked) ls.set('dp.indMai', true);
    $('#velo-ind').hidden = true; const l = $('#c-ind'); if (l && !$('#card').hidden && !l.hidden) l.focus({ preventScroll: true });
  }
  $('#vi-ok').onclick = chiudiAvvisoInd;
  $('#velo-ind').addEventListener('click', (e) => { if (e.target.id === 'velo-ind') chiudiAvvisoInd(); });
  $('#c-ind').onclick = () => avvisoInd(true);
  function sottotitolo() {
    const s = stalli.get(selId); if (!s) return; const r = me && (traffico(s) || suStrada(me, s, 'car')), d = me ? dist(me.lat, me.lon, s.lat, s.lon) : null;
    $('#c-sub').textContent = [s.comune, r ? inAuto(r) : (d != null ? fmtDist(d) + ' da te' : '')].filter(Boolean).join(' · ');
  }
  function aggiornaConferma() {
    const s = stalli.get(selId); if (!s) return;
    const vicino = me && dist(me.lat, me.lon, s.lat, s.lon) <= CFG.VICINO_M, n = s.conferme_esiste || 0;
    const info = n ? `Confermato da ${n === 1 ? '1 persona' : n + ' persone'}${s.ultima_conferma ? ', l\'ultima ' + quando(s.ultima_conferma) : ''}.` : (s.stato === 'proposto' ? 'Nessuno lo ha ancora confermato.' : '');
    const fatto = ls.get('dp.conf', {})[s.id];
    $('#c-confirm').hidden = !vicino || !!fatto; $('#c-conf-info').textContent = info;
    $('#c-conf-far').textContent = fatto ? 'Grazie, hai già risposto per questo posto.' : (vicino ? '' : info); $('#c-conf-far').hidden = !$('#c-conf-far').textContent;
  }
  function chiudiScheda(daIndietro) {
    if (!selId) return; selId = null; mostra(); disegna();
    map.easeTo({ padding: padHome(), duration: 300 });
  }
  // tasto Indietro del telefono: chiude la scheda; sulla mappa mette l'app in secondo piano
  (function () {
    const cap = window.Capacitor, App = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.App;
    if (App) App.addListener('backButton', () => { if (!$('#aggiorna').hidden || !$('#welcome').hidden) App.exitApp(); else if (!$('#velo-ind').hidden) chiudiAvvisoInd(); else if (!$('#velo-n').hidden) $('#vn-no').click(); else if (!$('#velo-nav').hidden) $('#vnv-no').click(); else if (probAperto()) probChiudi(); else if (fgStato) fgChiudi(); else if (!$('#nuova').hidden) $('#nuova').hidden = true; else if (!$('#elimina').hidden) $('#elimina').hidden = true; else if (!$('#fonti').hidden) $('#fonti').hidden = true; else if (!$('#segn').hidden) $('#segn').hidden = true; else if (!$('#sugg').hidden) $('#sugg').hidden = true; else if (!$('#regole').hidden) $('#regole').hidden = true; else if (!$('#voto').hidden) $('#voto').hidden = true; else if (!$('#profilo').hidden) $('#profilo').hidden = true; else if (!$('#search').hidden) { if (catAperta) inizio(); else chiudiRicerca(); } else if (!$('#account').hidden) chiudiAccount(); else if (!$('#menu').hidden) $('#menu').hidden = true; else if (selId) chiudiScheda(true); else if (aggiungo) chiudiAggiungi(); else if (dest) chiudiDest(); else if (App.minimizeApp) App.minimizeApp(); else App.exitApp(); });
    else window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('#velo-ind').hidden) chiudiAvvisoInd(); else if (probAperto()) probChiudi(); else if (fgStato) fgChiudi(); else chiudiScheda(true); } });
  })();
  $('#c-close').onclick = () => chiudiScheda(false);
  $('#c-nav').onclick = () => naviga(stalli.get(selId));
  $('#c-street').onclick = () => { const s = stalli.get(selId); if (s) traccia('streetview', { comune: s.comune || null }); if (s) apri(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${s.lat},${s.lon}`); };
  $('#c-save').onclick = () => {
    const s = stalli.get(selId); if (!s) return;
    if (salvati.has(selId)) salvati.delete(selId); else salvati.set(selId, { id: s.id, lat: s.lat, lon: s.lon, t: titolo(s), c: s.comune || '' });
    ls.set('dp.salvati', [...salvati.values()]); toccato(); const on = salvati.has(selId);
    $('#c-save').setAttribute('aria-pressed', on); $('#c-save').querySelector('span').textContent = on ? 'Salvato' : 'Salva'; toast(on ? 'Salvato tra i tuoi posti' : 'Tolto dai tuoi posti'); if (on) traccia('salva', { comune: s.comune || null });
  };
  $('#c-share').onclick = async () => {
    const s = stalli.get(selId); if (!s) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`, text = `Posto riservato ai disabili: ${titolo(s)}${s.comune ? ', ' + s.comune : ''}`;
    const cap = window.Capacitor, Sh = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Share;
    traccia('condividi', { comune: s.comune || null });
    try {
      if (Sh) await Sh.share({ title: 'SostAbile', text, url, dialogTitle: 'Condividi il posto' });
      else if (navigator.share) await navigator.share({ title: 'SostAbile', text, url });
      else { await navigator.clipboard.writeText(text + ' ' + url); toast('Link copiato'); }
    } catch (e) { /* condivisione annullata */ }
  };
  $('#c-confirm').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-esito]'); const s = stalli.get(selId); if (!b || !s) return;
    try {
      const r = await fetch(`${CFG.SB}/rest/v1/conferme`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, H), body: JSON.stringify({ stallo_id: s.id, esito: b.dataset.esito, device_id: deviceId }) });
      if (!r.ok) throw new Error(r.status);
      const fatti = ls.get('dp.conf', {}); fatti[s.id] = b.dataset.esito; ls.set('dp.conf', fatti); traccia('conferma', { comune: s.comune || null, dettaglio: b.dataset.esito });
      if (b.dataset.esito === 'esiste') s.conferme_esiste = (s.conferme_esiste || 0) + 1;
      toast('Grazie! La tua risposta aiuta chi arriva dopo.'); aggiornaConferma();
    } catch (err) { toast('Non sono riuscito a inviare la risposta. Riprova.'); }
  });

  // ---------- «C'è un problema con questo posto?» ----------
  // Link sempre in fondo alla scheda. Si invia con la funzione segnala_problema (supabase/23_problemi_posti.sql): funziona anche senza account
  // (con il codice del telefono; se c'è l'accesso, la segnalazione porta anche l'utente), con un massimo di 10 al giorno e una per posto al giorno.
  // «È in un altro punto» chiede anche dove: stessa mappa con il segnaposto di «Segnala un posto nuovo» e si invia la posizione proposta.
  const prob = { tipo: null, s: null, lat: null, lon: null, occ: false };
  const probAperto = () => !$('#prob').hidden || !$('#probpos').hidden;
  const oggiIso = () => new Date().toISOString().slice(0, 10);
  const probOggi = () => (ls.get('dp.problemi', {})[oggiIso()] || 0);
  function probScelta(t) {
    prob.tipo = t; document.querySelectorAll('#p-scelte .p-sc').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === t)));
    $('#p-dove').hidden = t !== 'spostato'; $('#p-invia').disabled = !t;
  }
  function apriProblema() {
    const s = stalli.get(selId); if (!s) return;
    if (probOggi() >= 10) { toast('Per oggi hai già inviato 10 segnalazioni. Grazie! Riprova domani.', 4000); return; }
    Object.assign(prob, { s, tipo: null, lat: null, lon: null, occ: false });
    $('#p-sub').textContent = [titolo(s), s.comune].filter(Boolean).join(', ') + '. Scegli cosa non va: lo controlliamo prima di cambiare la mappa.';
    $('#p-testo').value = ''; probScelta(null); $('#prob').hidden = false; $('#p-tit').focus({ preventScroll: true });
  }
  function probPadding() { return LARGO() ? padPC() : { top: 90, bottom: $('#probpos .sheet').offsetHeight || 0, left: 0, right: 0 }; }
  function probPos() { // mappa per indicare il punto giusto: si sposta la mappa finché il segnaposto è sopra lo stallo
    const s = prob.s; if (!s) return;
    $('#prob').hidden = true; $('#probpos').hidden = false; document.body.classList.add('prob-pos'); seguo = false;
    const pad = probPadding(); map.setPadding(pad); map.jumpTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 18) });
    $('#p-pin').style.top = (pad.top + (window.innerHeight - pad.top - pad.bottom) / 2) + 'px'; $('#p-pin').style.left = (pad.left + (window.innerWidth - pad.left - pad.right) / 2) + 'px';
    probQui();
  }
  function probQui() {
    const s = prob.s; if (!s || $('#probpos').hidden) return; const c = map.getCenter(), d = dist(s.lat, s.lon, c.lat, c.lng);
    $('#pp-dove').textContent = d < 5 ? 'Sposta la mappa: il segnaposto è ancora sul punto segnato ora.' : d > 500 ? 'Troppo lontano dal punto segnato (più di 500 m).' : `A ${fmtDist(d)} dal punto segnato ora sulla mappa.`;
    $('#pp-invia').disabled = d < 5 || d > 500;
  }
  function probPosFine() { // torna alla scheda: la mappa riprende il suo margine
    $('#probpos').hidden = true; document.body.classList.remove('prob-pos');
    map.easeTo({ center: prob.s ? [prob.s.lon, prob.s.lat] : map.getCenter(), padding: LARGO() ? padPC() : { top: 90, bottom: $('#card .sheet').offsetHeight + 20, left: 0, right: 0 }, duration: 300 });
  }
  function probChiudi() { // Indietro/Esc: dalla mappa si torna alle scelte, dal foglio si chiude tutto
    if (!$('#probpos').hidden) { probPosFine(); $('#prob').hidden = false; return; }
    $('#prob').hidden = true; const l = $('#c-problema'); if (l && !$('#card').hidden) l.focus({ preventScroll: true });
  }
  async function inviaProblema() {
    const s = prob.s; if (!s || !prob.tipo) return false;
    const corpo = JSON.stringify({ p_stallo: s.id, p_tipo: prob.tipo, p_note: $('#p-testo').value.trim().slice(0, 500) || null, p_lat: prob.lat, p_lon: prob.lon, p_device: deviceId });
    const anonimo = () => fetch(`${CFG.SB}/rest/v1/rpc/segnala_problema`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: corpo });
    try {
      let r; try { r = await aut('/rest/v1/rpc/segnala_problema', { method: 'POST', body: corpo }); } catch (e) { r = await anonimo(); } // sessione scaduta: si invia come telefono senza account
      if (r.status === 401) r = await anonimo();
      if (r.status === 429) { troppe(); return false; }
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      if (j && j.ok) { const f = ls.get('dp.problemi', {}); ls.set('dp.problemi', { [oggiIso()]: (f[oggiIso()] || 0) + 1 }); toast('Grazie! Controlliamo il posto prima di cambiare la mappa.', 4000); return true; }
      const e = j && j.errore;
      if (e === 'limite') { ls.set('dp.problemi', { [oggiIso()]: 10 }); toast('Per oggi hai già inviato 10 segnalazioni. Grazie! Riprova domani.', 4000); return true; }
      if (e === 'gia_segnalato') { toast('Hai già segnalato un problema per questo posto oggi. Grazie!', 4000); return true; }
      if (e === 'lontano') { toast('Il punto scelto è troppo lontano dal posto. Avvicinalo e riprova.', 4000); return false; }
      throw new Error(e || 'risposta');
    } catch (err) { toast('Non riusciamo a inviare ora, riprova più tardi.', 4500); return false; }
  }
  async function probInvia(btn) {
    if (btn.disabled) return; btn.disabled = true; const lab = btn.querySelector('span'), t0 = lab.textContent; lab.textContent = 'Invio…';
    const dallaMappa = !$('#probpos').hidden, ok = await inviaProblema(); lab.textContent = t0; btn.disabled = false;
    if (ok) { $('#prob').hidden = true; if (dallaMappa) probPosFine(); const l = $('#c-problema'); if (l && !$('#card').hidden) l.focus({ preventScroll: true }); }
    else if (!$('#prob').hidden) $('#p-invia').disabled = !prob.tipo;
  }
  $('#c-problema').onclick = apriProblema;
  $('#p-x').onclick = probChiudi; $('#prob').addEventListener('click', (e) => { if (e.target === $('#prob')) probChiudi(); });
  $('#p-scelte').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) probScelta(b.dataset.t); });
  $('#p-scelte').addEventListener('keydown', (e) => { // come in un gruppo di scelte: le frecce cambiano la scelta
    const v = [...document.querySelectorAll('#p-scelte .p-sc')], i = v.indexOf(document.activeElement); if (i < 0) return;
    const j = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? (i + 1) % v.length : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? (i - 1 + v.length) % v.length : -1;
    if (j >= 0) { e.preventDefault(); v[j].focus(); probScelta(v[j].dataset.t); }
  });
  $('#p-invia').onclick = () => { if (prob.tipo === 'spostato') probPos(); else probInvia($('#p-invia')); };
  $('#pp-close').onclick = probChiudi;
  $('#pp-invia').onclick = () => { const c = map.getCenter(); prob.lat = +c.lat.toFixed(7); prob.lon = +c.lng.toFixed(7); probInvia($('#pp-invia')); };
  map.on('moveend', probQui);

  // ---------- barra in alto, filtri, pulsanti ----------
  document.querySelectorAll('.chip').forEach((c) => c.onclick = () => { const k = c.dataset.f; filtri[k] = !filtri[k]; c.setAttribute('aria-pressed', filtri[k]); disegna(); });
  async function vaiAMe() {
    if (me) { seguo = true; map.easeTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 16), padding: padHome() }); return; }
    seguo = true; const ok = await attivaPosizione(true); if (!ok) toast('Per trovarti serve il permesso alla posizione. Lo trovi nelle impostazioni del telefono.', 4500);
  }
  $('#b-me').onclick = vaiAMe;
  const presto = () => toast('Arriva nella prossima versione di prova.');
  $('#b-search').onclick = () => apriRicerca(); $('#b-add').onclick = () => apriAggiungi(); $('#b-menu').onclick = () => apriMenu();


  // ---------- schermata 4 · posti vicino alla destinazione ----------
  let lista = [], inCorso = -1, numMk = [], destMk = null;
  $('#a-r').value = String(raggio);
  async function vaiA(d) {
    dest = d; inCorso = -1; chiudiRicerca(); ricorda(d); $('#d-name').textContent = d.t; seguo = false; mostra();
    $('#a-count').textContent = 'Cerco i posti…'; $('#a-sub').textContent = ''; $('#a-list').innerHTML = ''; $('#a-nav').hidden = true; $('#a-hint').textContent = '';
    map.jumpTo({ center: [d.lon, d.lat], zoom: 16 });
    await carica(d.lat - 0.012, d.lon - 0.017, d.lat + 0.012, d.lon + 0.017, false); arrivo(true);
    if (dest === d) { // per il cruscotto: le destinazioni senza posti attorno dicono dove mancano dati
      const n = attorno(d.lat, d.lon).filter((x) => x.d <= raggio).length, vic = attorno(d.lat, d.lon)[0];
      traccia('destinazione', { comune: d.comune || (vic && vic.s.comune) || (String(d.sub || '').split(',').map((t) => t.trim()).filter(Boolean).slice(-1)[0]) || null, dettaglio: n ? 'con_posti' : 'senza_posti',
        lat_g: Math.round(d.lat * 100) / 100, lon_g: Math.round(d.lon * 100) / 100 }); // arrotondata a circa 1 km: mai la posizione esatta
    }
  }
  function attorno(lat, lon) { // posti attorno a un punto, dal più vicino, senza doppioni a pochi metri
    const tutti = []; for (const s of stalli.values()) if (passa(s)) { const d = dist(lat, lon, s.lat, s.lon); if (d <= 1300) tutti.push({ s, d }); }
    tutti.sort((a, b) => a.d - b.d); const out = [];
    for (const x of tutti) if (!out.some((y) => dist(x.s.lat, x.s.lon, y.s.lat, y.s.lon) < 25)) out.push(x);
    return out;
  }
  function arrivo(inquadra) {
    if (!dest) return;
    const tutti = attorno(dest.lat, dest.lon), dentro = tutti.filter((x) => x.d <= raggio), n = dentro.reduce((a, x) => a + (x.s.posti || 1), 0);
    lista = (dentro.length ? dentro : tutti.slice(0, 3)).slice(0, 8);
    lista.forEach((x) => { x.r = suStrada(dest, x.s, 'foot'); }); lista.sort((a, b) => (a.r ? a.r.m : a.d * 1.3) - (b.r ? b.r.m : b.d * 1.3));
    tempi(dest, lista, 'foot').then((ok) => { if (ok) arrivo(false); });
    $('#a-count').textContent = dentro.length ? posti(n) : 'Nessun posto';
    $('#a-sub').textContent = dentro.length ? 'In ordine di distanza a piedi dalla destinazione' : (tutti.length ? `Il più vicino è a ${fmtDist(tutti[0].d)}. Ecco i più vicini, anche se fuori raggio.` : 'Nessun posto nemmeno entro 1 km da qui.');
    const prox = prossimoElenco(inCorso), cur = inCorso >= 0 ? lista[inCorso] : null, curOcc = !!cur && occupati.has(cur.s.id), primo = inCorso < 0 ? Math.max(0, prossimoElenco(-1)) : 0;
    const att = inCorso < 0 ? primo : Math.max(0, Math.min(inCorso, lista.length - 1));
    const rgA = raggio >= 1000 ? '1 km' : raggio + ' m';
    $('#a-list').innerHTML = (dentro.length ? '' : vuoto('pin', 'Nessun posto riservato qui', `Entro ${rgA} dalla destinazione non ne conosciamo.${raggio < 1000 ? ' Prova ad allargare la ricerca.' : ''}`, (raggio < 1000 ? [['Cerca entro 1 km', 'km', 'v-1']] : []).concat([['Ne conosci uno? Segnalalo', 'segnala', 'v-2']]))) + lista.map((x, i) => `<button class="arow${i === att ? ' on' : ''}${occupati.has(x.s.id) ? ' occ' : ''}" data-id="${esc(x.s.id)}"><span class="num">${occupati.has(x.s.id) ? icon('x') : i + 1}</span><span class="t"><b>${esc(titolo(x.s))}</b><span>${[occupati.has(x.s.id) ? 'Occupato' : '', affidabilita(x.s)[1], posti(x.s.posti), x.s.coperto ? 'coperto' : ''].filter(Boolean).join(' · ')}</span></span><span class="d">${x.r ? `${fmtDist(x.r.m)}<small>${fmtMin(x.r.sec)} a piedi</small>` : fmtDist(x.d)}</span></button>`).join('');
    $('#a-nav').hidden = !lista.length;
    $('#a-nav span').textContent = inCorso < 0 ? `Portami al numero ${primo + 1}` : prox < 0 ? 'Riapri il navigatore' : curOcc ? `Portami al numero ${prox + 1}` : `Occupato? Portami al numero ${prox + 1}`;
    $('#a-hint').textContent = inCorso < 0 && lista.length > 1 && prossimoElenco(primo) >= 0 ? `Se è occupato, con un tocco passi al numero ${prossimoElenco(primo) + 1}.` : '';
    numMk.forEach((m) => m.remove()); numMk = []; if (destMk) destMk.remove();
    const de = document.createElement('div'); de.className = 'mdest'; de.innerHTML = icon(dest.k === 'casa' ? 'casa' : dest.k === 'lavoro' ? 'lavoro' : 'flag'); destMk = new maplibregl.Marker({ element: de }).setLngLat([dest.lon, dest.lat]).addTo(map);
    lista.forEach((x, i) => { const el = document.createElement('div'); const occ = occupati.has(x.s.id); el.className = 'mnum' + (i === att ? ' on' : '') + (occ ? ' occ' : ''); if (occ) { el.innerHTML = icon('x'); el.setAttribute('aria-label', 'Posto occupato'); } else el.textContent = i + 1; el.onclick = (e) => { e.stopPropagation(); apriScheda(x.s.id); }; numMk.push(new maplibregl.Marker({ element: el }).setLngLat([x.s.lon, x.s.lat]).addTo(map)); });
    if (inquadra) {
      const b = new maplibregl.LngLatBounds([dest.lon, dest.lat], [dest.lon, dest.lat]); lista.slice(0, 5).forEach((x) => b.extend([x.s.lon, x.s.lat]));
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // fitBounds somma il suo margine a quello già impostato
      map.fitBounds(b, { padding: LARGO() ? padPC(50) : { top: 110, bottom: $('#arrivo').offsetHeight + 40, left: 50, right: 50 }, maxZoom: 17, duration: 500 });
    }
  }
  // elenco dei posti attorno alla destinazione: si può ridurre al solo posto scelto per lasciare spazio alla mappa
  let ridotto = false;
  function riduci(si) {
    if (ridotto === si) return; ridotto = si; gestoT = Date.now(); $('#arrivo').classList.toggle('min', si); $('#a-handle').setAttribute('aria-expanded', !si);
    if (!si) $('#a-list').scrollTop = 0;
    if (dest && !selId) arrivo(true);
  }
  (function () { // trascina giù per ridurre, su per riaprire; un tocco sulla maniglia fa lo stesso
    const el = $('#arrivo'); let y0 = null, daLista = false, tocco = 0, daManiglia = false;
    bloccaClickDopoGesto(el);
    el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; daManiglia = sullaManiglia(e, el.querySelector('.sheet')); const o = e.target.closest('#a-list'); daLista = !!(o && !ridotto && o.scrollHeight > o.clientHeight + 2); }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; let fatto = false;
      if (dy > 40 && !ridotto && !daLista) { riduci(true); fatto = true; } else if (dy < -40 && ridotto) { riduci(false); fatto = true; }
      else if (Math.abs(dy) < 10 && daManiglia) { tocco = Date.now(); riduci(!ridotto); fatto = true; }
      if (fatto) { gestoT = Date.now(); if (e.cancelable) e.preventDefault(); }
    }, { passive: false });
    $('#a-handle').addEventListener('click', () => { if (Date.now() - tocco > 700) riduci(!ridotto); });
  })();
  function chiudiDest() { dest = null; numMk.forEach((m) => m.remove()); numMk = []; if (destMk) destMk.remove(); destMk = null; mostra(); map.easeTo({ padding: padHome(), duration: 300 }); vicini(); }
  $('#d-back').onclick = chiudiDest;
  $('#d-name').onclick = () => { if (dest) apriRicerca(dest.q || dest.t); };
  $('#a-r').onchange = () => { raggio = +$('#a-r').value; ls.set('dp.raggio', raggio); inCorso = -1; arrivo(true); };
  $('#a-list').addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]');
    if (v) { if (v.dataset.v === 'km') { raggio = 1000; $('#a-r').value = '1000'; ls.set('dp.raggio', raggio); inCorso = -1; arrivo(true); } else if (v.dataset.v === 'segnala') apriAggiungi(); return; }
    const b = e.target.closest('[data-id]'); if (b) apriScheda(b.dataset.id);
  });
  // primo posto dell'elenco dopo "da" che non sia stato segnato occupato (-1 se non ce n'è)
  function prossimoElenco(da) { for (let i = da + 1; i < lista.length; i++) if (!occupati.has(lista[i].s.id)) return i; return -1; }
  // "Occupato? Portami al numero N": il posto di prima risulta occupato (come per il piano B) e si va al successivo dell'elenco
  function avantiElenco() {
    if (!lista.length) return;
    const prox = prossimoElenco(inCorso), cur = inCorso >= 0 ? lista[inCorso] : null;
    if (cur && prox >= 0 && !occupati.has(cur.s.id)) segnaOccupato({ id: cur.s.id, comune: cur.s.comune });
    inCorso = prox >= 0 ? prox : (inCorso >= 0 ? inCorso : 0);
    naviga(lista[inCorso].s, 'elenco'); setTimeout(() => arrivo(false), 600);
  }
  $('#a-nav').onclick = avantiElenco;

  // ---------- schermata 3 · ricerca ----------
  let sCtl, sT, scelgo = null; // scelgo: 'casa' o 'lavoro' mentre si imposta la scorciatoia
  let catAperta = null;        // categoria di luogo aperta nella ricerca (es. 'ospedali'), altrimenti null
  const luoghi = () => ls.get('dp.luoghi', {});
  function ricorda(d) { const r = ls.get('dp.recenti', []).filter((x) => x.t !== d.t); r.unshift({ t: d.t, sub: d.sub || '', lat: d.lat, lon: d.lon, q: d.q || '' }); ls.set('dp.recenti', r.slice(0, 5)); }
  function apriRicerca(testo, imposta) {
    $('#search').hidden = false; $('#s-q').value = testo || ''; $('#s-x').hidden = !testo; scelgo = imposta || null;
    if (testo) { chipStato(); cerca(testo); } else inizio();
    setTimeout(() => { $('#s-q').focus(); if (testo) $('#s-q').select(); }, 60);
  }
  function chiudiRicerca() { $('#search').hidden = true; $('#s-q').blur(); if (sCtl) sCtl.abort(); catAperta = null; }
  function chipStato() { document.querySelectorAll('.s-chips button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === scelgo)); $('#s-q').placeholder = scelgo ? `Cerca l'indirizzo ${scelgo === 'casa' ? 'di casa' : 'del lavoro'}` : 'Via, luogo o città'; }
  function inizio() {
    chipStato(); catAperta = null; const r = ls.get('dp.recenti', []);
    $('#s-body').innerHTML = (scelgo ? `<div class="empty">Scrivi l'indirizzo e toccalo: lo ritrovi qui sopra con un tocco.</div>` : '') +
      (!scelgo && !$('#s-q').value.trim() ? htmlCategorie() : '') +
      (r.length ? '<div class="eyebrow">Cercati di recente</div>' + r.map((x, i) => `<button class="res rec" data-rec="${i}"><span class="mk">${icon('clock')}</span><span class="t"><b>${esc(x.t)}</b></span></button>`).join('') : (scelgo ? '' : '<div class="empty">Scrivi dove stai andando: ti mostro i posti riservati lì attorno.</div>'));
  }
  function etichetta(p) { const via = [p.street, p.housenumber].filter(Boolean).join(' '), t = p.name || via || p.city || ''; return { t, sub: [p.name && via, p.city !== t && p.city, p.county].filter(Boolean).join(', ') }; }
  let risultati = [];
  const attesa = (q) => { $('#s-body').innerHTML = `<div class="empty cerco">Cerco «${esc(q)}»…</div>`; };
  const norma = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '');
  // Due servizi di ricerca: Photon (veloce, adatto mentre scrivi) e, se non risponde, Nominatim di OpenStreetMap.
  // fetch con un tempo massimo: se il servizio non risponde entro ms si passa oltre invece di restare in attesa
  async function entro(url, signal, ms) {
    const ctl = new AbortController(), ferma = () => ctl.abort(); let scaduto = false;
    if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', ferma);
    const t = setTimeout(() => { scaduto = true; ctl.abort(); }, ms);
    try { return await fetch(url, { signal: ctl.signal }); }
    catch (e) { if (scaduto) throw new Error('tempo scaduto'); throw e; }
    finally { clearTimeout(t); signal.removeEventListener('abort', ferma); }
  }
  async function geocodifica(q, c, signal) {
    try {
      const r = await entro(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lat=${c[1]}&lon=${c[0]}&zoom=12&location_bias_scale=0.4`, signal, 4000);
      if (!r.ok) throw new Error('photon ' + r.status);
      const j = await r.json();
      return j.features.filter((f) => { const p = f.properties || {}; return !p.countrycode || p.countrycode === 'IT' || p.country === 'Italia'; }).slice(0, 6)
        .map((f) => { const p = f.properties; return Object.assign({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], strada: p.osm_key === 'highway', citta: p.type === 'city' || (p.osm_key === 'place' && ['city', 'town', 'village'].includes(p.osm_value)), zona: p.type === 'county' || p.type === 'state' }, etichetta(p)); }).filter((x) => x.t);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const r = await entro(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=it&accept-language=it&q=${encodeURIComponent(q)}&viewbox=${c[0] - .4},${c[1] + .3},${c[0] + .4},${c[1] - .3}`, signal, 8000);
      if (!r.ok) throw new Error('nominatim ' + r.status);
      return (await r.json()).map((x) => { const a = x.address || {}, via = [a.road, a.house_number].filter(Boolean).join(' '), citta = a.city || a.town || a.village || a.municipality || '';
        const t = x.name || via || citta; return { lat: +x.lat, lon: +x.lon, strada: x.category === 'highway', citta: ['city', 'town', 'village', 'municipality'].includes(x.addresstype), zona: ['county', 'state', 'province'].includes(x.addresstype), t, sub: [x.name && via, citta !== t && citta, a.county].filter(Boolean).join(', ') }; }).filter((x) => x.t);
    }
  }
  async function cerca(q) {
    catAperta = null; if (sCtl) sCtl.abort(); sCtl = new AbortController(); const mio = sCtl; attesa(q); const c = me ? [me.lon, me.lat] : [map.getCenter().lng, map.getCenter().lat];
    try {
      const trovati = await geocodifica(q, c, mio.signal); if (sCtl !== mio) return;
      // niente righe uguali, e niente provincia o regione quando c'è già la città con lo stesso nome
      const visti = new Set(), nomiCitta = new Set(trovati.filter((x) => x.citta).map((x) => norma(x.t)));
      risultati = trovati.filter((x) => { if (x.zona && nomiCitta.has(norma(x.t))) return false; const k = norma(x.t) + '|' + norma(x.sub); if (visti.has(k)) return false; visti.add(k); return true; });
      const civ = (q.match(/(?:^|[\s,])(\d{1,4}\s?[a-zA-Z]?)(?=$|[\s,])/) || [])[1]; // "via natisone 27": se la mappa conosce solo la via, tengo il 27 nel nome
      if (civ && TT) { // la mappa libera spesso non ha i civici: per quelli chiedo a TomTom la posizione esatta
        try {
          const r = await entro(`https://api.tomtom.com/search/2/geocode/${encodeURIComponent(q)}.json?key=${TT}&countrySet=IT&limit=1&language=it-IT&lat=${c[1]}&lon=${c[0]}`, mio.signal, 4000);
          const g = r.ok ? ((await r.json()).results || [])[0] : null;
          if (g && g.type === 'Point Address' && g.address.streetNumber) {
            const t = `${g.address.streetName} ${g.address.streetNumber}`;
            risultati = risultati.filter((x) => !(x.strada && !/\d/.test(x.t) && norma(x.t) === norma(g.address.streetName)));
            risultati.unshift({ lat: g.position.lat, lon: g.position.lon, t, sub: [g.address.municipalitySubdivision, g.address.municipality].filter(Boolean).join(', ') });
          }
        } catch (e) { if (e.name === 'AbortError') throw e; }
      }
      if (civ) risultati.forEach((x) => { if (x.strada && !/\d/.test(x.t)) { x.t += ' ' + civ.trim(); x.sub = [x.sub, 'civico non in mappa: punto a metà via'].filter(Boolean).join(' · '); } });
      if (sCtl !== mio) return;
      risultati.forEach((x) => { x.q = q; });
      if (!risultati.length) { $('#s-body').innerHTML = vuoto('cerca', 'Non trovo questo posto', 'Prova con la via e la città, per esempio «Via Roma, Udine».', null, true); return; }
      // I conteggi dei posti (e l'eventuale avviso «Nessun posto entro…», alto circa 76 px) si aspettano al massimo 1,2 secondi PRIMA di disegnare
      // l'elenco: così le righe non scendono quando l'avviso arriva dopo. Quelli che tardano ancora si aggiungono dopo, come prima.
      let tardi = false; const stati = new Array(risultati.length).fill(null), attese = scelgo ? [] : risultati.map((x, i) => datiConta(x, mio.signal).then((st) => { stati[i] = st; if (tardi) applicaConta(i, st); }, () => null));
      await Promise.race([Promise.all(attese), new Promise((ok) => setTimeout(ok, 1200))]); tardi = true; if (sCtl !== mio) return;
      $('#s-body').innerHTML = '<div class="eyebrow">Risultati</div>' + risultati.map((x, i) => `<div data-box="${i}"><button class="res" data-res="${i}"><span class="mk">${icon('pin')}</span><span class="t"><b>${esc(x.t)}</b><span>${esc(x.sub)}</span></span>${scelgo ? '' : '<span class="n wait">…</span>'}</button></div>`).join('');
      stati.forEach((st, i) => { if (st) applicaConta(i, st); });
    } catch (e) { if (e.name !== 'AbortError' && sCtl === mio) $('#s-body').innerHTML = `<div class="empty">La ricerca non risponde. Controlla la connessione e riprova.<br><span class="small">(${esc(e.message || e)})</span></div>`; }
  }
  // quanti posti ci sono attorno a un risultato (solo i dati, senza toccare lo schermo); se nessuno, il più vicino
  async function datiConta(x, signal) {
    if (x.citta && riepilogo) { // per una città conta tutto il comune, non solo il cerchio attorno al centro
      const c = riepilogo.comuni.filter((v) => norma(v.n) === norma(x.t) && Math.abs(v.lat - x.lat) < 0.15 && Math.abs(v.lon - x.lon) < 0.2)[0];
      if (c && c.t) return { testo: num(c.t) + ' nel comune' };
    }
    await carica(x.lat - 0.012, x.lon - 0.017, x.lat + 0.012, x.lon + 0.017, false);
    if (signal.aborted) return null;
    const tutti = attorno(x.lat, x.lon), dentro = tutti.filter((y) => y.d <= raggio), n = dentro.reduce((a, y) => a + (y.s.posti || 1), 0);
    return dentro.length ? { testo: posti(n) } : { lontano: tutti[0] || null };
  }
  function applicaConta(i, st) {
    const box = document.querySelector(`[data-box="${i}"]`); if (!box || !st) return; const b = box.querySelector('.n'); if (!b && !st.lontano) return;
    if (st.testo) { b.className = 'n'; b.textContent = st.testo; return; }
    if (box.querySelector('.lontano')) return;
    if (b) b.remove(); const rg = raggio >= 1000 ? '1 km' : raggio + ' m';
    const d = document.createElement('div'), v = st.lontano; d.className = 'lontano';
    if (v) d.innerHTML = `<div><b>Nessun posto entro ${rg}.</b> Il più vicino è a ${fmtDist(v.d)}${v.s.indirizzo ? ', in ' + esc(v.s.indirizzo) : ''}.</div><button data-nav="${esc(v.s.id)}">${icon('nav')}<span>Portami lì</span></button>`;
    else d.innerHTML = '<div><b>Nessun posto entro 1 km.</b> Qui la mappa è ancora vuota.</div>';
    box.appendChild(d);
  }
  $('#s-q').addEventListener('input', () => { const q = $('#s-q').value.trim(); $('#s-x').hidden = !q; clearTimeout(sT); if (sCtl) sCtl.abort(); if (q.length < 3) { inizio(); return; } attesa(q); sT = setTimeout(() => cerca(q), 450); });
  $('#s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#s-q').blur(); const q = $('#s-q').value.trim(); clearTimeout(sT); if (q.length >= 2) cerca(q); } });
  $('.s-field').addEventListener('click', (e) => { if (!e.target.closest('#s-x')) $('#s-q').focus(); }); // tutta la barra apre la tastiera, non solo il testo
  $('#s-x').onclick = () => { $('#s-q').value = ''; $('#s-x').hidden = true; inizio(); $('#s-q').focus(); };
  $('#s-back').onclick = () => { if (catAperta) { inizio(); $('#s-q').focus(); } else chiudiRicerca(); };
  function scegli(x) {
    const k = scelgo;
    if (k) { const l = luoghi(); l[k] = { t: x.t, sub: x.sub || '', lat: x.lat, lon: x.lon }; ls.set('dp.luoghi', l); toccato(); toast(`${k === 'casa' ? 'Casa' : 'Lavoro'} impostato: ${x.t}`); scelgo = null; }
    vaiA(k ? Object.assign({ k }, x) : x);
  }
  async function apriSalvato(id) {
    const v = salvati.get(id); chiudiRicerca();
    if (!stalli.has(id)) { try { const j = await rpc('stallo', { p_id: id }); if (j[0]) stalli.set(id, j[0]); } catch (e) { if (e.status === 429) { troppe(); return; } /* sotto */ } }
    if (!stalli.has(id)) { toast('Questo posto non è più in mappa.'); return; }
    if (v && !v.lat) { const s = stalli.get(id); salvati.set(id, { id, lat: s.lat, lon: s.lon, t: titolo(s), c: s.comune || '' }); ls.set('dp.salvati', [...salvati.values()]); }
    apriScheda(id);
  }
  $('#s-body').addEventListener('click', (e) => {
    const n = e.target.closest('[data-nav]'); if (n) { naviga(stalli.get(n.dataset.nav)); return; }
    const a = e.target.closest('[data-res]'); if (a) { scegli(risultati[+a.dataset.res]); return; }
    const r = e.target.closest('[data-rec]'); if (r) { scegli(ls.get('dp.recenti', [])[+r.dataset.rec]); return; }
    const sv = e.target.closest('[data-sal]'); if (sv) { apriSalvato(sv.dataset.sal); return; }
    const ct = e.target.closest('[data-cat]'); if (ct) { apriCategoria(ct.dataset.cat); return; }
    const lg = e.target.closest('[data-luogo]'); if (lg) { sceltaLuogo(+lg.dataset.luogo); return; }
    if (e.target.closest('[data-cat-fine]')) { inizio(); $('#s-q').focus(); }
  });
  document.querySelector('.s-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const k = b.dataset.k;
    if (k === 'salvati') {
      scelgo = null; catAperta = null; chipStato(); const v = [...salvati.values()];
      $('#s-body').innerHTML = '<div class="eyebrow">I tuoi posti salvati</div>' + (v.length ? v.map((x) => `<button class="res" data-sal="${esc(x.id)}"><span class="mk">${icon('save')}</span><span class="t"><b>${esc(x.t || 'Posto riservato')}</b><span>${esc(x.c || '')}</span></span></button>`).join('') : vuoto('salv', 'Nessun posto salvato', 'Apri un posto sulla mappa e tocca «Salva»: lo ritrovi qui con un tocco.', null, true));
      return;
    }
    const l = luoghi()[k];
    if (l && scelgo !== k) { vaiA(Object.assign({ k }, l)); return; }
    scelgo = scelgo === k ? null : k; $('#s-q').value = ''; $('#s-x').hidden = true; inizio(); $('#s-q').focus();
  });


  // ---------- arrivo, piano B e ritorno all'auto ----------
  // PUNTI DI AGGANCIO PER LA FASE NATIVA (Android: ascolto della posizione in sottofondo e notifica all'arrivo).
  // Sono richiamabili anche da fuori, come window.DPArrivo, perché sarà la notifica a chiamarli quando si apre l'app:
  //   navigazioneAvviata(posto, da, nPiano) ricorda dove si sta andando e a che ora (solo sul dispositivo, chiave dp.navpend)
  //   arrivatoVicino(pend)                  mostra "Hai parcheggiato qui?" (la fase nativa lo chiama quando rileva l'arrivo entro CFG.ARRIVO_M)
  //   ritornoLontano(pend)                  mostra "Com'è andata?" (rientro nell'app lontano dal posto)
  //   esito('parcheggiato' | 'occupato', { posto, altrove })  registra l'esito: salva l'auto, oppure segna il posto occupato e propone il prossimo
  //   controllaRitorno()                    sceglie quale dei due fogli mostrare (lo chiamano visibilitychange e la ripresa di Capacitor)
  // "pend" = { id, lat, lon, t, comune, ora, da: 'elenco' | 'piano' | 'altro', piano, chiesto }; se manca si usa quello salvato.
  // La posizione dell'auto (dp.auto) resta solo sul dispositivo: non fa parte dei dati sincronizzati con l'account.
  const ARRIVO_MAX_MS = 2 * 3600 * 1000; // una navigazione conta per 2 ore
  const navPend = () => { const p = ls.get('dp.navpend', null); return p && p.id && isFinite(p.lat) && isFinite(p.lon) && isFinite(p.ora) ? p : null; };
  const autoSalvata = () => { const a = ls.get('dp.auto', null); return a && isFinite(a.lat) && isFinite(a.lon) && isFinite(a.ora) ? a : null; };
  const dentroElenco = (p) => !!p && p.da === 'elenco' && !!dest && lista.some((x) => x.s.id === p.id);

  function navigazioneAvviata(s, da, nPiano) {
    if (!s) return;
    ls.set('dp.navpend', { id: s.id, lat: s.lat, lon: s.lon, t: titolo(s), comune: s.comune || '', ora: Date.now(), da: da || 'altro', piano: da === 'piano' ? (nPiano || 0) : 0, chiesto: false });
  }
  function segnaOccupato(p) { // un posto si registra occupato una volta sola; il pin diventa grigio con la X
    if (!p || !p.id || occupati.has(p.id)) return;
    occupati.add(p.id); traccia('occupato', { comune: p.comune || null, dettaglio: String(p.id).slice(0, 80) }); disegna();
  }
  function esito(tipo, opz) {
    opz = opz || {}; const p = opz.posto || navPend(); if (!p) return;
    fermaAscolto(); annullaNotifica(ID_ARRIVO);
    if (tipo === 'occupato') {
      segnaOccupato(p); ls.set('dp.navpend', null);
      if (dentroElenco(p)) { fgChiudi(); arrivo(false); return; } // con l'elenco numerato il "prossimo" è il numero successivo dell'elenco
      if (selId) chiudiScheda(); // la scheda del posto occupato non serve più
      fgPianoB(p, (p.piano || 0) + 1);
    } else if (tipo === 'parcheggiato') {
      let lat = p.lat, lon = p.lon, t = p.t, nuovaVia = !t || /^Posto riservato$/i.test(t);
      if (opz.altrove && me) { lat = me.lat; lon = me.lon; t = ''; nuovaVia = true; }
      traccia('parcheggiato', { comune: p.comune || null, dettaglio: (opz.altrove ? 'altrove' : String(p.id)).slice(0, 80) });
      ls.set('dp.navpend', null);
      if (selId) chiudiScheda(); if (dest) chiudiDest(); // si è parcheggiato: si torna alla schermata principale, dove c'è il tasto dell'auto
      const a = { lat, lon, t: t || 'Posizione dell\'auto', ora: Date.now(), nota: '' }; ls.set('dp.auto', a);
      disegnaAuto(); fgMostra('salvata', {}); $('#fg-live').textContent = `Auto salvata: ${a.t}, alle ${oraDi(a.ora)}`;
      if (nuovaVia) indirizzoDa(lat, lon).then((v) => { const c = autoSalvata(); if (v && c && c.ora === a.ora) { c.t = v; ls.set('dp.auto', c); fgRinfresca(); } });
    }
  }
  // indirizzo di un punto: TomTom se c'è la chiave, altrimenti Photon (come per le segnalazioni)
  async function indirizzoDa(lat, lon) {
    try {
      const sg = new AbortController().signal;
      if (TT) { const r = await entro(`https://api.tomtom.com/search/2/reverseGeocode/${lat},${lon}.json?key=${TT}&language=it-IT&radius=60`, sg, 5000); const a = (((await r.json()).addresses || [])[0] || {}).address || {}; return [a.streetName, a.streetNumber].filter(Boolean).join(' '); }
      const r = await entro(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`, sg, 5000); const q = ((await r.json()).features[0] || {}).properties || {};
      return q.street ? [q.street, q.housenumber].filter(Boolean).join(' ') : (q.name || '');
    } catch (e) { return ''; }
  }

  // --- al rientro nell'app ---
  let ritornoIn = false;
  async function posizioneFresca() { // il GPS in sottofondo può avere una posizione vecchia: ne chiedo una nuova (al massimo 4 secondi)
    const cap = window.Capacitor, G = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Geolocation;
    try {
      if (G) { const pos = await G.getCurrentPosition({ enableHighAccuracy: true, timeout: 4000 }); if (pos && pos.coords) setMe(pos.coords.latitude, pos.coords.longitude); return; }
      if (!navigator.geolocation || !me) return; // senza permesso già dato non si chiede nulla al rientro
      await new Promise((ok) => { const t = setTimeout(ok, 4500); navigator.geolocation.getCurrentPosition((pos) => { setMe(pos.coords.latitude, pos.coords.longitude); clearTimeout(t); ok(); }, () => { clearTimeout(t); ok(); }, { enableHighAccuracy: true, timeout: 4000, maximumAge: 10000 }); });
    } catch (e) { /* resta l'ultima posizione nota */ }
  }
  async function controllaRitorno() {
    const p = navPend(); if (!p || p.chiesto || ritornoIn || fgStato) return;
    if (Date.now() - p.ora > ARRIVO_MAX_MS) { ls.set('dp.navpend', null); return; }
    ritornoIn = true; try { await posizioneFresca(); } finally { ritornoIn = false; }
    const q = navPend(); if (!q || q.chiesto || q.ora !== p.ora || fgStato || !$('#welcome').hidden || !$('#aggiorna').hidden) return;
    if (me && dist(me.lat, me.lon, q.lat, q.lon) <= CFG.ARRIVO_M) arrivatoVicino(q); else ritornoLontano(q);
  }
  function segnaChiesto(p) { fermaAscolto(); annullaNotifica(ID_ARRIVO); p.chiesto = true; const q = navPend(); if (q && q.ora === p.ora) ls.set('dp.navpend', p); } // il foglio compare una sola volta per navigazione
  function arrivatoVicino(p) { p = p || navPend(); if (!p) return; segnaChiesto(p); fgMostra('qui', { p }); }
  function ritornoLontano(p) { p = p || navPend(); if (!p) return; segnaChiesto(p); fgMostra('come', { p, elenco: dentroElenco(p) }); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(controllaRitorno, 500); });
  (function () { const cap = window.Capacitor, A = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.App;
    if (A) { A.addListener('resume', () => setTimeout(controllaRitorno, 500)); A.addListener('appStateChange', (st) => { if (st && st.isActive) setTimeout(controllaRitorno, 500); }); } })();
  if (ls.get('dp.benvenuto', false)) setTimeout(controllaRitorno, 2500); // app riaperta da zero durante la navigazione

  // --- il foglio in basso (uno solo, con più stati: come, qui, pb, salvata, auto) ---
  let fgStato = null, fgDati = {}, fgFuoco = null, pbMk = [], autoMk = null;
  const oraDi = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  function quandoAuto(t) {
    const d = new Date(t), oggi = new Date(), ieri = new Date(Date.now() - 864e5), st = (x) => x.toDateString();
    return (st(d) === st(oggi) ? 'oggi' : st(d) === st(ieri) ? 'ieri' : 'il ' + d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })) + ' alle ' + oraDi(t);
  }
  function trascorso(ms) {
    const m = Math.floor(ms / 60000); if (m < 1) return 'proprio adesso'; if (m < 60) return (m === 1 ? '1 minuto' : m + ' minuti') + ' fa';
    const h = Math.floor(m / 60), r = m % 60; if (h < 24) return (h === 1 ? '1 ora' : h + ' ore') + (r ? ' e ' + (r === 1 ? '1 minuto' : r + ' minuti') : '') + ' fa';
    const g = Math.floor(h / 24); return (g === 1 ? '1 giorno' : g + ' giorni') + ' fa';
  }
  const bottoneX = (etic) => `<button class="fg-x" data-fg="chiudi" aria-label="${esc(etic)}">${icon('x')}</button>`;
  function fgMostra(stato, dati, senzaFuoco) {
    const prima = fgStato, attivo = document.activeElement, dentro = !!attivo && $('#fg-sheet').contains(attivo), tasto = dentro ? attivo.dataset.fg : null, eraTitolo = dentro && attivo.id === 'fg-h';
    if (!prima) fgFuoco = attivo;
    fgStato = stato; fgDati = dati || {};
    const r = fgHtml(stato, fgDati);
    document.body.classList.add('fg-on'); $('#fg').hidden = false; $('#fg-top').hidden = !r.top; $('#fg-top').innerHTML = r.top || '';
    $('#fg-sheet').innerHTML = '<div class="handle"></div>' + r.html;
    const volta = tasto && $('#fg-sheet').querySelector(`[data-fg="${tasto}"]`), h = $('#fg-h');
    if (!senzaFuoco || eraTitolo) { if (h) h.focus({ preventScroll: true }); } else if (volta) volta.focus({ preventScroll: true });
    if (!senzaFuoco) { if (stato === 'come' || stato === 'pb') fgProposta(); fgMappa(); }
  }
  function fgRinfresca() { if (fgStato === 'come' || fgStato === 'pb') fgProposta(); else if (fgStato) fgMostra(fgStato, fgDati, true); }
  function fgChiudi() {
    if (!fgStato) return; fgStato = null; fgDati = {}; pbPulisci();
    document.body.classList.remove('fg-on'); $('#fg').hidden = true; $('#fg-top').hidden = true;
    const f = fgFuoco; fgFuoco = null; if (f && f.isConnected && f !== document.body && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) { /* ignora */ } }
    if (pronta) map.easeTo({ padding: selId ? (LARGO() ? padPC() : { top: 90, bottom: $('#card .sheet').offsetHeight + 20, left: 0, right: 0 }) : padHome(), duration: 300 });
  }
  function fgInquadra(pts) { // porta in vista i punti sopra il foglio
    if (!pronta || !pts.length) return;
    const pad = LARGO() ? padPC(50) : { top: 120, bottom: $('#fg-sheet').offsetHeight + 40, left: 50, right: 50 };
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); seguo = false;
    if (pts.length === 1) { map.easeTo({ center: pts[0], zoom: Math.max(map.getZoom(), 16.5), padding: pad, duration: 500 }); return; }
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]); pts.slice(1).forEach((q) => b.extend(q)); map.fitBounds(b, { padding: pad, maxZoom: 17, duration: 500 });
  }
  function fgMappa() {
    const p = fgDati.p, a = autoSalvata();
    if (fgStato === 'auto' && a) fgInquadra(me ? [[a.lon, a.lat], [me.lon, me.lat]] : [[a.lon, a.lat]]);
    else if (fgStato === 'salvata' && a) fgInquadra([[a.lon, a.lat]]);
    else if ((fgStato === 'qui' || fgStato === 'come') && p) fgInquadra([[p.lon, p.lat]]);
  }
  function fgHtml(stato, d) {
    const p = d.p, a = autoSalvata();
    if (stato === 'come') return { html: `${bottoneX('Chiudi, non ora')}
      <div class="fg-testa"><div class="eyebrow">Verso ${esc(p.t)}</div><h2 id="fg-h" tabindex="-1">Com'è andata?</h2></div>
      <button class="primary" data-fg="parcheggiato">${icon('check')}<span>Ho parcheggiato qui</span></button>
      <button class="btn2" data-fg="occupato"><span>${esc(d.etichetta || 'Occupato, portami al prossimo')}</span></button>
      ${d.prox || ''}
      <button class="btn3" data-fg="chiudi">Non ora</button>` };
    if (stato === 'qui') { const m = me ? dist(me.lat, me.lon, p.lat, p.lon) : null; return { html: `${bottoneX('Chiudi, non ora')}
      <div class="fg-testa"><div class="eyebrow">${m != null && m >= 10 ? 'Sei a ' + fmtDist(m) + ' dal posto' : 'Sei arrivato al posto'}</div><h2 id="fg-h" tabindex="-1">Hai parcheggiato qui?</h2>
        <p class="muted">Se sì, salvo la posizione dell'auto e al ritorno ti ci riporto.</p></div>
      <button class="primary" data-fg="parcheggiato">${icon('check')}<span>Sì, salva la posizione</span></button>
      <button class="btn2" data-fg="occupato"><span>No, era occupato</span></button>
      <button class="btn3" data-fg="altrove">Ho parcheggiato altrove</button>` }; }
    if (stato === 'pb') {
      const P = d.prop, n0 = P && P.out[0], n1 = P && P.out[1];
      const top = `${icon('nav')}<div><b>Piano B attivo</b><span>${P && !P.usoMe ? 'Ti porto al posto libero più vicino a quello occupato' : 'Ti porto al posto libero più vicino a te'}</span></div>`;
      if (!n0) return { top, html: `${bottoneX('Chiudi il piano B')}
        <div class="fg-testa"><div class="eyebrow">Piano B</div><h2 id="fg-h" tabindex="-1">${P && !d.attesa ? 'Non trovo altri posti qui vicino' : 'Cerco il prossimo posto…'}</h2>${P && !d.attesa ? '<p class="muted">Prova a cercare un indirizzo o a spostare la mappa.</p>' : ''}</div>
        <button class="btn2" data-fg="cerca"><span>Cerca un altro posto</span></button><button class="btn3" data-fg="altrove-trovato">Ho trovato posto altrove</button>` };
      return { top, html: `${bottoneX('Chiudi il piano B')}
        <div class="fg-testa"><div class="eyebrow">Prossimo posto</div><h2 id="fg-h" tabindex="-1">${esc(titolo(n0.s))}</h2><div class="muted">${esc(descrizione(n0, P))}</div></div>
        <button class="primary" data-fg="vai">${icon('nav')}<span>Portami al numero ${n0.num}</span></button>
        ${n1 ? `<div class="fg-sez"><div class="eyebrow">Se è occupato anche quello</div><div class="fg-prox"><span class="num" aria-hidden="true">${n1.num}</span><span class="t"><b><span class="vh">Numero ${n1.num}: </span>${esc(titolo(n1.s))}</b><span>${esc(descrizione(n1, P))}</span></span></div></div>` : ''}
        <button class="btn3" data-fg="altrove-trovato">Ho trovato posto altrove</button>` };
    }
    if (stato === 'salvata' && a) return { html: `${bottoneX('Chiudi')}
      <div class="fg-ok" aria-hidden="true">${icon('car')}</div>
      <div class="fg-testa"><h2 id="fg-h" tabindex="-1">Auto salvata</h2><div class="b">${esc(a.t)} · ${esc(quandoAuto(a.ora))}</div>
        <p class="muted">Quando vuoi tornare, tocca «La tua auto» sulla mappa. La posizione resta solo su questo telefono.</p></div>
      ${a.nota && !d.nota ? `<div class="fg-nota"><span class="muted small">La tua nota</span><b>${esc(a.nota)}</b></div>` : ''}
      ${d.nota ? `<div class="fg-campo"><label for="fg-nota" class="lab">Nota (piano, settore)</label><input id="fg-nota" maxlength="80" value="${esc(a.nota || '')}" autocomplete="off" enterkeyhint="done"><button class="primary" data-fg="nota-ok">${icon('check')}<span>Salva la nota</span></button></div>`
        : `<button class="btn2" data-fg="nota"><span>${a.nota ? 'Modifica la nota' : 'Aggiungi una nota (piano, settore)'}</span></button>`}
      <button class="primary" data-fg="chiudi">${icon('check')}<span>Fatto</span></button>
      <button class="btn3 dang" data-fg="togli">Non salvare la posizione</button>` };
    if (stato === 'auto' && a) {
      const m = me ? dist(me.lat, me.lon, a.lat, a.lon) : null; // niente richieste di rete: la posizione dell'auto non esce dal telefono; i minuti sono una stima (strada = linea d'aria x 1,25, 80 m al minuto)
      const min = m != null && m <= 2500 ? 'circa ' + fmtMin(m * 1.25 / 80 * 60) : '';
      return { html: `${bottoneX('Chiudi')}
        <div class="fg-testa"><div class="eyebrow">La tua auto</div><h2 id="fg-h" tabindex="-1">${esc(a.t)}</h2><div class="muted">Parcheggiata ${esc(quandoAuto(a.ora))} · ${esc(trascorso(Date.now() - a.ora))}</div></div>
        ${m != null ? `<div class="fg-stat"><div><b>${esc(fmtDist(m))}</b><span>dalla tua posizione</span></div>${min ? `<div><b>${esc(min)}</b><span>a piedi</span></div>` : ''}</div>` : ''}
        ${a.nota ? `<div class="fg-nota"><span class="muted small">La tua nota</span><b>${esc(a.nota)}</b></div>` : ''}
        <button class="primary" data-fg="riporta">${icon('nav')}<span>Riportami all'auto</span></button>
        <button class="btn3 dang" data-fg="togli">Sono ripartito, togli la posizione</button>` };
    }
    return { html: '' };
  }
  function fgAggiornaAuto() { // la distanza dall'auto cambia mentre cammini: ridisegno il foglio solo se il numero mostrato è cambiato
    if (fgStato !== 'auto') return; const a = autoSalvata(); if (!a || !me) return;
    const k = fmtDist(dist(me.lat, me.lon, a.lat, a.lon)); if (fgDati.k === k) return; fgDati.k = k; fgRinfresca();
  }
  $('#fg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fg]'); if (!b) return; const k = b.dataset.fg, d = fgDati, p = d.p;
    if (k === 'chiudi') { fgChiudi(); return; }
    if (k === 'parcheggiato') { esito('parcheggiato', { posto: p }); return; }
    if (k === 'altrove') { esito('parcheggiato', { posto: p, altrove: true }); return; }
    if (k === 'occupato') {
      if (d.elenco && fgStato === 'come') { // con l'elenco numerato vale "Occupato? Portami al numero N" dell'elenco: stessa numerazione
        const i = lista.findIndex((x) => x.s.id === p.id); fgChiudi(); ls.set('dp.navpend', null);
        if (i >= 0 && prossimoElenco(i) >= 0) { inCorso = i; avantiElenco(); } else { segnaOccupato(p); arrivo(false); toast('Non ci sono altri posti nell\'elenco.'); }
        return;
      }
      esito('occupato', { posto: p }); return;
    }
    if (k === 'vai') { const n0 = d.prop && d.prop.out[0]; if (!n0) return; const n = n0.num - 1; fgChiudi(); naviga(n0.s, 'piano', n); return; }
    if (k === 'altrove-trovato') { fgChiudi(); toast('Va bene, piano B chiuso.'); return; }
    if (k === 'cerca') { fgChiudi(); apriRicerca(); return; }
    if (k === 'nota') { d.nota = true; fgMostra('salvata', d, true); const i = $('#fg-nota'); if (i) { i.focus(); i.select(); } return; }
    if (k === 'nota-ok') { const a = autoSalvata(), i = $('#fg-nota'); if (a && i) { a.nota = i.value.trim().slice(0, 80); ls.set('dp.auto', a); } d.nota = false; fgMostra('salvata', d, true); const bt = $('#fg-sheet').querySelector('[data-fg="nota"]'); if (bt) bt.focus(); return; }
    if (k === 'togli') { ls.set('dp.auto', null); disegnaAuto(); fgChiudi(); toast('Posizione dell\'auto eliminata.'); return; }
    if (k === 'riporta') { const a = autoSalvata(); if (a) apri(`https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lon}&travelmode=walking`); }
  });
  $('#fg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'fg-nota') { e.preventDefault(); const b = $('#fg-sheet').querySelector('[data-fg="nota-ok"]'); if (b) b.click(); } });

  // --- piano B: il prossimo posto libero, dalla posizione di adesso ---
  function fgPianoB(p, n) { fgMostra('pb', { p, n, piano: true }); }
  function pbPulisci() { pbMk.forEach((m) => m.remove()); pbMk = []; }
  function proposte(p) { // i due posti liberi più vicini a dove sei adesso (o al posto occupato, se la posizione non è nota)
    const usoMe = !!me, ref = me || { lat: p.lat, lon: p.lon }, esclusi = [{ lat: p.lat, lon: p.lon }];
    for (const id of occupati) { const o = stalli.get(id); if (o) esclusi.push(o); }
    const tutti = [];
    for (const s of stalli.values()) {
      if (s.id === p.id || occupati.has(s.id) || !passa(s)) continue; const d = dist(ref.lat, ref.lon, s.lat, s.lon); if (d > 5000) continue;
      if (esclusi.some((o) => dist(o.lat, o.lon, s.lat, s.lon) < 25)) continue; tutti.push({ s, d });
    }
    tutti.sort((a, b) => a.d - b.d); const out = [];
    for (const x of tutti) { if (!out.some((y) => dist(x.s.lat, x.s.lon, y.s.lat, y.s.lon) < 25)) out.push(x); if (out.length === 2) break; }
    return { usoMe, ref, out };
  }
  function proposteElenco(p) { // con l'elenco numerato: i due successivi non occupati, con i loro numeri
    const out = []; for (let i = lista.findIndex((x) => x.s.id === p.id) + 1; i < lista.length && out.length < 2; i++) if (!occupati.has(lista[i].s.id)) out.push({ s: lista[i].s, d: lista[i].d, num: i + 1, elenco: true });
    return { usoMe: false, ref: { lat: dest ? dest.lat : p.lat, lon: dest ? dest.lon : p.lon }, out };
  }
  function descrizione(x, P) { // "Verificato · 1 posto · 2 min in auto"
    const r = P.usoMe ? (traffico(x.s) || suStrada(me, x.s, 'car')) : null;
    return [affidabilita(x.s)[1], posti(x.s.posti), r ? fmtMin(r.sec) + ' in auto' : 'a ' + fmtDist(x.d) + (x.elenco ? ' dalla destinazione' : P.usoMe ? ' da te' : ' da qui')].join(' · ');
  }
  function fgProposta() { // calcola i candidati e ridisegna il foglio; si richiama da sé quando arrivano tempi, indirizzi o dati nuovi
    const d = fgDati, p = d.p; if (!p || (fgStato !== 'come' && fgStato !== 'pb')) return;
    const P = d.elenco ? proposteElenco(p) : proposte(p), n0 = (p.piano || 0) + 2;
    P.out.forEach((x, i) => { x.num = x.num || (d.piano ? d.n + 1 + i : n0 + i); trovaVia(x.s); });
    d.prop = P;
    if (fgStato === 'come') {
      const x = P.out[0]; d.etichetta = x ? (d.elenco ? `Occupato, portami al numero ${x.num}` : 'Occupato, portami al prossimo') : 'Occupato';
      const r = x && P.usoMe ? (traffico(x.s) || suStrada(me, x.s, 'car')) : null;
      d.prox = x ? `<div class="fg-prox"><span class="num" aria-hidden="true">${x.num}</span><span class="t"><b>Il prossimo: ${esc(titolo(x.s))}</b><span>${esc(r ? fmtMin(r.sec) + ' in auto da dove sei' : 'a ' + fmtDist(x.d) + (d.elenco ? ' dalla destinazione' : P.usoMe ? ' da dove sei' : ' da qui'))}</span></span></div>` : '';
    }
    if (!P.out.length && !d.caricato && !d.elenco) { // nessun posto in memoria attorno: carico la zona una volta sola
      d.caricato = d.attesa = true;
      carica(P.ref.lat - 0.024, P.ref.lon - 0.035, P.ref.lat + 0.024, P.ref.lon + 0.035, false).then(() => { d.attesa = false; if (fgDati === d) fgProposta(); });
    }
    if (P.usoMe && P.out.length) tempi(me, P.out.map((x) => ({ s: x.s })), 'car').then((ok) => { if (ok && fgDati === d) fgProposta(); });
    pbPulisci();
    P.out.forEach((x, i) => { const el = document.createElement('div'); el.className = 'mnum' + (i === 0 ? ' on' : ''); el.textContent = x.num; el.setAttribute('role', 'img'); el.setAttribute('aria-label', `Posto numero ${x.num}`); pbMk.push(new maplibregl.Marker({ element: el }).setLngLat([x.s.lon, x.s.lat]).addTo(map)); });
    fgMostra(fgStato, d, true);
    if (fgStato === 'pb' && P.out.length && !d.inquadrato) { d.inquadrato = true; const pts = [[p.lon, p.lat]]; if (me) pts.push([me.lon, me.lat]); P.out.forEach((x) => pts.push([x.s.lon, x.s.lat])); fgInquadra(pts); }
  }

  // --- l'auto salvata: segnaposto, tasto in alto, foglio "La tua auto" ---
  function disegnaAuto() {
    const a = autoSalvata();
    if (!a) { if (autoMk) { autoMk.remove(); autoMk = null; } }
    else if (!autoMk) {
      const el = document.createElement('button'); el.className = 'mauto'; el.type = 'button'; el.setAttribute('aria-label', 'La tua auto: apri i dettagli'); el.innerHTML = icon('car');
      el.onclick = (e) => { e.stopPropagation(); apriAuto(); }; autoMk = new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).addTo(map);
    } else autoMk.setLngLat([a.lon, a.lat]);
    aggiornaPillAuto();
  }
  function aggiornaPillAuto() {
    const a = autoSalvata(), b = $('#b-auto'), era = !b.hidden; b.hidden = !a; document.body.classList.toggle('con-auto', !!a);
    if (a) { const t = me ? `La tua auto · ${fmtDist(dist(me.lat, me.lon, a.lat, a.lon))}` : 'La tua auto', sp = b.querySelector('span'); if (sp.textContent !== t) sp.textContent = t; }
    if (era !== !!a && pronta && !selId && !dest && !aggiungo) map.setPadding(padHome());
  }
  function apriAuto() {
    const a = autoSalvata(); if (!a) return;
    fgMostra('auto', { k: me ? fmtDist(dist(me.lat, me.lon, a.lat, a.lon)) : '' });
  }
  $('#b-auto').onclick = apriAuto;
  disegnaAuto();
  window.DPArrivo = { navigazioneAvviata, arrivatoVicino, ritornoLontano, esito, controllaRitorno, apriAuto };

  // ---------- solo app Android: avviso all'arrivo ----------
  // Sul sito (senza Capacitor) niente di tutto questo si attiva. Plugin: @capacitor-community/background-geolocation (posizione mentre
  // l'app è in secondo piano, con servizio in primo piano di tipo "location": serve solo il permesso "mentre usi l'app") e
  // @capacitor/local-notifications (notifica all'arrivo con due azioni).
  // Le azioni della notifica richiamano i punti di aggancio qui sopra (esito, controllaRitorno).
  const NAT = () => SITO_NATIVO();
  const LN = () => plug('LocalNotifications');
  const plug = (n) => { const cap = window.Capacitor; try { return (NAT() && ((cap.Plugins && cap.Plugins[n]) || (cap.registerPlugin && cap.registerPlugin(n)))) || null; } catch (e) { return null; } };
  const ID_ARRIVO = 41, ASCOLTO_MAX_MS = 60 * 60000;
  let ascolto = null; // { id, timer, ora }
  const fuoriPronta = (f) => { const t = setInterval(() => { if (pronta) { clearInterval(t); f(); } }, 200); setTimeout(() => clearInterval(t), 20000); };

  // permesso per le notifiche (Android 13+): prima una frase chiara, poi la richiesta di sistema. true = concesso.
  function chiediNotifiche(frase) {
    const L = LN(); if (!L) return Promise.resolve(false);
    return L.checkPermissions().then((st) => {
      if (st.display === 'granted') return true;
      if (st.display === 'denied') return false; // rifiutato per sempre: Android non lo richiede più
      return new Promise((ok) => {
        const v = $('#velo-n'), fuoco = document.activeElement; $('#vn-p').textContent = frase; v.hidden = false; $('#vn-h').focus();
        const fine = (si) => { v.hidden = true; $('#vn-si').onclick = $('#vn-no').onclick = null; if (fuoco && fuoco.isConnected && fuoco.focus) { try { fuoco.focus({ preventScroll: true }); } catch (e) { /* ignora */ } } ok(si); };
        $('#vn-si').onclick = () => { L.requestPermissions().then((r) => { fine(r.display === 'granted'); }, () => fine(false)); };
        $('#vn-no').onclick = () => fine(false);
      });
    }).catch(() => false);
  }
  async function preparaNotifiche() { // canali e azioni; si rifà a ogni uso, è leggero e idempotente
    const L = LN(); if (!L) return false;
    try {
      await L.createChannel({ id: 'arrivo', name: 'Arrivo al posto', description: 'Ti avvisa quando sei vicino al posto riservato', importance: 4, visibility: 1, vibration: true });
      await L.registerActionTypes({ types: [{ id: 'ARRIVO', actions: [{ id: 'parcheggiato', title: 'Ho parcheggiato' }, { id: 'occupato', title: 'Occupato' }] }] });
      return true;
    } catch (e) { return false; }
  }
  async function annullaNotifica(id) { const L = LN(); if (L) { try { await L.cancel({ notifications: [{ id }] }); } catch (e) { /* niente da annullare */ } } }

  function fermaAscolto() {
    const a = ascolto; ascolto = null; if (!a) return; clearTimeout(a.timer);
    const BG = plug('BackgroundGeolocation'); if (BG && a.id != null) { try { Promise.resolve(BG.removeWatcher({ id: a.id })).catch(() => {}); } catch (e) { /* già fermo */ } }
  }
  // Parte quando si tocca «Portami lì», con l'app in primo piano. Se mancano permesso di posizione o di notifiche non fa nulla:
  // restano i fogli al rientro nell'app, come sul sito.
  async function avviaAscolto(p) {
    fermaAscolto(); const BG = plug('BackgroundGeolocation'), G = plug('Geolocation'); if (!BG || !G || !LN() || ascolto) return;
    try {
      const pos = await G.checkPermissions(); if (pos.location !== 'granted') return;
      if (Date.now() - ls.get('dp.notifNo', 0) < 3 * 864e5 && (await LN().checkPermissions()).display !== 'granted') return; // ha detto «Non ora» da poco
      const si = await chiediNotifiche('Ti mando una notifica solo quando sei vicino al posto, per chiederti com\'è andata. Durante il viaggio non ti disturbo.');
      if (!si) { ls.set('dp.notifNo', Date.now()); return; }
      await preparaNotifiche();
      const mio = { id: null, timer: setTimeout(fermaAscolto, ASCOLTO_MAX_MS), ora: p.ora }; ascolto = mio;
      const id = await BG.addWatcher({ backgroundTitle: 'SostAbile', backgroundMessage: 'SostAbile ti avvisa all\'arrivo', requestPermissions: false, stale: false, distanceFilter: 15 }, (loc, err) => {
        if (ascolto !== mio) return;
        if (err) { if (err.code === 'NOT_AUTHORIZED') fermaAscolto(); return; }
        const q = navPend(); if (!q || q.ora !== mio.ora || q.chiesto || Date.now() - q.ora > ASCOLTO_MAX_MS) { fermaAscolto(); return; }
        if (!loc || !(loc.accuracy <= 100)) return; // posizione troppo incerta
        if (dist(loc.latitude, loc.longitude, q.lat, q.lon) <= CFG.ARRIVO_M) notificaArrivo(q);
      });
      if (ascolto === mio) mio.id = id; else if (BG) { try { Promise.resolve(BG.removeWatcher({ id })).catch(() => {}); } catch (e) { /* ignora */ } }
    } catch (e) { fermaAscolto(); }
  }
  async function notificaArrivo(p) { // «arrivato vicino al posto»: se l'app è visibile basta il foglio, altrimenti la notifica
    fermaAscolto();
    if (document.visibilityState === 'visible') { controllaRitorno(); return; }
    const L = LN(); if (!L) return;
    try { await L.schedule({ notifications: [{ id: ID_ARRIVO, title: 'SostAbile', body: `Sei quasi arrivato in ${p.t}. Com'è andata?`, channelId: 'arrivo', actionTypeId: 'ARRIVO', extra: { ora: p.ora } }] }); } catch (e) { /* senza notifica restano i fogli */ }
  }
  function azioneNotifica(ev) {
    const n = ev && ev.notification; if (!n) return;
    if (n.id === ID_ARRIVO) {
      annullaNotifica(ID_ARRIVO); const p = navPend(), ora = n.extra && n.extra.ora;
      if (!p || (ora && p.ora !== ora)) return; // già risolta dentro l'app
      fuoriPronta(() => { if (ev.actionId === 'parcheggiato') esito('parcheggiato', { posto: p }); else if (ev.actionId === 'occupato') esito('occupato', { posto: p }); else controllaRitorno(); });
    }
  }
  if (NAT() && LN()) { try { LN().addListener('localNotificationActionPerformed', azioneNotifica); } catch (e) { /* senza ascolto restano i fogli */ } }


  // ---------- ricerca per tipo di luogo (in aggiunta alla ricerca per indirizzo) ----------
  // I luoghi vengono da un nostro elenco di punti d'interesse di OpenStreetMap, a tasselli (file statici del sito, generati da tools/poi_osm.py):
  // funziona uguale sul web e su Android, senza servizi a pagamento. TomTom Search resta solo come riserva (dove c'è la chiave) se il tassello non si scarica.
  // "e" è l'etichetta usata quando il luogo non ha nome. Le chiavi "k" sono le stesse di tools/poi_osm.py. Il resto (cat, q, si, no) serve solo alla
  // riserva TomTom: categorie della Search API (categorySearch / poiSearch), "si" tiene solo i nomi che c'entrano.
  const CATEGORIE = [
    { k: 'ospedali', n: 'Ospedali', e: 'Ospedale', ic: 'ospedale', cat: '7321', si: /ospedal|hospital|policlinic|clinica|presidio|pronto soccorso|casa di cura|irccs|asst|azienda sanitaria/i },
    { k: 'stazioni', n: 'Stazioni', e: 'Stazione', ic: 'treno', q: 'stazione ferroviaria', si: (x) => (/^stazione/i.test(x.poi.name) || /national|international/.test((x.poi.categories || []).join())) && !/biglietteria|cargo|s\.?p\.?a/i.test(x.poi.name) },
    { k: 'uffici', n: 'Uffici pubblici', e: 'Ufficio pubblico', ic: 'ufficio', cat: '7367,7324' },
    { k: 'farmacie', n: 'Farmacie', e: 'Farmacia', ic: 'farmacia', cat: '7326', no: /erboristeria|drogheria/i },
    { k: 'supermercati', n: 'Supermercati', e: 'Supermercato', ic: 'carrello', cat: '7332005' },
    { k: 'scuole', n: 'Scuole', e: 'Scuola', ic: 'scuola', cat: '7372004,7372005,7372006,7372014,7372007,7372009' },
  ];
  let luoghiCat = [];
  const htmlCategorie = () => `<div class="eyebrow">Cerca un luogo vicino a te</div><div class="muted small" style="padding-bottom:8px">Scegli il tipo di luogo: ti mostro i posti riservati più vicini all'ingresso.</div>
    <div class="catgrid">${CATEGORIE.map((c) => `<button data-cat="${c.k}"><span class="mk">${icon(c.ic)}</span><span>${c.n}</span></button>`).join('')}</div>`;
  const messaggioCat = (testo, vuotoCat) => { $('#s-body').innerHTML = vuotoCat ? `<div class="s-msg">${vuoto('cerca', vuotoCat, testo, null, true)}<button class="bsm" data-cat-fine="1">Torna alla ricerca</button></div>` : `<div class="s-msg" role="status"><div class="empty">${testo}</div><button class="bsm" data-cat-fine="1">Torna alla ricerca</button></div>`; };

  // Elenco OSM a tasselli. Sul web sta accanto all'app (poi/); su Android l'app è un guscio locale e li scarica dal sito pubblicato.
  // Ogni tassello (circa 0,25 gradi) si scarica una volta sola: resta in memoria e, con la versione nell'indirizzo, nella cache del browser (anche offline).
  const POI_RAGGIO = 10000, POI_MAX = 8;
  const poiBase = () => NATIVO() ? (/sostabile\.it/.test(SITO_ANDROID) ? SITO_ANDROID + 'app/poi/' : SITO_ANDROID.replace(/sito\/$/, 'poi/')) : new URL('poi/', document.baseURI).href;
  let poiMeta = null; const poiTess = new Map();
  async function poiLeggi(url, ms, primaCache) {
    let cache = null; try { cache = await caches.open('dp-poi'); } catch (e) { /* senza cache si va solo in rete */ }
    if (cache && primaCache) { try { const h = await cache.match(url); if (h) return await h.json(); } catch (e) { /* rete */ } }
    try {
      const r = await entro(url, new AbortController().signal, ms); if (!r.ok) throw new Error(r.status);
      const j = await r.clone().json(); if (cache) { try { cache.put(url, r); } catch (e) { /* non è grave */ } } return j;
    } catch (e) {
      if (cache && !primaCache) { try { const h = await cache.match(url); if (h) return await h.json(); } catch (e2) { /* niente copia */ } }
      throw e;
    }
  }
  function poiMetaGet() {
    if (!poiMeta) poiMeta = poiLeggi(poiBase() + 'meta.json', 6000, false).then((m) => { if (!m || !m.d || !Array.isArray(m.tasselli)) throw new Error('meta'); m.set = new Set(m.tasselli); return m; }).catch((e) => { poiMeta = null; throw e; });
    return poiMeta;
  }
  function poiTassello(m, id) {
    if (!poiTess.has(id)) poiTess.set(id, poiLeggi(`${poiBase()}${id}.json?v=${encodeURIComponent(m.v)}`, 10000, true).catch((e) => { poiTess.delete(id); throw e; }));
    return poiTess.get(id);
  }
  async function cercaPoi(c, centro) {
    const m = await poiMetaGet(), D = m.d, dla = POI_RAGGIO / 111320, dlo = POI_RAGGIO / (111320 * Math.cos(centro.lat * Math.PI / 180)), ids = [];
    for (let iy = Math.floor((centro.lat - dla) * D); iy <= Math.floor((centro.lat + dla) * D); iy++)
      for (let ix = Math.floor((centro.lon - dlo) * D); ix <= Math.floor((centro.lon + dlo) * D); ix++) if (m.set.has(iy + '_' + ix)) ids.push(iy + '_' + ix);
    const tess = await Promise.all(ids.map((id) => poiTassello(m, id))), v = [];
    for (const t of tess) for (const p of (t && t[c.k]) || []) { const d = dist(centro.lat, centro.lon, p[0], p[1]); if (d <= POI_RAGGIO) v.push({ t: p[2] || c.e, via: '', comune: '', lat: p[0], lon: p[1], d }); }
    return ordinaLuoghi(v);
  }
  function ordinaLuoghi(v) { // per distanza; niente doppioni a pochi metri l'uno dall'altro; al massimo POI_MAX
    v.sort((a, b) => a.d - b.d); const out = [];
    for (const x of v) { if (out.some((y) => dist(x.lat, x.lon, y.lat, y.lon) < 150)) continue; out.push(x); if (out.length === POI_MAX) break; }
    return out;
  }
  // Riserva: TomTom Search (solo dove c'è la chiave: l'app Android), se l'elenco della zona non si scarica
  async function cercaTomTom(c, centro, signal) {
    const url = `https://api.tomtom.com/search/2/${c.q ? 'poiSearch/' + encodeURIComponent(c.q) : 'categorySearch/.'}.json?key=${TT}&lat=${centro.lat}&lon=${centro.lon}&radius=10000&limit=25&countrySet=IT&language=it-IT${c.cat ? '&categorySet=' + c.cat : ''}`;
    const r = await entro(url, signal, 6000); if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const v = (j.results || []).filter((x) => x.poi && x.poi.name && x.position && (!c.si || (typeof c.si === 'function' ? c.si(x) : c.si.test(x.poi.name))) && !(c.no && c.no.test(x.poi.name)))
      .map((x) => { const a = x.address || {}; return { t: x.poi.name, via: [a.streetName, a.streetNumber].filter(Boolean).join(' '), comune: a.municipality || '', lat: x.position.lat, lon: x.position.lon, d: dist(centro.lat, centro.lon, x.position.lat, x.position.lon) }; });
    return ordinaLuoghi(v);
  }
  async function apriCategoria(k) {
    const c = CATEGORIE.find((x) => x.k === k); if (!c) return;
    catAperta = k; if (sCtl) sCtl.abort(); sCtl = new AbortController(); const mio = sCtl;
    $('#s-body').innerHTML = `<div class="empty cerco" role="status">Cerco ${c.n.toLowerCase()} vicino a te…</div>`;
    const centro = me ? { lat: me.lat, lon: me.lon } : { lat: map.getCenter().lat, lon: map.getCenter().lng }, usoMe = !!me;
    try {
      let v, osm = true;
      try { v = await cercaPoi(c, centro); }
      catch (e) { if (TT) { osm = false; traccia('categoria'); v = await cercaTomTom(c, centro, mio.signal); } else throw e; } // il contatore TomTom Search conta solo le richieste vere
      if (sCtl !== mio) return;
      luoghiCat = v;
      if (!luoghiCat.length) { messaggioCat('Prova a cercare per nome o indirizzo.', `Non trovo ${c.n.toLowerCase()} nei dintorni`); return; }
      $('#s-body').innerHTML = `<div class="cat-testa"><h2 id="cat-h" tabindex="-1">${c.n}</h2><div class="muted">${usoMe ? 'Vicino a te' : 'Vicino al centro della mappa'}</div></div>` +
        luoghiCat.map((x, i) => `<button class="res luogoc" data-luogo="${i}"><span class="mk">${icon(c.ic)}</span><span class="t"><b>${esc(x.t)}</b><span>${esc([x.via, x.comune].filter(Boolean).join(', '))}</span><span class="cnt" data-cnt="${i}"></span></span><span class="d">${fmtDist(x.d)}</span></button>`).join('') +
        `<div class="cat-piede"><p>Tocca un luogo per vedere i posti numerati attorno, come con un indirizzo.</p><button class="lnk" data-cat-fine="1"><span>Non lo trovi? Cerca per nome o indirizzo</span></button>${osm ? '<p class="muted small">Luoghi: © OpenStreetMap contributors</p>' : ''}</div>`;
      const h = $('#cat-h'); if (h) h.focus({ preventScroll: true });
      contaLuoghi(luoghiCat.slice(), mio.signal);
    } catch (e) { if (e.name === 'AbortError' || sCtl !== mio) return; messaggioCat('La ricerca per tipo di luogo non risponde. Controlla la connessione, oppure cerca per nome o indirizzo.'); }
  }
  // Posti riservati attorno a ogni luogo: al massimo 6 richieste per ricerca. Ogni richiesta copre una zona di circa 5 x 5 km attorno
  // a un luogo e vale per tutti i luoghi che ci cadono dentro con almeno 1 km di margine (il raggio massimo): gli altri restano senza riga.
  async function contaLuoghi(arr, signal) {
    const HH = 0.0245, HW = 0.036; let chiamate = 0; const coperti = new Set();
    for (const x of arr) {
      if (coperti.has(x) || chiamate >= 6 || signal.aborted) continue; chiamate++;
      const ih = HH - 1000 / 111320, iw = HW - 1000 / (111320 * Math.cos(x.lat * Math.PI / 180));
      try {
        const rows = await rpc('stalli_zona', { p_s: x.lat - HH, p_w: x.lon - HW, p_n: x.lat + HH, p_e: x.lon + HW }, signal);
        for (const y of rows) { const v = stalli.get(y.id); if (v && v._via) y._via = v._via; stalli.set(y.id, y); }
        disegna();
      } catch (e) { if (e.name === 'AbortError' || e.status === 429) return; continue; } // senza dati la riga non compare
      if (signal.aborted) return;
      for (const y of arr) if (Math.abs(y.lat - x.lat) <= ih && Math.abs(y.lon - x.lon) <= iw) coperti.add(y);
      for (const y of coperti) { const el = document.querySelector(`[data-cnt="${luoghiCat.indexOf(y)}"]`); if (el && !el.textContent) el.textContent = rigaPosti(y); }
    }
  }
  function rigaPosti(y) {
    const tutti = attorno(y.lat, y.lon), dentro = tutti.filter((z) => z.d <= raggio), n = dentro.reduce((a, z) => a + (z.s.posti || 1), 0), rg = raggio >= 1000 ? '1 km' : raggio + ' m';
    if (dentro.length) return `${n === 1 ? '1 posto riservato' : n + ' posti riservati'} · il più vicino a ${fmtDist(dentro[0].d)}`;
    const v = tutti[0]; return `Nessun posto entro ${rg}` + (v && v.d <= 1000 ? ` · il più vicino a ${fmtDist(v.d)}` : '');
  }
  function sceltaLuogo(i) {
    const x = luoghiCat[i]; if (!x) return;
    vaiA({ t: x.t, sub: [x.via, x.comune].filter(Boolean).join(', '), lat: x.lat, lon: x.lon, q: '', comune: x.comune });
  }

  // ---------- schermata 6 · segnala un posto nuovo ----------
  const nuovo = { tipo: 'generico', posti: 1, via: '', comune: '', doppio: false };
  let quiT, quiCtl;
  function apriAggiungi() {
    const oggi = new Date().toISOString().slice(0, 10), fatti = ls.get('dp.segnalati', {});
    if ((fatti[oggi] || 0) >= 10) { toast('Per oggi hai già segnalato 10 posti. Grazie! Riprova domani.', 4000); return; }
    aggiungo = true; nuovo.tipo = 'generico'; nuovo.posti = 1; $('#n-foto').value = ''; fotoStato(); segStato(); $('#n-posti').textContent = '1'; mostra();
    const c = me && dist(me.lat, me.lon, map.getCenter().lat, map.getCenter().lng) < 400 ? [me.lon, me.lat] : map.getCenter();
    seguo = false; map.easeTo({ center: c, zoom: Math.max(map.getZoom(), 18), padding: padHome(), duration: 400 });
    const pad = padHome(); $('#n-pin').style.top = (pad.top + (window.innerHeight - pad.top - pad.bottom) / 2) + 'px'; $('#n-pin').style.left = (pad.left + (window.innerWidth - pad.left - pad.right) / 2) + 'px';
    qui();
  }
  function chiudiAggiungi() { aggiungo = false; mostra(); map.easeTo({ padding: padHome(), duration: 300 }); vicini(); }
  function segStato() { document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tipo === nuovo.tipo)); $('#n-nota').textContent = nuovo.tipo === 'personalizzato' ? 'I posti riservati a una sola targa vengono registrati ma non compaiono sulla mappa.' : 'Compare subito sulla mappa come "da verificare".'; }
  function fotoStato() { const f = $('#n-foto').files[0]; document.querySelector('.foto').classList.toggle('ok', !!f); $('#n-foto-t').textContent = f ? 'Foto pronta' : 'Scatta una foto'; $('#n-foto-s').textContent = f ? 'Tocca per rifarla' : 'Facoltativa, ma aiuta a verificarlo prima'; }
  function qui() { // cosa c'è sotto il segnaposto: indirizzo, ed eventuale posto già presente
    const c = map.getCenter(); let vicino = null;
    for (const s of stalli.values()) { const d = dist(c.lat, c.lng, s.lat, s.lon); if (d <= 12 && (!vicino || d < vicino.d)) vicino = { s, d }; }
    nuovo.doppio = !!vicino; $('#n-invia').disabled = !!vicino;
    if (vicino) { $('#n-dove').textContent = 'Qui c\'è già un posto in mappa. Sposta il segnaposto, oppure torna indietro e apri quel posto.'; return; }
    $('#n-dove').textContent = nuovo.via ? 'Vicino a ' + nuovo.via : 'Cerco l\'indirizzo…';
    clearTimeout(quiT); quiT = setTimeout(async () => {
      if (quiCtl) quiCtl.abort(); quiCtl = new AbortController();
      try {
        let via = '', comune = '';
        if (TT) { const r = await fetch(`https://api.tomtom.com/search/2/reverseGeocode/${c.lat},${c.lng}.json?key=${TT}&language=it-IT&radius=60`, { signal: quiCtl.signal }); const a = (((await r.json()).addresses || [])[0] || {}).address || {}; via = [a.streetName, a.streetNumber].filter(Boolean).join(' '); comune = a.municipality || ''; }
        else { const r = await fetch(`https://photon.komoot.io/reverse?lat=${c.lat}&lon=${c.lng}`, { signal: quiCtl.signal }); const q = ((await r.json()).features[0] || {}).properties || {}; via = q.street ? [q.street, q.housenumber].filter(Boolean).join(' ') : (q.name || ''); comune = q.city || ''; }
        nuovo.via = via; nuovo.comune = comune;
        if (aggiungo && !nuovo.doppio) $('#n-dove').textContent = via ? `Vicino a ${via}${comune ? ', ' + comune : ''}` : 'Posizione scelta sulla mappa';
      } catch (e) { if (e.name !== 'AbortError' && aggiungo && !nuovo.doppio) $('#n-dove').textContent = 'Posizione scelta sulla mappa'; }
    }, 500);
  }
  const uuid = () => { try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* senza contesto sicuro */ } const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128; const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  async function rimpicciolisci(file, max) { // le foto del telefono sono enormi: bastano 1280 px
    const img = await createImageBitmap(file), k = Math.min(1, (max || 1280) / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.82));
  }
  $('#n-close').onclick = chiudiAggiungi;
  $('#n-foto').onchange = fotoStato;
  document.querySelector('.seg').addEventListener('click', (e) => { const b = e.target.closest('[data-tipo]'); if (b) { nuovo.tipo = b.dataset.tipo; segStato(); } });
  $('#n-meno').onclick = () => { nuovo.posti = Math.max(1, nuovo.posti - 1); $('#n-posti').textContent = nuovo.posti; };
  $('#n-piu').onclick = () => { nuovo.posti = Math.min(20, nuovo.posti + 1); $('#n-posti').textContent = nuovo.posti; };
  $('#n-invia').onclick = async () => {
    const btn = $('#n-invia'), lab = btn.querySelector('span'), c = map.getCenter(); if (btn.disabled) return;
    btn.disabled = true; lab.textContent = 'Invio…';
    try {
      let foto_url = null; const f = $('#n-foto').files[0];
      if (f) {
        const blob = await rimpicciolisci(f), path = `${new Date().toISOString().slice(0, 10)}/${deviceId}-${Date.now()}.jpg`;
        const u = await fetch(`${CFG.SB}/storage/v1/object/foto/${path}`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'image/jpeg' }, H), body: blob });
        if (!u.ok) throw new Error('foto ' + u.status); foto_url = `${CFG.SB}/storage/v1/object/public/foto/${path}`;
      }
      // l'id lo genera il telefono: così non serve rileggere la riga (la lettura libera della tabella è chiusa, vedi supabase/12)
      const rec = { id: uuid(), lat: +c.lat.toFixed(7), lon: +c.lng.toFixed(7), tipo: nuovo.tipo, posti: nuovo.posti, indirizzo: nuovo.via || null, comune: nuovo.comune || null, foto_url, stato: 'proposto', fonte: 'utente', device_id: deviceId };
      const r = await fetch(`${CFG.SB}/rest/v1/stalli`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, H), body: JSON.stringify(rec) });
      if (!r.ok) throw new Error('invio ' + r.status);
      if (rec.tipo !== 'personalizzato') stalli.set(rec.id, { id: rec.id, lat: rec.lat, lon: rec.lon, tipo: rec.tipo, posti: rec.posti, nome: null, indirizzo: rec.indirizzo, comune: rec.comune, note: null, coperto: false, stato: 'proposto', fonte: 'utente', conferme_esiste: 0, conferme_non_esiste: 0, ultima_conferma: null });
      const oggi = new Date().toISOString().slice(0, 10), fatti = ls.get('dp.segnalati', {}); ls.set('dp.segnalati', { [oggi]: (fatti[oggi] || 0) + 1 });
      traccia('segnala', { comune: nuovo.comune || null, dettaglio: nuovo.tipo });
      chiudiAggiungi(); disegna(); toast(nuovo.tipo === 'personalizzato' ? 'Grazie! Posto registrato.' : 'Grazie! Il posto è in mappa come "da verificare".', 3500);
    } catch (err) { toast('Non sono riuscito a inviare la segnalazione. Controlla la connessione e riprova.', 4500); }
    lab.textContent = 'Invia la segnalazione'; btn.disabled = nuovo.doppio;
  };


  // ---------- account facoltativo e sincronizzazione ----------
  // Senza account tutto resta sul telefono. Con l'account, posti salvati, Casa/Lavoro e scadenza del contrassegno
  // vengono copiati nel profilo dell'utente (dati dell'account Supabase) e ritrovati su un altro telefono.
  let sessione = ls.get('dp.sessione', null), sincT;
  const profilo = () => Object.assign({ scadenza: '', giorni: 60, notifica: false }, ls.get('dp.profilo', {}));
  // Avvisi via email (li manda tools/avvisi_utenti.py): le scelte stanno in user_metadata.avvisi, separate dal pacchetto dp.
  // Il registro degli invii (user_metadata.avvisi_inviati) lo scrive solo lo script, per questo è una chiave a parte.
  const avvisi = () => Object.assign({ email_scadenza: false, nuovi_vicino: false }, ls.get('dp.avvisi', {}));
  function salvaAvvisi(pz) { const n = Object.assign(avvisi(), pz); ls.set('dp.avvisi', n); if (sessione) aut('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { avvisi: n } }) }).catch(() => {}); }
  async function aut(path, opt) {
    if (sessione && sessione.scade - 60 < Date.now() / 1000) {
      const r = await fetch(`${CFG.SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: CFG.KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sessione.refresh }) });
      if (r.ok) entra2(await r.json()); else if (r.status === 400 || r.status === 401) { sessione = null; ls.set('dp.sessione', null); throw new Error('sessione scaduta'); }
    }
    return fetch(CFG.SB + path, Object.assign({}, opt, { headers: Object.assign({ apikey: CFG.KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (sessione ? sessione.token : CFG.KEY) }, (opt || {}).headers) }));
  }
  // Se l'account con cui si accede è di un admin (public.is_admin() con il suo token), questo dispositivo è del gruppo interno: lo si chiede
  // UNA volta per account e si ricorda l'esito. Se la chiamata non riesce (offline) si riprova alla prossima apertura.
  async function controllaAdmin() {
    try {
      if (!sessione || !sessione.token) return; const chi = sessione.email || ''; if (!chi || ls.get('dp.adminChk', '') === chi) return;
      const r = await aut('/rest/v1/rpc/is_admin', { method: 'POST', body: '{}' }); if (!r.ok) return;
      const si = (await r.json()) === true; ls.set('dp.adminChk', chi);
      if (si && !eInterno()) { ls.set('dp.interno', 1); traccia('attivo'); }
    } catch (e) { /* si riprova alla prossima apertura */ }
  }
  // come si accede: 'google' se l'account ha solo Google (niente password), 'email' se ha anche la password; '' se non si sa
  const provDa = (u) => { const m = (u && u.app_metadata) || {}, p = Array.isArray(m.providers) && m.providers.length ? m.providers : m.provider ? [m.provider] : []; return !p.length ? '' : p.includes('email') ? 'email' : p[0]; };
  function entra2(j) { sessione = { token: j.access_token, refresh: j.refresh_token, scade: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || (sessione && sessione.email) || '', prov: provDa(j.user) || (sessione && sessione.prov) || '' }; ls.set('dp.sessione', sessione); }
  // i telefoni usati con questo account: servono a ritrovare le proprie segnalazioni anche da un telefono nuovo
  const dispositivi = (altri) => [...new Set([deviceId, ...ls.get('dp.dispositivi', []), ...(altri || [])])].slice(0, 20);
  const pacchetto = () => ({ salvati: [...salvati.values()], luoghi: luoghi(), profilo: profilo(), dispositivi: dispositivi(), agg: ls.get('dp.agg', 0) });
  function applica(d) {
    salvati.clear(); (d.salvati || []).forEach((x) => salvati.set(x.id, x)); ls.set('dp.salvati', [...salvati.values()]);
    ls.set('dp.luoghi', d.luoghi || {}); ls.set('dp.profilo', d.profilo || {}); ls.set('dp.agg', d.agg || Date.now()); programmaAvvisi();
  }
  function toccato() { ls.set('dp.agg', Date.now()); if (!sessione) return; clearTimeout(sincT); sincT = setTimeout(() => { aut('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { dp: pacchetto() } }) }).catch(() => {}); }, 1200); }
  async function allinea() { // dopo l'accesso: vince la copia più recente tra telefono e account
    try {
      const r = await aut('/auth/v1/user'); if (!r.ok) return; const u = await r.json(), remoto = (u.user_metadata || {}).dp; ls.set('dp.avvisi', (u.user_metadata || {}).avvisi || {}); if (provDa(u) && sessione && sessione.prov !== provDa(u)) { sessione.prov = provDa(u); ls.set('dp.sessione', sessione); }
      const nuovoQui = !remoto || !(remoto.dispositivi || []).includes(deviceId); if (remoto) ls.set('dp.dispositivi', dispositivi(remoto.dispositivi));
      const locale = pacchetto(), vuoto = !locale.salvati.length && !Object.keys(locale.luoghi).length && !locale.profilo.scadenza;
      if (remoto && (vuoto || (remoto.agg || 0) > locale.agg)) { applica(remoto); if (nuovoQui) await aut('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { dp: pacchetto() } }) }); } else if (!vuoto) { ls.set('dp.agg', locale.agg || Date.now()); await aut('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { dp: pacchetto() } }) }); }
    } catch (e) { /* si riprova al prossimo cambiamento */ }
  }
  // Regole della password per i nuovi account, uguali a quelle impostate su Supabase: lunghezza minima,
  // almeno una minuscola, una maiuscola, un numero e un carattere speciale.
  // Chi ha già un account con una password più semplice continua a entrare.
  const PASS_MIN = 10;
  function passMancante(p) {
    const m = [];
    if (p.length < PASS_MIN) m.push(p.length ? `altri ${PASS_MIN - p.length} caratteri` : `almeno ${PASS_MIN} caratteri`);
    if (!/[a-z]/.test(p)) m.push('una lettera minuscola');
    if (!/[A-Z]/.test(p)) m.push('una lettera maiuscola');
    if (!/[0-9]/.test(p)) m.push('un numero');
    if (!/[!@#$%^&*()_+\-=\[\]{};':"|<>?,.\/`~\\]/.test(p)) m.push('un carattere speciale (es. ! ? @ #)');
    return m;
  }
  async function accedi(email, password, nuovoAccount) {
    // Sul web il link di conferma riporta alla pagina da cui ci si è iscritti (non all'indirizzo predefinito di Supabase).
    const ritorno = nuovoAccount && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ? '?redirect_to=' + encodeURIComponent(location.origin + location.pathname) : '';
    const r = await fetch(`${CFG.SB}/auth/v1/${nuovoAccount ? 'signup' + ritorno : 'token?grant_type=password'}`, { method: 'POST', headers: { apikey: CFG.KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const m = (j.msg || j.error_description || j.message || '').toLowerCase(); throw new Error(/invalid login/.test(m) ? 'Email o password non corrette.' : /not confirmed/.test(m) ? 'Devi prima confermare l\'email: apri il link che ti abbiamo mandato.' : /already registered/.test(m) ? 'Questa email ha già un account: usa "Accedi".' : /password/.test(m) ? `La password deve avere almeno ${PASS_MIN} caratteri, con minuscola, maiuscola, numero e carattere speciale.` : /rate|too many/.test(m) ? 'Troppi tentativi. Riprova tra qualche minuto.' : 'Non riesco ad accedere. Riprova.'); }
    traccia(nuovoAccount ? 'registrazione' : 'accesso');
    if (!j.access_token) return 'conferma'; // account creato: serve il clic sul link ricevuto per email
    entra2(j); controllaAdmin(); await allinea(); return 'ok';
  }
  // Accesso con Google (OAuth di Supabase). Sul telefono si torna all'app con il link it.disabilityparking.app://login,
  // sul web si torna alla stessa pagina; in entrambi i casi i codici arrivano dopo il # dell'indirizzo.
  const NATIVO = () => { const cap = window.Capacitor; return !!(cap && cap.isNativePlatform && cap.isNativePlatform()); };
  function accediGoogle() {
    const torna = NATIVO() ? 'it.disabilityparking.app://login' : location.origin + location.pathname;
    ls.set('dp.google', Date.now());
    const url = `${CFG.SB}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(torna)}`;
    if (NATIVO()) apri(url); else location.href = url;
  }
  async function daGoogle(href) { // legge i codici tornati da Google e completa l'accesso
    const h = new URLSearchParams(String(href).split('#')[1] || ''), at = h.get('access_token');
    if (!at) { if (h.get('error')) toast('Accesso con Google non riuscito. Riprova.'); return false; }
    let email = ''; try { email = JSON.parse(atob(at.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || ''; } catch (e) { /* email non leggibile */ }
    entra2({ access_token: at, refresh_token: h.get('refresh_token'), expires_in: +h.get('expires_in') || 3600, user: { email, app_metadata: { provider: 'google' } } });
    traccia('accesso', { dettaglio: 'google' }); ls.set('dp.google', 0); controllaAdmin();
    try { await allinea(); } catch (e) { /* si riallinea alla prossima modifica */ }
    if (!$('#menu').hidden) menu(); toast('Accesso fatto. I tuoi posti ora ti seguono.'); return true;
  }
  // ---------- recupero della password ----------
  // Richiesta: POST /auth/v1/recover. Sul web il link riporta a questa pagina; sul telefono porta alla versione web (https://sostabile.it/app/),
  // dove si sceglie la nuova password: poi si accede nell'app. Il messaggio è sempre lo stesso, così non si scopre quali email sono registrate.
  const urlRecupero = () => NATIVO() ? 'https://sostabile.it/app/' : location.origin + location.pathname;
  let recTok = null; // token del link di recupero: serve solo a cambiare la password
  function apriRecupero(email) {
    $('#re-email').value = email || ''; $('#re-msg').textContent = ''; $('#re-go').disabled = false; $('#re-nota').hidden = !NATIVO();
    $('#recupero').hidden = false; $('#re-tit').focus({ preventScroll: true });
  }
  const chiudiRecupero = () => { $('#recupero').hidden = true; };
  $('#re-back').onclick = chiudiRecupero; $('#re-no').onclick = chiudiRecupero;
  $('#re-go').onclick = async () => {
    const btn = $('#re-go'), msg = $('#re-msg'), email = $('#re-email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { msg.textContent = 'Scrivi l\'email con cui ti sei registrato.'; $('#re-email').focus(); return; }
    btn.disabled = true; msg.textContent = 'Un momento…';
    try {
      const r = await fetch(`${CFG.SB}/auth/v1/recover?redirect_to=${encodeURIComponent(urlRecupero())}`, { method: 'POST', headers: { apikey: CFG.KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      if (r.status === 429) { msg.textContent = 'Hai chiesto troppi link in poco tempo. Aspetta qualche minuto e riprova.'; btn.disabled = false; return; }
      if (!r.ok && r.status >= 500) throw new Error('http ' + r.status);
      msg.textContent = 'Se l\'email è registrata, ti abbiamo mandato un link per scegliere una nuova password. Controlla anche lo spam.' + (NATIVO() ? ' Il link si apre nel browser: lì scegli la nuova password, poi torna nell\'app e accedi.' : '');
      setTimeout(() => { btn.disabled = false; }, 8000);
    } catch (e) { msg.textContent = 'Non riesco a mandare la richiesta. Controlla la connessione e riprova.'; btn.disabled = false; }
  };
  let cambioPw = false; // true: la schermata serve a cambiare la password con l'accesso già fatto (da "Il mio account"), non dopo il link di recupero
  function apriNuova(scaduto, cambio) {
    cambioPw = !!cambio; $('#n-annulla').hidden = !cambio;
    $('#n-form').hidden = !!scaduto; $('#n-scaduto').hidden = !scaduto; $('#n-msg').textContent = ''; $('#n-go').disabled = false;
    ['#n-p1', '#n-p2'].forEach((q) => { $(q).value = ''; nascondiPass($(q)); });
    $('#nuova').hidden = false; $('#n-tit').focus({ preventScroll: true });
  }
  function daRecupero(href) { // true se l'indirizzo porta i codici del link di recupero (o il suo errore)
    const h = new URLSearchParams(String(href).split('#')[1] || ''), at = h.get('access_token'), desc = h.get('error_description') || '';
    if (h.get('type') === 'recovery' && at) { recTok = { at, rt: h.get('refresh_token') || '', exp: +h.get('expires_in') || 3600 }; apriNuova(false); return true; }
    if (!at && (h.get('error_code') === 'otp_expired' || (/expired|invalid|scadut/i.test(desc) && !ls.get('dp.google', 0)))) { recTok = null; apriNuova(true); return true; }
    return false;
  }
  $('#n-nuovo').onclick = () => { $('#nuova').hidden = true; apriRecupero(''); };
  $('#n-chiudi').onclick = () => { $('#nuova').hidden = true; };
  $('#n-annulla').onclick = () => { $('#nuova').hidden = true; cambioPw = false; };
  $('#n-go').onclick = async () => {
    const btn = $('#n-go'), msg = $('#n-msg'), p1 = $('#n-p1').value, p2 = $('#n-p2').value; if ((!recTok && !cambioPw) || btn.disabled) return;
    const manca = passMancante(p1);
    if (manca.length) { msg.textContent = 'Alla password manca: ' + manca.join(', ') + '.'; $('#n-p1').focus(); return; }
    if (p1 !== p2) { msg.textContent = 'Le due password non coincidono.'; $('#n-p2').focus(); return; }
    btn.disabled = true; msg.textContent = 'Un momento…';
    try {
      const r = cambioPw ? await aut('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ password: p1 }) }) : await fetch(`${CFG.SB}/auth/v1/user`, { method: 'PUT', headers: { apikey: CFG.KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + recTok.at }, body: JSON.stringify({ password: p1 }) });
      const j = await r.json().catch(() => ({})), m = String(j.msg || j.message || j.error_description || '').toLowerCase();
      if (cambioPw && (r.status === 401 || r.status === 403 || /expired|invalid jwt|invalid token/.test(m))) { msg.textContent = 'La sessione è scaduta: esci, accedi di nuovo e riprova.'; btn.disabled = false; return; }
      if (cambioPw && /reauth|nonce/.test(m)) { msg.textContent = 'Per sicurezza esci, accedi di nuovo e riprova.'; btn.disabled = false; return; }
      if (r.status === 401 || r.status === 403 || /expired|invalid jwt|invalid token/.test(m)) { recTok = null; apriNuova(true); return; }
      if (!r.ok) { msg.textContent = /different|same/.test(m) ? 'La nuova password deve essere diversa da quella attuale.' : r.status === 429 ? 'Troppi tentativi. Riprova tra qualche minuto.' : /password/.test(m) ? `La password deve avere almeno ${PASS_MIN} caratteri, con minuscola, maiuscola, numero e carattere speciale.` : 'Non riesco a cambiare la password. Riprova.'; btn.disabled = false; return; }
      if (cambioPw) { cambioPw = false; $('#nuova').hidden = true; $('#n-p1').value = ''; $('#n-p2').value = ''; toast('Password cambiata', 4000); return; }
      let email = j.email || ''; if (!email) try { email = JSON.parse(atob(recTok.at.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || ''; } catch (e) { /* email non leggibile */ }
      entra2({ access_token: recTok.at, refresh_token: recTok.rt, expires_in: recTok.exp, user: { email } }); recTok = null;
      traccia('accesso', { dettaglio: 'recupero_password' }); controllaAdmin();
      $('#nuova').hidden = true; $('#n-p1').value = ''; $('#n-p2').value = ''; chiudiRecupero(); toast('Password cambiata', 4000);
      try { await allinea(); } catch (e) { /* si riallinea alla prossima modifica */ }
      if (!$('#menu').hidden) menu();
    } catch (e) { msg.textContent = /sessione scaduta/.test(String(e && e.message)) ? 'La sessione è scaduta: esci, accedi di nuovo e riprova.' : 'Non riesco a cambiare la password. Controlla la connessione e riprova.'; btn.disabled = false; }
  };
  if (/access_token=|error_description=|error_code=/.test(location.hash)) { const h = location.hash; history.replaceState(null, '', location.pathname + location.search); setTimeout(() => { if (!daRecupero(h)) daGoogle(h); }, 300); }
  (function () { const cap = window.Capacitor, A = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.App; if (A) A.addListener('appUrlOpen', (e) => { if (!e || !e.url) return; if (e.url.indexOf('it.disabilityparking.app://login') === 0) daGoogle(e.url); else { const m = /^it\.disabilityparking\.app:\/\/azione\/(vicino|casa|lavoro|auto)\/?$/.exec(e.url); if (m) azione(m[1]); } }); })();
  setTimeout(controllaAdmin, 4000); // chi è già dentro con un account admin (accesso fatto prima di questa versione)
  function esci() { if (sessione) fetch(`${CFG.SB}/auth/v1/logout`, { method: 'POST', headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + sessione.token } }).catch(() => {}); sessione = null; ls.set('dp.sessione', null); }

  // ---------- occhio sulle password e tastiera ----------
  // L'occhio non toglie il focus al campo (mousedown annullato) e rimette il cursore dov'era.
  function nascondiPass(i) { i.type = 'password'; const b = document.querySelector(`.occhio[aria-controls="${i.id}"]`); if (b) { b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Mostra password'); b.querySelector('use').setAttribute('href', '#i-eye'); } }
  document.addEventListener('mousedown', (e) => { if (e.target.closest('.occhio')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.occhio'); if (!b) return; const i = document.getElementById(b.getAttribute('aria-controls')); if (!i) return;
    const aveva = document.activeElement === i, s = i.selectionStart, f = i.selectionEnd, mostra = i.type === 'password';
    i.type = mostra ? 'text' : 'password'; b.setAttribute('aria-pressed', String(mostra)); b.setAttribute('aria-label', mostra ? 'Nascondi password' : 'Mostra password');
    b.querySelector('use').setAttribute('href', mostra ? '#i-eyeoff' : '#i-eye');
    if (aveva) { const rimetti = () => { try { i.setSelectionRange(s, f); } catch (er) { /* alcuni tipi non lo permettono */ } }; i.focus({ preventScroll: true }); rimetti(); requestAnimationFrame(rimetti); }
  });
  // Quando si apre la tastiera il campo deve restare visibile: si segue visualViewport (--kb = altezza coperta) e si porta il campo al centro.
  (function () {
    const vv = window.visualViewport, root = document.documentElement;
    const campo = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.closest('.page') ? a : null; };
    const centra = () => { const a = campo(); if (a) a.scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    const kb = () => { if (vv) root.style.setProperty('--kb', Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 'px'); };
    if (vv) { vv.addEventListener('resize', () => { kb(); setTimeout(centra, 60); }); vv.addEventListener('scroll', kb); }
    document.addEventListener('focusin', (e) => { if (e.target === campo()) setTimeout(() => { kb(); centra(); }, 350); });
    document.addEventListener('focusout', () => setTimeout(() => { if (!campo()) root.style.setProperty('--kb', '0px'); }, 150));
  })();

  // ---------- eliminazione dell'account ----------
  // Cancella solo l'account Supabase (email, accesso, dati nei user_metadata) con la funzione elimina_mio_account (supabase/16_utenti.sql).
  // Stalli, conferme ed eventi sono legati al codice del telefono, non all'account: restano, anonimi.
  function pulisciAccount() {
    clearTimeout(sincT); esci();
    salvati.clear(); ls.set('dp.salvati', []); ls.set('dp.luoghi', {}); ls.set('dp.profilo', {}); ls.set('dp.contrassegno', ''); ls.set('dp.dispositivi', []); ls.set('dp.agg', 0);
    programmaAvvisi();
  }
  function apriElimina() { $('#elimina').hidden = false; $('#x-conf').value = ''; $('#x-msg').textContent = ''; $('#x-go').disabled = true; $('#elimina').scrollTop = 0; $('#x-tit').focus({ preventScroll: true }); /* il focus va sul titolo: niente tastiera automatica */ }
  const chiudiElimina = () => { $('#elimina').hidden = true; };
  $('#x-back').onclick = chiudiElimina; $('#x-no').onclick = chiudiElimina;
  $('#x-conf').addEventListener('input', () => { $('#x-go').disabled = $('#x-conf').value.trim().toUpperCase() !== 'ELIMINA'; });
  $('#x-go').onclick = async () => {
    const btn = $('#x-go'); if (!sessione || btn.disabled) return;
    btn.disabled = true; $('#x-msg').textContent = 'Elimino l\'account…';
    try {
      const r = await aut('/rest/v1/rpc/elimina_mio_account', { method: 'POST', body: '{}' });
      if (!r.ok) throw new Error('http ' + r.status);
      traccia('account_eliminato'); pulisciAccount(); chiudiElimina(); $('#account').hidden = true; formAperto = false; accessoAperto = false; menu(); toast('Account eliminato', 4000);
    } catch (err) {
      $('#x-msg').textContent = /sessione scaduta/.test(String(err && err.message)) ? 'La sessione è scaduta: esci, accedi di nuovo e riprova.' : 'Non è stato possibile eliminare l\'account, scrivi a info@sostabile.it';
      btn.disabled = $('#x-conf').value.trim().toUpperCase() !== 'ELIMINA';
    }
  };

  // ---------- schermata 7 · i tuoi posti ----------
  let formAperto = false, accessoAperto = false, toccoVers = 0, toccoVersT = 0;
  function apriMenu() { formAperto = false; accessoAperto = false; $('#menu').hidden = false; menu(); }
  const sez = (id, tit, corpo) => `<section class="sez" aria-labelledby="${id}"><h2 id="${id}">${tit}</h2>${corpo}</section>`;
  const dataIt = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  function menu(msg) {
    const l = luoghi(), v = [...salvati.values()], PRIMI = 3;
    const login = formAperto
      ? `<label class="vh" for="a-email">Email</label><input id="a-email" type="email" placeholder="La tua email" autocomplete="username"><label class="vh" for="a-pass">Password</label><span class="pw"><input id="a-pass" type="password" placeholder="Password" autocomplete="current-password" aria-describedby="a-reg"><button type="button" class="occhio" aria-label="Mostra password" aria-pressed="false" aria-controls="a-pass">${icon('eye')}</button></span><button type="button" class="lnk" data-a="dimenticata">Password dimenticata?</button><p class="reg" id="a-reg">Per un nuovo account: almeno ${PASS_MIN} caratteri, con minuscola, maiuscola, numero e carattere speciale.</p><div class="msg" role="status">${esc(msg || '')}</div><button class="bw" data-a="entra">Accedi</button><button class="bo" data-a="crea">Crea un account</button>`
      : accessoAperto
        ? `${CFG.GOOGLE ? `<button class="bw gg" data-a="google"><span class="g" aria-hidden="true">G</span>Continua con Google</button>` : ''}<button class="${CFG.GOOGLE ? 'bo' : 'bw'}" data-a="form">Usa la tua email</button>${CFG.GOOGLE ? '' : '<p>L\'accesso con Google arriva presto.</p>'}`
        : '<button class="bw" data-a="accedi">Accedi o crea un account</button>';
    const acc = sessione
      ? `<button class="chi btn" data-a="account"><span class="av" aria-hidden="true">${esc((sessione.email || '?')[0])}</span><span class="t"><b>${esc(sessione.email)}</b><span>Contrassegno, segnalazioni e sicurezza</span></span>${icon('chev', 'chev')}</button>`
      : `<div class="acc"><h2 class="b">Ritrova i tuoi posti su ogni telefono</h2><p>Con un account ritrovi Casa, Lavoro e i posti salvati su ogni telefono, ricevi l'avviso prima che scada il contrassegno e segui le tue segnalazioni. È facoltativo.</p>${login}</div>`;
    const luogo = (k, nome, ic) => l[k]
      ? `<div class="luogo"><button class="vai" data-a="vai" data-k="${k}"><span class="mk">${icon(ic)}</span><span class="t"><b>${nome}</b><span>${esc(l[k].t)}</span></span></button><div class="az"><button data-a="imposta" data-k="${k}" aria-label="Cambia ${nome}">Cambia</button><button data-a="rimuovi" data-k="${k}" aria-label="Rimuovi ${nome}">Rimuovi</button></div></div>`
      : `<div class="luogo vuoto"><button class="vai" data-a="imposta" data-k="${k}"><span class="mk">${icon(ic)}</span><span class="t"><b>${nome}</b><span>Imposta</span></span></button></div>`;
    const riga = (a, ic, t) => `<button class="rg" data-a="${a}">${icon(ic)}<span class="t">${t}</span>${icon('chev', 'chev')}</button>`;
    const salv = v.length
      ? `<div class="grp">${v.slice(0, PRIMI).map((x) => `<div class="riga"><button class="apri" data-a="salvato" data-id="${esc(x.id)}"><span class="st">${icon('save')}</span><span class="t"><b>${esc(x.t || 'Posto riservato')}</b><span>${esc(x.c || '')}</span></span></button><button class="via" data-a="via" data-id="${esc(x.id)}" aria-label="Togli ${esc(x.t || 'questo posto')} dai salvati">${icon('x')}</button></div>`).join('')}${v.length > PRIMI ? '<button class="rg tutti" data-a="tutti">Vedi tutti i salvati</button>' : ''}</div>`
      : vuoto('salv', 'Nessun posto salvato', 'Apri un posto sulla mappa e tocca «Salva»: lo ritrovi qui con un tocco.', null, true);
    const np = navPref();
    $('#m-body').innerHTML = `${acc}
      ${sez('h-posti', 'Dove vai spesso', `<div class="luoghi">${luogo('casa', 'Casa', 'casa')}${luogo('lavoro', 'Lavoro', 'lavoro')}</div>`)}
      ${sez('h-salvati', 'Posti salvati' + (v.length ? ' · ' + v.length : ''), salv)}
      ${sez('h-info', 'Aiuto e informazioni', `<div class="grp">${riga('regole', 'shield', 'Regole della sosta con il contrassegno')}${riga('sugg', 'idea', 'Suggerisci un miglioramento')}${riga('consiglia', 'share', 'Consiglia l\'app a un amico')}${riga('novita', 'bell', 'Novità dell\'app')}${riga('fonti', 'flag', 'Fonti, condizioni e privacy')}</div>`)}
      ${sez('h-imp', 'Impostazioni', `<div class="grp"><label class="vaip stat nav"><span class="t">Navigatore<span>Si apre con «Portami lì»</span></span><select id="m-nav"><option value="google"${np === 'google' ? ' selected' : ''}>Google Maps</option><option value="waze"${np === 'waze' ? ' selected' : ''}>Waze</option><option value="chiedi"${np === 'chiedi' ? ' selected' : ''}>Chiedi ogni volta</option></select></label><button class="vaip stat" data-a="stat" role="switch" aria-checked="${statAttive()}"><span class="t">Statistiche anonime<span>${statAttive() ? 'Attive: ci aiutano a capire cosa migliorare. Niente posizione né dati personali.' : 'Disattivate su questo telefono.'}</span></span><span class="tgl" aria-hidden="true"></span></button>${eInterno() ? '<button class="rg int" data-a="interno-off">Dispositivo interno · tocca per togliere</button>' : ''}</div>`)}
      <div class="vers" data-a="versione">Versione ${esc(window.DP_VERSIONE || '')}</div>`;
  }
  // ---------- il mio account (solo con l'accesso fatto): contrassegno, segnalazioni, password, esci, elimina ----------
  function account() {
    if (!sessione) return;
    const pr = profilo(), g = pr.scadenza ? giorniA(pr.scadenza) : null;
    const contr = !pr.scadenza ? 'Aggiungi la scadenza per ricevere un avviso' : `${g < 0 ? 'Scaduto il' : 'Scade il'} ${dataIt(pr.scadenza)}${pr.notifica ? ` · avviso ${pr.giorni} giorni prima` : ''}`;
    const solo = sessione.prov === 'google';
    const riga = (a, ic, t, sub, mk) => `<button class="rg" data-a="${a}">${mk ? `<span class="mk">${icon(ic)}</span>` : icon(ic)}<span class="t"><b>${t}</b>${sub ? `<span>${sub}</span>` : ''}</span>${a === 'esci' ? '' : icon('chev', 'chev')}</button>`;
    $('#ac-body').innerHTML = `<div class="chi"><span class="av" aria-hidden="true">${esc((sessione.email || '?')[0])}</span><span class="t"><b>${esc(sessione.email)}</b><span>${solo ? 'Accedi con Google: la password la gestisce Google' : 'I tuoi posti sono al sicuro nel tuo account'}</span></span></div>
      ${sez('h-per', 'Per te', `<div class="grp">${riga('profilo', 'wc', 'Il mio contrassegno', contr, 1)}${riga('segn', 'plus', 'Le mie segnalazioni', 'Quelle che hai inviato e a che punto sono', 1)}<button class="vaip stat" data-a="nuovi" role="switch" aria-checked="${avvisi().nuovi_vicino}"><span class="t">Nuovi posti vicino a Casa e Lavoro<span>Ti scriviamo quando ne aggiungiamo uno entro 500 m</span></span><span class="tgl" aria-hidden="true"></span></button></div>`)}
      ${sez('h-sic', 'Accesso e sicurezza', `<div class="grp">${solo ? '' : riga('cambiapw', 'edit', 'Cambia password', '')}${riga('esci', 'user', 'Esci da questo dispositivo', 'I posti restano su questo telefono')}</div>`)}
      <div class="zona"><button class="dng" data-a="elimina">Elimina il mio account</button><p>Cancella email, posti salvati, Casa e Lavoro e dati del contrassegno, anche su questo telefono. Le segnalazioni già fatte restano in mappa, anonime. Non si può annullare.</p></div>`;
  }
  function apriAccount() { if (!sessione) return; account(); $('#account').hidden = false; $('#account').scrollTop = 0; $('#ac-tit').focus({ preventScroll: true }); }
  function chiudiAccount() { $('#account').hidden = true; const r = document.querySelector('#m-body [data-a=account]'); if (r && !$('#menu').hidden) r.focus({ preventScroll: true }); }
  $('#ac-back').onclick = chiudiAccount;
  $('#ac-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
    if (a === 'profilo') { $('#profilo').hidden = false; scheda8(); }
    else if (a === 'segn') apriSegnalazioni();
    else if (a === 'cambiapw') { if (sessione && sessione.prov === 'google') toast('Accedi con Google: non serve una password.', 4000); else apriNuova(false, true); }
    else if (a === 'esci') { esci(); chiudiAccount(); formAperto = false; accessoAperto = false; menu(); toast('Sei uscito. I posti restano su questo telefono.'); }
    else if (a === 'elimina') apriElimina();
    else if (a === 'nuovi') { const on = !avvisi().nuovi_vicino; salvaAvvisi({ nuovi_vicino: on }); account(); const n = $('#ac-body [data-a=nuovi]'); if (n) n.focus({ preventScroll: true }); toast(on ? 'Ti scriviamo quando c\'è un posto nuovo vicino a Casa o Lavoro.' : 'Avviso disattivato.', 3500); }
  });
  $('#m-back').onclick = () => { $('#menu').hidden = true; };
  $('#m-body').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a, k = b.dataset.k;
    if (a === 'dimenticata') apriRecupero((($('#a-email') || {}).value || '').trim());
    else if (a === 'form') { formAperto = true; menu(); $('#a-email').focus(); }
    else if (a === 'entra' || a === 'crea') {
      const email = $('#a-email').value.trim(), pass = $('#a-pass').value;
      if (!/^\S+@\S+\.\S+$/.test(email) || !pass) { $('#m-body .msg').textContent = 'Scrivi la tua email e la password.'; return; }
      const manca = a === 'crea' ? passMancante(pass) : [];
      if (manca.length) { $('#m-body .msg').textContent = 'Per creare un account alla password manca: ' + manca.join(', ') + '.'; $('#a-pass').focus(); return; }
      b.disabled = true; $('#m-body .msg').textContent = 'Un momento…';
      try { const esito = await accedi(email, pass, a === 'crea'); if (esito === 'conferma') { $('#m-body .msg').textContent = 'Ti abbiamo mandato un\'email: apri il link di conferma, poi torna qui e tocca "Accedi".'; b.disabled = false; } else { formAperto = false; menu(); toast('Accesso fatto. I tuoi posti ora ti seguono.'); } }
      catch (err) { $('#m-body .msg').textContent = err.message; b.disabled = false; }
    }
    else if (a === 'accedi') { accessoAperto = true; menu(); const p = document.querySelector('#m-body .acc button'); if (p) p.focus({ preventScroll: true }); }
    else if (a === 'account') apriAccount();
    else if (a === 'tutti') { $('#menu').hidden = true; apriRicerca(''); const c = document.querySelector('.s-chips [data-k=salvati]'); if (c) c.click(); }
    else if (a === 'vai') { $('#menu').hidden = true; vaiA(Object.assign({ k }, luoghi()[k])); }
    else if (a === 'imposta') { $('#menu').hidden = true; apriRicerca('', k); }
    else if (a === 'rimuovi') { const l = luoghi(); delete l[k]; ls.set('dp.luoghi', l); toccato(); menu(); toast(`${k === 'casa' ? 'Casa rimossa' : 'Lavoro rimosso'}.`); }
    else if (a === 'salvato') { $('#menu').hidden = true; apriSalvato(b.dataset.id); }
    else if (a === 'via') { salvati.delete(b.dataset.id); ls.set('dp.salvati', [...salvati.values()]); toccato(); menu(); }
    else if (a === 'sugg') apriSuggerimento();
    else if (a === 'regole') apriRegole(null);
    else if (a === 'consiglia') consiglia();
    else if (a === 'stat') { const on = !statAttive(); if (!on) traccia('stat_off', null, true); ls.set('dp.stat', on); menu(); toast(on ? 'Statistiche anonime attivate. Grazie!' : 'Statistiche anonime disattivate.'); }
    else if (a === 'versione') { // 7 tocchi di fila (al massimo 1,5 secondi tra uno e l'altro) segnano questo dispositivo come interno
      const ora = Date.now(); toccoVers = ora - toccoVersT < 1500 ? toccoVers + 1 : 1; toccoVersT = ora;
      if (toccoVers >= 7) { toccoVers = 0; if (!eInterno()) { ls.set('dp.interno', 1); traccia('attivo'); } menu(); toast('Questo dispositivo è segnato come interno: non entra nelle statistiche', 4500); }
    }
    else if (a === 'interno-off') { ls.set('dp.interno', 0); menu(); toast('Dispositivo non più interno: rientra nelle statistiche.', 3500); }
    else if (a === 'google') accediGoogle();
    else if (a === 'novita') apri('https://sostabile.it/novita.html'); // pagina sempre sul dominio, anche dall'app Android
    else if (a === 'fonti') { $('#fonti').hidden = false; $('#f-elenco').href = CFG.SITO + 'fonti.html'; $('#f-cond').href = CFG.SITO + 'condizioni.html'; $('#f-priv').href = CFG.SITO + 'privacy.html'; $('#f-ver').textContent = 'SostAbile, versione di prova ' + (window.DP_VERSIONE || ''); }
  });
  $('#m-body').addEventListener('change', (e) => {
    if (e.target.id !== 'm-nav') return; const v = e.target.value === 'waze' || e.target.value === 'chiedi' ? e.target.value : 'google';
    ls.set('dp.profilo', Object.assign(profilo(), { nav: v })); toccato(); toast(v === 'chiedi' ? 'Ti chiederò il navigatore a ogni «Portami lì».' : `Navigatore: ${v === 'waze' ? 'Waze' : 'Google Maps'}.`);
  });
  $('#f-back').onclick = () => { $('#fonti').hidden = true; };

  // ---------- le mie segnalazioni: i posti che ho segnalato e a che punto sono ----------
  async function apriSegnalazioni() {
    const el = $('#g-body'); $('#segn').hidden = false; el.innerHTML = '<div class="empty">Carico le tue segnalazioni…</div>';
    try {
      const r = await fetch(CFG.SB + '/rest/v1/rpc/mie_segnalazioni', { method: 'POST', headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_device: dispositivi() }) });
      if (!r.ok) throw new Error(r.status);
      const v = await r.json();
      if (!v.length) { el.innerHTML = vuoto('segn', 'Nessuna segnalazione per ora', 'Hai visto un posto riservato che non è sulla mappa? Aggiungilo: aiuti chi arriva dopo di te.', [['Segnala un posto', 'segnala', 'v-1']]); return; }
      const STATO = { proposto: ['att', 'In attesa di verifica'], verificato: ['ok', 'Approvata'], ufficiale: ['ok', 'Approvata'], rifiutato: ['no', 'Non approvata'], rimosso: ['no', 'Posto rimosso'] };
      el.innerHTML = `<p class="muted">${sessione ? 'Le segnalazioni fatte con il tuo account.' : 'Le segnalazioni fatte da questo telefono. Accedi per ritrovarle anche su un altro.'}</p>` + v.map((x) => {
        const [c, t] = STATO[x.stato] || ['att', x.stato], g = new Date(x.created_at), vivo = x.stato !== 'rifiutato' && x.stato !== 'rimosso';
        return `<${vivo ? 'button' : 'div'} class="segn" ${vivo ? `data-la="${x.lat}" data-lo="${x.lon}" data-id="${esc(x.id)}"` : ''}><span class="t"><b>${esc(x.indirizzo || 'Posto riservato')}</b><span>${esc([x.comune, `${g.getDate()} ${MESI[g.getMonth()]} ${g.getFullYear()}`].filter(Boolean).join(' · '))}</span>${x.stato === 'rifiutato' && x.motivo_rifiuto ? `<span class="perche"><b>Motivo:</b> ${esc(x.motivo_rifiuto)}</span>` : ''}</span><span class="esito ${c}">${t}</span></${vivo ? 'button' : 'div'}>`;
      }).join('');
    } catch (e) { el.innerHTML = '<div class="empty">Non riesco a caricare le segnalazioni. Controlla la connessione e riprova.</div>'; }
  }
  $('#g-back').onclick = () => { $('#segn').hidden = true; };
  $('#g-body').addEventListener('click', (e) => { if (e.target.closest('[data-v=segnala]')) { $('#segn').hidden = true; $('#menu').hidden = true; apriAggiungi(); } });

  // ---------- consiglia l'app e invito a lasciare una recensione su Play ----------
  async function consiglia() {
    const text = 'SostAbile trova i parcheggi riservati alle persone con disabilità in tutta Italia e ti porta lì. È gratis.', url = NATIVO() ? CFG.PLAY : CFG.SITO;
    const cap = window.Capacitor, Sh = NATIVO() && cap.Plugins && cap.Plugins.Share;
    traccia('consiglia');
    try {
      if (Sh) await Sh.share({ title: 'SostAbile', text, url, dialogTitle: 'Consiglia l\'app' });
      else if (navigator.share) await navigator.share({ title: 'SostAbile', text, url });
      else { await navigator.clipboard.writeText(text + ' ' + url); toast('Link copiato: incollalo dove vuoi'); }
    } catch (e) { /* condivisione annullata */ }
  }
  // Solo sull'app Android: dopo almeno 3 navigazioni, al ritorno nell'app, una volta sola (o di nuovo dopo 30 giorni se "Più tardi")
  function forseVoto() {
    if (!NATIVO() || !$('#voto').hidden) return;
    const st = ls.get('dp.voto', {}), nav = ls.get('dp.nav', 0), t = ls.get('dp.navT', 0);
    if (st.fatto || st.mai || nav < 3 || Date.now() - t > 20 * 60000 || (st.dopo && Date.now() - st.dopo < 30 * 864e5)) return;
    $('#voto').hidden = false;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(forseVoto, 1200); });
  $('#voto').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return; const st = ls.get('dp.voto', {}), v = b.dataset.v;
    if (v === 'si') { st.fatto = Date.now(); traccia('recensione', { dettaglio: 'si' }); apri(CFG.PLAY); }
    else if (v === 'dopo') { st.dopo = Date.now(); traccia('recensione', { dettaglio: 'dopo' }); }
    else { st.mai = Date.now(); traccia('recensione', { dettaglio: 'no' }); }
    ls.set('dp.voto', st); $('#voto').hidden = true;
  });

  // ---------- regole della sosta con il contrassegno (nazionali + note del comune) ----------
  const regoleCache = new Map();
  async function regoleDi(comune) {
    if (!comune) return null; const k = norma(comune); if (regoleCache.has(k)) return regoleCache.get(k);
    try { const r = await fetch(`${CFG.SB}/rest/v1/regole_comuni?select=*&comune=ilike.${encodeURIComponent(comune.replace(/[%_*]/g, ''))}`, { headers: H }); const j = r.ok ? await r.json() : []; regoleCache.set(k, j[0] || null); return j[0] || null; }
    catch (e) { return null; }
  }
  async function apriRegole(comune) {
    if (!comune) { const s = selId && stalli.get(selId); comune = (s && s.comune) || null; }
    $('#regole').hidden = false; traccia('regole', { comune });
    const box = $('#r-comune'); box.innerHTML = comune ? `<p class="muted">Carico le regole di ${esc(comune)}…</p>` : '';
    const r = await regoleDi(comune);
    box.innerHTML = !comune ? '' : r
      ? `<p><b>A ${esc(r.comune)}</b></p>${r.ztl ? `<p><b>ZTL:</b> ${esc(r.ztl)}</p>` : ''}${r.note ? `<p>${esc(r.note).replace(/\n/g, '<br>')}</p>` : ''}${r.link ? `<p><a href="${esc(r.link)}" target="_blank" rel="noopener">Pagina del Comune</a></p>` : ''}<p class="small muted">Aggiornato il ${new Date(r.aggiornato).toLocaleDateString('it-IT')}.</p>`
      : `<p><b>A ${esc(comune)}</b></p><p class="muted">Non abbiamo ancora le regole di questo comune su ZTL e parcheggi. Valgono quelle nazionali qui sopra; per la ZTL chiedi al Comando di Polizia Locale.</p>`;
  }
  $('#r-back').onclick = () => { $('#regole').hidden = true; };
  $('#c-regole').onclick = () => { const s = stalli.get(selId); apriRegole(s && s.comune); };

  // ---------- suggerimenti: gli utenti ci dicono cosa manca ----------
  let catSugg = 'manca';
  function apriSuggerimento() {
    $('#sugg').hidden = false; $('#u-msg').textContent = '';
    if (sessione && sessione.email && !$('#u-email').value) $('#u-email').value = sessione.email;
    document.querySelectorAll('#sugg [data-cat]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cat === catSugg));
    setTimeout(() => $('#u-testo').focus(), 50);
  }
  $('#u-back').onclick = () => { $('#sugg').hidden = true; };
  $('#sugg .u-cat').addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; catSugg = b.dataset.cat; document.querySelectorAll('#sugg [data-cat]').forEach((x) => x.setAttribute('aria-pressed', x === b)); });
  $('#u-invia').onclick = async () => {
    const btn = $('#u-invia'), testo = $('#u-testo').value.trim(), email = $('#u-email').value.trim();
    if (testo.length < 3) { $('#u-msg').textContent = 'Scrivi qualche parola sul tuo suggerimento.'; $('#u-testo').focus(); return; }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) { $('#u-msg').textContent = 'Controlla l\'email, oppure lasciala vuota.'; return; }
    btn.disabled = true; $('#u-msg').textContent = 'Invio…';
    try {
      const r = await fetch(CFG.SB + '/rest/v1/suggerimenti', { method: 'POST', headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ device_id: deviceId, categoria: catSugg, testo: testo.slice(0, 2000), email: email || null, piattaforma: PIATTAFORMA, versione: String(window.DP_VERSIONE || '').slice(0, 40) || null }) });
      if (!r.ok) throw new Error(r.status);
      traccia('suggerimento', { dettaglio: catSugg });
      $('#u-testo').value = ''; $('#sugg').hidden = true; toast('Grazie! Il tuo suggerimento è arrivato.', 3500);
    } catch (err) { $('#u-msg').textContent = 'Non sono riuscito a inviarlo. Controlla la connessione e riprova.'; }
    btn.disabled = false;
  };
  $('#g-body').addEventListener('click', (e) => {
    const b = e.target.closest('button.segn'); if (!b) return;
    $('#segn').hidden = true; $('#account').hidden = true; $('#menu').hidden = true; seguo = false;
    const la = +b.dataset.la, lo = +b.dataset.lo, id = b.dataset.id;
    map.jumpTo({ center: [lo, la], zoom: 17 }); carica(la - 0.004, lo - 0.006, la + 0.004, lo + 0.006, false).then(() => { if (stalli.has(id)) apriScheda(id); });
  });

  // ---------- schermata 8 · profilo e contrassegno ----------
  const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  const dataLunga = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MESI[m - 1]} ${y}`; };
  const giorniA = (iso) => Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toDateString())) / 864e5);
  function salvaProfilo(pz) { ls.set('dp.profilo', Object.assign(profilo(), pz)); toccato(); programmaAvvisi(); scheda8(); }
  let altroAperto = false;
  function scheda8() {
    const pr = profilo(), foto = ls.get('dp.contrassegno', ''), g = pr.scadenza ? giorniA(pr.scadenza) : null;
    const stato = g == null ? '' : g < 0 ? `<span class="stato scaduto">Scaduto da ${-g === 1 ? '1 giorno' : -g + ' giorni'}</span>` : g <= pr.giorni ? `<span class="stato presto">${icon('bell')}${g === 0 ? 'Scade oggi' : g === 1 ? 'Scade domani' : 'Scade tra ' + g + ' giorni'}</span>` : `<span class="stato">${icon('check')}Valido · mancano ${g} giorni</span>`;
    const std = [30, 60, 90].includes(pr.giorni) && !altroAperto;
    $('#p-body').innerHTML = `
      ${sessione ? `<div class="chi"><span class="av">${esc((sessione.email || '?')[0])}</span><span class="t"><b>${esc(sessione.email)}</b><span>Accesso fatto</span></span></div>` : ''}
      <div class="cont"><div class="eyebrow">Il mio contrassegno</div>
        <div class="su"><span class="ft">${foto ? `<img src="${foto}" alt="Foto del tuo contrassegno">` : icon('wc')}</span><span class="dt">${pr.scadenza ? `<span>Scade il</span><b>${dataLunga(pr.scadenza)}</b>` : '<span>Scadenza non impostata</span><b>Aggiungila qui sotto</b>'}</span></div>
        ${stato}
        <div class="azioni"><label>${icon('edit')}<span>${pr.scadenza ? 'Cambia data' : 'Imposta la data'}</span><input id="p-data" type="date" value="${esc(pr.scadenza)}" aria-label="Data di scadenza del contrassegno"></label><button data-p="foto">${icon('camera')}<span>${foto ? 'Rifai la foto' : 'Aggiungi foto'}</span></button></div>
      </div>
      <div class="campo"><div class="b" style="font-size:1.0625rem">Avvisami prima della scadenza</div>
        <div class="giorni">${[30, 60, 90].map((n) => `<button data-g="${n}" aria-pressed="${std && pr.giorni === n}">${n} gg</button>`).join('')}<button data-g="altro" aria-pressed="${!std}">Altro</button></div>
        ${!std ? `<label class="altro"><input id="p-altro" type="number" inputmode="numeric" min="1" max="365" value="${pr.giorni}"> giorni prima</label>` : ''}
        <div><div class="sw"><span class="t">Notifica sul telefono<span>${pr.scadenza ? 'Un avviso alla data scelta e uno il giorno della scadenza' : 'Imposta prima la data di scadenza'}</span></span><button role="switch" data-p="notifica" aria-checked="${!!pr.notifica}" aria-label="Notifica sul telefono" ${pr.scadenza ? '' : 'disabled'}><i></i></button></div>
        <div class="sw"><span class="t">Email<span>${!sessione ? 'Disponibile con un account' : pr.scadenza ? 'Ti scriviamo all\'indirizzo dell\'account' : 'Imposta prima la data di scadenza'}</span></span><button role="switch" data-p="email" aria-checked="${!!sessione && avvisi().email_scadenza}" aria-label="Avviso via email" ${sessione && pr.scadenza ? '' : 'disabled'}><i></i></button></div></div>
      </div>
      <p class="small muted" style="margin:0">La foto del contrassegno resta solo su questo telefono. Nell'account viene salvata soltanto la data di scadenza.</p>`;
  }
  $('#p-back').onclick = () => { $('#profilo').hidden = true; altroAperto = false; if (!$('#account').hidden) account(); };
  $('#p-body').addEventListener('change', (e) => {
    if (e.target.id === 'p-data') salvaProfilo({ scadenza: e.target.value || '' });
    if (e.target.id === 'p-altro') { const n = Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 60)); altroAperto = ![30, 60, 90].includes(n); salvaProfilo({ giorni: n }); }
  });
  $('#p-body').addEventListener('click', async (e) => {
    const g = e.target.closest('[data-g]'); if (g) { if (g.dataset.g === 'altro') { altroAperto = true; scheda8(); const i = $('#p-altro'); if (i) { i.focus(); i.select(); } } else { altroAperto = false; salvaProfilo({ giorni: +g.dataset.g }); } return; }
    const b = e.target.closest('[data-p]'); if (!b) return;
    if (b.dataset.p === 'foto') $('#p-foto').click();
    if (b.dataset.p === 'notifica') {
      const on = !profilo().notifica;
      if (on && !(await permessoAvvisi())) { toast('Per ricevere l\'avviso serve il permesso alle notifiche. Lo trovi nelle impostazioni del telefono.', 4500); return; }
      salvaProfilo({ notifica: on }); if (on) toast('Avviso programmato.');
    }
    if (b.dataset.p === 'email' && sessione) { const on = !avvisi().email_scadenza; salvaAvvisi({ email_scadenza: on }); scheda8(); if (on) toast('Ti scriviamo prima della scadenza.'); }
  });
  $('#p-foto').onchange = async () => { const f = $('#p-foto').files[0]; if (!f) return; try { const blob = await rimpicciolisci(f, 1000); const r = new FileReader(); r.onload = () => { ls.set('dp.contrassegno', r.result); scheda8(); }; r.readAsDataURL(blob); } catch (e) { toast('Non riesco a leggere la foto. Riprova.'); } };
  // avvisi sul telefono: programmati sul dispositivo, funzionano anche senza rete e senza account
  async function permessoAvvisi() { const p = LN(); if (!p) return true; try { let s = await p.checkPermissions(); if (s.display !== 'granted') s = await p.requestPermissions(); return s.display === 'granted'; } catch (e) { return false; } }
  async function programmaAvvisi() {
    const p = LN(); if (!p) return; const pr = profilo();
    try {
      await p.cancel({ notifications: [{ id: 1 }, { id: 2 }] }).catch(() => {});
      if (!pr.notifica || !pr.scadenza) return;
      const fine = new Date(pr.scadenza + 'T09:00:00'), prima = new Date(fine.getTime() - pr.giorni * 864e5), n = [];
      if (prima > new Date()) n.push({ id: 1, title: 'Il contrassegno sta per scadere', body: `Scade il ${dataLunga(pr.scadenza)}, tra ${pr.giorni} giorni. Il rinnovo si chiede al tuo Comune.`, schedule: { at: prima, allowWhileIdle: true } });
      if (fine > new Date()) n.push({ id: 2, title: 'Il contrassegno scade oggi', body: 'Ricordati di rinnovarlo al tuo Comune.', schedule: { at: fine, allowWhileIdle: true } });
      if (n.length) await p.schedule({ notifications: n });
    } catch (e) { /* senza permesso non si programma nulla */ }
  }
  if (sessione) allinea();
  // link dalle email di SostAbile: https://sostabile.it/app/#posto=<id> apre la scheda di quel posto
  (function () {
    const m = /[#&]posto=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(location.hash); if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* resta nell'indirizzo */ }
    const via = () => apriSalvato(m[1].toLowerCase()); if (pronta) via(); else map.once('load', via);
  })();

  // ---------- primo avvio ----------
  // condizioni d'uso: si accettano al primo avvio; se cambia CONDIZIONI_VER chi aveva già l'app le riaccetta una volta
  const CONDIZIONI_VER = '2026-11-20';
  document.querySelectorAll('.l-cond').forEach((a) => a.onclick = (e) => { e.preventDefault(); apri(CFG.SITO + 'condizioni.html'); });
  document.querySelectorAll('.l-priv').forEach((a) => a.onclick = (e) => { e.preventDefault(); apri(CFG.SITO + 'privacy.html'); });
  $('#w-acc').onchange = () => { $('#w-go').disabled = $('#w-skip').disabled = !$('#w-acc').checked; };
  $('#cd-acc').onchange = () => { $('#cd-go').disabled = !$('#cd-acc').checked; };
  $('#cd-go').onclick = () => { ls.set('dp.condizioni', CONDIZIONI_VER); $('#condizioni').hidden = true; };
  if (!ls.get('dp.benvenuto', false)) $('#welcome').hidden = false;
  else { attivaPosizione(false); if (ls.get('dp.condizioni', '') !== CONDIZIONI_VER) $('#condizioni').hidden = false; }
  const entra = () => { ls.set('dp.benvenuto', true); ls.set('dp.condizioni', CONDIZIONI_VER); $('#welcome').hidden = true; };
  $('#w-go').onclick = async () => { entra(); const ok = await attivaPosizione(true); if (!ok) toast('Posizione non attiva: puoi muovere la mappa a mano.', 4000); };
  $('#w-skip').onclick = entra;

  // ---------- aggiornamento obbligatorio (solo Android) ----------
  // Il database dice qual è la versione minima ancora accettata (funzione app_config); se questa è più vecchia, schermata bloccante.
  // Se la chiamata non riesce o la versione non è un numero, l'app prosegue normalmente.
  const numeri = (v) => (String(v || '').match(/\d+/g) || []).map(Number);
  function piuVecchia(a, min) { const x = numeri(a), y = numeri(min); if (!x.length || !y.length) return false; for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p < q; } return false; }
  $('#ag-go').onclick = () => apri(CFG.PLAY);
  if (NATIVO()) configApp.then((c) => { if (c && piuVecchia(window.DP_VERSIONE, c.versione_minima_android)) { $('#aggiorna').hidden = false; $('#ag-go').focus(); } });
  // ---------- scorciatoie dall'icona (Android) e «Condividi» da Google Maps ----------
  // Le scorciatoie (tenendo premuta l'icona: Posto più vicino, Casa, Lavoro, Auto) aprono l'app con it.disabilityparking.app://azione/<nome> (res/xml/shortcuts.xml in
  // mobile/android-extra). Il testo condiviso da un'altra app (ACTION_SEND text/plain: Google Maps manda «Nome del luogo», a volte l'indirizzo, e un link) arriva dal plugin
  // nativo SostAbile, come l'azione quando l'app parte da zero (leggiIntent) o è già aperta (evento «intent»). Sul web non c'è niente di tutto questo.
  const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const bloccata = () => !$('#welcome').hidden || !$('#condizioni').hidden || !$('#aggiorna').hidden; // primo avvio, condizioni o aggiornamento: l'azione non parte
  function chiudiPannelli() { // porta l'app alla mappa, così l'azione si vede
    ['#menu', '#account', '#profilo', '#segn', '#sugg', '#regole', '#fonti', '#elimina', '#recupero', '#nuova'].forEach((q) => { $(q).hidden = true; });
    if (!$('#search').hidden) chiudiRicerca(); if (fgStato) fgChiudi(); if (selId) chiudiScheda(); if (aggiungo) chiudiAggiungi();
  }
  let ultimaAzione = { k: '', t: 0 };
  function azione(nome) { // nome: vicino | casa | lavoro | auto
    if (ultimaAzione.k === nome && Date.now() - ultimaAzione.t < 3000) return; ultimaAzione = { k: nome, t: Date.now() }; // lo stesso intent può arrivare da due strade
    if (bloccata()) return;
    fuoriPronta(async () => {
      try {
        chiudiPannelli();
        if (nome === 'vicino') await azioneVicino();
        else if (nome === 'auto') {
          if (!autoSalvata()) { toast('Non hai ancora salvato la posizione dell\'auto: si salva quando dici di aver parcheggiato dopo «Portami lì».', 5000); return; }
          if (dest) chiudiDest(); apriAuto();
        } else {
          const l = luoghi()[nome], n = nome === 'casa' ? 'Casa' : 'Lavoro';
          if (!l) { toast(`${n} non è ancora impostato. Impostalo da «I tuoi posti».`, 5000); apriMenu(); return; }
          vaiA(Object.assign({ k: nome }, l));
        }
      } catch (e) { /* l'azione non riesce: la mappa resta com'è */ }
    });
  }
  async function azioneVicino() {
    if (dest) chiudiDest();
    if (!me) { toast('Cerco la tua posizione…', 3000); seguo = true; await attivaPosizione(true); for (let i = 0; i < 25 && !me; i++) await pausa(200); }
    if (!me) { toast('Non trovo la tua posizione. Controlla che sia attiva nelle impostazioni del telefono.', 5000); return; }
    seguo = true; map.jumpTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 16), padding: padHome() });
    for (let i = 0; i < 20 && !elencoVicini().out.length; i++) await pausa(250); // i posti attorno arrivano un attimo dopo la posizione
    const o = elencoVicini().out[0]; if (!o) { toast('Nessun posto riservato vicino a te.', 4000); return; }
    apriScheda(o.s.id);
  }
  // coordinate in un testo o in un link di Google Maps: @lat,lon · !3dlat!4dlon · q= ll= query= destination= center= · geo:lat,lon · «lat, lon» scritte nel testo
  function coordinateDa(t) {
    let x = String(t || ''); for (let i = 0; i < 2; i++) { try { x = decodeURIComponent(x); } catch (e) { break; } }
    const N = '(-?\\d{1,3}\\.\\d+)', modelli = [new RegExp('@' + N + ',' + N), new RegExp('!3d' + N + '!4d' + N), new RegExp('[?&](?:q|ll|query|destination|daddr|center|sll|viewpoint)=' + N + ',\\s*' + N, 'i'), new RegExp('geo:' + N + ',' + N), new RegExp('(?:^|[^\\d.])' + N + '\\s*,\\s*' + N + '(?![\\d.])')];
    for (const re of modelli) { const m = re.exec(x); if (!m) continue; const lat = +m[1], lon = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) return { lat, lon }; }
    return null;
  }
  const URL_CORTO = /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|app\.goo\.gl)\//i;
  const decodifica = (u) => { let x = String(u || ''); for (let i = 0; i < 4; i++) { let y; try { y = decodeURIComponent(x); } catch (e) { break; } if (y === x) break; x = y; } return x; }; // anche il «continue=» della pagina dei cookie di Google
  const nomeDaLink = (u) => { // nome del luogo da un link lungo di Google Maps: /maps/place/<nome>/ oppure ?q= / query= con un testo (non coordinate)
    const x = decodifica(u); let m = /\/maps\/place\/([^/@?&]+)/.exec(x);
    if (!m) { m = /[?&](?:q|query|daddr|destination)=([^&]+)/i.exec(x); if (m && coordinateDa(m[1])) m = null; }
    return m ? m[1].replace(/\+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  };
  async function condividi(testo) {
    testo = String(testo || '').trim(); if (!testo || bloccata()) return;
    fuoriPronta(async () => {
      try {
        chiudiPannelli(); if (dest) chiudiDest();
        const urls = testo.match(/https?:\/\/\S+/g) || [], righe = testo.replace(/https?:\/\/\S+/g, ' ').split(/\n+/).map((t) => t.trim()).filter(Boolean);
        let nome = righe[0] || '', c = coordinateDa(testo), finale = '';
        if (!c) for (const u of urls) { c = coordinateDa(u); if (c) break; }
        if (!c) { // link corto: sul telefono lo segue il plugin nativo (la WebView non può leggere il reindirizzamento di Google)
          const pl = plug('SostAbile'), corto = urls.find((u) => URL_CORTO.test(u));
          if (pl && corto && typeof pl.risolviLink === 'function') { toast('Leggo il luogo condiviso…', 3000); try { const r = await Promise.race([pl.risolviLink({ url: corto }), pausa(9000).then(() => null)]); if (r && r.url) { finale = r.url; c = coordinateDa(r.url); } } catch (e) { /* si cerca per nome */ } }
        }
        if (!c && finale) c = coordinateDa(decodifica(finale));
        if (!nome) for (const u of [finale, ...urls]) { if (u) { nome = nomeDaLink(u); if (nome) break; } }
        if (!c && !nome) traccia('errore', { dettaglio: ('condividi: ' + testo.slice(0, 120) + ' -> ' + (finale || 'nessun link risolto').slice(0, 160)).slice(0, 300) }); // per capire i formati che non leggiamo
        if (c) { vaiA({ t: nome || 'Luogo condiviso', sub: righe[1] || '', lat: c.lat, lon: c.lon, q: nome }); return; }
        // niente coordinate: nome e indirizzo diventano una ricerca (Photon, come la barra «Dove vai?»), si apre il primo risultato
        // dal link: «Zero81, Corso Italia, 110, 34170 Gorizia GO» → si cerca prima tutto, poi solo l'indirizzo (la ricerca indirizzi non conosce sempre i nomi dei locali)
        const virg = !righe.length && nome.includes(',') ? nome.indexOf(',') : -1, breve = virg > 0 ? nome.slice(0, virg).trim() : '', indir = virg > 0 ? nome.slice(virg + 1).trim() : '';
        const cand = [...new Set([righe.slice(0, 2).join(', '), righe[0], righe[1], nome, indir].filter(Boolean))];
        if (!cand.length) { toast('Non riesco a leggere il luogo condiviso. Cercalo per nome.', 5000); apriRicerca(''); return; }
        toast(`Cerco «${cand[0]}»…`, 3000);
        const ctl = new AbortController(), centro = me ? [me.lon, me.lat] : [map.getCenter().lng, map.getCenter().lat];
        for (const q of cand) {
          let res = []; try { res = await geocodifica(q, centro, ctl.signal); } catch (e) { break; }
          if (res.length) { const x = res[0]; x.q = q; if (breve && q === indir) { x.sub = [x.t, x.sub].filter(Boolean).join(' · '); x.t = breve; } vaiA(x); return; }
        }
        apriRicerca(cand[0]); // non trovato o senza rete: la ricerca aperta col testo mostra l'esito e lascia correggere
      } catch (e) { toast('Non riesco ad aprire il luogo condiviso.', 4000); }
    });
  }
  (function () {
    const pl = plug('SostAbile'); if (!pl) return;
    const gestisci = (r) => { if (!r) return; if (r.azione) azione(r.azione); if (r.testo) condividi(r.testo); };
    try { pl.addListener('intent', gestisci); } catch (e) { /* senza ascolto restano solo gli intent all'avvio */ }
    try { Promise.resolve(pl.leggiIntent()).then(gestisci, () => {}); } catch (e) { /* app avviata normalmente */ }
  })();
  window.DPAzioni = { azione, condividi, coordinateDa }; // anche per le prove
})();
