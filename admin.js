(function () {
  // il server restituisce al massimo 1000 righe per richiesta: scarico a pagine
  // (6 pagine alla volta in parallelo: con tutta Italia gli stalli sono decine di migliaia)
  async function fetchAll(mk) {
    const out = []; let i = 0, done = false, err = null;
    while (!done && !err) {
      const batch = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => mk().range(i + k * 1000, i + k * 1000 + 999)));
      for (const { data, error } of batch) { if (error) { err = error; break; } out.push(...data); if (data.length < 1000) { done = true; break; } }
      i += 6000;
    }
    return err ? { data: out, error: err } : { data: out };
  }
  'use strict';
  const C = window.DP_CONFIG; const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const TIPO = { generico: 'Generico', personalizzato: 'Personalizzato', sconosciuto: 'Sconosciuto' };
  let rows = [], filter = 'utenti', sel = null, map, layer, markers = new Map();

  // ---------- auth ----------
  async function session() { const { data } = await sb.auth.getSession(); return data.session; }
  async function boot() { const s = await session(); if (s) { $('#login').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false; initMap(); load(); loadCands(); } }
  $('#l-in').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : ''; if (!error) boot(); };
  $('#l-up').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signUp({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : 'Registrazione inviata: se Supabase richiede la conferma, controlla la posta e poi premi "Entra".'; };
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };

  // ---------- mappa ----------
  function initMap() {
    if (map) return;
    map = L.map('amap').setView([C.HOME.lat, C.HOME.lon], 13);
    bases.osm.addTo(map); curBase = 'osm';
    layer = L.layerGroup().addTo(map); candLayer = L.layerGroup().addTo(map);
    let mvT; map.on('moveend', () => { clearTimeout(mvT); mvT = setTimeout(() => { if (rows.length) drawPins(); }, 200); });
    document.querySelectorAll('input[name=base]').forEach((r) => r.onchange = () => setBase(r.value));
    
  }
  // livelli di base: strade, satellite Esri, TrueOrtofoto FVG 2020 (WMS regionale, 10-20 cm/px)
  const CRS900913 = L.extend({}, L.CRS.EPSG3857, { code: 'EPSG:900913' });
  const bases = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' }),
    esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Esri, Maxar' }),
    fvg: L.tileLayer.wms('https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows', { layers: 'trueorto_FVG_1720', format: 'image/jpeg', version: '1.1.1', crs: CRS900913, maxZoom: 22, tileSize: 512, attribution: 'TrueOrtofoto 2020 © Regione FVG / Insiel' })
  };
  let curBase = 'osm', candLayer;
  function setBase(k) { if (k === curBase || !bases[k]) return; map.removeLayer(bases[curBase]); bases[k].addTo(map).bringToBack(); curBase = k; document.querySelectorAll('input[name=base]').forEach((r) => r.checked = r.value === k); }
  function pinClass(s) { return s.stato === 'proposto' ? 'proposto' : s.tipo; }
  function icon(s, on) { return L.divIcon({ className: '', html: `<div class="pin ${pinClass(s)}${on ? ' sel' : ''}"><b>${s.posti > 1 ? s.posti : '♿'}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }); }

  // ---------- dati ----------
  let tutti = false; // true quando sono arrivati tutti gli stalli, non solo le segnalazioni
  async function load() {
    kpiFast();
    if (!rows.length) { // le segnalazioni degli utenti arrivano subito, senza aspettare tutti gli stalli
      $('#rows').innerHTML = '<div class="empty">Carico gli stalli…</div>';
      const u = await sb.from('stalli_con_conferme').select('*').eq('fonte', 'utente').eq('stato', 'proposto').order('created_at', { ascending: false });
      if (!u.error && !tutti) { rows = u.data; render(); }
    }
    const { data, error } = await fetchAll(() => sb.from('stalli_con_conferme').select('*').order('created_at', { ascending: false }).order('id'));
    if (error) { $('#rows').innerHTML = `<div class="empty">Errore: ${esc(error.message)} (sei registrato come admin? controlla la tabella admins)</div>`; return; }
    rows = data; tutti = true; if (sel) sel = rows.find((r) => r.id === sel.id) || sel; kpi(); render(); if (cands.length) renderCands();
  }
  // conteggi subito dal server, senza aspettare di aver scaricato tutti gli stalli
  async function kpiFast() {
    const c = async (f) => { const { count } = await f(sb.from('stalli_con_conferme').select('id', { count: 'exact', head: true })); return count ?? '…'; };
    const [s0, p, v, u, x, t] = await Promise.all([c((q) => q.eq('stato', 'proposto').eq('fonte', 'utente')), c((q) => q.eq('stato', 'proposto')), c((q) => q.eq('stato', 'verificato')), c((q) => q.eq('stato', 'ufficiale')),
      c((q) => q.gt('conferme_non_esiste', 0).neq('stato', 'rifiutato')), c((q) => q.in('stato', ['proposto', 'verificato', 'ufficiale']))]);
    if (!tutti) $('#kpi').innerHTML = [['Segnalazioni utenti', s0], ['Da approvare', p], ['Verificati', v], ['Ufficiali', u], ['Con "non esiste"', x], ['Totale attivi', t]].map((k) => `<div>${k[0]}<b>${k[1]}</b></div>`).join('');
  }
  function kpi() {
    const n = (st) => rows.filter((r) => r.stato === st).length;
    $('#kpi').innerHTML = [['Segnalazioni utenti', rows.filter((r) => r.fonte === 'utente' && r.stato === 'proposto').length], ['Da approvare', n('proposto')], ['Verificati', n('verificato')], ['Ufficiali', n('ufficiale')], ['Con "non esiste"', rows.filter((r) => r.conferme_non_esiste > 0 && r.stato !== 'rifiutato').length], ['Totale attivi', rows.filter((r) => ['proposto', 'verificato', 'ufficiale'].includes(r.stato)).length]].map((k) => `<div>${k[0]}<b>${k[1]}</b></div>`).join('');
  }
  document.querySelectorAll('.tabs .btn').forEach((b) => b.onclick = () => { document.querySelectorAll('.tabs .btn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); filter = b.dataset.f; render(); });
  function visible() { return filter === 'utenti' ? rows.filter((r) => r.fonte === 'utente' && r.stato === 'proposto') : filter === 'segnalati' ? rows.filter((r) => r.conferme_non_esiste > 0 && r.stato !== 'rifiutato') : rows.filter((r) => r.stato === filter); }
  function render() {
    const v = visible();
    $('#rows').innerHTML = v.length ? v.slice(0, 300).map((r) => `<div class="row-item${sel && sel.id === r.id ? ' sel' : ''}" data-id="${r.id}">
      <div><div class="n">${esc(r.nome || r.indirizzo || TIPO[r.tipo])} · ${r.posti} ${r.posti > 1 ? 'posti' : 'posto'}</div>
      <div class="s">${TIPO[r.tipo]} · ${r.comune || '—'} · ${r.fonte} · ${new Date(r.created_at).toLocaleDateString('it-IT')}${r.conferme_esiste ? ` · ✓${r.conferme_esiste}` : ''}${r.conferme_non_esiste ? ` · ✗${r.conferme_non_esiste}` : ''}${r.foto_url ? ' · 📷' : ''}</div></div>
      <div class="s">${r.stato}</div></div>`).join('') : `<div class="empty">${filter === 'utenti' ? 'Nessuna segnalazione degli utenti da controllare.' : 'Niente qui.'}</div>`;
    if (v.length && !sel && v.length <= 2000) map.fitBounds(v.map((r) => [r.lat, r.lon]), { padding: [20, 20], maxZoom: 15 });
    drawPins();
  }
  // sulla mappa solo i pin della zona visibile (max 1500), ridisegnati quando sposti la mappa
  function drawPins() {
    layer.clearLayers(); markers.clear(); const b = map.getBounds().pad(0.2); let n = 0;
    for (const r of visible()) {
      const isSel = sel && sel.id === r.id;
      if (!isSel && (!b.contains([r.lat, r.lon]) || n >= 1500)) continue; n++;
      const m = L.marker([r.lat, r.lon], { icon: icon(r, isSel) }); m.on('click', () => select(r.id)); layer.addLayer(m); markers.set(r.id, m);
    }
  }
  $('#rows').addEventListener('click', (e) => { const it = e.target.closest('.row-item'); if (it) select(it.dataset.id); });

  // ---------- modifica ----------
  function select(id) {
    sel = rows.find((r) => r.id === id); if (!sel) return;
    render(); map.setView([sel.lat, sel.lon], Math.max(map.getZoom(), 17));
    const s = sel;
    $('#edit').innerHTML = `
      <div class="badges"><span class="badge ${s.tipo}">${TIPO[s.tipo]}</span><span class="badge ${s.stato}">${s.stato}</span><span class="badge osm">${s.fonte}</span></div>
      ${s.foto_url ? `<a href="${s.foto_url}" target="_blank"><img src="${s.foto_url}" alt="foto"></a>` : ''}
      <div class="sub">${s.lat.toFixed(6)}, ${s.lon.toFixed(6)} · <a target="_blank" href="https://www.google.com/maps?q=${s.lat},${s.lon}&layer=c&cbll=${s.lat},${s.lon}">Street View</a> · <a target="_blank" href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=19/${s.lat}/${s.lon}">OSM</a>${s.osm_url ? ` · <a target="_blank" href="${s.osm_url}">oggetto OSM</a>` : ''}</div>
      <div class="sub">Conferme: esiste ${s.conferme_esiste} · non esiste ${s.conferme_non_esiste}${s.ultima_conferma ? ' · ultima ' + new Date(s.ultima_conferma).toLocaleString('it-IT') : ''}</div>
      <div class="field two">
        <label>Tipo<select id="e-tipo">${Object.keys(TIPO).map((k) => `<option value="${k}"${s.tipo === k ? ' selected' : ''}>${TIPO[k]}</option>`).join('')}</select></label>
        <label>Posti<input type="number" id="e-posti" min="1" value="${s.posti}"></label>
      </div>
      <div class="field two">
        <label>Nome<input type="text" id="e-nome" value="${esc(s.nome)}"></label>
        <label>Comune<input type="text" id="e-comune" value="${esc(s.comune)}"></label>
      </div>
      <label class="field">Indirizzo<input type="text" id="e-ind" value="${esc(s.indirizzo)}"></label>
      <label class="field">Orari<input type="text" id="e-orari" value="${esc(s.orari)}"></label>
      <label class="field">Note<textarea id="e-note" rows="2">${esc(s.note)}</textarea></label>
      <div class="field two">
        <label>Segnale verticale<select id="e-seg"><option value=""${s.segnale_verticale == null ? ' selected' : ''}>Non so</option><option value="true"${s.segnale_verticale === true ? ' selected' : ''}>Sì</option><option value="false"${s.segnale_verticale === false ? ' selected' : ''}>No</option></select></label>
        <label>Coperto<select id="e-cop"><option value="false"${!s.coperto ? ' selected' : ''}>No</option><option value="true"${s.coperto ? ' selected' : ''}>Sì</option></select></label>
      </div>
      <div class="acts">
        <button class="btn primary" data-st="verificato">✓ Approva (verificato)</button>
        <button class="btn" data-st="ufficiale">Segna ufficiale</button>
        <button class="btn danger" data-st="rifiutato">✗ Rifiuta</button>
        <button class="btn danger" data-st="rimosso">Rimosso dalla strada</button>
        <button class="btn" id="e-save">Salva modifiche</button>
        <button class="btn" id="e-move">Sposta sul centro mappa</button>
      </div>
      <div class="sub" id="e-msg"></div>`;
    $('#edit').querySelectorAll('[data-st]').forEach((b) => b.onclick = () => {
      const extra = { stato: b.dataset.st };
      if (sel.fonte === 'utente' && b.dataset.st === 'rifiutato') { // il motivo lo legge chi ha fatto la segnalazione, in "Le mie segnalazioni"
        const m = prompt('Motivo del rifiuto (lo vedrà chi ha fatto la segnalazione). Lascia vuoto per non indicarlo.', sel.motivo_rifiuto || '');
        if (m === null) return; extra.motivo_rifiuto = m.trim() || null;
      }
      save(extra);
    });
    $('#e-save').onclick = () => save({});
    $('#e-move').onclick = () => { const c = map.getCenter(); save({ lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6) }); };
  }
  function formValues() {
    const seg = $('#e-seg').value;
    return { tipo: $('#e-tipo').value, posti: +$('#e-posti').value || 1, nome: $('#e-nome').value.trim() || null, comune: $('#e-comune').value.trim() || null, indirizzo: $('#e-ind').value.trim() || null,
      orari: $('#e-orari').value.trim() || null, note: $('#e-note').value.trim() || null, segnale_verticale: seg === '' ? null : seg === 'true', coperto: $('#e-cop').value === 'true' };
  }
  async function save(extra) {
    const patch = Object.assign(formValues(), extra); $('#e-msg').textContent = 'Salvo…';
    let { error } = await sb.from('stalli').update(patch).eq('id', sel.id);
    if (error && 'motivo_rifiuto' in patch && /motivo_rifiuto/.test(error.message)) { delete patch.motivo_rifiuto; ({ error } = await sb.from('stalli').update(patch).eq('id', sel.id)); if (!error) alert('Rifiutato, ma il motivo non è stato salvato: manca ancora la colonna nel database (file supabase/08_mie_segnalazioni.sql).'); }
    if (error) { $('#e-msg').textContent = 'Errore: ' + error.message; return; }
    Object.assign(sel, patch); const inLista = rows.find((r) => r.id === sel.id); if (inLista && inLista !== sel) Object.assign(inLista, patch); $('#e-msg').textContent = 'Salvato ' + new Date().toLocaleTimeString('it-IT'); kpi(); render();
  }
  // ---------- import da OpenStreetMap (dal browser dell'admin) ----------
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const ilog = (m) => { const l = $('#i-log'); l.textContent += m + '\n'; l.scrollTop = l.scrollHeight; };
  function osmQuery(bb) { // bb = "sud,ovest,nord,est"
    return `[out:json][timeout:60];(
      nwr["amenity"="parking_space"]["parking_space"="disabled"](${bb});
      nwr["amenity"="parking_space"]["disabled"~"^(yes|designated)$"](${bb});
      nwr["amenity"="parking"]["capacity:disabled"](${bb});
      nwr["amenity"="parking"]["disabled"~"^(yes|designated)$"](${bb}););out center tags;`;
  }

  let stopReq = false, activeCtl = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checkStop = () => { if (stopReq) throw new Error('Interrotto dall\'utente'); };
  async function overpassOnce(url, bb, timeoutMs, query) {
    const ctl = new AbortController(); activeCtl = ctl; const to = setTimeout(() => ctl.abort(), timeoutMs); const t0 = Date.now();
    try {
      checkStop();
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query || osmQuery(bb)), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.remark && /timed out|error/i.test(j.remark)) throw new Error('server: ' + j.remark.slice(0, 80));
      return { els: j.elements, ms: Date.now() - t0 };
    } catch (e) { if (stopReq) throw new Error('Interrotto dall\'utente'); if (e.name === 'AbortError') throw new Error(`nessuna risposta entro ${Math.round(timeoutMs / 1000)} s`); throw e; }
    finally { clearTimeout(to); activeCtl = null; }
  }
  async function overpassFetch(bb, query, logFn) {
    const L_ = logFn || ilog; let lastErr = null;
    for (let round = 0; round < 3; round++) {
      for (const url of OVERPASS) {
        const host = new URL(url).host;
        try { const { els, ms } = await overpassOnce(url, bb, round === 0 ? 45000 : 75000, query); L_(`    ${host}: ${els.length} elementi in ${Math.round(ms / 1000)} s`); return els; }
        catch (e) { if (stopReq) throw e; lastErr = e; L_(`    ${host}: ${e.message}`); if (/HTTP 429|HTTP 50/.test(e.message)) await sleep(4000); }
      }
      checkStop();
      const wait = 20 * (round + 1); L_(`  tutti i server occupati: riprovo tra ${wait} s (tentativo ${round + 2}/3)…`); for (let t = 0; t < wait; t++) { checkStop(); await sleep(1000); }
    }
    throw lastErr || new Error('Nessun server Overpass ha risposto');
  }
  function osmConvert(el, comune) {
    const t = el.tags || {}; const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon; if (lat == null) return null;
    const capDis = parseInt(t['capacity:disabled']); let posti, nome, note = null;
    if (t.amenity === 'parking') {
      if (t['capacity:disabled'] != null && !(capDis > 0)) return null;
      posti = capDis || 1; nome = t.name || 'Parcheggio con posti riservati'; note = 'Area di parcheggio: i posti riservati sono all\'interno.';
    } else { posti = capDis || parseInt(t.capacity) || 1; nome = t.name || null; note = t.description || t.note || null; }
    const desc = [t.description, t.note, t['access:note'], t.ref].join(' ').toLowerCase();
    const tipo = /contrassegno|personalizz|nominativ|ad personam/.test(desc) ? 'personalizzato' : 'generico';
    return { osm_id: `${el.type}/${el.id}`, lat, lon, tipo, posti: Math.max(1, posti), nome, indirizzo: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ') || null,
      comune, note, orari: t.opening_hours || t['access:conditional'] || null, segnale_verticale: t.traffic_sign ? true : null,
      coperto: t.covered === 'yes' || ['multi-storey', 'underground'].includes(t.parking), stato: 'verificato', fonte: 'osm', osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}` };
  }


  // ======================================================================
  // CANDIDATI AUTOMATICI — Mapillary (cartelli riconosciuti) + ortofoto
  // ======================================================================
  const MLY_CLASSES = ['information--disabled-persons--g1', 'information--disabled-persons--g2', 'information--disabled-persons--g3', 'complementary--disabled-persons--g1', 'regulatory--reserved-parking--g1'];
  const CLASSE_LABEL = { 'information--disabled-persons--g1': 'Pannello "disabili"', 'information--disabled-persons--g2': 'Pannello "disabili"', 'information--disabled-persons--g3': 'Pannello "disabili"', 'complementary--disabled-persons--g1': 'Pannello integrativo "disabili"', 'regulatory--reserved-parking--g1': 'Parcheggio riservato' };
  let cands = [], cfilter = 'nuovo', csel = null, cmarker = null;
  const distM = (a, b) => map.distance([a.lat, a.lon], [b.lat, b.lon]);

  async function loadCands() {
    const { data, error } = await fetchAll(() => sb.from('candidati').select('*').order('created_at', { ascending: false }).order('id'));
    if (error) { $('#cand-rows').innerHTML = `<div class="empty">Errore: ${esc(error.message)} — hai eseguito supabase/03_candidati.sql?</div>`; return; }
    cands = data; renderCands();
  }
  document.querySelectorAll('[data-cf]').forEach((b) => b.onclick = () => { document.querySelectorAll('[data-cf]').forEach((x) => x.classList.remove('active')); b.classList.add('active'); cfilter = b.dataset.cf; renderCands(); });
  function cicon(c, on) { return L.divIcon({ className: '', html: `<div class="pin proposto${on ? ' sel' : ''}" style="background:#7c3aed"><b>?</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }); }
  // punteggio di confidenza della rete (dal testo "punteggio N%"); i candidati senza punteggio vanno in fondo
  const score = (c) => { const m = /punteggio (\d+)%/.exec(c.classe || ''); return m ? +m[1] : -1; };
  const AUTO = 'Confermato in automatico';
  // indice degli stalli per id: cercarli uno a uno tra decine di migliaia a ogni clic rendeva lenta la verifica
  let idxRows = null, idxN = -1, idx = new Map();
  const rowById = (id) => { if (idxRows !== rows || idxN !== rows.length) { idx = new Map(rows.map((r) => [r.id, r])); idxRows = rows; idxN = rows.length; } return idx.get(id); };
  const stOf = (c) => c.stallo_id && rowById(c.stallo_id);
  const isAutoTodo = (c) => { if (c.stato !== 'accettato') return false; const st = stOf(c); return !!(st && (st.note || '').startsWith(AUTO) && !/controllato/.test(st.note) && st.stato === 'verificato'); };
  const inView = (c) => cfilter === 'auto' ? isAutoTodo(c) : c.stato === cfilter;
  const candView = () => cands.filter(inView).sort((a, b) => score(b) - score(a) || String(b.created_at).localeCompare(String(a.created_at)));
  function renderCands() {
    const v = candView();
    $('#cand-count').textContent = `· ${cands.filter((c) => c.stato === 'nuovo').length} da verificare · ${cands.filter(isAutoTodo).length} automatici da controllare`;
    $('#cand-rows').innerHTML = v.length ? v.slice(0, 300).map((c) => `<div class="row-item${csel && csel.id === c.id ? ' sel' : ''}" data-cid="${c.id}">
      <div><div class="n">${esc(CLASSE_LABEL[c.classe] || c.classe)}</div><div class="s">${esc(c.comune || '')} · visto ${c.last_seen ? new Date(c.last_seen).toLocaleDateString('it-IT') : '—'} · ${c.fonte}</div></div><div class="s">${c.stato}</div></div>`).join('') : '<div class="empty">Nessun candidato in questo stato.</div>';
    candLayer.clearLayers();
    v.forEach((c) => { const m = L.marker([c.lat, c.lon], { icon: cicon(c, csel && csel.id === c.id) }); m.on('click', () => selectCand(c.id)); candLayer.addLayer(m); });
  }
  $('#cand-rows').addEventListener('click', (e) => { const it = e.target.closest('[data-cid]'); if (it) selectCand(it.dataset.cid); });

  // dopo Accetta / Scarta / Salta: apre il prossimo candidato ancora da controllare nello stesso elenco
  const skipped = new Set();
  function goNext(fromId, order, msg) {
    const i = order.indexOf(fromId);
    const seq = order.slice(i + 1).concat(order.slice(0, Math.max(i, 0)));
    const ok = (id) => { const x = cands.find((y) => y.id === id); return x && inView(x) && id !== fromId; };
    const next = seq.find((id) => ok(id) && !skipped.has(id)) || seq.find(ok);
    if (next) { selectCand(next).then(() => { const m = $('#c-msg'); if (m && msg) m.textContent = msg + ' Ecco il prossimo.'; }); return; }
    csel = null; if (cmarker) { map.removeLayer(cmarker); cmarker = null; }
    renderCands(); $('#cand-edit').innerHTML = `<div class="empty">${esc(msg || '')} Finito: non ci sono altri candidati in questo elenco. 🎉</div>`;
  }
  document.addEventListener('keydown', (e) => {
    if (!csel || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''))) return;
    const k = e.key.toLowerCase(); const b = k === 'a' ? ($('#c-ok') ? '#c-ok' : '#c-accept') : k === 'x' ? ($('#c-bad') ? '#c-bad' : '#c-reject') : k === 's' ? '#c-skip' : null;
    if (b && $(b)) { e.preventDefault(); $(b).click(); }
  });
  async function selectCand(id) {
    csel = cands.find((c) => c.id === id); if (!csel) return; const c = csel;
    const order = candView().map((x) => x.id); // ordine dell'elenco al momento dell'apertura
    renderCands(); $('#cand-box').open = true;
    if (cmarker) map.removeLayer(cmarker);
    cmarker = L.marker([c.lat, c.lon], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="pin generico sel"><b>♿</b></div>', iconSize: [30, 30], iconAnchor: [15, 30] }), zIndexOffset: 2000 }).addTo(map);
    map.setView([c.lat, c.lon], 20); setBase('fvg');
    const near = rows.filter((r) => r.stato !== 'rifiutato' && Math.abs(r.lat - c.lat) < 0.0005 && Math.abs(r.lon - c.lon) < 0.0008 && distM(r, c) <= 40);
    $('#cand-edit').innerHTML = `
      <div class="badges"><span class="badge proposto" style="background:#7c3aed">${esc(CLASSE_LABEL[c.classe] || c.classe)}</span><span class="badge osm">${c.fonte}</span><span class="badge osm">${c.stato}</span></div>
      <div class="sub">${c.lat.toFixed(6)}, ${c.lon.toFixed(6)} · visto dal ${c.first_seen ? new Date(c.first_seen).toLocaleDateString('it-IT') : '—'} al ${c.last_seen ? new Date(c.last_seen).toLocaleDateString('it-IT') : '—'}
        · <a target="_blank" href="https://www.mapillary.com/app/?lat=${c.lat}&lng=${c.lon}&z=18${c.image_id ? '&pKey=' + c.image_id : ''}">Apri in Mapillary</a>
        · <a target="_blank" href="https://www.google.com/maps?q=${c.lat},${c.lon}&layer=c&cbll=${c.lat},${c.lon}">Street View</a></div>
      ${near.length ? `<div class="warn">Attenzione: ${near.length} stallo/i già presenti entro 40 m (${near.map((n) => esc(n.nome || n.indirizzo || n.tipo)).join(', ')}). Forse è lo stesso.</div>` : ''}
      ${c.fonte === 'satellite' && c.note && /^https?:/.test(c.note) ? `<a href="${c.note}" target="_blank"><img src="${c.note}" alt="ritaglio ortofoto" style="width:100%;max-width:360px;border-radius:12px;image-rendering:auto"></a><div class="sub">Ritaglio dell'ortofoto attorno al candidato.</div>` : (c.image_id ? `<div class="sub"><a target="_blank" href="https://www.mapillary.com/app/?pKey=${c.image_id}">Foto Mapillary</a></div>` : '')}
      <div class="sub">Sulla mappa (ortofoto) trascina il segnaposto esattamente sullo stallo prima di accettare: il cartello è di solito a pochi metri dallo stallo.</div>
      <div class="field two">
        <label>Tipo<select id="c-tipo"><option value="generico">Generico</option><option value="personalizzato">Personalizzato</option><option value="sconosciuto">Sconosciuto</option></select></label>
        <label>Posti<input type="number" id="c-posti" min="1" value="1"></label>
      </div>
      <label class="field">Note<input type="text" id="c-note" placeholder="es. davanti al civico 12"></label>
      <div class="acts">
        <button class="btn primary" id="c-accept">✓ Accetta: crea stallo qui</button>
        <button class="btn danger" id="c-reject">✗ Scarta</button>
        <button class="btn" id="c-skip">Salta ›</button>
        <button class="btn" id="c-reset">Torna "nuovo"</button>
      </div>
      <div class="sub">Dopo Accetta, Scarta o Salta si apre da solo il prossimo da controllare. Tasti: A accetta · X scarta · S salta.</div>
      <div class="sub" id="c-msg"></div>`;
    $('#c-accept').onclick = async () => {
      const p = cmarker.getLatLng();
      const rec = { lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6), tipo: $('#c-tipo').value, posti: +$('#c-posti').value || 1, note: $('#c-note').value.trim() || null, comune: c.comune, stato: 'verificato', fonte: c.fonte, segnale_verticale: c.fonte === 'mapillary' ? true : null, nome: null };
      $('#c-msg').textContent = 'Creo lo stallo…';
      const { data, error } = await sb.from('stalli').insert(rec).select().single();
      if (error) { $('#c-msg').textContent = 'Errore: ' + error.message; return; }
      sb.from('candidati').update({ stato: 'accettato', stallo_id: data.id }).eq('id', c.id).then((r) => { if (r.error) alert('Stallo creato, ma il candidato non è stato aggiornato: ' + r.error.message); }); // non aspetto la risposta per passare al prossimo
      c.stato = 'accettato'; c.stallo_id = data.id;
      rows.unshift(Object.assign({ conferme_esiste: 0, conferme_non_esiste: 0, ultima_conferma: null }, data)); if (tutti) kpi(); // aggiungo lo stallo all'elenco senza riscaricare tutto
      goNext(c.id, order, 'Stallo creato.');
    };
    $('#c-reject').onclick = async () => {
      $('#c-msg').textContent = 'Scarto…';
      const { error } = await sb.from('candidati').update({ stato: 'scartato' }).eq('id', c.id);
      if (error) { $('#c-msg').textContent = 'Errore: ' + error.message; return; }
      c.stato = 'scartato'; goNext(c.id, order, 'Scartato.');
    };
    $('#c-skip').onclick = () => { skipped.add(c.id); goNext(c.id, order, 'Saltato.'); };
    $('#c-reset').onclick = async () => { await sb.from('candidati').update({ stato: 'nuovo' }).eq('id', c.id); c.stato = 'nuovo'; renderCands(); };
    if (cfilter === 'auto' && isAutoTodo(c)) { // controllo degli stalli confermati in automatico dalla rete
      const st = stOf(c);
      $('#cand-edit').querySelector('.acts').innerHTML = `<button class="btn primary" id="c-ok">✓ Giusto</button><button class="btn danger" id="c-bad">✗ Sbagliato: togli dalla mappa</button><button class="btn" id="c-skip">Salta ›</button>`;
      $('#cand-edit').querySelector('.field.two').hidden = true; $('#c-note').closest('.field').hidden = true;
      const hint = $('#cand-edit').querySelectorAll('.sub'); hint[hint.length - 1].insertAdjacentHTML('beforebegin', `<div class="sub">${esc(st.note)}. Se il segnaposto non è esattamente sullo stallo, trascinalo prima di premere "Giusto". Tasti: A giusto · X sbagliato · S salta.</div>`);
      $('#c-ok').onclick = async () => {
        const p = cmarker.getLatLng(); const upd = { note: st.note + ' · controllato', lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6) };
        $('#c-msg').textContent = 'Salvo…';
        const { error } = await sb.from('stalli').update(upd).eq('id', st.id);
        if (error) { $('#c-msg').textContent = 'Errore: ' + error.message; return; }
        Object.assign(st, upd); goNext(c.id, order, 'Confermato.');
      };
      $('#c-bad').onclick = async () => {
        $('#c-msg').textContent = 'Tolgo…';
        const { error } = await sb.from('stalli').update({ stato: 'rifiutato', note: st.note + ' · controllato: sbagliato' }).eq('id', st.id);
        if (error) { $('#c-msg').textContent = 'Errore: ' + error.message; return; }
        await sb.from('candidati').update({ stato: 'scartato' }).eq('id', c.id);
        st.stato = 'rifiutato'; c.stato = 'scartato'; goNext(c.id, order, 'Tolto dalla mappa.');
      };
      $('#c-skip').onclick = () => { skipped.add(c.id); goNext(c.id, order, 'Saltato.'); };
    }
  }

  // ======================================================================
  // IMPORT DI TUTTO IL FVG (una sola richiesta Overpass per area regionale)
  // ======================================================================
  $('#i-region').onclick = async () => {
    const btn = $('#i-region'); btn.disabled = true; $('#i-log').textContent = '';
    const q = `[out:json][timeout:170];area["ISO3166-2"="IT-36"]->.a;(
      nwr["amenity"="parking_space"]["parking_space"="disabled"](area.a);
      nwr["amenity"="parking_space"]["disabled"~"^(yes|designated)$"](area.a);
      nwr["amenity"="parking"]["capacity:disabled"](area.a);
      nwr["amenity"="parking"]["disabled"~"^(yes|designated)$"](area.a););out center tags;`;
    try {
      let els = null;
      for (const url of ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter']) {
        ilog(`Interrogo ${new URL(url).host} per tutta la regione (può richiedere 1–3 minuti)…`);
        try { const r = await overpassOnce(url, null, 180000, q); els = r.els; ilog(`  ${els.length} elementi in ${Math.round(r.ms / 1000)} s`); break; } catch (e) { ilog('  ' + e.message); }
      }
      if (!els) throw new Error('Overpass non ha risposto: riprova più tardi.');
      const have = new Set(rows.map((r) => r.osm_id).filter(Boolean));
      const recs = els.map((el) => osmConvert(el, (el.tags && (el.tags['addr:city'] || el.tags['is_in:city'])) || null)).filter((r) => r && !have.has(r.osm_id));
      ilog(`Nuovi stalli da aggiungere: ${recs.length} (già presenti: ${els.length - recs.length}).`);
      for (let i = 0; i < recs.length; i += 200) { const { error } = await sb.from('stalli').upsert(recs.slice(i, i + 200), { onConflict: 'osm_id', ignoreDuplicates: true }); if (error) throw error; ilog(`  salvati ${Math.min(i + 200, recs.length)}/${recs.length}`); }
      ilog('Fatto.'); load();
    } catch (e) { ilog('Errore: ' + (e.message || e)); }
    btn.disabled = false;
  };


  // ======================================================================
  // CONTESTO PER LA SCANSIONE: edifici, strade e parcheggi OSM di un comune → Supabase Storage (foto/contesto/<comune>.json)
  // ======================================================================
  const slugOf = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // scarica edifici/strade/parcheggi di un rettangolo e li salva in foto/contesto/<slug>-<data>.json
  async function buildContext(label, bbox, log = ilog) {
    const q = `[out:json][timeout:300];(way["building"](${bbox});way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bbox});way["amenity"="parking"](${bbox}););out geom qt;`;
    let els = null;
    for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
      log(`  scarico da ${new URL(url).host}…`);
      try { const r = await overpassOnce(url, null, 320000, q); els = r.els; log(`  ${els.length} elementi in ${Math.round(r.ms / 1000)} s`); break; } catch (e) { log('  ' + e.message); }
    }
    if (!els) throw new Error('Overpass non ha risposto');
    const r5 = (x) => Math.round(x * 1e5) / 1e5; const out = { comune: label, bbox, creato: new Date().toISOString(), edifici: [], strade: [], parcheggi: [] };
    for (const el of els) {
      if (!el.geometry || !el.tags) continue; const pts = el.geometry.map((p) => [r5(p.lat), r5(p.lon)]);
      if (el.tags.building) out.edifici.push(pts);
      else if (el.tags.amenity === 'parking') out.parcheggi.push(pts);
      else if (el.tags.highway) out.strade.push(pts);
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const path = `contesto/${slugOf(label)}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
    const { error } = await sb.storage.from('foto').upload(path, blob, { contentType: 'application/json' });
    if (error) throw error;
    return { path, size: blob.size, n: [out.edifici.length, out.strade.length, out.parcheggi.length] };
  }


  // ======================================================================
  // CONTESTO PER TUTTI I COMUNI DEL FVG (uno dopo l'altro; salta quelli già pronti; scrive contesto/_elenco_fvg.json)
  // ======================================================================
  let ctxStop = false;
  $('#ctx-stop').onclick = () => { ctxStop = true; $('#ctx-stop').disabled = true; ilog('Mi fermo dopo il comune in corso…'); };
  $('#ctx-all').onclick = async () => {
    const btn = $('#ctx-all'); btn.disabled = true; ctxStop = false; stopReq = false; $('#ctx-stop').hidden = false; $('#ctx-stop').disabled = false; $('#i-log').textContent = '';
    try {
      ilog('Scarico l\'elenco dei comuni del Friuli Venezia Giulia…');
      const q = '[out:json][timeout:120];area["ISO3166-2"="IT-36"]->.a;rel["boundary"="administrative"]["admin_level"="8"](area.a);out tags bb;';
      let els = null;
      for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
        try { els = (await overpassOnce(url, null, 150000, q)).els; break; } catch (e) { ilog('  ' + e.message); }
      }
      if (!els || !els.length) throw new Error('Elenco dei comuni non disponibile: riprova più tardi.');
      const comuni = els.filter((e) => e.tags && e.tags.name && e.bounds).map((e) => ({ nome: e.tags.name, slug: slugOf(e.tags.name),
        bbox: [e.bounds.minlat, e.bounds.minlon, e.bounds.maxlat, e.bounds.maxlon].map((x) => x.toFixed(7)).join(',') }))
        .sort((x, y) => x.nome.localeCompare(y.nome, 'it'));
      ilog(`  ${comuni.length} comuni.`);
      const { data: files } = await sb.storage.from('foto').list('contesto', { limit: 1000 });
      const done = new Set((files || []).map((f) => f.name.replace(/-\d{12}\.json$/, '')));
      const saveList = async () => {
        const lst = comuni.map((c) => ({ ...c, pronto: done.has(c.slug) }));
        // l'elenco serve solo per nomi e confini: lo scanner controlla da sé quali comuni hanno il file pronto
        const { error } = await sb.storage.from('foto').upload('contesto/_elenco_fvg.json', new Blob([JSON.stringify(lst)], { type: 'application/json' }), { contentType: 'application/json', upsert: true });
        if (error && !/exists|duplicate/i.test(error.message || '')) ilog('  (elenco non aggiornato: ' + error.message + ')');
      };
      const todo = comuni.filter((c) => !done.has(c.slug));
      ilog(`Già pronti ${comuni.length - todo.length}, da preparare ${todo.length}.`);
      let k = 0, err = 0;
      for (const c of todo) {
        if (ctxStop) { ilog('Fermato. Ripremi il pulsante per riprendere.'); break; }
        k++; ilog(`[${k}/${todo.length}] ${c.nome}`);
        try { const r = await buildContext(c.nome, c.bbox, () => {}); done.add(c.slug); ilog(`  ok: ${r.n[0]} edifici, ${r.n[1]} strade, ${r.n[2]} parcheggi (${(r.size / 1e6).toFixed(1)} MB)`); }
        catch (e) { err++; ilog(`  errore: ${e.message || e} (lo riprovo al prossimo giro)`); }
        if (k % 10 === 0) await saveList();
        await new Promise((r) => setTimeout(r, 4000)); // non sovraccaricare Overpass
      }
      await saveList();
      ilog(`Fatto: ${done.size}/${comuni.length} comuni pronti${err ? `, ${err} da riprovare (ripremi il pulsante)` : ''}.`);
    } catch (e) { ilog('Errore: ' + (e.message || e)); }
    btn.disabled = false; $('#ctx-stop').hidden = true;
  };

  // ======================================================================
  // RAGGRUPPA STALLI VICINI (stessa logica di tools/merge_stalli.py)
  // ======================================================================
  let mPlan = null;
  const mglog = (t) => { const el = $('#g-log'); el.textContent += t + '\n'; el.scrollTop = el.scrollHeight; };
  const mDist = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));
  const mRank = (s) => { const auto = (s.note || '').startsWith('Confermato in automatico'); return ({ ufficiale: 4, verificato: auto ? 2 : 3, proposto: 1 })[s.stato] || 0; };
  // lavora SOLO sugli stalli dei comuni del Friuli-Venezia Giulia (elenco dei comuni preparati per la scansione), mai su tutta Italia
  async function mPlanMerge(R) {
    const el = await (await fetch(C.SUPABASE_URL + '/storage/v1/object/public/foto/contesto/_elenco_fvg.json')).json();
    if (!Array.isArray(el) || el.length < 200) throw new Error('elenco dei comuni del FVG non disponibile');
    const bb = el.map((c) => c.bbox.split(',').map(Number)), nomi = el.map((c) => c.nome.split(' / ')[0]);
    const S = Math.min(...bb.map((b) => b[0])), W = Math.min(...bb.map((b) => b[1])), N = Math.max(...bb.map((b) => b[2])), E = Math.max(...bb.map((b) => b[3]));
    const interi = new Set(el.map((c) => c.nome).concat(nomi)), fvg = (n) => !!n && (interi.has(n) || nomi.some((x) => n.startsWith(x + '-')));
    const { data, error } = await fetchAll(() => sb.from('stalli').select('id,lat,lon,tipo,stato,note,created_at,comune').in('stato', ['proposto', 'verificato', 'ufficiale'])
      .gte('lat', S).lte('lat', N).gte('lon', W).lte('lon', E).order('id'));
    if (error) throw error;
    const st = data.filter((s) => fvg(s.comune)); // il riquadro del FVG comprende pezzi di Veneto: tengo solo i comuni della regione
    const merges = [];
    for (const fam of ['generico', 'personalizzato']) {
      const rest = st.filter((s) => (s.tipo === 'personalizzato' ? 'personalizzato' : 'generico') === fam)
        .sort((a, b) => (mRank(b) - mRank(a)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
      const cell = (s) => [Math.floor(s.lat * 111320 / R), Math.floor(s.lon * 111320 * Math.cos(46 * Math.PI / 180) / R)];
      const grid = new Map();
      for (const s of rest) { const k = cell(s).join(); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); }
      const used = new Set();
      for (const s of rest) {
        if (used.has(s.id)) continue; used.add(s.id);
        const [cy, cx] = cell(s); const grp = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
          for (const t of grid.get(`${cy + dy},${cx + dx}`) || []) if (!used.has(t.id) && mDist(s, t) <= R) grp.push(t);
        grp.forEach((t) => used.add(t.id));
        if (grp.length) merges.push([s, grp]);
      }
    }
    return { total: st.length, merges };
  }
  $('#g-prev').onclick = async () => {
    const R = Number($('#g-r').value) || 40; $('#g-log').textContent = ''; $('#g-go').disabled = true; mPlan = null;
    try {
      mglog('Calcolo sui comuni del Friuli-Venezia Giulia…'); const p = await mPlanMerge(R); const n = p.merges.reduce((a, [, g]) => a + g.length, 0);
      mglog(`Entro ${R} m, solo in Friuli-Venezia Giulia: ${p.total} stalli attivi → ${p.total - n} (${p.merges.length} gruppi, ${n} stalli da togliere dalla mappa).`);
      if (n) { mPlan = { R, merges: p.merges }; $('#g-go').disabled = false; mglog('Premi "Raggruppa" per applicare.'); } else mglog('Niente da raggruppare.');
    } catch (e) { mglog('Errore: ' + (e.message || e)); }
  };
  $('#g-go').onclick = async () => {
    if (!mPlan) return; const btn = $('#g-go'); btn.disabled = true; $('#g-prev').disabled = true;
    let k = 0, err = 0;
    for (const [keep, grp] of mPlan.merges) {
      const ids = grp.map((t) => t.id);
      const r1 = await sb.from('candidati').update({ stallo_id: keep.id }).in('stallo_id', ids); if (r1.error) err++;
      for (const t of grp) {
        const r2 = await sb.from('stalli').update({ stato: 'rimosso', note: `Accorpato in ${keep.id} (${Math.round(mDist(keep, t))} m). ` + (t.note || '') }).eq('id', t.id);
        if (r2.error) err++;
      }
      if (++k % 20 === 0) mglog(`  ${k}/${mPlan.merges.length} gruppi…`);
    }
    mglog(`Fatto: ${k} gruppi raggruppati${err ? `, ${err} errori (riprova Anteprima)` : ''}.`);
    mPlan = null; $('#g-prev').disabled = false;
  };

  $('#ver').textContent = 'v' + C.VERSION;
  boot();
})();
