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
  const OVERPASS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass-api.de/api/interpreter'];
  const ilog = (m) => { $('#i-log').textContent += m + '\n'; };
  function osmQuery(bb) { // bb = "sud,ovest,nord,est"
    return `[out:json][timeout:90];(
      nwr["amenity"="parking_space"]["parking_space"="disabled"](${bb});
      nwr["amenity"="parking_space"]["disabled"~"^(yes|designated)$"](${bb});
      nwr["amenity"="parking"]["capacity:disabled"](${bb});
      nwr["amenity"="parking"]["disabled"~"^(yes|designated)$"](${bb}););out center tags;`;
  }
  // confine del comune da Nominatim (rettangolo + poligono)
  async function comuneBoundary(name) {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=it&polygon_geojson=1&q=${encodeURIComponent(name)}`, { headers: { 'Accept-Language': 'it' } });
    const j = await r.json();
    const hit = j.find((x) => x.class === 'boundary' && x.type === 'administrative') || j.find((x) => x.geojson && /Polygon/.test(x.geojson.type));
    if (!hit) return null;
    const bb = hit.boundingbox.map(Number); // [sud, nord, ovest, est]
    return { bbox: `${bb[0]},${bb[2]},${bb[1]},${bb[3]}`, geojson: hit.geojson, label: hit.display_name.split(',')[0] };
  }
  function inRing(ring, lon, lat) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c; } return c; }
  function inside(geo, lon, lat) {
    if (!geo) return true;
    const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : null; if (!polys) return true;
    return polys.some((p) => inRing(p[0], lon, lat) && !p.slice(1).some((h) => inRing(h, lon, lat)));
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
  $('#i-go').onclick = async () => {
    const area = $('#i-area').value.trim(); if (!area) return; $('#i-log').textContent = ''; $('#i-go').disabled = true;
    try {
      ilog(`Cerco il confine di "${area}"…`);
      const b = await comuneBoundary(area);
      if (!b) throw new Error(`Comune "${area}" non trovato: prova con il nome esatto (es. "Udine")`);
      ilog(`  confine trovato: ${b.label}`);
      let json = null;
      for (const url of OVERPASS) {
        ilog(`Interrogo ${new URL(url).host}…`);
        const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 95000); const t0 = Date.now();
        try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(osmQuery(b.bbox)), signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); json = await r.json(); ilog(`  risposta in ${Math.round((Date.now() - t0) / 1000)} s`); break; }
        catch (e) { ilog('  non disponibile: ' + (e.name === 'AbortError' ? 'nessuna risposta entro 95 s' : e.message)); }
        finally { clearTimeout(to); }
      }
      if (!json) throw new Error('Nessun server Overpass ha risposto: riprova tra qualche minuto.');
      const all = json.elements.map((el) => osmConvert(el, b.label)).filter(Boolean);
      const recs = all.filter((r) => inside(b.geojson, r.lon, r.lat));
      ilog(`Trovati ${all.length} stalli nel rettangolo, ${recs.length} dentro il confine di ${b.label}.`);
      if (!recs.length) { ilog('Nessuno stallo mappato su OpenStreetMap in questo comune.'); return; }
      for (let i = 0; i < recs.length; i += 200) {
        const { error } = await sb.from('stalli').upsert(recs.slice(i, i + 200), { onConflict: 'osm_id' });
        if (error) throw error; ilog(`  salvati ${Math.min(i + 200, recs.length)}/${recs.length}`);
      }
      ilog('Fatto.'); load();
    } catch (e) { ilog('Errore: ' + (e.message || e)); }
    $('#i-go').disabled = false;
  };

  boot();
})();
