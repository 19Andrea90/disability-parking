(function () {
  'use strict';
  const C = window.DP_CONFIG; const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const TIPO = { generico: 'Generico', personalizzato: 'Personalizzato', sconosciuto: 'Sconosciuto' };
  let rows = [], filter = 'proposto', sel = null, map, layer, markers = new Map();

  // ---------- auth ----------
  async function session() { const { data } = await sb.auth.getSession(); return data.session; }
  async function boot() { const s = await session(); if (s) { $('#login').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false; initMap(); load(); loadCands(); setTimeout(() => loadLabels(), 1500); } }
  $('#l-in').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : ''; if (!error) boot(); };
  $('#l-up').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signUp({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : 'Registrazione inviata: se Supabase richiede la conferma, controlla la posta e poi premi "Entra".'; };
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };

  // ---------- mappa ----------
  function initMap() {
    if (map) return;
    map = L.map('amap').setView([C.HOME.lat, C.HOME.lon], 13);
    bases.osm.addTo(map); curBase = 'osm';
    layer = L.layerGroup().addTo(map); candLayer = L.layerGroup().addTo(map);
    document.querySelectorAll('input[name=base]').forEach((r) => r.onchange = () => setBase(r.value));
    map.on('moveend zoomend', zoomInfo); zoomInfo();
  }
  function zoomInfo() {
    const b = map.getBounds(); const wKm = map.distance(b.getSouthWest(), b.getSouthEast()) / 1000, hKm = map.distance(b.getSouthWest(), b.getNorthWest()) / 1000;
    const cells = Math.ceil(wKm * 1000 / 120) * Math.ceil(hKm * 1000 / 120); const z = map.getZoom();
    const hint = cells > 900 ? ' · troppo grande per lo scanner: avvicina' : cells < 36 ? ' · lo scanner userà 720 m attorno al centro' : ' · ok per lo scanner';
    $('#zinfo').textContent = `zoom ${z} · area visibile ${wKm.toFixed(1)} × ${hKm.toFixed(1)} km · ${cells} riquadri${hint}`;
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
  async function load() {
    const { data, error } = await sb.from('stalli_con_conferme').select('*').order('created_at', { ascending: false }).limit(5000);
    if (error) { $('#rows').innerHTML = `<div class="empty">Errore: ${esc(error.message)} (sei registrato come admin? controlla la tabella admins)</div>`; return; }
    rows = data; kpi(); render(); if (labDone.size) labCount();
  }
  function kpi() {
    const n = (st) => rows.filter((r) => r.stato === st).length;
    $('#kpi').innerHTML = [['Da approvare', n('proposto')], ['Verificati', n('verificato')], ['Ufficiali', n('ufficiale')], ['Con "non esiste"', rows.filter((r) => r.conferme_non_esiste > 0 && r.stato !== 'rifiutato').length], ['Totale attivi', rows.filter((r) => ['proposto', 'verificato', 'ufficiale'].includes(r.stato)).length]].map((k) => `<div>${k[0]}<b>${k[1]}</b></div>`).join('');
  }
  document.querySelectorAll('.tabs .btn').forEach((b) => b.onclick = () => { document.querySelectorAll('.tabs .btn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); filter = b.dataset.f; render(); });
  function visible() { return filter === 'segnalati' ? rows.filter((r) => r.conferme_non_esiste > 0 && r.stato !== 'rifiutato') : rows.filter((r) => r.stato === filter); }
  function render() {
    const v = visible();
    $('#rows').innerHTML = v.length ? v.slice(0, 300).map((r) => `<div class="row-item${sel && sel.id === r.id ? ' sel' : ''}" data-id="${r.id}">
      <div><div class="n">${esc(r.nome || r.indirizzo || TIPO[r.tipo])} · ${r.posti} ${r.posti > 1 ? 'posti' : 'posto'}</div>
      <div class="s">${TIPO[r.tipo]} · ${r.comune || '—'} · ${r.fonte} · ${new Date(r.created_at).toLocaleDateString('it-IT')}${r.conferme_esiste ? ` · ✓${r.conferme_esiste}` : ''}${r.conferme_non_esiste ? ` · ✗${r.conferme_non_esiste}` : ''}${r.foto_url ? ' · 📷' : ''}</div></div>
      <div class="s">${r.stato}</div></div>`).join('') : '<div class="empty">Niente qui.</div>';
    layer.clearLayers(); markers.clear();
    v.forEach((r) => { const m = L.marker([r.lat, r.lon], { icon: icon(r, sel && sel.id === r.id) }); m.on('click', () => select(r.id)); layer.addLayer(m); markers.set(r.id, m); });
    if (v.length && !sel) map.fitBounds(v.map((r) => [r.lat, r.lon]), { padding: [20, 20], maxZoom: 15 });
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
    $('#edit').querySelectorAll('[data-st]').forEach((b) => b.onclick = () => save({ stato: b.dataset.st }));
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
    const { error } = await sb.from('stalli').update(patch).eq('id', sel.id);
    if (error) { $('#e-msg').textContent = 'Errore: ' + error.message; return; }
    Object.assign(sel, patch); $('#e-msg').textContent = 'Salvato ' + new Date().toLocaleTimeString('it-IT'); kpi(); render();
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

  // --- suggerimento comuni (Photon, dati OSM) ---
  const cs = $('#i-sug'); let csItems = [], csT, csCtl, chosen = null;
  $('#i-area').addEventListener('input', () => {
    chosen = null; progress = null; $('#i-go').textContent = 'Importa'; const v = $('#i-area').value.trim(); clearTimeout(csT);
    if (v.length < 2) { cs.hidden = true; return; }
    csT = setTimeout(async () => {
      if (csCtl) csCtl.abort(); csCtl = new AbortController();
      try {
        const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(v)}&limit=15`, { signal: csCtl.signal });
        const j = await r.json();
        if (!j.features) throw new Error(j.message || 'risposta inattesa');
        const seen = new Set(); const okPlace = ['city', 'town', 'village', 'municipality', 'hamlet', 'borough'];
        csItems = j.features.filter((f) => { const p = f.properties; return p.countrycode === 'IT' && p.name && ((p.osm_key === 'place' && okPlace.includes(p.osm_value)) || (p.osm_key === 'boundary' && p.osm_value === 'administrative')); })
          .filter((f) => { const k = f.properties.name + '|' + (f.properties.county || f.properties.state); if (seen.has(k)) return false; seen.add(k); return true; })
          .slice(0, 8)
          .map((f) => ({ name: f.properties.name, where: [f.properties.county, f.properties.state].filter(Boolean).join(', '), extent: f.properties.extent, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
        cs.innerHTML = csItems.map((c, i) => `<li data-i="${i}"><span class="m">${esc(c.name)}</span><span class="s">${esc(c.where)}</span></li>`).join('');
        cs.hidden = !csItems.length;
      } catch (e) { if (e.name !== 'AbortError') ilog('Suggerimenti non disponibili: ' + e.message); }
    }, 250);
  });
  cs.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (!li) return; e.preventDefault(); chosen = csItems[+li.dataset.i]; $('#i-area').value = chosen.name; cs.hidden = true; });
  $('#i-area').addEventListener('blur', () => setTimeout(() => { cs.hidden = true; }, 150));
  $('#i-area').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!cs.hidden && csItems.length) { chosen = csItems[0]; $('#i-area').value = chosen.name; cs.hidden = true; } $('#i-go').click(); } });

  // --- confine del comune da Nominatim (rettangolo + poligono) ---
  async function comuneBoundary(name, hint) {
    const q = hint && hint.where ? `${name}, ${hint.where.split(',')[0]}` : name;
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=it&polygon_geojson=1&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'it' } });
    const j = await r.json();
    // preferisco il confine comunale (admin_level 8 = city/town/village/municipality), poi un qualsiasi confine amministrativo
    const isComune = (x) => x.class === 'boundary' && x.type === 'administrative' && ['city', 'town', 'village', 'municipality', 'hamlet'].includes(x.addresstype);
    let hit = j.find(isComune) || j.find((x) => x.class === 'boundary' && x.type === 'administrative') || j.find((x) => x.geojson && /Polygon/.test(x.geojson.type));
    if (!hit && hint && hint.extent) { const e = hint.extent; return { bbox: `${e[3]},${e[0]},${e[1]},${e[2]}`, geojson: null, label: hint.name, kind: 'rettangolo (Photon)' }; }
    if (!hit) return null;
    const bb = hit.boundingbox.map(Number); // [sud, nord, ovest, est]
    const geo = hit.geojson && /Polygon/.test(hit.geojson.type) ? hit.geojson : null;
    return { bbox: `${bb[0]},${bb[2]},${bb[1]},${bb[3]}`, geojson: geo, label: hit.display_name.split(',')[0], kind: `${hit.addresstype || hit.type}${geo ? ', poligono' : ', solo rettangolo'}`, bb };
  }
  function inRing(ring, lon, lat) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c; } return c; }
  function inside(geo, lon, lat) {
    if (!geo) return true;
    const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : null; if (!polys) return true;
    return polys.some((p) => inRing(p[0], lon, lat) && !p.slice(1).some((h) => inRing(h, lon, lat)));
  }
  // spezza il rettangolo in celle di max ~0.06° (~5-7 km) per non far scadere Overpass
  function tiles(bboxStr, max = 0.06) {
    const [s, w, n, e] = bboxStr.split(',').map(Number); const out = [];
    const ny = Math.max(1, Math.ceil((n - s) / max)), nx = Math.max(1, Math.ceil((e - w) / max));
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) out.push(`${(s + (n - s) * i / ny).toFixed(5)},${(w + (e - w) * j / nx).toFixed(5)},${(s + (n - s) * (i + 1) / ny).toFixed(5)},${(w + (e - w) * (j + 1) / nx).toFixed(5)}`);
    return out;
  }
  let stopReq = false, activeCtl = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checkStop = () => { if (stopReq || sStop) throw new Error('Interrotto dall\'utente'); };
  let sStop = false;
  async function overpassOnce(url, bb, timeoutMs, query) {
    const ctl = new AbortController(); activeCtl = ctl; const to = setTimeout(() => ctl.abort(), timeoutMs); const t0 = Date.now();
    try {
      checkStop();
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query || osmQuery(bb)), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.remark && /timed out|error/i.test(j.remark)) throw new Error('server: ' + j.remark.slice(0, 80));
      return { els: j.elements, ms: Date.now() - t0 };
    } catch (e) { if (stopReq || sStop) throw new Error('Interrotto dall\'utente'); if (e.name === 'AbortError') throw new Error(`nessuna risposta entro ${Math.round(timeoutMs / 1000)} s`); throw e; }
    finally { clearTimeout(to); activeCtl = null; }
  }
  async function overpassFetch(bb, query, logFn) {
    const L_ = logFn || ilog; let lastErr = null;
    for (let round = 0; round < 3; round++) {
      for (const url of OVERPASS) {
        const host = new URL(url).host;
        try { const { els, ms } = await overpassOnce(url, bb, round === 0 ? 45000 : 75000, query); L_(`    ${host}: ${els.length} elementi in ${Math.round(ms / 1000)} s`); return els; }
        catch (e) { if (stopReq || sStop) throw e; lastErr = e; L_(`    ${host}: ${e.message}`); if (/HTTP 429|HTTP 50/.test(e.message)) await sleep(4000); }
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
  let progress = null;
  $('#i-go').onclick = async () => {
    const area = $('#i-area').value.trim(); if (!area) return; $('#i-log').textContent = ''; $('#i-go').disabled = true; $('#i-stop').hidden = false; stopReq = false; cs.hidden = true;
    try {
      ilog(`Cerco il confine di "${area}"…`);
      const b = await comuneBoundary(area, chosen);
      if (!b) throw new Error(`Comune "${area}" non trovato: scegli un suggerimento dalla tendina.`);
      const [s, w, n, e] = b.bbox.split(',').map(Number);
      ilog(`  confine: ${b.label} (${b.kind}), area ${Math.round((n - s) * 111)} × ${Math.round((e - w) * 111 * Math.cos(s * Math.PI / 180))} km`);
      const cells = tiles(b.bbox, 0.08);
      const resume = progress && progress.key === b.bbox ? progress : { key: b.bbox, done: 0, byId: new Map() };
      const byId = resume.byId;
      ilog(`Interrogo Overpass in ${cells.length} riquadr${cells.length === 1 ? 'o' : 'i'}${resume.done ? ` (riprendo dal ${resume.done + 1})` : ''}…`);
      for (let i = resume.done; i < cells.length; i++) {
        ilog(`  riquadro ${i + 1}/${cells.length}`);
        let els;
        try { els = await overpassFetch(cells[i]); }
        catch (e) { progress = resume; $('#i-go').textContent = 'Riprendi'; throw new Error(`${e.message}. Premi "Riprendi" ${stopReq ? 'quando vuoi' : 'tra qualche minuto'}: ripartirà dal riquadro ${i + 1}.`); }
        els.forEach((el) => byId.set(el.type + '/' + el.id, el)); resume.done = i + 1;
        if (cells.length > 1) await sleep(2000);
      }
      progress = null; $('#i-go').textContent = 'Importa';
      const all = [...byId.values()].map((el) => osmConvert(el, b.label)).filter(Boolean);
      let recs = all.filter((r) => inside(b.geojson, r.lon, r.lat));
      ilog(`Trovati ${all.length} stalli nel rettangolo, ${recs.length} dentro il confine di ${b.label}.`);
      if (!recs.length && all.length) { ilog('  Il filtro sul confine ha scartato tutto: uso il rettangolo intero (controlla poi sulla mappa).'); recs = all; }
      if (!recs.length) { ilog('Nessuno stallo mappato su OpenStreetMap in questo comune: qui si parte dalle segnalazioni.'); return; }
      for (let i = 0; i < recs.length; i += 200) {
        const { error } = await sb.from('stalli').upsert(recs.slice(i, i + 200), { onConflict: 'osm_id' });
        if (error) throw error; ilog(`  salvati ${Math.min(i + 200, recs.length)}/${recs.length}`);
      }
      ilog('Fatto.'); load();
    } catch (e) { ilog((stopReq ? 'Fermato: ' : 'Errore: ') + (e.message || e)); }
    $('#i-go').disabled = false; $('#i-stop').hidden = true;
  };
  $('#i-stop').onclick = () => { stopReq = true; if (activeCtl) activeCtl.abort(); $('#i-stop').disabled = true; setTimeout(() => { $('#i-stop').disabled = false; }, 1500); ilog('Interrompo…'); };


  // ======================================================================
  // CANDIDATI AUTOMATICI — Mapillary (cartelli riconosciuti) + ortofoto
  // ======================================================================
  const MLY_CLASSES = ['information--disabled-persons--g1', 'information--disabled-persons--g2', 'information--disabled-persons--g3', 'complementary--disabled-persons--g1', 'regulatory--reserved-parking--g1'];
  const CLASSE_LABEL = { 'information--disabled-persons--g1': 'Pannello "disabili"', 'information--disabled-persons--g2': 'Pannello "disabili"', 'information--disabled-persons--g3': 'Pannello "disabili"', 'complementary--disabled-persons--g1': 'Pannello integrativo "disabili"', 'regulatory--reserved-parking--g1': 'Parcheggio riservato' };
  const mlog = (m) => { const l = $('#m-log'); l.textContent += m + '\n'; l.scrollTop = l.scrollHeight; };
  let cands = [], cfilter = 'nuovo', csel = null, cmarker = null, mStop = false;
  $('#m-token').value = (() => { try { return localStorage.getItem('dp.mly') || ''; } catch (e) { return ''; } })();
  $('#m-token').addEventListener('change', () => { try { localStorage.setItem('dp.mly', $('#m-token').value.trim()); } catch (e) { /* ignora */ } });
  const distM = (a, b) => map.distance([a.lat, a.lon], [b.lat, b.lon]);

  async function loadCands() {
    const { data, error } = await sb.from('candidati').select('*').order('created_at', { ascending: false }).limit(5000);
    if (error) { $('#cand-rows').innerHTML = `<div class="empty">Errore: ${esc(error.message)} — hai eseguito supabase/03_candidati.sql?</div>`; return; }
    cands = data; renderCands();
  }
  document.querySelectorAll('[data-cf]').forEach((b) => b.onclick = () => { document.querySelectorAll('[data-cf]').forEach((x) => x.classList.remove('active')); b.classList.add('active'); cfilter = b.dataset.cf; renderCands(); });
  function cicon(c, on) { return L.divIcon({ className: '', html: `<div class="pin proposto${on ? ' sel' : ''}" style="background:#7c3aed"><b>?</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }); }
  function renderCands() {
    const v = cands.filter((c) => c.stato === cfilter);
    $('#cand-count').textContent = `· ${cands.filter((c) => c.stato === 'nuovo').length} da verificare`;
    $('#cand-rows').innerHTML = v.length ? v.slice(0, 300).map((c) => `<div class="row-item${csel && csel.id === c.id ? ' sel' : ''}" data-cid="${c.id}">
      <div><div class="n">${esc(CLASSE_LABEL[c.classe] || c.classe)}</div><div class="s">${esc(c.comune || '')} · visto ${c.last_seen ? new Date(c.last_seen).toLocaleDateString('it-IT') : '—'} · ${c.fonte}</div></div><div class="s">${c.stato}</div></div>`).join('') : '<div class="empty">Nessun candidato in questo stato.</div>';
    candLayer.clearLayers();
    v.forEach((c) => { const m = L.marker([c.lat, c.lon], { icon: cicon(c, csel && csel.id === c.id) }); m.on('click', () => selectCand(c.id)); candLayer.addLayer(m); });
  }
  $('#cand-rows').addEventListener('click', (e) => { const it = e.target.closest('[data-cid]'); if (it) selectCand(it.dataset.cid); });

  async function selectCand(id) {
    csel = cands.find((c) => c.id === id); if (!csel) return; const c = csel;
    renderCands(); $('#cand-box').open = true;
    if (cmarker) map.removeLayer(cmarker);
    cmarker = L.marker([c.lat, c.lon], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="pin generico sel"><b>♿</b></div>', iconSize: [30, 30], iconAnchor: [15, 30] }), zIndexOffset: 2000 }).addTo(map);
    map.setView([c.lat, c.lon], 20); setBase('fvg');
    const near = rows.filter((r) => r.stato !== 'rifiutato' && distM(r, c) <= 40);
    $('#cand-edit').innerHTML = `
      <div class="badges"><span class="badge proposto" style="background:#7c3aed">${esc(CLASSE_LABEL[c.classe] || c.classe)}</span><span class="badge osm">${c.fonte}</span><span class="badge osm">${c.stato}</span></div>
      <div class="sub">${c.lat.toFixed(6)}, ${c.lon.toFixed(6)} · visto dal ${c.first_seen ? new Date(c.first_seen).toLocaleDateString('it-IT') : '—'} al ${c.last_seen ? new Date(c.last_seen).toLocaleDateString('it-IT') : '—'}
        · <a target="_blank" href="https://www.mapillary.com/app/?lat=${c.lat}&lng=${c.lon}&z=18${c.image_id ? '&pKey=' + c.image_id : ''}">Apri in Mapillary</a>
        · <a target="_blank" href="https://www.google.com/maps?q=${c.lat},${c.lon}&layer=c&cbll=${c.lat},${c.lon}">Street View</a></div>
      ${near.length ? `<div class="warn">Attenzione: ${near.length} stallo/i già presenti entro 40 m (${near.map((n) => esc(n.nome || n.indirizzo || n.tipo)).join(', ')}). Forse è lo stesso.</div>` : ''}
      ${c.fonte === 'satellite' && c.note && /^https?:/.test(c.note) ? `<a href="${c.note}" target="_blank"><img src="${c.note}" alt="ritaglio ortofoto" style="width:100%;max-width:360px;border-radius:12px;image-rendering:auto"></a><div class="sub">Ritaglio ortofoto 24×24 m, in rosso la segnaletica gialla rilevata.</div>` : '<div id="cand-photo" class="sub">Carico la foto…</div>'}
      <div class="sub">Sulla mappa (ortofoto) trascina il segnaposto esattamente sullo stallo prima di accettare: il cartello è di solito a pochi metri dallo stallo.</div>
      <div class="field two">
        <label>Tipo<select id="c-tipo"><option value="generico">Generico</option><option value="personalizzato">Personalizzato</option><option value="sconosciuto">Sconosciuto</option></select></label>
        <label>Posti<input type="number" id="c-posti" min="1" value="1"></label>
      </div>
      <label class="field">Note<input type="text" id="c-note" placeholder="es. davanti al civico 12"></label>
      <div class="acts">
        <button class="btn primary" id="c-accept">✓ Accetta: crea stallo qui</button>
        <button class="btn danger" id="c-reject">✗ Scarta</button>
        <button class="btn" id="c-reset">Torna "nuovo"</button>
      </div>
      <div class="sub" id="c-msg"></div>`;
    $('#c-accept').onclick = async () => {
      const p = cmarker.getLatLng();
      const rec = { lat: +p.lat.toFixed(6), lon: +p.lng.toFixed(6), tipo: $('#c-tipo').value, posti: +$('#c-posti').value || 1, note: $('#c-note').value.trim() || null, comune: c.comune, stato: 'verificato', fonte: c.fonte, segnale_verticale: c.fonte === 'mapillary' ? true : null, nome: null };
      $('#c-msg').textContent = 'Creo lo stallo…';
      const { data, error } = await sb.from('stalli').insert(rec).select().single();
      if (error) { $('#c-msg').textContent = 'Errore: ' + error.message; return; }
      await sb.from('candidati').update({ stato: 'accettato', stallo_id: data.id }).eq('id', c.id);
      c.stato = 'accettato'; c.stallo_id = data.id; $('#c-msg').textContent = 'Stallo creato.'; load(); renderCands();
    };
    $('#c-reject').onclick = async () => { await sb.from('candidati').update({ stato: 'scartato' }).eq('id', c.id); c.stato = 'scartato'; $('#c-msg').textContent = 'Scartato.'; renderCands(); };
    $('#c-reset').onclick = async () => { await sb.from('candidati').update({ stato: 'nuovo' }).eq('id', c.id); c.stato = 'nuovo'; renderCands(); };
    // foto Mapillary
    const tok = $('#m-token').value.trim();
    if (c.fonte === 'satellite') { /* niente foto stradale */ } else if (c.image_id && tok) {
      try {
        const r = await fetch(`https://graph.mapillary.com/${c.image_id}?access_token=${encodeURIComponent(tok)}&fields=thumb_1024_url,captured_at,compass_angle`);
        const j = await r.json();
        $('#cand-photo').innerHTML = j.thumb_1024_url ? `<a href="${j.thumb_1024_url}" target="_blank"><img src="${j.thumb_1024_url}" alt="foto Mapillary" style="width:100%;border-radius:12px"></a><div class="sub">Foto del ${j.captured_at ? new Date(j.captured_at).toLocaleDateString('it-IT') : '—'} · © Mapillary contributors (CC BY-SA)</div>` : '<div class="sub">Foto non disponibile.</div>';
      } catch (e) { $('#cand-photo').textContent = 'Foto non caricata: ' + e.message; }
    } else $('#cand-photo').textContent = tok ? 'Nessuna immagine collegata.' : 'Inserisci il token Mapillary per vedere la foto.';
  }

  // ricerca candidati su un comune
  function mlyCells(bboxStr, max = 0.09) { // area di ogni cella < 0.01 gradi²
    const [s, w, n, e] = bboxStr.split(',').map(Number); const out = [];
    const ny = Math.max(1, Math.ceil((n - s) / max)), nx = Math.max(1, Math.ceil((e - w) / max));
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) out.push([w + (e - w) * j / nx, s + (n - s) * i / ny, w + (e - w) * (j + 1) / nx, s + (n - s) * (i + 1) / ny]);
    return out;
  }
  $('#m-stop').onclick = () => { mStop = true; };
  $('#m-go').onclick = async () => {
    const tok = $('#m-token').value.trim(), area = $('#m-area').value.trim();
    $('#m-log').textContent = '';
    if (!tok) { mlog('Serve il token Mapillary.'); return; }
    if (!area) { mlog('Scrivi il nome del comune.'); return; }
    $('#m-go').disabled = true; $('#m-stop').hidden = false; mStop = false;
    try {
      mlog(`Cerco il confine di "${area}"…`);
      const b = await comuneBoundary(area, null); if (!b) throw new Error('Comune non trovato');
      const cells = mlyCells(b.bbox); mlog(`  ${b.label}: ${cells.length} riquadri Mapillary`);
      const found = new Map();
      for (let i = 0; i < cells.length; i++) {
        if (mStop) throw new Error('Interrotto');
        const bb = cells[i].map((x) => x.toFixed(5)).join(',');
        const url = `https://graph.mapillary.com/map_features?access_token=${encodeURIComponent(tok)}&fields=id,object_value,geometry,first_seen_at,last_seen_at,images&bbox=${bb}&object_values=${MLY_CLASSES.join(',')}&limit=2000`;
        const r = await fetch(url); const j = await r.json();
        if (j.error) throw new Error('Mapillary: ' + (j.error.message || JSON.stringify(j.error)));
        (j.data || []).forEach((f) => found.set(f.id, f));
        mlog(`  riquadro ${i + 1}/${cells.length}: ${(j.data || []).length} rilevamenti`);
      }
      const feats = [...found.values()].map((f) => ({ ext_id: 'mly/' + f.id, classe: f.object_value, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], first_seen: f.first_seen_at || null, last_seen: f.last_seen_at || null, image_id: (f.images && f.images.data && f.images.data[0] && f.images.data[0].id) || null }))
        .filter((f) => inside(b.geojson, f.lon, f.lat));
      mlog(`Rilevamenti dentro il confine: ${feats.length}`);
      const known = new Set(cands.map((c) => c.ext_id));
      let dupStallo = 0, dupCand = 0; const fresh = [];
      for (const f of feats) {
        if (known.has(f.ext_id)) { dupCand++; continue; }
        if (rows.some((r) => r.stato !== 'rifiutato' && distM(r, f) <= 25)) { dupStallo++; continue; }
        fresh.push(Object.assign({ fonte: 'mapillary', comune: b.label, stato: 'nuovo' }, f));
      }
      mlog(`  già candidati: ${dupCand} · già stalli entro 25 m: ${dupStallo} · nuovi: ${fresh.length}`);
      for (let i = 0; i < fresh.length; i += 200) {
        const { error } = await sb.from('candidati').upsert(fresh.slice(i, i + 200), { onConflict: 'ext_id', ignoreDuplicates: true });
        if (error) throw error;
      }
      mlog('Fatto.'); await loadCands();
      if (fresh.length) { cfilter = 'nuovo'; renderCands(); map.fitBounds(fresh.map((f) => [f.lat, f.lon]), { padding: [20, 20], maxZoom: 15 }); }
    } catch (e) { mlog('Errore: ' + (e.message || e)); }
    $('#m-go').disabled = false; $('#m-stop').hidden = true;
  };


  // ======================================================================
  // SCANNER ORTOFOTO — cerca segnaletica gialla a terra (stalli disabili) nell'area visibile
  // ======================================================================
  const slog = (m) => { const l = $('#s-log'); l.textContent += m + '\n'; l.scrollTop = l.scrollHeight; };
  $('#s-stop').onclick = () => { sStop = true; if (activeCtl) activeCtl.abort(); slog('Interrompo…'); };
  const FVG_WMS = 'https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows';
  function mToDeg(lat) { return { dLat: 1 / 111320, dLon: 1 / (111320 * Math.cos(lat * Math.PI / 180)) }; }
  function loadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('immagine non caricata')); im.src = url; }); }
  // sorgente immagine per un riquadro (bbox in gradi), restituisce canvas con pixel leggibili
  async function fetchCell(s, w, n, e, px, src) {
    let url;
    if (src === 'fvg') {
      // WMS 1.1.1 in EPSG:4326: bbox = minLon,minLat,maxLon,maxLat
      url = `${FVG_WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=trueorto_FVG_1720&STYLES=&SRS=EPSG:4326&BBOX=${w},${s},${e},${n}&WIDTH=${px}&HEIGHT=${px}&FORMAT=image/jpeg`;
    } else if (src === 'proxy') {
      url = `${C.SUPABASE_URL}/functions/v1/wms-proxy?bbox=${w},${s},${e},${n}&w=${px}&h=${px}`;
    } else {
      // Esri: esporto via export API (consente CORS)
      url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${px},${px}&format=jpg&f=image`;
    }
    const im = await loadImg(url);
    const cv = document.createElement('canvas'); cv.width = px; cv.height = px; const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(im, 0, 0, px, px);
    return { cv, ctx };
  }
  // maschera "giallo segnaletico" e componenti connesse
  // soglie: "giallezza" = quanto il pixel è meno blu di rosso/verde (la vernice gialla sull'ortofoto è pallida: saturazione bassa, ma blu sempre più basso)
  function thresholds(sens) {
    const ref = (() => { try { return JSON.parse(localStorage.getItem('dp.yellow') || 'null'); } catch (e) { return null; } })();
    const base = [0.085, 0.07, 0.055, 0.045, 0.038][sens - 1];
    const contrast = [0.16, 0.13, 0.10, 0.08, 0.06][sens - 1];
    if (ref && ref.yel != null) return { yelMin: Math.max(0.03, ref.yel * [0.95, 0.85, 0.75, 0.65, 0.55][sens - 1]), valMin: 0.6, contrast, ref: true };
    return { yelMin: base, valMin: 0.6, contrast, ref: false };
  }
  function yellowMask(ctx, px, sens, res) {
    const d = ctx.getImageData(0, 0, px, px).data; const mask = new Uint8Array(px * px); const th = thresholds(sens); let count = 0;
    // luminosità e sua media locale (raggio ~2.5 m) tramite immagine integrale
    const V = new Float32Array(px * px); for (let i = 0; i < px * px; i++) V[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) / 255;
    const I = new Float64Array((px + 1) * (px + 1));
    for (let y = 1; y <= px; y++) { let rs = 0; for (let x = 1; x <= px; x++) { rs += V[(y - 1) * px + (x - 1)]; I[y * (px + 1) + x] = I[(y - 1) * (px + 1) + x] + rs; } }
    const R_ = Math.max(4, Math.round(2.5 / (res || 0.2)));
    const bg = (x, y) => { const x0 = Math.max(0, x - R_), x1 = Math.min(px, x + R_ + 1), y0 = Math.max(0, y - R_), y1 = Math.min(px, y + R_ + 1); const W = px + 1; return (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0)); };
    for (let i = 0; i < px * px; i++) {
      const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
      const v = V[i]; if (v < th.valMin) continue;
      if (((r + g) / 2 - b) < th.yelMin) continue;      // deficit di blu
      if (r < 0.98 * g || r > 1.07 * g) continue;        // giallo: rosso ≈ verde (esclude verde, rosa e terreno)
      if (v - bg(i % px, (i / px) | 0) < th.contrast) continue; // la vernice è più chiara dell'asfalto intorno; campi e ghiaia no
      mask[i] = 1; count++;
    }
    return { mask, count, th };
  }
  // componenti connesse su griglia 2x2 con orientamento (PCA): lunghezza, larghezza, angolo
  function components(mask, px, res) {
    const g = Math.ceil(px / 2), cell = new Uint8Array(g * g);
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) if (mask[y * px + x]) cell[(y >> 1) * g + (x >> 1)] = 1;
    const seen = new Uint8Array(g * g); const out = []; const r2 = res * 2;
    for (let i = 0; i < g * g; i++) {
      if (!cell[i] || seen[i]) continue;
      const stack = [i]; seen[i] = 1; const xs = [], ys = [];
      while (stack.length) {
        const k = stack.pop(); const x = k % g, y = (k / g) | 0; xs.push(x); ys.push(y);
        for (const nb of [k - 1, k + 1, k - g, k + g, k - g - 1, k - g + 1, k + g - 1, k + g + 1]) { if (nb < 0 || nb >= g * g) continue; if (Math.abs((nb % g) - x) > 1) continue; if (cell[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); } }
      }
      const n = xs.length; if (n < 5) continue;
      let mx = 0, my = 0; for (let k = 0; k < n; k++) { mx += xs[k]; my += ys[k]; } mx /= n; my /= n;
      let sxx = 0, syy = 0, sxy = 0; for (let k = 0; k < n; k++) { const dx = xs[k] - mx, dy = ys[k] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; } sxx /= n; syy /= n; sxy /= n;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy; const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
      const ang = (Math.atan2(l1 - sxx, sxy) * 180 / Math.PI + 180) % 180;
      let minx = g, maxx = 0, miny = g, maxy = 0; for (let k = 0; k < n; k++) { if (xs[k] < minx) minx = xs[k]; if (xs[k] > maxx) maxx = xs[k]; if (ys[k] < miny) miny = ys[k]; if (ys[k] > maxy) maxy = ys[k]; }
      out.push({ n, cx: mx * 2, cy: my * 2, L: 4 * Math.sqrt(l1) * r2, W: 4 * Math.sqrt(l2) * r2, area: n * r2 * r2, ang, bw: (maxx - minx + 1) * 2, bh: (maxy - miny + 1) * 2 });
    }
    return out;
  }
  // dalle componenti ai candidati: gruppi di fasce parallele (zone tratteggiate accanto ai posti) o blocchi compatti
  function detect(mask, px, res) {
    const comps = components(mask, px, res);
    const strips = comps.filter((c) => c.L >= 2.2 && c.L <= 7.5 && c.W >= 0.3 && c.W <= 2.2 && c.area >= 0.6);
    const used = new Set(); const cands = [];
    const dM = (a, b) => Math.hypot((a.cx - b.cx) * res, (a.cy - b.cy) * res);
    const par = (a, b) => Math.abs((((a.ang - b.ang) + 90) % 180) - 90) < 22;
    strips.forEach((s, i) => {
      if (used.has(i)) return; const grp = [i]; used.add(i); let changed = true;
      while (changed) { changed = false; strips.forEach((t, j) => { if (used.has(j)) return; if (grp.some((k) => par(strips[k], t) && dM(strips[k], t) <= 4.5)) { grp.push(j); used.add(j); changed = true; } }); }
      if (grp.length >= 2) { const cx = grp.reduce((a, k) => a + strips[k].cx, 0) / grp.length, cy = grp.reduce((a, k) => a + strips[k].cy, 0) / grp.length; cands.push({ cx, cy, posti: grp.length, kind: 'fasce', w: Math.max(...grp.map((k) => strips[k].bw)) + 20, h: Math.max(...grp.map((k) => strips[k].bh)) + 20, score: grp.length }); }
    });
    comps.forEach((c) => {
      const fill = c.area / Math.max(0.1, c.L * c.W); // riempimento lungo gli assi reali: un'auto è piena, uno stallo tratteggiato no
      if (c.L >= 3.5 && c.L <= 16 && c.W >= 1.8 && c.W <= 8 && c.area >= 2 && c.area <= 60 && fill >= 0.1 && fill <= 0.6 && c.L / c.W <= 5) {
        const posti = Math.max(1, Math.round(c.L / 2.6));
        const near = cands.find((k) => Math.hypot((k.cx - c.cx) * res, (k.cy - c.cy) * res) < 9);
        if (near) { near.cx = (near.cx + c.cx) / 2; near.cy = (near.cy + c.cy) / 2; near.posti += posti; near.w = Math.max(near.w, Math.abs(near.cx - c.cx) * 2 + c.bw); near.h = Math.max(near.h, Math.abs(near.cy - c.cy) * 2 + c.bh); }
        else cands.push({ cx: c.cx, cy: c.cy, posti, kind: 'blocco', w: c.bw, h: c.bh, score: 1 });
      }
    });
    // gruppi di macchie piccole (simboli/tratteggi a intervalli regolari): almeno 3 macchie simili entro 3.2 m l'una dall'altra, estensione 4-18 m
    const smalls = comps.map((c, i) => Object.assign({ i }, c)).filter((c) => c.area >= 0.2 && c.area <= 3.5 && c.L <= 3 && c.W <= 2);
    const su = new Set();
    smalls.forEach((a) => {
      if (su.has(a.i)) return; const grp = [a]; su.add(a.i); let ch = true;
      while (ch) { ch = false; smalls.forEach((b) => { if (su.has(b.i)) return; if (grp.some((g) => Math.hypot((g.cx - b.cx) * res, (g.cy - b.cy) * res) <= 3.2)) { grp.push(b); su.add(b.i); ch = true; } }); }
      if (grp.length < 3) return;
      let span = 0; for (const p of grp) for (const q of grp) span = Math.max(span, Math.hypot((p.cx - q.cx) * res, (p.cy - q.cy) * res));
      if (span < 4 || span > 18) return;
      const areas = grp.map((g) => g.area); const mean = areas.reduce((x, y) => x + y, 0) / areas.length; const sd = Math.sqrt(areas.reduce((x, y) => x + (y - mean) ** 2, 0) / areas.length);
      if (sd > mean * 1.2) return; // macchie troppo diverse tra loro: rumore
      // allineamento: almeno 3 macchie su una stessa retta (entro 0.9 m) a passo regolare 1.8–3.5 m (simboli o tratteggi a intervalli fissi)
      let bestLine = null;
      for (let i1 = 0; i1 < grp.length; i1++) for (let i2 = i1 + 1; i2 < grp.length; i2++) {
        const ax = grp[i1].cx, ay = grp[i1].cy; let ux = grp[i2].cx - ax, uy = grp[i2].cy - ay; const ln = Math.hypot(ux, uy); if (!ln) continue; ux /= ln; uy /= ln;
        const on = grp.filter((g) => Math.abs(-(g.cx - ax) * uy + (g.cy - ay) * ux) * res <= 0.9);
        if (on.length < 3) continue;
        const t = on.map((g) => ((g.cx - ax) * ux + (g.cy - ay) * uy) * res).sort((p, q) => p - q);
        const gaps = t.slice(1).map((v, k) => v - t[k]); const gm = gaps.reduce((p, q) => p + q, 0) / gaps.length;
        if (gm < 1.8 || gm > 3.5 || gaps.some((g) => Math.abs(g - gm) > 0.35 * gm)) continue;
        if (!bestLine || on.length > bestLine.length) bestLine = on;
      }
      if (!bestLine) return;
      const cx = grp.reduce((x, g) => x + g.cx, 0) / grp.length, cy = grp.reduce((x, g) => x + g.cy, 0) / grp.length;
      if (cands.some((k) => Math.hypot((k.cx - cx) * res, (k.cy - cy) * res) < 9)) return;
      const minx = Math.min(...grp.map((g) => g.cx - g.bw / 2)), maxx = Math.max(...grp.map((g) => g.cx + g.bw / 2)), miny = Math.min(...grp.map((g) => g.cy - g.bh / 2)), maxy = Math.max(...grp.map((g) => g.cy + g.bh / 2));
      cands.push({ cx, cy, posti: Math.max(1, Math.round(span / 2.6)), kind: 'gruppo', w: maxx - minx + 16, h: maxy - miny + 16, score: grp.length });
    });
    return { comps, strips, cands };
  }


  // l'intorno del candidato deve essere asfalto (grigio neutro, luminosità media): esclude alberi, prati, cortili in terra, tetti
  function asphaltAround(ctx, px, c, res) {
    const d = ctx.getImageData(0, 0, px, px).data;
    const x0 = Math.max(0, Math.round(c.cx - c.w / 2 - 2.5 / res)), x1 = Math.min(px - 1, Math.round(c.cx + c.w / 2 + 2.5 / res));
    const y0 = Math.max(0, Math.round(c.cy - c.h / 2 - 2.5 / res)), y1 = Math.min(px - 1, Math.round(c.cy + c.h / 2 + 2.5 / res));
    const ix0 = c.cx - c.w / 2, ix1 = c.cx + c.w / 2, iy0 = c.cy - c.h / 2, iy1 = c.cy + c.h / 2;
    let n = 0, grey = 0, green = 0, dark = 0, bright = 0;
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
      if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) continue;
      const i = (y * px + x) * 4; const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      n++;
      if (g > r * 1.06 && g > b * 1.06) green++;
      else if (mx < 0.22) dark++;
      else if (mx > 0.88) bright++;
      else if ((mx - mn) / Math.max(mx, 0.01) < 0.22 && mx >= 0.22 && mx <= 0.88) grey++;
    }
    if (!n) return { ok: false, grey: 0, green: 0 };
    return { ok: grey / n >= 0.5 && green / n <= 0.25, grey: grey / n, green: green / n };
  }

  // ======================================================================
  // CLASSIFICATORE (addestrato con tools/train_classifier.py): contesto attorno al candidato → probabilità stallo
  // Le caratteristiche devono restare identiche a features() in Python.
  // ======================================================================
  let MODEL = null;
  fetch('model.json?v=' + C.VERSION).then((r) => r.json()).then((m) => { MODEL = m; const el = $('#clf-info'); if (el) el.textContent = `Classificatore: addestrato su ${m.n_pos} stalli e ${m.n_neg} falsi (AUC ${m.cv_auc.toFixed(2)}, scarta ~${Math.round(m.cv_neg_rejected * 100)}% dei falsi tenendo il 90% dei veri).`; }).catch(() => { MODEL = null; });
  function clfFeatures(ctx, px, res) {
    const d = ctx.getImageData(0, 0, px, px).data, N = px * px;
    const mx = new Float32Array(N); const F = { paint_lo: new Uint8Array(N), paint_hi: new Uint8Array(N), green: new Uint8Array(N), grey: new Uint8Array(N), white: new Uint8Array(N), roof: new Uint8Array(N), dark: new Uint8Array(N) }; const yel = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255; const M = Math.max(r, g, b), m = Math.min(r, g, b); mx[i] = M;
      const sat = M > 0.01 ? (M - m) / Math.max(M, 0.01) : 0; const y = (r + g) / 2 - b; yel[i] = y; const rg = r >= 0.97 * g && r <= 1.10 * g;
      F.paint_lo[i] = y >= 0.035 && rg && M >= 0.55 ? 1 : 0; F.paint_hi[i] = y >= 0.07 && rg && M >= 0.55 ? 1 : 0;
      F.green[i] = g > r * 1.06 && g > b * 1.06 ? 1 : 0; F.grey[i] = sat < 0.22 && M >= 0.22 && M <= 0.82 ? 1 : 0; F.white[i] = sat < 0.15 && M > 0.82 ? 1 : 0;
      F.roof[i] = r > g * 1.18 && r > b * 1.25 ? 1 : 0; F.dark[i] = M < 0.22 ? 1 : 0;
    }
    const edge = new Uint8Array(N);
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
      const gx = x === 0 ? mx[y * px + 1] - mx[y * px] : x === px - 1 ? mx[y * px + x] - mx[y * px + x - 1] : (mx[y * px + x + 1] - mx[y * px + x - 1]) / 2;
      const gy = y === 0 ? mx[px + x] - mx[x] : y === px - 1 ? mx[y * px + x] - mx[(y - 1) * px + x] : (mx[(y + 1) * px + x] - mx[(y - 1) * px + x]) / 2;
      edge[y * px + x] = Math.hypot(gx, gy) > 0.08 ? 1 : 0;
    }
    const out = {}; const rings = MODEL ? MODEL.rings : [3, 6, 12];
    for (const R of rings) {
      let n = 0; const cnt = { paint_lo: 0, paint_hi: 0, green: 0, grey: 0, white: 0, roof: 0, dark: 0, edge: 0 }; let sv = 0, sv2 = 0, sy = 0;
      for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
        if (Math.hypot((x - px / 2 + 0.5) * res, (y - px / 2 + 0.5) * res) > R) continue;
        const i = y * px + x; n++; for (const k in F) cnt[k] += F[k][i]; cnt.edge += edge[i]; sv += mx[i]; sv2 += mx[i] * mx[i]; sy += yel[i];
      }
      n = Math.max(1, n); const tag = R.toFixed(1) + 'm';
      for (const k in cnt) out[`${k}_${tag}`] = cnt[k] / n;
      out[`v_mean_${tag}`] = sv / n; out[`v_std_${tag}`] = Math.sqrt(Math.max(0, sv2 / n - (sv / n) ** 2)); out[`yel_mean_${tag}`] = sy / n;
    }
    out.paint_ratio = out['paint_lo_3.0m'] / (out['paint_lo_12.0m'] + 1e-3);
    return out;
  }
  function clfScore(ctx, px, res) {
    if (!MODEL) return null; const f = clfFeatures(ctx, px, res); let z = MODEL.b;
    MODEL.names.forEach((nm, i) => { z += MODEL.w[i] * ((f[nm] - MODEL.mu[i]) / MODEL.sd[i]); });
    return 1 / (1 + Math.exp(-z));
  }
  // ritaglio 24x24 m a 10 cm/px centrato sul punto, poi punteggio (ruoto di 90° e faccio la media, come in addestramento)
  async function clfAt(lat, lon, src) {
    const { dLat, dLon } = mToDeg(lat); const got = await fetchCell(lat - 12 * dLat, lon - 12 * dLon, lat + 12 * dLat, lon + 12 * dLon, 240, src);
    let tot = 0; const cv = document.createElement('canvas'); cv.width = cv.height = 240; const c = cv.getContext('2d', { willReadFrequently: true });
    for (let k = 0; k < 4; k++) { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, 240, 240); c.translate(120, 120); c.rotate(k * Math.PI / 2); c.drawImage(got.cv, -120, -120); tot += clfScore(c, 240, 0.1); }
    return tot / 4;
  }
  // --- contesto OSM: analizzo solo strade e parcheggi, escludo gli edifici ---
  let ctxData = null; // { key, buildings:[[ [lon,lat],... ]], roads:[{pts,w}], parkings:[[...]] }
  async function loadContext(s0, w0, n0, e0, logFn) {
    const key = [s0, w0, n0, e0].map((x) => x.toFixed(4)).join(',');
    if (ctxData && ctxData.key === key) return ctxData;
    const bb = `${s0},${w0},${n0},${e0}`;
    const GREEN = '["landuse"~"^(grass|farmland|meadow|orchard|vineyard|forest|farmyard|greenhouse_horticulture|cemetery|allotments)$"]';
    const q = `[out:json][timeout:60];(way["building"](${bb});way["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road)$"](${bb});way["amenity"="parking"](${bb});relation["amenity"="parking"](${bb});way${GREEN}(${bb});relation${GREEN}(${bb});way["natural"~"^(wood|scrub|grassland|water|wetland|heath)$"](${bb});way["leisure"~"^(park|garden|pitch|playground)$"](${bb}););out geom;`;
    logFn(`Scarico contesto da OpenStreetMap (edifici, strade, parcheggi) per ${bb}…`);
    const els = await overpassFetch(bb, q, logFn);
    logFn(`  risposta: ${els.length} elementi` + (els.length ? ` (primo: ${els[0].type} ${Object.keys(els[0].tags || {}).slice(0, 3).join(',')}, geometria ${els[0].geometry ? els[0].geometry.length + ' punti' : 'assente'})` : ''));
    const d = { key, buildings: [], roads: [], parkings: [], green: [] };
    for (const el of els) {
      const pts = (el.geometry || []).map((p) => [p.lon, p.lat]);
      if (el.type === 'way' && el.tags) {
        if (el.tags.building) d.buildings.push(pts);
        else if (el.tags.amenity === 'parking') d.parkings.push(pts);
        else if (el.tags.landuse || el.tags.natural || el.tags.leisure) d.green.push(pts);
        else if (el.tags.highway) d.roads.push({ pts, w: /^(primary|secondary)$/.test(el.tags.highway) ? 22 : /^(tertiary|unclassified|residential|road)$/.test(el.tags.highway) ? 16 : 12 });
      } else if (el.type === 'relation' && el.members) {
        const isPark = el.tags && el.tags.amenity === 'parking';
        el.members.forEach((m) => { if (m.role === 'outer' && m.geometry) (isPark ? d.parkings : d.green).push(m.geometry.map((p) => [p.lon, p.lat])); });
      }
    }
    logFn(`  contesto: ${d.buildings.length} edifici, ${d.roads.length} strade, ${d.parkings.length} parcheggi, ${d.green.length} aree verdi/campi`);
    if (!d.roads.length && !d.parkings.length) { logFn('  contesto vuoto: lo ignoro e analizzo tutto il riquadro.'); return null; }
    ctxData = d; return d;
  }
  // maschera di contesto per un riquadro: 1 = analizzabile
  function contextMask(d, s, w, n, e, px, res) {
    const cv = document.createElement('canvas'); cv.width = cv.height = px; const c = cv.getContext('2d', { willReadFrequently: true });
    const X = (lon) => (lon - w) / (e - w) * px, Y = (lat) => (n - lat) / (n - s) * px;
    c.fillStyle = '#000'; c.fillRect(0, 0, px, px);
    c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineCap = 'round'; c.lineJoin = 'round';
    d.parkings.forEach((poly) => { c.beginPath(); poly.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.closePath(); c.fill(); c.lineWidth = 8 / res; c.stroke(); });
    d.roads.forEach((r) => { c.lineWidth = r.w / res; c.beginPath(); r.pts.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.stroke(); });
    c.fillStyle = '#000'; d.green.forEach((poly) => { c.beginPath(); poly.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.closePath(); c.fill(); });
    d.buildings.forEach((poly) => { c.beginPath(); poly.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1]))); c.closePath(); c.fill(); });
    const im = c.getImageData(0, 0, px, px).data; const m = new Uint8Array(px * px); let n1 = 0;
    for (let i = 0; i < px * px; i++) if (im[i * 4] > 127) { m[i] = 1; n1++; }
    return { mask: m, frac: n1 / (px * px) };
  }
  function applyContext(mask, cm) { for (let i = 0; i < mask.length; i++) if (!cm[i]) mask[i] = 0; }
  // --- taratura del colore giallo sul riquadro al centro ---
  let calib = null; // {cv, px, s,w,n,e}
  function showCalib(sens) {
    const pc = $('#s-canvas'); const px = calib.px; pc.width = px; pc.height = px; const pctx = pc.getContext('2d', { willReadFrequently: true }); pctx.drawImage(calib.cv, 0, 0);
    const ym = yellowMask(pctx, px, sens, calib.res);
    if (calib.ctx) { const cm = contextMask(calib.ctx, calib.s, calib.w, calib.n, calib.e, px, calib.res); applyContext(ym.mask, cm.mask); ym.count = ym.mask.reduce((a, b) => a + b, 0); calib.cm = cm.mask; }
    const det = detect(ym.mask, px, calib.res);
    const rejected = []; det.cands = det.cands.filter((c) => { const a = asphaltAround(pctx, px, c, calib.res); if (!a.ok) rejected.push(`${c.kind} (asfalto ${Math.round(a.grey * 100)}%, verde ${Math.round(a.green * 100)}%)`); return a.ok; });
    if (rejected.length) slog('  scartati per intorno non asfaltato: ' + rejected.join('; '));
    if (MODEL && det.cands.length) {
      Promise.all(det.cands.map((c) => { const lat = calib.n - (c.cy / px) * (calib.n - calib.s), lon = calib.w + (c.cx / px) * (calib.e - calib.w); return clfAt(lat, lon, 'proxy').then((p) => `${c.kind} ×${c.posti}: ${Math.round(p * 100)}%`).catch(() => `${c.kind}: n/d`); }))
        .then((t) => slog('  punteggio classificatore (soglia ' + Math.round(MODEL.threshold * 100) + '%): ' + t.join('; ')));
    }
    const im = pctx.getImageData(0, 0, px, px); for (let i = 0; i < px * px; i++) { if (calib.cm && !calib.cm[i]) { im.data[i * 4] = im.data[i * 4] * .45; im.data[i * 4 + 1] = im.data[i * 4 + 1] * .45; im.data[i * 4 + 2] = im.data[i * 4 + 2] * .45 + 60; } if (ym.mask[i]) { im.data[i * 4] = 255; im.data[i * 4 + 1] = 0; im.data[i * 4 + 2] = 255; } } pctx.putImageData(im, 0, 0);
    pctx.lineWidth = 2; pctx.strokeStyle = '#ffd400'; det.strips.forEach((c) => pctx.strokeRect(c.cx - c.bw / 2, c.cy - c.bh / 2, c.bw, c.bh));
    pctx.lineWidth = 4; pctx.strokeStyle = '#ff2d2d'; det.cands.forEach((c) => pctx.strokeRect(c.cx - c.w / 2, c.cy - c.h / 2, c.w, c.h));
    $('#s-prev').hidden = false;
    $('#s-prevtxt').textContent = `Riquadro di 100 m al centro, 10 cm/px. Pixel gialli: ${ym.count}. Soglia giallezza ≥ ${ym.th.yelMin.toFixed(3)}, contrasto ≥ ${ym.th.contrast.toFixed(2)}${ym.th.ref ? ' (da colore campionato)' : ' (predefinita)'}. In blu scuro le zone escluse (edifici, verde), in magenta i pixel gialli, in giallo le fasce riconosciute, in rosso i candidati. Clicca su una fascia gialla per usarla come riferimento.`;
    slog(`Taratura: ${ym.count} pixel gialli, ${det.strips.length} fasce, ${det.cands.length} candidati (${det.cands.map((c) => c.kind + ' ×' + c.posti).join(', ') || 'nessuno'}).`);
  }
  $('#s-cal').onclick = async () => {
    $('#s-cal').disabled = true; sStop = false;
    try {
      const c = map.getCenter(); const { dLat, dLon } = mToDeg(c.lat); const cellM = 100, res = 0.1, px = 1000;
      const s0 = c.lat - cellM / 2 * dLat, n0 = c.lat + cellM / 2 * dLat, w0 = c.lng - cellM / 2 * dLon, e0 = c.lng + cellM / 2 * dLon;
      let got = null;
      for (const src of ['fvg', 'proxy', 'esri']) { try { got = await fetchCell(s0, w0, n0, e0, px, src); got.ctx.getImageData(0, 0, 1, 1); slog('Taratura: sorgente ' + src); break; } catch (e) { got = null; slog(`  ${src}: ${e.message}`); } }
      if (!got) throw new Error('immagine non disponibile');
      calib = { cv: got.cv, px, res, s: s0, w: w0, n: n0, e: e0, ctx: null };
      try { calib.ctx = await loadContext(s0 - 0.002, w0 - 0.003, n0 + 0.002, e0 + 0.003, slog); } catch (e) { slog('Contesto OSM non disponibile (' + e.message + '): analizzo tutto il riquadro.'); }
      showCalib(+$('#s-sens').value);
    } catch (e) { slog('Errore taratura: ' + e.message); }
    $('#s-cal').disabled = false;
  };
  $('#s-canvas').addEventListener('click', (ev) => {
    if (!calib) return;
    const pc = $('#s-canvas'); const r = pc.getBoundingClientRect(); const x = Math.round((ev.clientX - r.left) * pc.width / r.width), y = Math.round((ev.clientY - r.top) * pc.height / r.height);
    const ctx = calib.cv.getContext('2d', { willReadFrequently: true }); const d = ctx.getImageData(Math.max(0, x - 1), Math.max(0, y - 1), 3, 3).data;
    let R = 0, G = 0, B = 0, n = 0; for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
    const rr = R / n / 255, gg = G / n / 255, bb = B / n / 255; const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb); const v = mx, sat = mx ? (mx - mn) / mx : 0;
    let h = 0; if (mx === mn) h = 0; else if (mx === rr) h = 60 * (((gg - bb) / (mx - mn)) % 6); else if (mx === gg) h = 60 * ((bb - rr) / (mx - mn) + 2); else h = 60 * ((rr - gg) / (mx - mn) + 4); if (h < 0) h += 360;
    const yel = (rr + gg) / 2 - bb;
    slog(`Colore campionato: RGB(${Math.round(R / n)},${Math.round(G / n)},${Math.round(B / n)}) → giallezza ${yel.toFixed(3)}, luminosità ${v.toFixed(2)}`);
    if (yel < 0.025 || rr < 0.9 * gg || gg < 0.75 * rr) { slog('  Non sembra vernice gialla: campiona esattamente sopra la fascia gialla.'); return; }
    try { localStorage.setItem('dp.yellow', JSON.stringify({ yel, v })); } catch (e) { /* ignora */ }
    slog('  Riferimento salvato: le soglie ora seguono questo colore. Rilancio l\'analisi…');
    showCalib(+$('#s-sens').value);
  });
  $('#s-reset').onclick = () => { try { localStorage.removeItem('dp.yellow'); } catch (e) { /* ignora */ } slog('Soglie riportate alle predefinite.'); if (calib) showCalib(+$('#s-sens').value); };
  $('#s-sens').addEventListener('input', () => { if (calib) showCalib(+$('#s-sens').value); });
  $('#s-go').onclick = async () => {
    $('#s-log').textContent = 'Preparo la scansione…\n'; $('#s-go').disabled = true; $('#s-go').textContent = 'Scansione in corso…'; $('#s-stop').hidden = false; sStop = false;
    const sens = +$('#s-sens').value;
    try {
      const b = map.getBounds(); let s0 = b.getSouth(), w0 = b.getWest(), n0 = b.getNorth(), e0 = b.getEast();
      const { dLat, dLon } = mToDeg((s0 + n0) / 2);
      const cellM = 120, res = 0.2, px = Math.round(cellM / res); // 120 m a 20 cm/px = 600 px
      const minSide = 720; // se la vista è più piccola, scansiono comunque 720 m attorno al centro
      if ((n0 - s0) < minSide * dLat || (e0 - w0) < minSide * dLon) { const c = map.getCenter(); s0 = c.lat - minSide / 2 * dLat; n0 = c.lat + minSide / 2 * dLat; w0 = c.lng - minSide / 2 * dLon; e0 = c.lng + minSide / 2 * dLon; slog(`Vista piccola: scansiono ${minSide} m attorno al centro.`); }
      const ny = Math.ceil((n0 - s0) / (cellM * dLat)), nx = Math.ceil((e0 - w0) / (cellM * dLon)); const tot = nx * ny;
      if (tot > 900) throw new Error(`Area troppo grande (${tot} riquadri): avvicina la mappa (zoom 15-16).`);
      // sorgente: 1) ortofoto FVG diretta, 2) ortofoto FVG via proxy Supabase, 3) satellite Esri
      let src = null;
      for (const cand of [['fvg', 'TrueOrtofoto FVG 2020 (diretta)'], ['proxy', 'TrueOrtofoto FVG 2020 (via proxy Supabase)'], ['esri', 'satellite Esri (meno nitido)']]) {
        try { const t = await fetchCell(s0, w0, s0 + cellM * dLat, w0 + cellM * dLon, 64, cand[0]); t.ctx.getImageData(0, 0, 1, 1); src = cand[0]; slog('Sorgente: ' + cand[1]); break; }
        catch (e) { slog(`  ${cand[1]}: non disponibile (${e.message})`); }
      }
      if (!src) throw new Error('Nessuna sorgente immagini disponibile');
      let ctxd = null;
      try { ctxd = await loadContext(s0 - 0.002, w0 - 0.003, n0 + 0.002, e0 + 0.003, slog); } catch (e) { slog('Contesto OSM non disponibile (' + e.message + '): analizzo tutto, aspettati più falsi positivi.'); }
      slog(`Scansiono ${tot} riquadri da ${cellM} m…`);
      let best = null, skipped = 0, asphRej = 0; $('#s-prev').hidden = true;
      const found = []; let done = 0;
      const known = cands.filter((c) => c.stato !== 'scartato');
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        if (sStop) throw new Error('Interrotto');
        const cs = s0 + iy * cellM * dLat, cw = w0 + ix * cellM * dLon, cn = cs + cellM * dLat, ce = cw + cellM * dLon;
        let cm = null;
        if (ctxd) { cm = contextMask(ctxd, cs, cw, cn, ce, px, res); if (cm.frac < 0.01) { skipped++; done++; continue; } }
        let cellImg; try { cellImg = await fetchCell(cs, cw, cn, ce, px, src); } catch (e) { done++; continue; }
        const ym = yellowMask(cellImg.ctx, px, sens, res); if (cm) applyContext(ym.mask, cm.mask);
        const det = detect(ym.mask, px, res);
        if (!best || ym.count > best.count) best = { count: ym.count, mask: ym.mask, cv: cellImg.cv };
        for (const c of det.cands) {
          if (!asphaltAround(cellImg.ctx, px, c, res).ok) { asphRej++; continue; }
          const lat = cn - (c.cy / px) * (cn - cs), lon = cw + (c.cx / px) * (ce - cw);
          if (rows.some((r) => r.stato !== 'rifiutato' && map.distance([r.lat, r.lon], [lat, lon]) <= 12)) continue;
          if (known.some((k) => map.distance([k.lat, k.lon], [lat, lon]) <= 12)) continue;
          if (found.some((k) => map.distance([k.lat, k.lon], [lat, lon]) <= 8)) continue;
          const half = Math.round(14 / res); const cx = Math.round(c.cx), cy = Math.round(c.cy);
          const crop = document.createElement('canvas'); crop.width = crop.height = half * 2; const cctx = crop.getContext('2d');
          cctx.drawImage(cellImg.cv, cx - half, cy - half, half * 2, half * 2, 0, 0, half * 2, half * 2);
          cctx.strokeStyle = '#ff2d2d'; cctx.lineWidth = 3; cctx.strokeRect(half - c.w / 2, half - c.h / 2, c.w, c.h);
          const blob = await new Promise((r) => crop.toBlob(r, 'image/jpeg', .85));
          found.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), blob, posti: c.posti, kind: c.kind, score: null });
        }
        done++; if (done % 10 === 0 || done === tot) slog(`  ${done}/${tot} riquadri · candidati finora: ${found.length}`);
      }
      if (best) {
        const pc = $('#s-canvas'); pc.width = px; pc.height = px; const pctx = pc.getContext('2d'); pctx.drawImage(best.cv, 0, 0);
        const im = pctx.getImageData(0, 0, px, px); for (let i = 0; i < px * px; i++) if (best.mask[i]) { im.data[i * 4] = 255; im.data[i * 4 + 1] = 0; im.data[i * 4 + 2] = 255; } pctx.putImageData(im, 0, 0);
        $('#s-prev').hidden = false; slog(`Pixel gialli nel riquadro più ricco: ${best.count} (su ${px * px}).`);
      }
      if (skipped) slog(`Riquadri saltati perché senza strade/parcheggi: ${skipped}.`);
      if (asphRej) slog(`Scartati perché non circondati da asfalto: ${asphRej}.`);
      let keep = found;
      if (MODEL && $('#clf-on').checked && found.length) {
        const thr = MODEL.threshold * (1 - (+$('#s-sens').value - 3) * 0.12);
        slog(`Classificatore: valuto ${found.length} candidati (soglia ${Math.round(thr * 100)}%)…`); keep = []; let k = 0;
        for (const f of found) {
          if (sStop) throw new Error('Interrotto');
          try { f.score = await clfAt(f.lat, f.lon, src); } catch (e) { f.score = null; }
          if (f.score == null || f.score >= thr) keep.push(f);
          if (++k % 10 === 0) slog(`  ${k}/${found.length} · tenuti ${keep.length}`);
        }
        slog(`Classificatore: tenuti ${keep.length} su ${found.length}.`);
      }
      keep = keep.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)); found.length = 0; keep.forEach((f) => found.push(f));
      slog(`Candidati finali: ${found.length}. Salvo…`);
      let saved = 0;
      for (const f of found) {
        const path = `sat/${f.lat}_${f.lon}.jpg`;
        const { error: ue } = await sb.storage.from('foto').upload(path, f.blob, { contentType: 'image/jpeg', upsert: true });
        const url = ue ? null : sb.storage.from('foto').getPublicUrl(path).data.publicUrl;
        const { error } = await sb.from('candidati').upsert({ ext_id: `sat/${f.lat},${f.lon}`, fonte: 'satellite', classe: `segnaletica gialla (${f.kind}, ~${f.posti} posti${f.score != null ? `, punteggio ${Math.round(f.score * 100)}%` : ''})`, lat: f.lat, lon: f.lon, comune: null, note: url, stato: 'nuovo' }, { onConflict: 'ext_id', ignoreDuplicates: true });
        if (!error) saved++;
      }
      slog(`Salvati ${saved} candidati. Ora rivedili uno per uno: "Da verificare".`);
      await loadCands(); cfilter = 'nuovo'; renderCands();
    } catch (e) { slog((sStop ? 'Fermato: ' : 'Errore: ') + (e.message || e)); }
    $('#s-go').disabled = false; $('#s-go').textContent = 'Scansiona area visibile'; $('#s-stop').hidden = true; sStop = false;
  };


  // --- scheda dei candidati: montaggio dei ritagli in un'unica immagine scaricabile (debug / esempi) ---
  $('#cand-sheet').onclick = async () => {
    const v = cands.filter((c) => c.stato === cfilter && c.note && /^https?:/.test(c.note)).slice(0, 60);
    if (!v.length) { alert('Nessun candidato con ritaglio in questo stato.'); return; }
    const cols = 6, cell = 220, rows = Math.ceil(v.length / cols);
    const cv = document.createElement('canvas'); cv.width = cols * cell; cv.height = rows * (cell + 22); const c = cv.getContext('2d'); c.fillStyle = '#111'; c.fillRect(0, 0, cv.width, cv.height);
    c.font = '13px sans-serif'; c.fillStyle = '#fff'; let ok = 0;
    await Promise.all(v.map((cd, i) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => { const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + 22); c.drawImage(im, x, y, cell, cell); c.fillStyle = '#fff'; c.fillText(`#${i + 1} ${cd.classe || ''}`.slice(0, 34), x + 4, y + cell + 15); ok++; res(); }; im.onerror = () => res(); im.src = cd.note; })));
    cv.toBlob((blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `candidati-${cfilter}-${new Date().toISOString().slice(0, 10)}.jpg`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); }, 'image/jpeg', .85);
  };
  $('#cand-clear').onclick = async () => {
    const n = cands.filter((c) => c.stato === 'nuovo' && c.fonte === 'satellite').length; if (!n) return;
    if (!confirm(`Scartare tutti i ${n} candidati "nuovi" dello scanner ortofoto? (quelli Mapillary restano)`)) return;
    const { error } = await sb.from('candidati').update({ stato: 'scartato' }).eq('stato', 'nuovo').eq('fonte', 'satellite');
    if (error) alert(error.message); else loadCands();
  };


  // --- esporta dataset v2: ritagli degli stalli etichettati (con i punti cliccati) + candidati scartati ---
  async function loadJSZip() { if (!window.JSZip) await new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); }
  async function cropBox(lat, lon, sideM, px) {
    const { dLat, dLon } = mToDeg(lat); const h = sideM / 2;
    const b = { s: lat - h * dLat, n: lat + h * dLat, w: lon - h * dLon, e: lon + h * dLon };
    const got = await fetchCell(b.s, b.w, b.n, b.e, px, 'proxy'); return Object.assign(b, { cv: got.cv, px });
  }
  $('#ds-export').onclick = async () => {
    const btn = $('#ds-export'); btn.disabled = true; const log = (m) => { $('#ds-log').textContent += m + '\n'; }; $('#ds-log').textContent = '';
    try {
      await loadJSZip(); const zip = new JSZip(); const items = [];
      const { data: labs, error } = await sb.from('etichette').select('*'); if (error) throw new Error(error.message + ' — hai eseguito 04_etichette.sql?');
      const good = labs.filter((l) => l.esito === 'stalli' && l.punti.length);
      log(`Etichette con stalli: ${good.length} (punti totali ${good.reduce((a, l) => a + l.punti.length, 0)}) · non visibili: ${labs.length - good.length}`);
      let i = 0;
      for (const l of good) {
        try {
          const px = Math.round(l.crop_m * 10); const c = await cropBox(l.centro_lat, l.centro_lon, l.crop_m, px);
          const pts = l.punti.map(([la, lo]) => [Math.round((lo - c.w) / (c.e - c.w) * px * 10) / 10, Math.round((c.n - la) / (c.n - c.s) * px * 10) / 10]);
          zip.file(`img/lab-${l.ref_id}.jpg`, await new Promise((r) => c.cv.toBlob(r, 'image/jpeg', .92)));
          items.push({ id: `lab-${l.ref_id}`, kind: 'label', crop_m: l.crop_m, px, points: pts, lat: l.centro_lat, lon: l.centro_lon });
        } catch (e) { log('  salto ' + l.ref_id + ': ' + e.message); }
        if (++i % 20 === 0) log(`  ${i}/${good.length}`);
      }
      const neg = cands.filter((c) => c.stato === 'scartato'); log(`Candidati scartati (negativi puri): ${neg.length}`); i = 0;
      for (const c of neg) {
        try { const cb = await cropBox(c.lat, c.lon, 24, 240); zip.file(`img/neg-${c.id}.jpg`, await new Promise((r) => cb.cv.toBlob(r, 'image/jpeg', .9))); items.push({ id: `neg-${c.id}`, kind: 'neg', crop_m: 24, px: 240, points: [], lat: c.lat, lon: c.lon, fonte: c.fonte }); } catch (e) { /* salto */ }
        if (++i % 40 === 0) log(`  ${i}/${neg.length}`);
      }
      zip.file('meta.json', JSON.stringify({ version: 2, exported: new Date().toISOString(), res_m: 0.1, items }, null, 1));
      log('Comprimo…'); const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `dataset-v2-${new Date().toISOString().slice(0, 10)}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      log(`Fatto: ${items.filter((x) => x.kind === 'label').length} ritagli etichettati, ${items.filter((x) => x.kind === 'neg').length} negativi.`);
    } catch (e) { log('Errore: ' + (e.message || e)); }
    btn.disabled = false;
  };

  // ======================================================================
  // ETICHETTATURA: posizione esatta dei posti riservati sull'ortofoto
  // ======================================================================
  let labQueue = [], labIdx = 0, labCur = null, labPts = [], labBox = null, labDone = new Map(), labZoom = false; const labCache = new Map();
  // vista: in zoom mostro i 20 m centrali; i punti restano in coordinate del ritaglio intero (0-400)
  const v2c = ([x, y]) => (labZoom ? [(x - 100) * 2, (y - 100) * 2] : [x, y]);
  const c2v = (x, y) => (labZoom ? [100 + x / 2, 100 + y / 2] : [x, y]);
  const isLabTarget = (r) => ['verificato', 'ufficiale'].includes(r.stato);
  const labSide = (r) => (/Parcheggio con posti/.test(r.nome || '') ? 60 : 40);
  async function loadLabels() {
    const { data, error } = await sb.from('etichette').select('ref_id,esito,punti');
    if (error) { $('#lab-status').textContent = 'Errore: ' + error.message + ' — esegui supabase/04_etichette.sql'; return false; }
    labDone = new Map(data.map((e) => [e.ref_id, e])); labCount(); return true;
  }
  function labCount() {
    const t = rows.filter(isLabTarget); const d = t.filter((r) => labDone.has(r.id));
    const pts = [...labDone.values()].reduce((a, e) => a + (e.punti ? e.punti.length : 0), 0);
    $('#lab-count').textContent = `· ${d.length}/${t.length} etichettati · ${pts} posti cliccati`;
  }
  function labFetch(r) {
    if (!labCache.has(r.id)) { const side = labSide(r); labCache.set(r.id, cropBox(r.lat, r.lon, side, 400).then((b) => Object.assign(b, { side })).catch((e) => { labCache.delete(r.id); throw e; })); }
    return labCache.get(r.id);
  }
  function labDraw() {
    const cv = $('#lab-canvas'), c = cv.getContext('2d'); c.clearRect(0, 0, 400, 400);
    if (labBox) { if (labZoom) c.drawImage(labBox.cv, 100, 100, 200, 200, 0, 0, 400, 400); else c.drawImage(labBox.cv, 0, 0, 400, 400); }
    c.lineWidth = 2; c.strokeStyle = '#2d7bff'; c.fillStyle = 'rgba(45,123,255,.9)'; c.beginPath(); c.arc(200, 200, 4, 0, 7); c.fill();
    labPts.map(v2c).forEach(([x, y], i) => { c.strokeStyle = '#ff2d2d'; c.lineWidth = 3; c.beginPath(); c.arc(x, y, 11, 0, 7); c.stroke(); c.fillStyle = '#ff2d2d'; c.beginPath(); c.arc(x, y, 2.5, 0, 7); c.fill(); c.font = 'bold 13px sans-serif'; c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 3; c.strokeText(String(i + 1), x + 12, y - 8); c.fillText(String(i + 1), x + 12, y - 8); });
    if (labBox) { c.font = '12px sans-serif'; c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 3; const t = `${labZoom ? labBox.side / 2 : labBox.side} m${labZoom ? ' (zoom 2×)' : ''} · ${labPts.length} posti`; c.strokeText(t, 8, 392); c.fillText(t, 8, 392); }
  }
  const toLL = ([x, y]) => [+(labBox.n - (y / 400) * (labBox.n - labBox.s)).toFixed(7), +(labBox.w + (x / 400) * (labBox.e - labBox.w)).toFixed(7)];
  const toPx = ([la, lo]) => [(lo - labBox.w) / (labBox.e - labBox.w) * 400, (labBox.n - la) / (labBox.n - labBox.s) * 400];
  async function labShow() {
    if (labIdx >= labQueue.length) { $('#lab-area').hidden = true; $('#lab-status').textContent = `Finito: ${labQueue.length} stalli rivisti. Ora puoi esportare il dataset.`; labCount(); return; }
    labCur = labQueue[labIdx]; labBox = null; labPts = []; labDraw();
    $('#lab-sv').href = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${labCur.lat},${labCur.lon}`;
    $('#lab-gs').href = `https://www.google.com/maps/@${labCur.lat},${labCur.lon},45m/data=!3m1!1e3`;
    $('#lab-title').textContent = `${labIdx + 1} / ${labQueue.length} · ${labCur.nome || labCur.indirizzo || labCur.tipo} · ${labCur.comune || ''} · fonte ${labCur.fonte} · carico l'ortofoto…`;
    try { labBox = await labFetch(labCur); } catch (e) { $('#lab-title').textContent += ' errore: ' + e.message + ' (premi S per saltare)'; return; }
    const prev = labDone.get(labCur.id); if (prev && prev.punti) labPts = prev.punti.map(toPx);
    $('#lab-title').textContent = `${labIdx + 1} / ${labQueue.length} · ${labCur.nome || labCur.indirizzo || labCur.tipo} · ${labCur.comune || ''} · fonte ${labCur.fonte}${prev ? ' · già etichettato: ' + prev.esito : ''}`;
    labDraw();
    for (let k = 1; k <= 3; k++) if (labQueue[labIdx + k]) labFetch(labQueue[labIdx + k]).catch(() => {});
  }
  async function labSave(esito) {
    if (!labCur || !labBox) return;
    const rec = { ref_id: labCur.id, centro_lat: labCur.lat, centro_lon: labCur.lon, crop_m: labBox.side, esito: esito || (labPts.length ? 'stalli' : 'non_visibile'), punti: (esito === 'non_visibile' ? [] : labPts).map(toLL) };
    const { error } = await sb.from('etichette').upsert(rec, { onConflict: 'ref_id' });
    if (error) { $('#lab-status').textContent = 'Errore nel salvataggio: ' + error.message; return; }
    labDone.set(labCur.id, rec); labCount(); labCache.delete(labCur.id); labIdx++; labShow();
  }
  $('#lab-start').onclick = async () => {
    if (!(await loadLabels())) return; const redo = $('#lab-redo').checked;
    labQueue = rows.filter(isLabTarget).filter((r) => redo || !labDone.has(r.id)).sort((a, b) => (a.comune || '').localeCompare(b.comune || '') || b.lat - a.lat);
    labIdx = 0; if (!labQueue.length) { $('#lab-status').textContent = 'Tutti gli stalli sono già etichettati.'; return; }
    $('#lab-status').textContent = ''; $('#lab-area').hidden = false; $('#lab-box').open = true; labShow();
  };
  $('#lab-canvas').addEventListener('click', (e) => { if (!labBox) return; const r = e.currentTarget.getBoundingClientRect(); labPts.push(c2v((e.clientX - r.left) * 400 / r.width, (e.clientY - r.top) * 400 / r.height)); labDraw(); });
  $('#lab-canvas').addEventListener('contextmenu', (e) => { e.preventDefault(); if (!labPts.length) return; const r = e.currentTarget.getBoundingClientRect(); const [x, y] = c2v((e.clientX - r.left) * 400 / r.width, (e.clientY - r.top) * 400 / r.height); let bi = 0, bd = 1e9; labPts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bi = i; } }); labPts.splice(bi, 1); labDraw(); });
  $('#lab-undo').onclick = () => { labPts.pop(); labDraw(); };
  $('#lab-zoom').onclick = () => { labZoom = !labZoom; $('#lab-zoom').classList.toggle('active', labZoom); labDraw(); };
  $('#lab-save').onclick = () => labSave();
  $('#lab-none').onclick = () => labSave('non_visibile');
  $('#lab-skip').onclick = () => { labIdx++; labShow(); };
  $('#lab-back').onclick = () => { if (labIdx > 0) { labIdx--; labShow(); } };
  document.addEventListener('keydown', (e) => {
    if ($('#lab-area').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'Enter') { e.preventDefault(); labSave(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); labSave('non_visibile'); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); labIdx++; labShow(); }
    else if (e.key === 'Backspace') { e.preventDefault(); labPts.pop(); labDraw(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (labIdx > 0) { labIdx--; labShow(); } }
    else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); $('#lab-sv').click(); }
    else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); $('#lab-gs').click(); }
    else if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); $('#lab-zoom').click(); }
  });

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
  $('#ctx-go').onclick = async () => {
    const area = $('#i-area').value.trim(); if (!area) { $('#i-log').textContent = 'Scrivi prima il nome del comune nella casella qui sopra.'; return; }
    const btn = $('#ctx-go'); btn.disabled = true; $('#i-log').textContent = '';
    try {
      ilog(`Cerco il confine di "${area}"…`);
      const b = await comuneBoundary(area, chosen); if (!b) throw new Error('Comune non trovato');
      ilog(`  ${b.label}: ${b.bbox}`);
      const q = `[out:json][timeout:300];(way["building"](${b.bbox});way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${b.bbox});way["amenity"="parking"](${b.bbox}););out geom qt;`;
      let els = null;
      for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
        ilog(`Scarico da ${new URL(url).host} (può richiedere 1–4 minuti)…`);
        try { const r = await overpassOnce(url, null, 320000, q); els = r.els; ilog(`  ${els.length} elementi in ${Math.round(r.ms / 1000)} s`); break; } catch (e) { ilog('  ' + e.message); }
      }
      if (!els) throw new Error('Overpass non ha risposto: riprova più tardi.');
      const r5 = (x) => Math.round(x * 1e5) / 1e5; const out = { comune: b.label, bbox: b.bbox, creato: new Date().toISOString(), edifici: [], strade: [], parcheggi: [] };
      for (const el of els) {
        if (!el.geometry || !el.tags) continue; const pts = el.geometry.map((p) => [r5(p.lat), r5(p.lon)]);
        if (el.tags.building) out.edifici.push(pts);
        else if (el.tags.amenity === 'parking') out.parcheggi.push(pts);
        else if (el.tags.highway) out.strade.push(pts);
      }
      ilog(`Edifici ${out.edifici.length} · strade ${out.strade.length} · parcheggi ${out.parcheggi.length}. Salvo…`);
      const slug = b.label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-');
      const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
      const path = `contesto/${slug}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
      const { error } = await sb.storage.from('foto').upload(path, blob, { contentType: 'application/json' });
      if (error) throw error;
      ilog(`Fatto: ${path} (${(blob.size / 1e6).toFixed(1)} MB). Ora la scansione di ${b.label} può usarlo.`);
    } catch (e) { ilog('Errore: ' + (e.message || e)); }
    btn.disabled = false;
  };

  $('#ver').textContent = 'v' + C.VERSION;
  boot();
})();
