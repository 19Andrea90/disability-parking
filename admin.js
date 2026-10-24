(function () {
  'use strict';
  const C = window.DP_CONFIG; const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const TIPO = { generico: 'Generico', personalizzato: 'Personalizzato', sconosciuto: 'Sconosciuto' };
  let rows = [], filter = 'proposto', sel = null, map, layer, markers = new Map();

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
    rows = data; kpi(); render();
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
  const checkStop = () => { if (stopReq) throw new Error('Interrotto dall\'utente'); };
  async function overpassOnce(url, bb, timeoutMs) {
    const ctl = new AbortController(); activeCtl = ctl; const to = setTimeout(() => ctl.abort(), timeoutMs); const t0 = Date.now();
    try {
      checkStop();
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(osmQuery(bb)), signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.remark && /timed out|error/i.test(j.remark)) throw new Error('server: ' + j.remark.slice(0, 80));
      return { els: j.elements, ms: Date.now() - t0 };
    } catch (e) { if (stopReq) throw new Error('Interrotto dall\'utente'); if (e.name === 'AbortError') throw new Error(`nessuna risposta entro ${Math.round(timeoutMs / 1000)} s`); throw e; }
    finally { clearTimeout(to); activeCtl = null; }
  }
  async function overpassFetch(bb) {
    let lastErr = null;
    for (let round = 0; round < 3; round++) {
      for (const url of OVERPASS) {
        const host = new URL(url).host;
        try { const { els, ms } = await overpassOnce(url, bb, round === 0 ? 45000 : 75000); ilog(`    ${host}: ${els.length} elementi in ${Math.round(ms / 1000)} s`); return els; }
        catch (e) { if (stopReq) throw e; lastErr = e; ilog(`    ${host}: ${e.message}`); if (/HTTP 429|HTTP 50/.test(e.message)) await sleep(4000); }
      }
      checkStop();
      const wait = 20 * (round + 1); ilog(`  tutti i server occupati: riprovo tra ${wait} s (tentativo ${round + 2}/3)…`); for (let t = 0; t < wait; t++) { checkStop(); await sleep(1000); }
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
  let sStop = false;
  $('#s-stop').onclick = () => { sStop = true; };
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
    if (ref && ref.yel != null) return { yelMin: Math.max(0.03, ref.yel * [0.95, 0.85, 0.75, 0.65, 0.55][sens - 1]), valMin: 0.6, ref: true };
    return { yelMin: base, valMin: 0.6, ref: false };
  }
  function yellowMask(ctx, px, sens) {
    const d = ctx.getImageData(0, 0, px, px).data; const mask = new Uint8Array(px * px); const th = thresholds(sens); let count = 0;
    for (let i = 0; i < px * px; i++) {
      const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
      const v = Math.max(r, g, b); if (v < th.valMin) continue;
      if (((r + g) / 2 - b) < th.yelMin) continue;      // deficit di blu
      if (r < 0.98 * g || r > 1.12 * g) continue;        // giallo: rosso ≈ verde (esclude verde dei cespugli e rosa degli attraversamenti)
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
    return { comps, strips, cands };
  }
  // --- taratura del colore giallo sul riquadro al centro ---
  let calib = null; // {cv, px, s,w,n,e}
  function showCalib(sens) {
    const pc = $('#s-canvas'); const px = calib.px; pc.width = px; pc.height = px; const pctx = pc.getContext('2d', { willReadFrequently: true }); pctx.drawImage(calib.cv, 0, 0);
    const ym = yellowMask(pctx, px, sens); const det = detect(ym.mask, px, calib.res);
    const im = pctx.getImageData(0, 0, px, px); for (let i = 0; i < px * px; i++) if (ym.mask[i]) { im.data[i * 4] = 255; im.data[i * 4 + 1] = 0; im.data[i * 4 + 2] = 255; } pctx.putImageData(im, 0, 0);
    pctx.lineWidth = 2; pctx.strokeStyle = '#ffd400'; det.strips.forEach((c) => pctx.strokeRect(c.cx - c.bw / 2, c.cy - c.bh / 2, c.bw, c.bh));
    pctx.lineWidth = 4; pctx.strokeStyle = '#ff2d2d'; det.cands.forEach((c) => pctx.strokeRect(c.cx - c.w / 2, c.cy - c.h / 2, c.w, c.h));
    $('#s-prev').hidden = false;
    $('#s-prevtxt').textContent = `Riquadro di 100 m al centro, 10 cm/px. Pixel gialli: ${ym.count}. Soglia giallezza ≥ ${ym.th.yelMin.toFixed(3)}${ym.th.ref ? ' (da colore campionato)' : ' (predefinita)'}. In magenta i pixel gialli, in giallo le fasce riconosciute, in rosso i candidati. Clicca su una fascia gialla per usarla come riferimento.`;
    slog(`Taratura: ${ym.count} pixel gialli, ${det.strips.length} fasce, ${det.cands.length} candidati (${det.cands.map((c) => c.kind + ' ×' + c.posti).join(', ') || 'nessuno'}).`);
  }
  $('#s-cal').onclick = async () => {
    $('#s-cal').disabled = true;
    try {
      const c = map.getCenter(); const { dLat, dLon } = mToDeg(c.lat); const cellM = 100, res = 0.1, px = 1000;
      const s0 = c.lat - cellM / 2 * dLat, n0 = c.lat + cellM / 2 * dLat, w0 = c.lng - cellM / 2 * dLon, e0 = c.lng + cellM / 2 * dLon;
      let got = null;
      for (const src of ['fvg', 'proxy', 'esri']) { try { got = await fetchCell(s0, w0, n0, e0, px, src); got.ctx.getImageData(0, 0, 1, 1); slog('Taratura: sorgente ' + src); break; } catch (e) { got = null; slog(`  ${src}: ${e.message}`); } }
      if (!got) throw new Error('immagine non disponibile');
      calib = { cv: got.cv, px, res, s: s0, w: w0, n: n0, e: e0 };
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
    $('#s-log').textContent = ''; $('#s-go').disabled = true; $('#s-stop').hidden = false; sStop = false;
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
      slog(`Scansiono ${tot} riquadri da ${cellM} m…`);
      let best = null; $('#s-prev').hidden = true;
      const found = []; let done = 0;
      const known = cands.filter((c) => c.stato !== 'scartato');
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        if (sStop) throw new Error('Interrotto');
        const cs = s0 + iy * cellM * dLat, cw = w0 + ix * cellM * dLon, cn = cs + cellM * dLat, ce = cw + cellM * dLon;
        let cellImg; try { cellImg = await fetchCell(cs, cw, cn, ce, px, src); } catch (e) { done++; continue; }
        const ym = yellowMask(cellImg.ctx, px, sens); const det = detect(ym.mask, px, res);
        if (!best || ym.count > best.count) best = { count: ym.count, mask: ym.mask, cv: cellImg.cv };
        for (const c of det.cands) {
          const lat = cn - (c.cy / px) * (cn - cs), lon = cw + (c.cx / px) * (ce - cw);
          if (rows.some((r) => r.stato !== 'rifiutato' && map.distance([r.lat, r.lon], [lat, lon]) <= 12)) continue;
          if (known.some((k) => map.distance([k.lat, k.lon], [lat, lon]) <= 12)) continue;
          if (found.some((k) => map.distance([k.lat, k.lon], [lat, lon]) <= 8)) continue;
          const half = Math.round(14 / res); const cx = Math.round(c.cx), cy = Math.round(c.cy);
          const crop = document.createElement('canvas'); crop.width = crop.height = half * 2; const cctx = crop.getContext('2d');
          cctx.drawImage(cellImg.cv, cx - half, cy - half, half * 2, half * 2, 0, 0, half * 2, half * 2);
          cctx.strokeStyle = '#ff2d2d'; cctx.lineWidth = 3; cctx.strokeRect(half - c.w / 2, half - c.h / 2, c.w, c.h);
          const blob = await new Promise((r) => crop.toBlob(r, 'image/jpeg', .85));
          found.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), blob, posti: c.posti, kind: c.kind });
        }
        done++; if (done % 10 === 0 || done === tot) slog(`  ${done}/${tot} riquadri · candidati finora: ${found.length}`);
      }
      if (best) {
        const pc = $('#s-canvas'); pc.width = px; pc.height = px; const pctx = pc.getContext('2d'); pctx.drawImage(best.cv, 0, 0);
        const im = pctx.getImageData(0, 0, px, px); for (let i = 0; i < px * px; i++) if (best.mask[i]) { im.data[i * 4] = 255; im.data[i * 4 + 1] = 0; im.data[i * 4 + 2] = 255; } pctx.putImageData(im, 0, 0);
        $('#s-prev').hidden = false; slog(`Pixel gialli nel riquadro più ricco: ${best.count} (su ${px * px}).`);
      }
      slog(`Trovati ${found.length} candidati. Salvo…`);
      let saved = 0;
      for (const f of found) {
        const path = `sat/${f.lat}_${f.lon}.jpg`;
        const { error: ue } = await sb.storage.from('foto').upload(path, f.blob, { contentType: 'image/jpeg', upsert: true });
        const url = ue ? null : sb.storage.from('foto').getPublicUrl(path).data.publicUrl;
        const { error } = await sb.from('candidati').upsert({ ext_id: `sat/${f.lat},${f.lon}`, fonte: 'satellite', classe: `segnaletica gialla (${f.kind}, ~${f.posti} posti)`, lat: f.lat, lon: f.lon, comune: null, note: url, stato: 'nuovo' }, { onConflict: 'ext_id', ignoreDuplicates: true });
        if (!error) saved++;
      }
      slog(`Salvati ${saved} candidati. Ora rivedili uno per uno: "Da verificare".`);
      await loadCands(); cfilter = 'nuovo'; renderCands();
    } catch (e) { slog('Errore: ' + (e.message || e)); }
    $('#s-go').disabled = false; $('#s-stop').hidden = true;
  };

  $('#ver').textContent = 'v' + C.VERSION;
  boot();
})();
