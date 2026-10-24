(function () {
  'use strict';
  const C = window.DP_CONFIG; const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const TIPO = { generico: 'Generico', personalizzato: 'Personalizzato', sconosciuto: 'Sconosciuto' };
  let rows = [], filter = 'proposto', sel = null, map, layer, markers = new Map();

  // ---------- auth ----------
  async function session() { const { data } = await sb.auth.getSession(); return data.session; }
  async function boot() { const s = await session(); if (s) { $('#login').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false; initMap(); load(); } }
  $('#l-in').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : ''; if (!error) boot(); };
  $('#l-up').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signUp({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : 'Registrazione inviata: se Supabase richiede la conferma, controlla la posta e poi premi "Entra".'; };
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.reload(); };

  // ---------- mappa ----------
  function initMap() {
    if (map) return;
    map = L.map('amap').setView([C.HOME.lat, C.HOME.lon], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
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

  $('#ver').textContent = 'v' + C.VERSION;
  boot();
})();
