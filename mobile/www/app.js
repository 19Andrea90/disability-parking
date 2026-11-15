/* Disability Parking · app Android (Capacitor). Passo 1: primo avvio, mappa, posto più vicino, scheda del posto. */
(() => {
  'use strict';
  const CFG = {
    SB: 'https://wwereqrojlwktgwlrsib.supabase.co',
    // chiave "anon": è pubblica per natura, i permessi li decide il database
    KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3ZXJlcXJvamx3a3Rnd2xyc2liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MjMzMjYsImV4cCI6MjEwODM5OTMyNn0.vOaCaVc8kaqsRT_o_TP01CbyX9SN-Af1fKjSZ3NxQys',
    STYLE: 'https://tiles.openfreemap.org/styles/positron',
    HOME: [13.236, 46.063], // Udine, finché non c'è la posizione
    MIN_ZOOM_DATI: 12,      // sotto questo zoom i posti sarebbero troppi: si chiede di avvicinarsi
    VICINO_M: 80,           // entro questa distanza si può confermare "c'è / non c'è più"
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

  // ---------- stato ----------
  const stalli = new Map();           // id -> stallo
  const filtri = { ver: false, cop: false, multi: false };
  let me = null;                      // {lat, lon}
  let seguo = true;                   // al primo fix la mappa va sulla posizione, finché non la sposti tu
  let selId = null;
  const salvati = new Map(ls.get('dp.salvati', []).map((x) => typeof x === 'string' ? [x, { id: x }] : [x.id, x])); // id -> {id, lat, lon, t, c}
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
  const padHome = () => ({ top: dest ? 90 : 150, bottom: $(dest ? '#arrivo' : '#home').offsetHeight || 0, left: 0, right: 0 });
  function mostra() { const c = !!selId, d = !!dest; $('#card').hidden = !c; $('#home').hidden = c || d; $('#top').hidden = c || d; $('#destbar').hidden = c || !d; $('#arrivo').hidden = c || !d; }
  function affidabilita(s) { return s.stato === 'ufficiale' ? ['uff', 'Ufficiale'] : s.stato === 'verificato' ? ['ver', 'Verificato'] : ['prop', 'Da verificare']; }
  function posti(n) { return n === 1 ? '1 posto' : n + ' posti'; }
  let toastT;
  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 2600); }
  function apri(url) { window.open(url, '_blank'); }
  function passa(s) { return !(filtri.ver && s.stato === 'proposto') && !(filtri.cop && !s.coperto) && !(filtri.multi && !(s.posti >= 2)); }

  // ---------- dati ----------
  const SEL = 'id,lat,lon,tipo,posti,nome,indirizzo,comune,note,coperto,stato,fonte,conferme_esiste,conferme_non_esiste,ultima_conferma';
  const H = { apikey: CFG.KEY, Authorization: 'Bearer ' + CFG.KEY };
  let ctl;
  async function carica(s, w, n, e, annullabile) {
    if (annullabile) { if (ctl) ctl.abort(); ctl = new AbortController(); }
    const u = `${CFG.SB}/rest/v1/stalli_con_conferme?select=${SEL}&stato=in.(proposto,verificato,ufficiale)&tipo=neq.personalizzato&lat=gte.${s}&lat=lte.${n}&lon=gte.${w}&lon=lte.${e}&limit=3000`;
    try {
      const r = await fetch(u, { headers: H, signal: annullabile ? ctl.signal : undefined });
      if (!r.ok) throw new Error(r.status);
      const rows = await r.json();
      if (stalli.size > 30000) stalli.clear();
      for (const x of rows) { const v = stalli.get(x.id); if (v && v._via) x._via = v._via; stalli.set(x.id, x); }
      disegna(); return rows;
    } catch (err) { if (err.name !== 'AbortError') toast('Non riesco a caricare i posti. Controlla la connessione.'); return []; }
  }
  function caricaVista() {
    if (map.getZoom() < CFG.MIN_ZOOM_DATI) { vicini(); return; }
    const b = map.getBounds(), dy = (b.getNorth() - b.getSouth()) * 0.25, dx = (b.getEast() - b.getWest()) * 0.25;
    carica(b.getSouth() - dy, b.getWest() - dx, b.getNorth() + dy, b.getEast() + dx, true);
  }

  // ---------- mappa ----------
  const map = new maplibregl.Map({ container: 'map', style: CFG.STYLE, center: CFG.HOME, zoom: 14, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
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
  map.on('load', () => {
    map.addImage('wc-w', glifo('#ffffff'), { pixelRatio: 2 }); map.addImage('wc-b', glifo('#0b2a5b'), { pixelRatio: 2 }); map.addImage('wc-d', glifo('#2b2300'), { pixelRatio: 2 });
    map.addSource('stalli', { type: 'geojson', data: VUOTO, cluster: true, clusterRadius: 42, clusterMaxZoom: 15 });
    map.addSource('sel', { type: 'geojson', data: VUOTO });
    map.addLayer({ id: 'gruppi', type: 'circle', source: 'stalli', filter: ['has', 'point_count'], paint: { 'circle-color': '#0b2a5b', 'circle-radius': ['step', ['get', 'point_count'], 17, 10, 21, 50, 25], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'gruppi-n', type: 'symbol', source: 'stalli', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 14, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
    map.addLayer({ id: 'pin', type: 'circle', source: 'stalli', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 15, 'circle-color': ['case', ['==', ['get', 'stato'], 'proposto'], '#ffffff', '#0b2a5b'], 'circle-stroke-color': ['case', ['==', ['get', 'stato'], 'proposto'], '#0b2a5b', '#ffffff'], 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'pin-i', type: 'symbol', source: 'stalli', filter: ['!', ['has', 'point_count']], layout: { 'icon-image': ['case', ['==', ['get', 'stato'], 'proposto'], 'wc-b', 'wc-w'], 'icon-size': 0.8, 'icon-allow-overlap': true } });
    map.addLayer({ id: 'sel', type: 'circle', source: 'sel', paint: { 'circle-radius': 23, 'circle-color': '#ffcc00', 'circle-stroke-color': '#0b1f44', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'sel-i', type: 'symbol', source: 'sel', layout: { 'icon-image': 'wc-d', 'icon-size': 1.15, 'icon-allow-overlap': true } });
    map.on('click', 'pin', (e) => apriScheda(e.features[0].properties.id));
    map.on('click', 'gruppi', (e) => { const f = e.features[0]; Promise.resolve(map.getSource('stalli').getClusterExpansionZoom(f.properties.cluster_id)).then((z) => map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z, 18) })); });
    pronta = true; map.setPadding(padHome()); disegna(); caricaVista();
  });
  map.on('error', (e) => { if (!pronta && e && e.error && /style|Failed to fetch|load/i.test(String(e.error.message))) toast('La mappa non si carica. Controlla la connessione.', 5000); });
  let pronta = false, moveT;
  map.on('dragstart', () => { seguo = false; });
  map.on('moveend', () => { clearTimeout(moveT); moveT = setTimeout(caricaVista, 300); });

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
    if (!ultimoCarico || dist(lat, lon, ultimoCarico.lat, ultimoCarico.lon) > 300) { ultimoCarico = { lat, lon }; carica(lat - 0.03, lon - 0.04, lat + 0.03, lon + 0.04, false); }
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
  function elencoVicini() {
    const c = map.getCenter(); const usoMe = me && dist(me.lat, me.lon, c.lat, c.lng) < 1500;
    const ref = usoMe ? me : { lat: c.lat, lon: c.lng };
    const tutti = []; for (const s of stalli.values()) if (passa(s)) { const d = dist(ref.lat, ref.lon, s.lat, s.lon); if (d < 5000) tutti.push({ s, d }); }
    tutti.sort((a, b) => a.d - b.d);
    const out = []; // niente doppioni a pochi metri l'uno dall'altro
    for (const x of tutti) { if (!out.some((y) => dist(x.s.lat, x.s.lon, y.s.lat, y.s.lon) < 25)) out.push(x); if (out.length === 3) break; }
    return { usoMe, out };
  }
  function vicini() {
    if (!pronta || dest) return;
    const el = $('#near-body');
    if (map.getZoom() < CFG.MIN_ZOOM_DATI) { el.innerHTML = '<div class="eyebrow">Mappa troppo lontana</div><div class="empty">Avvicinati con due dita per vedere i posti della zona.</div>'; return; }
    const { usoMe, out } = elencoVicini();
    if (!out.length) { el.innerHTML = `<div class="eyebrow">${usoMe ? 'Vicino a te' : 'In questa zona'}</div><div class="empty">Nessun posto qui${filtri.ver || filtri.cop || filtri.multi ? ' con questi filtri' : ''}. Sposta la mappa${filtri.ver || filtri.cop || filtri.multi ? ' o togli un filtro' : ''}.</div>`; return; }
    out.forEach((x) => trovaVia(x.s));
    const a = out[0], [cls, lab] = affidabilita(a.s), w = usoMe ? fmtWalk(a.d) : '';
    el.innerHTML = `<div class="eyebrow">${usoMe ? 'Il più vicino a te' : 'Il più vicino in questa zona'}</div>
      <button class="first" data-id="${esc(a.s.id)}"><span class="tile">${icon('wc')}</span><span class="t"><b>${esc(titolo(a.s))}</b><span>${[fmtDist(a.d), w, posti(a.s.posti)].filter(Boolean).join(' · ')}</span></span><span class="badge ${cls}">${lab}</span></button>
      <button class="primary" data-nav="${esc(a.s.id)}">${icon('nav')}<span>Portami lì</span></button>
      <div class="others">${out.slice(1).map((x) => `<button class="other" data-id="${esc(x.s.id)}"><span class="t"><b>${esc(titolo(x.s))}</b><span>${affidabilita(x.s)[1]} · ${posti(x.s.posti)}</span></span><span class="d">${fmtDist(x.d)}</span>${icon('chev')}</button>`).join('')}</div>`;
  }
  $('#near-body').addEventListener('click', (e) => {
    const n = e.target.closest('[data-nav]'); if (n) { naviga(stalli.get(n.dataset.nav)); return; }
    const b = e.target.closest('[data-id]'); if (b) apriScheda(b.dataset.id);
  });
  function naviga(s) { if (s) apri(`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`); }

  // ---------- scheda del posto ----------
  function apriScheda(id) {
    const s = stalli.get(id); if (!s) return;
    const eraAperta = !!selId; selId = id; disegna(); trovaVia(s);
    const [cls, lab] = affidabilita(s);
    $('#c-title').textContent = titolo(s);
    const d = me ? dist(me.lat, me.lon, s.lat, s.lon) : null;
    $('#c-sub').textContent = [s.comune, d != null ? fmtDist(d) + ' da te' : '', d != null ? fmtWalk(d) : ''].filter(Boolean).join(' · ');
    const fonte = s.stato === 'ufficiale' ? (s.fonte === 'opendata' ? 'Dato ufficiale del Comune' : 'Ufficiale') : lab;
    $('#c-badges').innerHTML = `<span class="badge ${cls}">${cls === 'uff' ? icon('shield') : ''}${fonte}</span><span class="badge">${posti(s.posti)}</span><span class="badge">Per tutti i contrassegni</span>${s.coperto ? '<span class="badge">Coperto</span>' : ''}`;
    const nota = (s.note || '').replace(/;?\s*Dato ufficiale[^;]*\(open data[^)]*\)/i, '').replace(/^Accorpato in [^.]*\.\s*/i, '').trim();
    $('#c-note').hidden = !nota; $('#c-note').textContent = nota ? nota.charAt(0).toUpperCase() + nota.slice(1) : '';
    $('#c-save').setAttribute('aria-pressed', salvati.has(id)); $('#c-save').querySelector('span').textContent = salvati.has(id) ? 'Salvato' : 'Salva';
    aggiornaConferma();
    mostra();
    seguo = false; map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 16.5), padding: { top: 90, bottom: $('#card .sheet').offsetHeight + 20, left: 0, right: 0 }, duration: 500 });
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
    if (App) App.addListener('backButton', () => { if (!$('#welcome').hidden) App.exitApp(); else if (!$('#search').hidden) chiudiRicerca(); else if (selId) chiudiScheda(true); else if (dest) chiudiDest(); else if (App.minimizeApp) App.minimizeApp(); else App.exitApp(); });
    else window.addEventListener('keydown', (e) => { if (e.key === 'Escape') chiudiScheda(true); });
  })();
  $('#c-close').onclick = () => chiudiScheda(false);
  $('#c-nav').onclick = () => naviga(stalli.get(selId));
  $('#c-street').onclick = () => { const s = stalli.get(selId); if (s) apri(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${s.lat},${s.lon}`); };
  $('#c-save').onclick = () => {
    const s = stalli.get(selId); if (!s) return;
    if (salvati.has(selId)) salvati.delete(selId); else salvati.set(selId, { id: s.id, lat: s.lat, lon: s.lon, t: titolo(s), c: s.comune || '' });
    ls.set('dp.salvati', [...salvati.values()]); const on = salvati.has(selId);
    $('#c-save').setAttribute('aria-pressed', on); $('#c-save').querySelector('span').textContent = on ? 'Salvato' : 'Salva'; toast(on ? 'Salvato tra i tuoi posti' : 'Tolto dai tuoi posti');
  };
  $('#c-share').onclick = async () => {
    const s = stalli.get(selId); if (!s) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`, text = `Posto riservato ai disabili: ${titolo(s)}${s.comune ? ', ' + s.comune : ''}`;
    const cap = window.Capacitor, Sh = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.Share;
    try {
      if (Sh) await Sh.share({ title: 'Disability Parking', text, url, dialogTitle: 'Condividi il posto' });
      else if (navigator.share) await navigator.share({ title: 'Disability Parking', text, url });
      else { await navigator.clipboard.writeText(text + ' ' + url); toast('Link copiato'); }
    } catch (e) { /* condivisione annullata */ }
  };
  $('#c-confirm').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-esito]'); const s = stalli.get(selId); if (!b || !s) return;
    try {
      const r = await fetch(`${CFG.SB}/rest/v1/conferme`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, H), body: JSON.stringify({ stallo_id: s.id, esito: b.dataset.esito, device_id: deviceId }) });
      if (!r.ok) throw new Error(r.status);
      const fatti = ls.get('dp.conf', {}); fatti[s.id] = b.dataset.esito; ls.set('dp.conf', fatti);
      if (b.dataset.esito === 'esiste') s.conferme_esiste = (s.conferme_esiste || 0) + 1;
      toast('Grazie! La tua risposta aiuta chi arriva dopo.'); aggiornaConferma();
    } catch (err) { toast('Non sono riuscito a inviare la risposta. Riprova.'); }
  });

  // ---------- barra in alto, filtri, pulsanti ----------
  document.querySelectorAll('.chip').forEach((c) => c.onclick = () => { const k = c.dataset.f; filtri[k] = !filtri[k]; c.setAttribute('aria-pressed', filtri[k]); disegna(); });
  $('#b-me').onclick = async () => {
    if (me) { seguo = true; map.easeTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 16), padding: padHome() }); return; }
    seguo = true; const ok = await attivaPosizione(true); if (!ok) toast('Per trovarti serve il permesso alla posizione. Lo trovi nelle impostazioni del telefono.', 4500);
  };
  const presto = () => toast('Arriva nella prossima versione di prova.');
  $('#b-search').onclick = () => apriRicerca(); $('#b-add').onclick = presto; $('#b-menu').onclick = presto;


  // ---------- schermata 4 · posti vicino alla destinazione ----------
  let lista = [], inCorso = -1, numMk = [], destMk = null;
  $('#a-r').value = String(raggio);
  async function vaiA(d) {
    dest = d; inCorso = -1; chiudiRicerca(); ricorda(d); $('#d-name').textContent = d.t; seguo = false; mostra();
    $('#a-count').textContent = 'Cerco i posti…'; $('#a-sub').textContent = ''; $('#a-list').innerHTML = ''; $('#a-nav').hidden = true; $('#a-hint').textContent = '';
    map.jumpTo({ center: [d.lon, d.lat], zoom: 16 });
    await carica(d.lat - 0.012, d.lon - 0.017, d.lat + 0.012, d.lon + 0.017, false); arrivo(true);
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
    $('#a-count').textContent = dentro.length ? posti(n) : 'Nessun posto';
    $('#a-sub').textContent = dentro.length ? 'In ordine di distanza dalla destinazione' : (tutti.length ? `Il più vicino è a ${fmtDist(tutti[0].d)}. Ecco i più vicini, anche se fuori raggio.` : 'Nessun posto nemmeno entro 1 km da qui.');
    const att = Math.max(0, Math.min(inCorso, lista.length - 1));
    $('#a-list').innerHTML = lista.map((x, i) => `<button class="arow${i === att ? ' on' : ''}" data-id="${esc(x.s.id)}"><span class="num">${i + 1}</span><span class="t"><b>${esc(titolo(x.s))}</b><span>${[affidabilita(x.s)[1], posti(x.s.posti), x.s.coperto ? 'coperto' : ''].filter(Boolean).join(' · ')}</span></span><span class="d">${fmtDist(x.d)}</span></button>`).join('');
    const prox = inCorso + 1 < lista.length ? inCorso + 1 : -1;
    $('#a-nav').hidden = !lista.length;
    $('#a-nav span').textContent = inCorso < 0 ? 'Portami al numero 1' : prox >= 0 ? `Occupato? Portami al numero ${prox + 1}` : 'Riapri il navigatore';
    $('#a-hint').textContent = inCorso < 0 && lista.length > 1 ? 'Se è occupato, con un tocco passi al numero 2.' : '';
    numMk.forEach((m) => m.remove()); numMk = []; if (destMk) destMk.remove();
    const de = document.createElement('div'); de.className = 'mdest'; de.innerHTML = icon('flag'); destMk = new maplibregl.Marker({ element: de }).setLngLat([dest.lon, dest.lat]).addTo(map);
    lista.forEach((x, i) => { const el = document.createElement('div'); el.className = 'mnum' + (i === att ? ' on' : ''); el.textContent = i + 1; el.onclick = (e) => { e.stopPropagation(); apriScheda(x.s.id); }; numMk.push(new maplibregl.Marker({ element: el }).setLngLat([x.s.lon, x.s.lat]).addTo(map)); trovaVia(x.s); });
    if (inquadra) {
      const b = new maplibregl.LngLatBounds([dest.lon, dest.lat], [dest.lon, dest.lat]); lista.slice(0, 5).forEach((x) => b.extend([x.s.lon, x.s.lat]));
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // fitBounds somma il suo margine a quello già impostato
      map.fitBounds(b, { padding: { top: 110, bottom: $('#arrivo').offsetHeight + 40, left: 50, right: 50 }, maxZoom: 17, duration: 500 });
    }
  }
  function chiudiDest() { dest = null; numMk.forEach((m) => m.remove()); numMk = []; if (destMk) destMk.remove(); destMk = null; mostra(); map.easeTo({ padding: padHome(), duration: 300 }); vicini(); }
  $('#d-back').onclick = chiudiDest;
  $('#a-r').onchange = () => { raggio = +$('#a-r').value; ls.set('dp.raggio', raggio); inCorso = -1; arrivo(true); };
  $('#a-list').addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) apriScheda(b.dataset.id); });
  $('#a-nav').onclick = () => { if (!lista.length) return; if (inCorso + 1 < lista.length) inCorso++; naviga(lista[inCorso].s); setTimeout(() => arrivo(false), 600); };

  // ---------- schermata 3 · ricerca ----------
  let sCtl, sT, scelgo = null; // scelgo: 'casa' o 'lavoro' mentre si imposta la scorciatoia
  const luoghi = () => ls.get('dp.luoghi', {});
  function ricorda(d) { const r = ls.get('dp.recenti', []).filter((x) => x.t !== d.t); r.unshift({ t: d.t, sub: d.sub || '', lat: d.lat, lon: d.lon }); ls.set('dp.recenti', r.slice(0, 5)); }
  function apriRicerca() { $('#search').hidden = false; $('#s-q').value = ''; $('#s-x').hidden = true; scelgo = null; inizio(); setTimeout(() => $('#s-q').focus(), 60); }
  function chiudiRicerca() { $('#search').hidden = true; $('#s-q').blur(); if (sCtl) sCtl.abort(); }
  function chipStato() { document.querySelectorAll('.s-chips button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === scelgo)); $('#s-q').placeholder = scelgo ? `Cerca l'indirizzo ${scelgo === 'casa' ? 'di casa' : 'del lavoro'}` : 'Via, luogo o città'; }
  function inizio() {
    chipStato(); const r = ls.get('dp.recenti', []);
    $('#s-body').innerHTML = (scelgo ? `<div class="empty">Scrivi l'indirizzo e toccalo: lo ritrovi qui sopra con un tocco.</div>` : '') +
      (r.length ? '<div class="eyebrow">Cercati di recente</div>' + r.map((x, i) => `<button class="res rec" data-rec="${i}"><span class="mk">${icon('clock')}</span><span class="t"><b>${esc(x.t)}</b></span></button>`).join('') : (scelgo ? '' : '<div class="empty">Scrivi dove stai andando: ti mostro i posti riservati lì attorno.</div>'));
  }
  function etichetta(p) { const via = [p.street, p.housenumber].filter(Boolean).join(' '), t = p.name || via || p.city || ''; return { t, sub: [p.name && via, p.city !== t && p.city, p.county].filter(Boolean).join(', ') }; }
  let risultati = [];
  async function cerca(q) {
    if (sCtl) sCtl.abort(); sCtl = new AbortController(); const c = me ? [me.lon, me.lat] : [map.getCenter().lng, map.getCenter().lat];
    try {
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lat=${c[1]}&lon=${c[0]}&bbox=6.6,35.4,18.6,47.2`, { signal: sCtl.signal });
      const j = await r.json();
      risultati = j.features.filter((f) => (f.properties.countrycode || 'IT') === 'IT').slice(0, 6).map((f) => Object.assign({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }, etichetta(f.properties))).filter((x) => x.t);
      if (!risultati.length) { $('#s-body').innerHTML = '<div class="empty">Non trovo questo posto. Prova con la via e la città.</div>'; return; }
      $('#s-body').innerHTML = '<div class="eyebrow">Risultati</div>' + risultati.map((x, i) => `<div data-box="${i}"><button class="res" data-res="${i}"><span class="mk">${icon('pin')}</span><span class="t"><b>${esc(x.t)}</b><span>${esc(x.sub)}</span></span>${scelgo ? '' : '<span class="n wait">…</span>'}</button></div>`).join('');
      if (!scelgo) risultati.forEach((x, i) => conta(x, i, sCtl.signal));
    } catch (e) { if (e.name !== 'AbortError') $('#s-body').innerHTML = '<div class="empty">La ricerca non risponde. Controlla la connessione e riprova.</div>'; }
  }
  async function conta(x, i, signal) { // quanti posti ci sono attorno a un risultato; se nessuno, propone il più vicino
    await carica(x.lat - 0.012, x.lon - 0.017, x.lat + 0.012, x.lon + 0.017, false);
    const box = document.querySelector(`[data-box="${i}"]`); if (signal.aborted || !box) return;
    const tutti = attorno(x.lat, x.lon), dentro = tutti.filter((y) => y.d <= raggio), n = dentro.reduce((a, y) => a + (y.s.posti || 1), 0), b = box.querySelector('.n');
    if (dentro.length) { b.className = 'n'; b.textContent = posti(n); return; }
    b.remove(); const rg = raggio >= 1000 ? '1 km' : raggio + ' m';
    const d = document.createElement('div'); d.className = 'lontano';
    if (tutti.length) { const v = tutti[0]; trovaVia(v.s); d.innerHTML = `<div><b>Nessun posto entro ${rg}.</b> Il più vicino è a ${fmtDist(v.d)}${v.s.indirizzo ? ', in ' + esc(v.s.indirizzo) : ''}.</div><button data-nav="${esc(v.s.id)}">${icon('nav')}<span>Portami lì</span></button>`; }
    else d.innerHTML = '<div><b>Nessun posto entro 1 km.</b> Qui la mappa è ancora vuota.</div>';
    box.appendChild(d);
  }
  $('#s-q').addEventListener('input', () => { const q = $('#s-q').value.trim(); $('#s-x').hidden = !q; clearTimeout(sT); if (q.length < 3) { if (sCtl) sCtl.abort(); inizio(); return; } sT = setTimeout(() => cerca(q), 350); });
  $('#s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#s-q').blur(); } });
  $('#s-x').onclick = () => { $('#s-q').value = ''; $('#s-x').hidden = true; inizio(); $('#s-q').focus(); };
  $('#s-back').onclick = chiudiRicerca;
  function scegli(x) {
    if (scelgo) { const l = luoghi(); l[scelgo] = { t: x.t, sub: x.sub || '', lat: x.lat, lon: x.lon }; ls.set('dp.luoghi', l); toast(`${scelgo === 'casa' ? 'Casa' : 'Lavoro'} impostato: ${x.t}`); scelgo = null; }
    vaiA(x);
  }
  async function apriSalvato(id) {
    const v = salvati.get(id); chiudiRicerca();
    if (!stalli.has(id)) { try { const r = await fetch(`${CFG.SB}/rest/v1/stalli_con_conferme?select=${SEL}&id=eq.${encodeURIComponent(id)}`, { headers: H }); const j = await r.json(); if (j[0]) stalli.set(id, j[0]); } catch (e) { /* sotto */ } }
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
    if (l && scelgo !== k) { vaiA(l); return; }
    scelgo = scelgo === k ? null : k; $('#s-q').value = ''; $('#s-x').hidden = true; inizio(); $('#s-q').focus();
  });

  // ---------- primo avvio ----------
  if (!ls.get('dp.benvenuto', false)) $('#welcome').hidden = false; else attivaPosizione(false);
  const entra = () => { ls.set('dp.benvenuto', true); $('#welcome').hidden = true; };
  $('#w-go').onclick = async () => { entra(); const ok = await attivaPosizione(true); if (!ok) toast('Posizione non attiva: puoi muovere la mappa a mano.', 4000); };
  $('#w-skip').onclick = entra;
})();
