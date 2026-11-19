/* SostAbile · app Android (Capacitor). Passo 1: primo avvio, mappa, posto più vicino, scheda del posto. */
(() => {
  'use strict';
  // Indirizzo base del sito vetrina (con / finale). Sul web aperto da sostabile.it (o www.) è il dominio; altrove (GitHub Pages,
  // prove in locale) e su Android resta quello provvisorio. È l'unico punto dell'app dove compare un indirizzo del sito.
  const SITO_ANDROID = 'https://19andrea90.github.io/disability-parking/sito/'; // da cambiare in https://sostabile.it/ quando il dominio è attivo
  const sitoBase = (host, nativo) => (!nativo && /^(www\.)?sostabile\.it$/i.test(host || '')) ? 'https://sostabile.it/' : SITO_ANDROID;
  const SITO_NATIVO = () => { const cap = window.Capacitor; return !!(cap && cap.isNativePlatform && cap.isNativePlatform()); };
  const CFG = {
    SB: 'https://wwereqrojlwktgwlrsib.supabase.co',
    // chiave "anon": è pubblica per natura, i permessi li decide il database
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3ZXJlcXJvamx3a3Rnd2xyc2liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MjMzMjYsImV4cCI6MjEwODM5OTMyNn0.vOaCaVc8kaqsRT_o_TP01CbyX9SN-Af1fKjSZ3NxQys',
    STYLE: 'https://tiles.openfreemap.org/styles/positron',
    HOME: [13.236, 46.063], // Udine, finché non c'è la posizione
    MIN_ZOOM_DATI: 12,      // sotto questo zoom si vedono i totali per regione, provincia e comune (file statico)
    MAX_H: 0.03,            // vista più alta di così (circa 3 km) o più larga di MAX_W: niente singoli posti, solo conteggi a griglia
    MAX_W: 0.07,            // il server accetta riquadri fino a 0,05° x 0,075° (stalli_zona): vedi il margine in caricaVista()
    VICINO_M: 80,           // entro questa distanza si può confermare "c'è / non c'è più"
    GOOGLE: true,           // accesso con Google: fornitore configurato su Supabase il 19/11/2026
    PLAY: 'https://play.google.com/store/apps/details?id=it.disabilityparking.app',
    SITO: sitoBase(location.hostname, SITO_NATIVO()), // indirizzo base del sito vetrina (con / finale): vedi sitoBase() qui sopra
  };
  const $ = (s) => document.querySelector(s);
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* spazio pieno o navigazione privata */ } },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  let deviceId = ls.get('dp.device', null);
  if (!deviceId) { deviceId = 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36); ls.set('dp.device', deviceId); }

  // ---------- statistiche d'uso anonime ----------
  // Solo il codice casuale del telefono, il tipo di azione e al massimo il comune: niente posizione, niente dati personali.
  // Servono al cruscotto del pannello admin (quante persone usano l'app, quante si fanno portare a un posto, dove mancano posti).
  const PIATTAFORMA = (() => { const cap = window.Capacitor; if (cap && cap.isNativePlatform && cap.isNativePlatform()) return (cap.getPlatform && cap.getPlatform()) === 'ios' ? 'ios' : 'android'; return window.matchMedia('(min-width:900px)').matches ? 'pc' : 'web'; })();
  const statAttive = () => ls.get('dp.stat', true) !== false;
  function traccia(tipo, x, sempre) {
    if (!sempre && !statAttive()) return;
    try {
      const corpo = Object.assign({ device_id: deviceId, tipo, piattaforma: PIATTAFORMA, versione: String(window.DP_VERSIONE || '').slice(0, 40) || null }, x || {});
      if (corpo.comune) corpo.comune = String(corpo.comune).slice(0, 80);
      fetch(CFG.SB + '/rest/v1/eventi', { method: 'POST', keepalive: true, headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(corpo) }).catch(() => {});
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
      if (via) { s._via = via; vicini(); if (dest) arrivo(false); if (selId === s.id) $('#c-title').textContent = titolo(s); }
    } catch (e) { /* senza rete resta "Posto riservato" */ }
  }
  // computer: pannello fisso a sinistra e mappa a tutto schermo; telefono: pannelli dal basso
  const LARGO = () => window.matchMedia('(min-width:900px)').matches, COL = 448;
  const padPC = (m) => ({ top: 30 + (m || 0), bottom: 30 + (m || 0), left: COL + (m || 0), right: 30 + (m || 0) });
  const padHome = () => LARGO() ? padPC() : (aggiungo ? { top: 90, bottom: $('#add .sheet').offsetHeight || 0, left: 0, right: 0 } : { top: dest ? 90 : 150, bottom: $(dest ? '#arrivo' : '#home').offsetHeight || 0, left: 0, right: 0 });
  function mostra() { const c = !!selId, d = !!dest, n = aggiungo; $('#card').hidden = !c; $('#add').hidden = !n || c; $('#home').hidden = c || d || n; $('#top').hidden = c || d || n; $('#destbar').hidden = c || !d || n; $('#arrivo').hidden = c || !d || n; }
  window.addEventListener('resize', () => { if (!pronta) return; map.resize(); if (LARGO()) espandi(true); if (!selId) map.setPadding(padHome()); });
  function affidabilita(s) { return s.stato === 'ufficiale' ? ['uff', 'Ufficiale'] : s.stato === 'verificato' ? ['ver', 'Verificato'] : ['prop', 'Da verificare']; }
  function posti(n) { return n === 1 ? '1 posto' : n + ' posti'; }
  let toastT;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 2600); }
  function apri(url) { window.open(url, '_blank'); }
  function passa(s) { return !(filtri.ver && s.stato === 'proposto') && !(filtri.cop && !s.coperto) && !(filtri.multi && !(s.posti >= 2)); }

  // ---------- dati ----------
  // I posti si chiedono al server solo per una zona piccola (funzione stalli_zona, al massimo 0,05° x 0,075°) e c'è un limite
  // di richieste per indirizzo: a mappa larga si chiedono solo conteggi a griglia (stalli_conteggi).
  const H = { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY };
  let ctl, pausa429 = 0;
  async function rpc(nome, args, signal) { // chiama una funzione del database; 429 = troppe richieste, non si ripete da soli
    const limite = () => Object.assign(new Error('429'), { status: 429 });
    if (Date.now() < pausa429) throw limite(); // già bloccati da poco: inutile insistere (si riprova da soli dopo 30 secondi, solo se l'utente muove la mappa)
    const r = await fetch(`${CFG.SB}/rest/v1/rpc/${nome}`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(args), signal });
    if (r.status === 429) { pausa429 = Date.now() + 30000; throw limite(); }
    if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status });
    return r.json();
  }
  const troppe = () => toast('Troppe richieste in poco tempo. Riprova tra qualche minuto.', 4500);
  const erroreDati = (err) => { if (err.name === 'AbortError') return; if (err.status === 429) troppe(); else toast('Non riesco a caricare i posti. Controlla la connessione.'); };
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
  const map = new maplibregl.Map({ container: 'map', style: CFG.STYLE, center: CFG.HOME, zoom: 14.5, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  window.__dp = { map, stalli }; // per le prove

  function glifo(colore) { // il simbolo disegnato su un quadratino trasparente, per i pin
    const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
    x.scale(2, 2); x.strokeStyle = colore; x.lineWidth = 2.3; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.arc(10, 4.5, 1.8, 0, Math.PI * 2); x.stroke();
    x.stroke(new Path2D('M10 8.5v5.5h5l2.5 5')); x.stroke(new Path2D('M7.5 11.5a5.5 5.5 0 1 0 7.5 7'));
    return x.getImageData(0, 0, 48, 48);
  }
  const VUOTO = { type: 'FeatureCollection', features: [] };
  // ---------- vista da lontano: quanti posti per regione, provincia, comune ----------
  let riepilogo = null, livello = '';
  const LIVELLI = [['regioni', 7.2, 8.4], ['province', 9.6, 10.6], ['comuni', CFG.MIN_ZOOM_DATI, 14.2]]; // nome, fino a che zoom, zoom dopo il tocco (14,2: la vista è abbastanza stretta per i singoli posti)
  const num = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+$)/g, '.');
  function fondoZona() { // fondo blu arrotondato che si allarga attorno al testo
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    x.beginPath(); x.roundRect(3, 3, 58, 58, 22); x.fillStyle = '#0b2a5b'; x.fill(); x.lineWidth = 4; x.strokeStyle = '#ffffff'; x.stroke();
    return x.getImageData(0, 0, 64, 64);
  }
  function zone() {
    if (!pronta || !riepilogo) return;
    const z = map.getZoom(), l = (LIVELLI.find((v) => z < v[1]) || [''])[0];
    if (l === livello) return; livello = l;
    map.getSource('zone').setData(l ? { type: 'FeatureCollection', features: riepilogo[l].map((v) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [v.lon, v.lat] }, properties: { n: v.n, t: v.t, tl: num(v.t) } })) } : VUOTO);
  }
  fetch(CFG.SB + '/storage/v1/object/public/foto/copertura/riepilogo.json').then((r) => r.ok ? r.json() : null).then((j) => { if (j && j.regioni) { riepilogo = j; zone(); vicini(); } }).catch(() => {});
  map.on('load', () => {
    map.addImage('wc-w', glifo('#ffffff'), { pixelRatio: 2 }); map.addImage('wc-b', glifo('#0b2a5b'), { pixelRatio: 2 }); map.addImage('wc-d', glifo('#2b2300'), { pixelRatio: 2 });
    map.addSource('stalli', { type: 'geojson', data: VUOTO, cluster: true, clusterRadius: 42, clusterMaxZoom: 15 });
    map.addSource('sel', { type: 'geojson', data: VUOTO }); map.addSource('conteggi', { type: 'geojson', data: VUOTO });
    map.addSource('zone', { type: 'geojson', data: VUOTO }); map.addImage('zona', fondoZona(), { pixelRatio: 2, stretchX: [[26, 38]], stretchY: [[26, 38]], content: [16, 11, 48, 53] });
    map.addLayer({ id: 'zone', type: 'symbol', source: 'zone', maxzoom: CFG.MIN_ZOOM_DATI, layout: { 'icon-image': 'zona', 'icon-text-fit': 'both', 'symbol-sort-key': ['-', ['get', 't']], 'text-field': ['format', ['get', 'n'], { 'font-scale': 0.8 }, '\n', {}, ['get', 'tl'], { 'text-font': ['literal', ['Noto Sans Bold']] }], 'text-font': ['Noto Sans Regular'], 'text-size': 15, 'text-line-height': 1.25, 'text-max-width': 9, 'text-padding': 6 }, paint: { 'text-color': '#ffffff' } });
    map.on('click', 'zone', (e) => { const f = e.features[0], v = LIVELLI.find((x) => x[0] === livello); seguo = false; map.easeTo({ center: f.geometry.coordinates, zoom: v ? v[2] : 13 }); });
    map.addLayer({ id: 'gruppi', type: 'circle', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['has', 'point_count'], paint: { 'circle-color': '#0b2a5b', 'circle-radius': ['step', ['get', 'point_count'], 17, 10, 21, 50, 25], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'gruppi-n', type: 'symbol', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
    map.addLayer({ id: 'pin', type: 'circle', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 15, 'circle-color': ['case', ['==', ['get', 'stato'], 'proposto'], '#ffffff', '#0b2a5b'], 'circle-stroke-color': ['case', ['==', ['get', 'stato'], 'proposto'], '#0b2a5b', '#ffffff'], 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'pin-i', type: 'symbol', source: 'stalli', minzoom: CFG.MIN_ZOOM_DATI, filter: ['!', ['has', 'point_count']], layout: { 'icon-image': ['case', ['==', ['get', 'stato'], 'proposto'], 'wc-b', 'wc-w'], 'icon-size': 0.8, 'icon-allow-overlap': true } });
    map.addLayer({ id: 'conteggi', type: 'circle', source: 'conteggi', paint: { 'circle-color': '#0b2a5b', 'circle-radius': ['get', 'r'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'conteggi-n', type: 'symbol', source: 'conteggi', layout: { 'text-field': ['get', 't'], 'text-font': ['Noto Sans Bold'], 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
    map.on('click', 'conteggi', (e) => avvicinaA(e.features[0].geometry.coordinates));
    map.on('mouseenter', 'conteggi', () => { map.getCanvas().style.cursor = 'pointer'; }); map.on('mouseleave', 'conteggi', () => { map.getCanvas().style.cursor = ''; });
    map.addLayer({ id: 'sel', type: 'circle', source: 'sel', paint: { 'circle-radius': 23, 'circle-color': '#ffcc00', 'circle-stroke-color': '#0b1f44', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'sel-i', type: 'symbol', source: 'sel', layout: { 'icon-image': 'wc-d', 'icon-size': 1.15, 'icon-allow-overlap': true } });
    map.on('click', 'pin', (e) => apriScheda(e.features[0].properties.id));
    map.on('click', 'gruppi', (e) => { const f = e.features[0]; Promise.resolve(map.getSource('stalli').getClusterExpansionZoom(f.properties.cluster_id)).then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z, 18) })); });
    const at = document.querySelector('.maplibregl-ctrl-attrib'); if (at) { at.classList.remove('maplibregl-compact-show'); at.removeAttribute('open'); } // i crediti della mappa partono chiusi (si aprono dalla i)
    pronta = true; vediPosti(false); if (LARGO()) { map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right'); espandi(true); }
    map.setPadding(padHome()); disegna(); zone(); caricaVista();
  });
  map.on('error', (e) => { if (!pronta && e && e.error && /style|Failed to fetch|load/i.test(String(e.error.message))) toast('La mappa non si carica. Controlla la connessione.', 5000); });
  let pronta = false, moveT;
  map.on('dragstart', () => { seguo = false; });
  map.on('moveend', () => { clearTimeout(moveT); moveT = setTimeout(caricaVista, 300); if (aggiungo) qui(); });

  function disegna() {
    if (!pronta) return;
    const feats = [];
    for (const s of stalli.values()) if (passa(s)) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, stato: s.stato } });
    map.getSource('stalli').setData({ type: 'FeatureCollection', features: feats });
    const s = selId && stalli.get(selId);
    map.getSource('sel').setData(s ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: {} }] } : VUOTO);
    vicini();
  }

  // ---------- posizione ----------
  let meMarker = null, ultimoCarico = null;
  function setMe(lat, lon) {
    const primo = !me; me = { lat, lon };
    if (!meMarker) { const el = document.createElement('div'); el.className = 'me'; el.innerHTML = '<i></i>'; meMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map); } else meMarker.setLngLat([lon, lat]);
    if (primo && seguo && !selId) map.jumpTo({ center: [lon, lat], zoom: 16, padding: padHome() });
    if (!ultimoCarico || dist(lat, lon, ultimoCarico.lat, ultimoCarico.lon) > 300) { ultimoCarico = { lat, lon }; carica(lat - 0.024, lon - 0.035, lat + 0.024, lon + 0.035, false); }
    vicini(); if (selId) aggiornaConferma();
  }
  async function attivaPosizione(chiedi) {
    const cap = window.Capacitor, G = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Geolocation;
    try {
      if (G) {
        let p = await G.checkPermissions();
        if (p.location !== 'granted') { if (!chiedi) return false; p = await G.requestPermissions(); if (p.location !== 'granted') return false; }
        await G.watchPosition({ enableHighAccuracy: true, timeout: 20000 }, (pos) => { if (pos && pos.coords) setMe(pos.coords.latitude, pos.coords.longitude); });
        return true;
      }
      if (!navigator.geolocation) return false;
      if (!chiedi && navigator.permissions) { const st = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null); if (st && st.state !== 'granted') return false; }
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

  // Traffico reale (TomTom): solo per il posto in cima all'elenco e per la scheda aperta, così il piano gratuito basta.
  const TT = window.DP_TOMTOM || '', cacheTT = new Map();
  const fresco = (c) => c && me && Date.now() - c.t < 120000 && dist(me.lat, me.lon, c.lat, c.lon) < 300;
  function traffico(s) { const c = cacheTT.get(s.id); return fresco(c) && c.sec != null ? c : null; }
  async function chiediTraffico(s) {
    if (!TT || !me || fresco(cacheTT.get(s.id))) return false;
    const c = { t: Date.now(), lat: me.lat, lon: me.lon }; cacheTT.set(s.id, c);
    try {
      const r = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${me.lat},${me.lon}:${s.lat},${s.lon}/json?key=${TT}&traffic=true&travelMode=car&routeType=fastest`);
      if (!r.ok) throw new Error(r.status); const su = (await r.json()).routes[0].summary;
      c.m = su.lengthInMeters; c.sec = su.travelTimeInSeconds; c.rit = su.trafficDelayInSeconds || 0; return true;
    } catch (e) { return false; }
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
      if (out[0]) { const tr = traffico(out[0].s); if (tr) out[0].r = tr; chiediTraffico(out[0].s).then((ok) => { if (ok) vicini(); }); }
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
    if (!out.length) { el.innerHTML = `<div class="eyebrow">${usoMe ? 'Vicino a te' : 'In questa zona'}</div><div class="empty">Nessun posto qui${filtri.ver || filtri.cop || filtri.multi ? ' con questi filtri' : ''}. Sposta la mappa${filtri.ver || filtri.cop || filtri.multi ? ' o togli un filtro' : ''}.</div>`; return; }
    const a = out[0], [cls, lab] = affidabilita(a.s);
    el.innerHTML = `<div class="eyebrow">${usoMe ? 'Il più vicino a te' : 'Il più vicino in questa zona'}</div>
      <button class="first" data-id="${esc(a.s.id)}"><span class="tile">${icon('wc')}</span><span class="t"><b>${esc(titolo(a.s))}</b><span>${[quanto(a), posti(a.s.posti)].join(' · ')}</span></span><span class="badge ${cls}">${lab}</span></button>
      <button class="primary" data-nav="${esc(a.s.id)}">${icon('nav')}<span>Portami lì</span></button>
      <div class="others">${out.slice(1).map((x) => `<button class="other" data-id="${esc(x.s.id)}"><span class="t"><b>${esc(titolo(x.s))}</b><span>${affidabilita(x.s)[1]} · ${posti(x.s.posti)}</span></span><span class="d">${x.r ? `${fmtMin(x.r.sec)}<small>${fmtDist(x.r.m)}</small>` : fmtDist(x.d)}</span>${icon('chev')}</button>`).join('')}</div>`;
  }
  function espandi(si) {
    if (LARGO()) si = true; // sul computer l'elenco è sempre completo
    if (espanso === si) return; espanso = si; $('#near').classList.toggle('exp', si); $('#near .handle').setAttribute('aria-expanded', si); vicini();
    const o = document.querySelector('#near .others'); if (o) o.scrollTop = 0;
    if (!selId && !dest) map.setPadding(padHome());
  }
  (function () { // trascina il pannello: su per vedere più posti, giù per richiuderlo; un tocco sulla maniglia fa lo stesso
    const el = $('#near'); let y0 = null, daLista = false;
    el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; const o = e.target.closest('.others'); daLista = !!(o && espanso && o.scrollTop > 0); }, { passive: true });
    let tocco = 0;
    el.addEventListener('touchend', (e) => {
      if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
      if (dy < -40 && !espanso) espandi(true); else if (dy > 40 && espanso && !daLista) espandi(false);
      else if (Math.abs(dy) < 10 && e.target.closest('.handle')) { tocco = Date.now(); espandi(!espanso); }
    }, { passive: true });
    $('#near .handle').addEventListener('click', () => { if (Date.now() - tocco > 700) espandi(!espanso); }); // con il mouse o la tastiera
  })();
  $('#near-body').addEventListener('click', (e) => {
    const n = e.target.closest('[data-nav]'); if (n) { naviga(stalli.get(n.dataset.nav)); return; }
    if (e.target.closest('[data-me]')) { vaiAMe(); return; }
    const b = e.target.closest('[data-id]'); if (b) apriScheda(b.dataset.id);
  });
  function naviga(s) { if (s) { traccia('naviga', { comune: s.comune || null }); ls.set('dp.nav', ls.get('dp.nav', 0) + 1); ls.set('dp.navT', Date.now()); } if (s) apri(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`); }

  // ---------- scheda del posto ----------
  function apriScheda(id) {
    const s = stalli.get(id); if (!s) return;
    const eraAperta = !!selId, prima = selId; selId = id; disegna(); trovaVia(s); if (prima !== id) traccia('scheda', { comune: s.comune || null });
    const [cls, lab] = affidabilita(s);
    $('#c-title').textContent = titolo(s);
    sottotitolo(); if (me) { tempi(me, [{ s }], 'car').then((ok) => { if (ok && selId === id) sottotitolo(); }); chiediTraffico(s).then((ok) => { if (ok && selId === id) sottotitolo(); }); }
    const fonte = s.stato === 'ufficiale' ? (s.fonte === 'opendata' ? 'Dato ufficiale del Comune' : 'Ufficiale') : lab;
    $('#c-badges').innerHTML = `<span class="badge ${cls}">${cls === 'uff' ? icon('shield') : ''}${fonte}</span><span class="badge">${posti(s.posti)}</span><span class="badge">Per tutti i contrassegni</span>${s.coperto ? '<span class="badge">Coperto</span>' : ''}`;
    const nota = (s.note || '').replace(/;?\s*Dato ufficiale[^;]*\(open data[^)]*\)/i, '').replace(/^Accorpato in [^.]*\.\s*/i, '').trim();
    $('#c-note').hidden = !nota; $('#c-note').textContent = nota ? nota.charAt(0).toUpperCase() + nota.slice(1) : '';
    $('#c-save').setAttribute('aria-pressed', salvati.has(id)); $('#c-save').querySelector('span').textContent = salvati.has(id) ? 'Salvato' : 'Salva';
    aggiornaConferma();
    mostra();
    seguo = false; map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16.5), padding: LARGO() ? padPC() : { top: 90, bottom: $('#card .sheet').offsetHeight + 20, left: 0, right: 0 }, duration: 500 });
  }
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
    if (App) App.addListener('backButton', () => { if (!$('#aggiorna').hidden || !$('#welcome').hidden) App.exitApp(); else if (!$('#fonti').hidden) $('#fonti').hidden = true; else if (!$('#segn').hidden) $('#segn').hidden = true; else if (!$('#sugg').hidden) $('#sugg').hidden = true; else if (!$('#regole').hidden) $('#regole').hidden = true; else if (!$('#voto').hidden) $('#voto').hidden = true; else if (!$('#profilo').hidden) $('#profilo').hidden = true; else if (!$('#search').hidden) chiudiRicerca(); else if (!$('#menu').hidden) $('#menu').hidden = true; else if (selId) chiudiScheda(true); else if (aggiungo) chiudiAggiungi(); else if (dest) chiudiDest(); else if (App.minimizeApp) App.minimizeApp(); else App.exitApp(); });
    else window.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudiScheda(true); });
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
    const att = Math.max(0, Math.min(inCorso, lista.length - 1));
    $('#a-list').innerHTML = lista.map((x, i) => `<button class="arow${i === att ? ' on' : ''}" data-id="${esc(x.s.id)}"><span class="num">${i + 1}</span><span class="t"><b>${esc(titolo(x.s))}</b><span>${[affidabilita(x.s)[1], posti(x.s.posti), x.s.coperto ? 'coperto' : ''].filter(Boolean).join(' · ')}</span></span><span class="d">${x.r ? `${fmtDist(x.r.m)}<small>${fmtMin(x.r.sec)} a piedi</small>` : fmtDist(x.d)}</span></button>`).join('');
    const prox = inCorso + 1 < lista.length ? inCorso + 1 : -1;
    $('#a-nav').hidden = !lista.length;
    $('#a-nav span').textContent = inCorso < 0 ? 'Portami al numero 1' : prox >= 0 ? `Occupato? Portami al numero ${prox + 1}` : 'Riapri il navigatore';
    $('#a-hint').textContent = inCorso < 0 && lista.length > 1 ? 'Se è occupato, con un tocco passi al numero 2.' : '';
    numMk.forEach((m) => m.remove()); numMk = []; if (destMk) destMk.remove();
    const de = document.createElement('div'); de.className = 'mdest'; de.innerHTML = icon(dest.k === 'casa' ? 'casa' : dest.k === 'lavoro' ? 'lavoro' : 'flag'); destMk = new maplibregl.Marker({ element: de }).setLngLat([dest.lon, dest.lat]).addTo(map);
    lista.forEach((x, i) => { const el = document.createElement('div'); el.className = 'mnum' + (i === att ? ' on' : ''); el.textContent = i + 1; el.onclick = (e) => { e.stopPropagation(); apriScheda(x.s.id); }; numMk.push(new maplibregl.Marker({ element: el }).setLngLat([x.s.lon, x.s.lat]).addTo(map)); });
    if (inquadra) {
      const b = new maplibregl.LngLatBounds([dest.lon, dest.lat], [dest.lon, dest.lat]); lista.slice(0, 5).forEach((x) => b.extend([x.s.lon, x.s.lat]));
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // fitBounds somma il suo margine a quello già impostato
      map.fitBounds(b, { padding: LARGO() ? padPC(50) : { top: 110, bottom: $('#arrivo').offsetHeight + 40, left: 50, right: 50 }, maxZoom: 17, duration: 500 });
    }
  }
  // elenco dei posti attorno alla destinazione: si può ridurre al solo posto scelto per lasciare spazio alla mappa
  let ridotto = false;
  function riduci(si) {
    if (ridotto === si) return; ridotto = si; $('#arrivo').classList.toggle('min', si); $('#a-handle').setAttribute('aria-expanded', !si);
    if (!si) $('#a-list').scrollTop = 0;
    if (dest && !selId) arrivo(true);
  }
  (function () { // trascina giù per ridurre, su per riaprire; un tocco sulla maniglia fa lo stesso
    const el = $('#arrivo'); let y0 = null, daLista = false, tocco = 0;
    el.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; const o = e.target.closest('#a-list'); daLista = !!(o && !ridotto && o.scrollHeight > o.clientHeight + 2); }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
      if (dy > 40 && !ridotto && !daLista) riduci(true); else if (dy < -40 && ridotto) riduci(false);
      else if (Math.abs(dy) < 10 && e.target.closest('.handle')) { tocco = Date.now(); riduci(!ridotto); }
    }, { passive: true });
    $('#a-handle').addEventListener('click', () => { if (Date.now() - tocco > 700) riduci(!ridotto); });
  })();
  function chiudiDest() { dest = null; numMk.forEach((m) => m.remove()); numMk = []; if (destMk) destMk.remove(); destMk = null; mostra(); map.easeTo({ padding: padHome(), duration: 300 }); vicini(); }
  $('#d-back').onclick = chiudiDest;
  $('#d-name').onclick = () => { if (dest) apriRicerca(dest.q || dest.t); };
  $('#a-r').onchange = () => { raggio = +$('#a-r').value; ls.set('dp.raggio', raggio); inCorso = -1; arrivo(true); };
  $('#a-list').addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) apriScheda(b.dataset.id); });
  $('#a-nav').onclick = () => { if (!lista.length) return; if (inCorso + 1 < lista.length) inCorso++; naviga(lista[inCorso].s); setTimeout(() => arrivo(false), 600); };

  // ---------- schermata 3 · ricerca ----------
  let sCtl, sT, scelgo = null; // scelgo: 'casa' o 'lavoro' mentre si imposta la scorciatoia
  const luoghi = () => ls.get('dp.luoghi', {});
  function ricorda(d) { const r = ls.get('dp.recenti', []).filter((x) => x.t !== d.t); r.unshift({ t: d.t, sub: d.sub || '', lat: d.lat, lon: d.lon, q: d.q || '' }); ls.set('dp.recenti', r.slice(0, 5)); }
  function apriRicerca(testo, imposta) {
    $('#search').hidden = false; $('#s-q').value = testo || ''; $('#s-x').hidden = !testo; scelgo = imposta || null;
    if (testo) { chipStato(); cerca(testo); } else inizio();
    setTimeout(() => { $('#s-q').focus(); if (testo) $('#s-q').select(); }, 60);
  }
  function chiudiRicerca() { $('#search').hidden = true; $('#s-q').blur(); if (sCtl) sCtl.abort(); }
  function chipStato() { document.querySelectorAll('.s-chips button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === scelgo)); $('#s-q').placeholder = scelgo ? `Cerca l'indirizzo ${scelgo === 'casa' ? 'di casa' : 'del lavoro'}` : 'Via, luogo o città'; }
  function inizio() {
    chipStato(); const r = ls.get('dp.recenti', []);
    $('#s-body').innerHTML = (scelgo ? `<div class="empty">Scrivi l'indirizzo e toccalo: lo ritrovi qui sopra con un tocco.</div>` : '') +
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
    if (sCtl) sCtl.abort(); sCtl = new AbortController(); const mio = sCtl; attesa(q); const c = me ? [me.lon, me.lat] : [map.getCenter().lng, map.getCenter().lat];
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
      if (!risultati.length) { $('#s-body').innerHTML = '<div class="empty">Non trovo questo posto. Prova con la via e la città.</div>'; return; }
      $('#s-body').innerHTML = '<div class="eyebrow">Risultati</div>' + risultati.map((x, i) => `<div data-box="${i}"><button class="res" data-res="${i}"><span class="mk">${icon('pin')}</span><span class="t"><b>${esc(x.t)}</b><span>${esc(x.sub)}</span></span>${scelgo ? '' : '<span class="n wait">…</span>'}</button></div>`).join('');
      if (!scelgo) risultati.forEach((x, i) => conta(x, i, mio.signal));
    } catch (e) { if (e.name !== 'AbortError' && sCtl === mio) $('#s-body').innerHTML = `<div class="empty">La ricerca non risponde. Controlla la connessione e riprova.<br><span class="small">(${esc(e.message || e)})</span></div>`; }
  }
  async function conta(x, i, signal) { // quanti posti ci sono attorno a un risultato; se nessuno, propone il più vicino
    if (x.citta && riepilogo) { // per una città conta tutto il comune, non solo il cerchio attorno al centro
      const c = riepilogo.comuni.filter((v) => norma(v.n) === norma(x.t) && Math.abs(v.lat - x.lat) < 0.15 && Math.abs(v.lon - x.lon) < 0.2)[0], box = document.querySelector(`[data-box="${i}"]`);
      if (c && c.t && box) { const b = box.querySelector('.n'); b.className = 'n'; b.textContent = num(c.t) + ' nel comune'; return; }
    }
    await carica(x.lat - 0.012, x.lon - 0.017, x.lat + 0.012, x.lon + 0.017, false);
    const box = document.querySelector(`[data-box="${i}"]`); if (signal.aborted || !box) return;
    const tutti = attorno(x.lat, x.lon), dentro = tutti.filter((y) => y.d <= raggio), n = dentro.reduce((a, y) => a + (y.s.posti || 1), 0), b = box.querySelector('.n');
    if (dentro.length) { b.className = 'n'; b.textContent = posti(n); return; }
    b.remove(); const rg = raggio >= 1000 ? '1 km' : raggio + ' m';
    const d = document.createElement('div'); d.className = 'lontano';
    if (tutti.length) { const v = tutti[0]; d.innerHTML = `<div><b>Nessun posto entro ${rg}.</b> Il più vicino è a ${fmtDist(v.d)}${v.s.indirizzo ? ', in ' + esc(v.s.indirizzo) : ''}.</div><button data-nav="${esc(v.s.id)}">${icon('nav')}<span>Portami lì</span></button>`; }
    else d.innerHTML = '<div><b>Nessun posto entro 1 km.</b> Qui la mappa è ancora vuota.</div>';
    box.appendChild(d);
  }
  $('#s-q').addEventListener('input', () => { const q = $('#s-q').value.trim(); $('#s-x').hidden = !q; clearTimeout(sT); if (sCtl) sCtl.abort(); if (q.length < 3) { inizio(); return; } attesa(q); sT = setTimeout(() => cerca(q), 450); });
  $('#s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#s-q').blur(); const q = $('#s-q').value.trim(); clearTimeout(sT); if (q.length >= 2) cerca(q); } });
  $('#s-x').onclick = () => { $('#s-q').value = ''; $('#s-x').hidden = true; inizio(); $('#s-q').focus(); };
  $('#s-back').onclick = chiudiRicerca;
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
    const sv = e.target.closest('[data-sal]'); if (sv) apriSalvato(sv.dataset.sal);
  });
  document.querySelector('.s-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const k = b.dataset.k;
    if (k === 'salvati') {
      scelgo = null; chipStato(); const v = [...salvati.values()];
      $('#s-body').innerHTML = '<div class="eyebrow">I tuoi posti salvati</div>' + (v.length ? v.map((x) => `<button class="res" data-sal="${esc(x.id)}"><span class="mk">${icon('save')}</span><span class="t"><b>${esc(x.t || 'Posto riservato')}</b><span>${esc(x.c || '')}</span></span></button>`).join('') : '<div class="empty">Non hai ancora salvato nessun posto. Apri un posto e tocca "Salva".</div>');
      return;
    }
    const l = luoghi()[k];
    if (l && scelgo !== k) { vaiA(Object.assign({ k }, l)); return; }
    scelgo = scelgo === k ? null : k; $('#s-q').value = ''; $('#s-x').hidden = true; inizio(); $('#s-q').focus();
  });


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
  async function aut(path, opt) {
    if (sessione && sessione.scade - 60 < Date.now() / 1000) {
      const r = await fetch(`${CFG.SB}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: CFG.KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sessione.refresh }) });
      if (r.ok) entra2(await r.json()); else if (r.status === 400 || r.status === 401) { sessione = null; ls.set('dp.sessione', null); throw new Error('sessione scaduta'); }
    }
    return fetch(CFG.SB + path, Object.assign({}, opt, { headers: Object.assign({ apikey: CFG.KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (sessione ? sessione.token : CFG.KEY) }, (opt || {}).headers) }));
  }
  function entra2(j) { sessione = { token: j.access_token, refresh: j.refresh_token, scade: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || (sessione && sessione.email) || '' }; ls.set('dp.sessione', sessione); }
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
      const r = await aut('/auth/v1/user'); if (!r.ok) return; const u = await r.json(), remoto = (u.user_metadata || {}).dp;
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
    entra2(j); await allinea(); return 'ok';
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
    entra2({ access_token: at, refresh_token: h.get('refresh_token'), expires_in: +h.get('expires_in') || 3600, user: { email } });
    traccia('accesso', { dettaglio: 'google' }); ls.set('dp.google', 0);
    try { await allinea(); } catch (e) { /* si riallinea alla prossima modifica */ }
    if (!$('#menu').hidden) menu(); toast('Accesso fatto. I tuoi posti ora ti seguono.'); return true;
  }
  if (/access_token=|error_description=/.test(location.hash)) { const h = location.hash; history.replaceState(null, '', location.pathname + location.search); setTimeout(() => daGoogle(h), 300); }
  (function () { const cap = window.Capacitor, A = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.App; if (A) A.addListener('appUrlOpen', (e) => { if (e && e.url && e.url.indexOf('it.disabilityparking.app://login') === 0) daGoogle(e.url); }); })();
  function esci() { if (sessione) fetch(`${CFG.SB}/auth/v1/logout`, { method: 'POST', headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + sessione.token } }).catch(() => {}); sessione = null; ls.set('dp.sessione', null); }

  // ---------- schermata 7 · i tuoi posti ----------
  let formAperto = false;
  function apriMenu() { formAperto = false; $('#menu').hidden = false; menu(); }
  function menu(msg) {
    const l = luoghi(), v = [...salvati.values()];
    const acc = sessione
      ? `<div class="chi"><span class="av">${esc((sessione.email || '?')[0])}</span><span class="t"><b>${esc(sessione.email)}</b><span>I tuoi posti sono al sicuro nel tuo account</span></span><button class="bsm" data-a="esci">Esci</button></div>`
      : `<div class="acc"><div class="b">Accedi per non perderli</div><p>I posti salvati ti seguono se cambi telefono. È facoltativo: l'app funziona anche senza.</p>${formAperto
        ? `<label class="vh" for="a-email">Email</label><input id="a-email" type="email" placeholder="La tua email" autocomplete="username"><label class="vh" for="a-pass">Password</label><input id="a-pass" type="password" placeholder="Password" autocomplete="current-password" aria-describedby="a-reg"><p class="reg" id="a-reg">Per un nuovo account: almeno ${PASS_MIN} caratteri, con minuscola, maiuscola, numero e carattere speciale.</p><div class="msg" role="status">${esc(msg || '')}</div><button class="bw" data-a="entra">Accedi</button><button class="bo" data-a="crea">Crea un account</button>`
        : `${CFG.GOOGLE ? `<button class="bw gg" data-a="google"><span class="g" aria-hidden="true">G</span>Continua con Google</button>` : ''}<button class="${CFG.GOOGLE ? 'bo' : 'bw'}" data-a="form">Usa la tua email</button>${CFG.GOOGLE ? '' : '<p>L\'accesso con Google arriva presto.</p>'}`}</div>`;
    const luogo = (k, nome, ic) => l[k]
      ? `<div class="luogo"><button class="vai" data-a="vai" data-k="${k}"><span class="mk">${icon(ic)}</span><span class="t"><b>${nome}</b><span>${esc(l[k].t)}</span></span></button><div class="az"><button data-a="imposta" data-k="${k}">Cambia</button><button data-a="togli" data-k="${k}">Togli</button></div></div>`
      : `<div class="luogo vuoto"><button class="vai" data-a="imposta" data-k="${k}"><span class="mk">${icon(ic)}</span><span class="t"><b>${nome}</b><span>Imposta l'indirizzo</span></span></button></div>`;
    $('#m-body').innerHTML = `${acc}
      <div class="luoghi">${luogo('casa', 'Casa', 'casa')}${luogo('lavoro', 'Lavoro', 'lavoro')}</div>
      <button class="vaip" data-a="profilo"><span class="mk">${icon('wc')}</span><span class="t">Il mio contrassegno e gli avvisi</span>${icon('chev')}</button>
      <button class="vaip" data-a="segn"><span class="mk">${icon('plus')}</span><span class="t">Le mie segnalazioni</span>${icon('chev')}</button>
      <button class="vaip" data-a="regole"><span class="mk">${icon('shield')}</span><span class="t">Regole della sosta con il contrassegno</span>${icon('chev')}</button>
      <button class="vaip" data-a="sugg"><span class="mk">${icon('idea')}</span><span class="t">Suggerisci un miglioramento</span>${icon('chev')}</button>
      <button class="vaip" data-a="consiglia"><span class="mk">${icon('share')}</span><span class="t">Consiglia l'app a un amico</span>${icon('chev')}</button>
      <button class="vaip stat" data-a="stat" role="switch" aria-checked="${statAttive()}"><span class="t">Statistiche anonime<span>${statAttive() ? 'Attive: ci aiutano a capire cosa migliorare. Niente posizione né dati personali.' : 'Disattivate su questo telefono.'}</span></span><span class="tgl" aria-hidden="true"></span></button>
      <div><div class="eyebrow">Posti salvati</div>${v.length ? v.map((x) => `<div class="riga"><button class="apri" data-a="salvato" data-id="${esc(x.id)}"><span class="st">${icon('save')}</span><span class="t"><b>${esc(x.t || 'Posto riservato')}</b><span>${esc(x.c || '')}</span></span></button><button class="via" data-a="via" data-id="${esc(x.id)}" aria-label="Togli ${esc(x.t || 'questo posto')} dai salvati">${icon('x')}</button></div>`).join('') : '<div class="empty">Ancora nessuno. Apri un posto sulla mappa e tocca "Salva".</div>'}</div>
      <div class="piede"><button data-a="fonti">Fonti e avvertenze</button></div>
      <div class="vers">Versione ${esc(window.DP_VERSIONE || '')}</div>`;
  }
  $('#m-back').onclick = () => { $('#menu').hidden = true; };
  $('#m-body').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a, k = b.dataset.k;
    if (a === 'form') { formAperto = true; menu(); $('#a-email').focus(); }
    else if (a === 'entra' || a === 'crea') {
      const email = $('#a-email').value.trim(), pass = $('#a-pass').value;
      if (!/^\S+@\S+\.\S+$/.test(email) || !pass) { $('#m-body .msg').textContent = 'Scrivi la tua email e la password.'; return; }
      const manca = a === 'crea' ? passMancante(pass) : [];
      if (manca.length) { $('#m-body .msg').textContent = 'Per creare un account alla password manca: ' + manca.join(', ') + '.'; $('#a-pass').focus(); return; }
      b.disabled = true; $('#m-body .msg').textContent = 'Un momento…';
      try { const esito = await accedi(email, pass, a === 'crea'); if (esito === 'conferma') { $('#m-body .msg').textContent = 'Ti abbiamo mandato un\'email: apri il link di conferma, poi torna qui e tocca "Accedi".'; b.disabled = false; } else { formAperto = false; menu(); toast('Accesso fatto. I tuoi posti ora ti seguono.'); } }
      catch (err) { $('#m-body .msg').textContent = err.message; b.disabled = false; }
    }
    else if (a === 'esci') { esci(); menu(); toast('Sei uscito. I posti restano su questo telefono.'); }
    else if (a === 'vai') { $('#menu').hidden = true; vaiA(Object.assign({ k }, luoghi()[k])); }
    else if (a === 'imposta') { $('#menu').hidden = true; apriRicerca('', k); }
    else if (a === 'togli') { const l = luoghi(); delete l[k]; ls.set('dp.luoghi', l); toccato(); menu(); }
    else if (a === 'salvato') { $('#menu').hidden = true; apriSalvato(b.dataset.id); }
    else if (a === 'via') { salvati.delete(b.dataset.id); ls.set('dp.salvati', [...salvati.values()]); toccato(); menu(); }
    else if (a === 'profilo') { $('#profilo').hidden = false; scheda8(); }
    else if (a === 'segn') apriSegnalazioni();
    else if (a === 'sugg') apriSuggerimento();
    else if (a === 'regole') apriRegole(null);
    else if (a === 'consiglia') consiglia();
    else if (a === 'stat') { const on = !statAttive(); if (!on) traccia('stat_off', null, true); ls.set('dp.stat', on); menu(); toast(on ? 'Statistiche anonime attivate. Grazie!' : 'Statistiche anonime disattivate.'); }
    else if (a === 'google') accediGoogle();
    else if (a === 'fonti') { $('#fonti').hidden = false; $('#f-elenco').href = CFG.SITO + 'fonti.html'; $('#f-cond').href = CFG.SITO + 'condizioni.html'; $('#f-ver').textContent = 'SostAbile, versione di prova ' + (window.DP_VERSIONE || ''); }
  });
  $('#f-back').onclick = () => { $('#fonti').hidden = true; };

  // ---------- le mie segnalazioni: i posti che ho segnalato e a che punto sono ----------
  async function apriSegnalazioni() {
    const el = $('#g-body'); $('#segn').hidden = false; el.innerHTML = '<div class="empty">Carico le tue segnalazioni…</div>';
    try {
      const r = await fetch(CFG.SB + '/rest/v1/rpc/mie_segnalazioni', { method: 'POST', headers: { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_device: dispositivi() }) });
      if (!r.ok) throw new Error(r.status);
      const v = await r.json();
      if (!v.length) { el.innerHTML = '<div class="empty">Non hai ancora segnalato posti. Se ne vedi uno che manca, tocca «Segnala un posto» sulla mappa.</div>'; return; }
      const STATO = { proposto: ['att', 'In attesa di verifica'], verificato: ['ok', 'Approvata'], ufficiale: ['ok', 'Approvata'], rifiutato: ['no', 'Non approvata'], rimosso: ['no', 'Posto rimosso'] };
      el.innerHTML = `<p class="muted">${sessione ? 'Le segnalazioni fatte con il tuo account.' : 'Le segnalazioni fatte da questo telefono. Accedi per ritrovarle anche su un altro.'}</p>` + v.map((x) => {
        const [c, t] = STATO[x.stato] || ['att', x.stato], g = new Date(x.created_at), vivo = x.stato !== 'rifiutato' && x.stato !== 'rimosso';
        return `<${vivo ? 'button' : 'div'} class="segn" ${vivo ? `data-la="${x.lat}" data-lo="${x.lon}" data-id="${esc(x.id)}"` : ''}><span class="t"><b>${esc(x.indirizzo || 'Posto riservato')}</b><span>${esc([x.comune, `${g.getDate()} ${MESI[g.getMonth()]} ${g.getFullYear()}`].filter(Boolean).join(' · '))}</span>${x.stato === 'rifiutato' && x.motivo_rifiuto ? `<span class="perche"><b>Motivo:</b> ${esc(x.motivo_rifiuto)}</span>` : ''}</span><span class="esito ${c}">${t}</span></${vivo ? 'button' : 'div'}>`;
      }).join('');
    } catch (e) { el.innerHTML = '<div class="empty">Non riesco a caricare le segnalazioni. Controlla la connessione e riprova.</div>'; }
  }
  $('#g-back').onclick = () => { $('#segn').hidden = true; };

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
    $('#segn').hidden = true; $('#menu').hidden = true; seguo = false;
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
      <div class="campo"><div class="b" style="font-size:17px">Avvisami prima della scadenza</div>
        <div class="giorni">${[30, 60, 90].map((n) => `<button data-g="${n}" aria-pressed="${std && pr.giorni === n}">${n} gg</button>`).join('')}<button data-g="altro" aria-pressed="${!std}">Altro</button></div>
        ${!std ? `<label class="altro"><input id="p-altro" type="number" inputmode="numeric" min="1" max="365" value="${pr.giorni}"> giorni prima</label>` : ''}
        <div><div class="sw"><span class="t">Notifica sul telefono<span>${pr.scadenza ? 'Un avviso alla data scelta e uno il giorno della scadenza' : 'Imposta prima la data di scadenza'}</span></span><button role="switch" data-p="notifica" aria-checked="${!!pr.notifica}" aria-label="Notifica sul telefono" ${pr.scadenza ? '' : 'disabled'}><i></i></button></div>
        <div class="sw"><span class="t">Email<span>Arriva con un prossimo aggiornamento</span></span><button role="switch" aria-checked="false" aria-label="Avviso via email" disabled><i></i></button></div></div>
      </div>
      <p class="small muted" style="margin:0">La foto del contrassegno resta solo su questo telefono. Nell'account viene salvata soltanto la data di scadenza.</p>`;
  }
  $('#p-back').onclick = () => { $('#profilo').hidden = true; altroAperto = false; };
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
  });
  $('#p-foto').onchange = async () => { const f = $('#p-foto').files[0]; if (!f) return; try { const blob = await rimpicciolisci(f, 1000); const r = new FileReader(); r.onload = () => { ls.set('dp.contrassegno', r.result); scheda8(); }; r.readAsDataURL(blob); } catch (e) { toast('Non riesco a leggere la foto. Riprova.'); } };
  // avvisi sul telefono: programmati sul dispositivo, funzionano anche senza rete e senza account
  const LN = () => { const cap = window.Capacitor; return cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.LocalNotifications; };
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

  // ---------- primo avvio ----------
  if (!ls.get('dp.benvenuto', false)) $('#welcome').hidden = false; else attivaPosizione(false);
  const entra = () => { ls.set('dp.benvenuto', true); $('#welcome').hidden = true; };
  $('#w-go').onclick = async () => { entra(); const ok = await attivaPosizione(true); if (!ok) toast('Posizione non attiva: puoi muovere la mappa a mano.', 4000); };
  $('#w-skip').onclick = entra;

  // ---------- aggiornamento obbligatorio (solo Android) ----------
  // Il database dice qual è la versione minima ancora accettata (funzione app_config); se questa è più vecchia, schermata bloccante.
  // Se la chiamata non riesce o la versione non è un numero, l'app prosegue normalmente.
  const numeri = (v) => (String(v || '').match(/\d+/g) || []).map(Number);
  function piuVecchia(a, min) { const x = numeri(a), y = numeri(min); if (!x.length || !y.length) return false; for (let i = 0; i < Math.max(x.length, y.length); i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p < q; } return false; }
  $('#ag-go').onclick = () => apri(CFG.PLAY);
  if (NATIVO()) fetch(`${CFG.SB}/rest/v1/rpc/app_config`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: '{}' })
    .then((r) => r.ok ? r.json() : null).then((c) => { if (c && piuVecchia(window.DP_VERSIONE, c.versione_minima_android)) { $('#aggiorna').hidden = false; $('#ag-go').focus(); } }).catch(() => {});
})();
