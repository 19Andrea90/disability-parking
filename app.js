/* Disability Parking — app principale (vanilla JS, nessun build step) */
(function () {
  'use strict';
  const C = window.DP_CONFIG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ls = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* spazio pieno: ignoro */ } }
  };
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);

  // identità anonima del telefono (serve solo per attribuire segnalazioni e conferme)
  let deviceId = ls.get('dp.device', null);
  if (!deviceId) { deviceId = 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36); ls.set('dp.device', deviceId); }

  const TIPO_LABEL = { generico: 'Generico', personalizzato: 'Personalizzato', sconosciuto: 'Tipo da verificare' };
  const STATO_LABEL = { proposto: 'Da verificare', verificato: 'Verificato', ufficiale: 'Ufficiale' };

  // ---------- toast ----------
  let toastT;
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }

  // ---------- mappa ----------
  const view = ls.get('dp.view', { c: [C.HOME.lat, C.HOME.lon], z: C.HOME.zoom });
  const map = L.map('map', { zoomControl: false }).setView(view.c, view.z);
  const CRS900913 = L.extend({}, L.CRS.EPSG3857, { code: 'EPSG:900913' });
  const bases = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' }),
    esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Esri, Maxar' }),
    fvg: L.tileLayer.wms('https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows', { layers: 'trueorto_FVG_1720', format: 'image/jpeg', version: '1.1.1', crs: CRS900913, maxZoom: 21, tileSize: 512, attribution: 'TrueOrtofoto 2020 © Regione FVG' })
  };
  const BASE_ORDER = ['osm', 'esri', 'fvg'], BASE_LABEL = { osm: 'Mappa stradale', esri: 'Satellite', fvg: 'Ortofoto Regione FVG (2020)' };
  let base = ls.get('dp.base', 'osm'); if (!bases[base]) base = 'osm';
  bases[base].addTo(map);
  $('#layers').onclick = () => { const next = BASE_ORDER[(BASE_ORDER.indexOf(base) + 1) % BASE_ORDER.length]; map.removeLayer(bases[base]); base = next; bases[base].addTo(map).bringToBack(); ls.set('dp.base', base); $('#layers').classList.toggle('on', base !== 'osm'); toast(BASE_LABEL[base], 1500); };
  $('#layers').classList.toggle('on', base !== 'osm');
  map.attributionControl.setPosition('topright');

  // ---------- dati ----------
  const stalli = new Map();           // id -> record
  const markers = new Map();          // id -> L.marker
  const layer = L.layerGroup().addTo(map);
  let favs = new Set(ls.get('dp.favs', []));
  let showFav = false;
  let dest = null;                    // {lat, lon, label}
  let destMarker = null, meMarker = null, mePos = null;
  let selectedId = null;

  function pinClass(s) { return s.stato === 'proposto' ? 'proposto' : s.tipo; }
  function icon(s, sel) {
    return L.divIcon({ className: '', html: `<div class="pin ${pinClass(s)}${sel ? ' sel' : ''}"><b>${s.posti > 1 ? s.posti : '♿'}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
  }
  function upsert(s) {
    stalli.set(s.id, s);
    let m = markers.get(s.id);
    if (!m) { m = L.marker([s.lat, s.lon], { icon: icon(s, false), keyboard: false }); m.on('click', () => openCard(s.id)); layer.addLayer(m); markers.set(s.id, m); }
    else { m.setLatLng([s.lat, s.lon]); m.setIcon(icon(s, s.id === selectedId)); }
  }
  function removeAll() { layer.clearLayers(); markers.clear(); stalli.clear(); }

  async function loadData() {
    const cached = ls.get('dp.stalli', null);
    if (cached && cached.rows) { cached.rows.forEach(upsert); refreshList(); }
    try {
      const { data, error } = await sb.from('stalli')
        .select('id,lat,lon,tipo,posti,nome,indirizzo,comune,note,orari,segnale_verticale,coperto,foto_url,stato,fonte,osm_url,updated_at')
        .in('stato', ['proposto', 'verificato', 'ufficiale']).limit(5000);
      if (error) throw error;
      removeAll(); data.forEach(upsert);
      ls.set('dp.stalli', { at: Date.now(), rows: data });
      $('#stats').textContent = `${data.length} stalli · aggiornato ora`;
      refreshList();
    } catch (e) {
      $('#stats').textContent = cached ? `${cached.rows.length} stalli · copia offline del ${new Date(cached.at).toLocaleDateString('it-IT')}` : 'Nessun dato: controlla la connessione';
      if (!cached) toast('Non riesco a scaricare gli stalli. Riprovo quando torni online.');
    }
  }
  window.addEventListener('online', loadData);

  // stato recente (libero/occupato nelle ultime 3 ore) segnalato dagli utenti
  const recent = new Map(); // stallo_id -> {esito, at}
  async function loadRecent() {
    try {
      const since = new Date(Date.now() - 3 * 3600e3).toISOString();
      const { data } = await sb.from('conferme').select('stallo_id,esito,created_at').in('esito', ['libero', 'occupato']).gte('created_at', since).order('created_at', { ascending: false }).limit(500);
      recent.clear(); (data || []).forEach((c) => { if (!recent.has(c.stallo_id)) recent.set(c.stallo_id, { esito: c.esito, at: c.created_at }); });
      refreshList();
    } catch (e) { /* offline */ }
  }
  setInterval(loadRecent, 120e3);
  function stTag(id) { const r = recent.get(id); return r ? `<span class="st ${r.esito}">${r.esito} ${timeAgo(r.at)}</span>` : ''; }
  let onlyUsable = ls.get('dp.onlyusable', true);
  $('#onlygen').checked = onlyUsable;
  $('#onlygen').onchange = () => { onlyUsable = $('#onlygen').checked; ls.set('dp.onlyusable', onlyUsable); refreshList(); };

  // ---------- lista ----------
  function dist(a, b) { return map.distance([a.lat, a.lon], [b.lat, b.lon]); }
  function fmtDist(d) { return d < 950 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'; }
  function refreshList() {
    const list = $('#list');
    let rows = [...stalli.values()].filter((s) => !onlyUsable || s.tipo !== 'personalizzato');
    let origin, title, sub;
    if (showFav) {
      rows = rows.filter((s) => favs.has(s.id)); origin = mePos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
      title = 'Preferiti'; sub = rows.length ? 'I tuoi stalli salvati' : 'Nessun preferito: apri uno stallo e tocca "Salva"';
    } else if (dest) {
      origin = dest; rows = rows.filter((s) => dist(s, dest) <= C.RAGGIO_DESTINAZIONE);
      title = 'Vicino a ' + dest.label; sub = rows.length ? `${rows.length} stalli entro ${C.RAGGIO_DESTINAZIONE} m` : `Nessuno stallo entro ${C.RAGGIO_DESTINAZIONE} m: allarga la mappa per vedere i più vicini`;
      if (!rows.length) { rows = [...stalli.values()].filter((s) => (!onlyUsable || s.tipo !== 'personalizzato') && dist(s, dest) <= 1500); }
    } else {
      const b = map.getBounds(); origin = mePos && b.contains([mePos.lat, mePos.lon]) ? mePos : { lat: map.getCenter().lat, lon: map.getCenter().lng };
      rows = rows.filter((s) => b.contains([s.lat, s.lon]));
      title = 'Stalli in zona'; sub = rows.length ? `${rows.length} in questa porzione di mappa` : 'Nessuno stallo qui: sposta la mappa o cerca una destinazione';
    }
    rows.forEach((s) => { s._d = dist(s, origin); });
    rows.sort((a, b) => a._d - b._d);
    $('#title').textContent = title; $('#sub').textContent = sub;
    list.innerHTML = rows.length ? `<div class="list">${rows.slice(0, 80).map((s) => `
      <button class="item" data-id="${s.id}">
        <i class="dot ${pinClass(s)}"></i>
        <div class="t"><div class="n">${esc(s.nome || s.indirizzo || TIPO_LABEL[s.tipo])}${s.posti > 1 ? ` · ${s.posti} posti` : ''}${stTag(s.id)}</div>
        <div class="s">${TIPO_LABEL[s.tipo]}${s.stato === 'proposto' ? ' · da verificare' : ''}${s.orari ? ' · ' + esc(s.orari) : ''}</div></div>
        <div class="d">${fmtDist(s._d)}<small>${favs.has(s.id) ? '★' : ''}</small></div>
      </button>`).join('')}</div>` : `<div class="empty">${sub}</div>`;
  }
  $('#list').addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) { openCard(it.dataset.id, true); } });
  $('#tabfav').onclick = () => { showFav = !showFav; $('#tabfav').setAttribute('aria-pressed', showFav); sheet.classList.remove('min'); refreshList(); };

  let moveT;
  map.on('moveend', () => { ls.set('dp.view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }); clearTimeout(moveT); moveT = setTimeout(refreshList, 250); });

  // ---------- sheet ----------
  const sheet = $('#sheet');
  function syncSide() { const h = sheet.classList.contains('min') ? 96 : Math.min(window.innerHeight * 0.7, sheet.offsetHeight); document.documentElement.style.setProperty('--sheet', h + 'px'); }
  $('#head').onclick = (e) => { if (e.target.closest('#tabfav')) return; sheet.classList.toggle('min'); setTimeout(syncSide, 260); };
  $('#grip').onclick = () => { sheet.classList.toggle('min'); setTimeout(syncSide, 260); };
  window.addEventListener('resize', syncSide); setTimeout(syncSide, 300);

  // ---------- scheda ----------
  async function openCard(id, fromList) {
    const s = stalli.get(id); if (!s) return;
    if (selectedId && markers.get(selectedId)) markers.get(selectedId).setIcon(icon(stalli.get(selectedId), false));
    selectedId = id; markers.get(id).setIcon(icon(s, true));
    if (fromList) map.panTo([s.lat, s.lon]);
    $('#c-badges').innerHTML = `<span class="badge ${s.tipo}">${TIPO_LABEL[s.tipo]}</span><span class="badge ${s.stato}">${STATO_LABEL[s.stato] || s.stato}</span>${s.fonte === 'osm' ? '<span class="badge osm">da OpenStreetMap</span>' : ''}`;
    $('#c-title').textContent = s.nome || s.indirizzo || 'Stallo riservato';
    $('#c-sub').textContent = [s.comune, mePos ? fmtDist(dist(s, mePos)) + ' da te' : null].filter(Boolean).join(' · ');
    const warn = $('#c-warn');
    if (s.tipo === 'personalizzato') { warn.hidden = false; warn.textContent = 'Stallo personalizzato: riservato a una persona specifica. Non utilizzabile' + (s.orari ? ', salvo: ' + s.orari : ' se non indicato diversamente sul cartello') + '.'; }
    else if (s.stato === 'proposto') { warn.hidden = false; warn.textContent = 'Segnalazione non ancora verificata: controlla la segnaletica sul posto.'; }
    else warn.hidden = true;
    const ph = $('#c-photo'); if (s.foto_url) { ph.src = s.foto_url; ph.hidden = false; } else ph.hidden = true;
    const info = [['Posti', s.posti], ['Orari', s.orari], ['Segnale verticale', s.segnale_verticale == null ? null : (s.segnale_verticale ? 'Sì' : 'No')], ['Coperto', s.coperto ? 'Sì' : null], ['Note', s.note], ['Aggiornato', s.updated_at ? new Date(s.updated_at).toLocaleDateString('it-IT') : null]].filter((r) => r[1] != null && r[1] !== '');
    $('#c-info').innerHTML = info.map((r) => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join('');
    $('#c-nav').href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`;
    updateFavBtn();
    $('#c-last').textContent = '';
    $('#card').hidden = false; sheet.hidden = true;
    try {
      const { data } = await sb.from('conferme').select('esito,created_at').eq('stallo_id', id).order('created_at', { ascending: false }).limit(1);
      if (data && data[0]) { const l = { esiste: 'confermato esistente', non_esiste: 'segnalato come inesistente', libero: 'visto libero', occupato: 'visto occupato' }[data[0].esito]; $('#c-last').textContent = `Ultimo aggiornamento: ${l} ${timeAgo(data[0].created_at)}`; }
    } catch (e) { /* offline */ }
  }
  function timeAgo(iso) { const m = Math.round((Date.now() - new Date(iso)) / 60000); if (m < 60) return m + ' min fa'; const h = Math.round(m / 60); if (h < 48) return h + ' ore fa'; return Math.round(h / 24) + ' giorni fa'; }
  function closeCard() { $('#card').hidden = true; sheet.hidden = false; if (selectedId && markers.get(selectedId)) markers.get(selectedId).setIcon(icon(stalli.get(selectedId), false)); selectedId = null; }
  $('#cardclose').onclick = closeCard; $('#cardgrip').onclick = closeCard;
  map.on('click', () => { if (!$('#card').hidden) closeCard(); });
  function updateFavBtn() { const on = favs.has(selectedId); $('#c-fav').textContent = on ? '★ Salvato' : '☆ Salva'; $('#c-fav').classList.toggle('active', on); }
  $('#c-fav').onclick = () => { if (favs.has(selectedId)) favs.delete(selectedId); else favs.add(selectedId); ls.set('dp.favs', [...favs]); updateFavBtn(); refreshList(); };
  document.querySelectorAll('[data-esito]').forEach((b) => b.onclick = async () => {
    if (!selectedId) return;
    b.disabled = true;
    const { error } = await sb.from('conferme').insert({ stallo_id: selectedId, esito: b.dataset.esito, device_id: deviceId });
    b.disabled = false;
    if (error) { toast('Non riesco a inviare: ' + error.message); return; }
    toast('Grazie, segnalazione registrata'); $('#c-last').textContent = 'Ultimo aggiornamento: adesso, da te';
    if (b.dataset.esito === 'libero' || b.dataset.esito === 'occupato') { recent.set(selectedId, { esito: b.dataset.esito, at: new Date().toISOString() }); refreshList(); }
  });

  // ---------- posizione ----------
  $('#loc').onclick = () => {
    if (!navigator.geolocation) { toast('Geolocalizzazione non disponibile'); return; }
    toast('Cerco la tua posizione…', 6000);
    navigator.geolocation.getCurrentPosition((p) => {
      mePos = { lat: p.coords.latitude, lon: p.coords.longitude };
      if (!meMarker) meMarker = L.marker([mePos.lat, mePos.lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meMarker.setLatLng([mePos.lat, mePos.lon]);
      map.setView([mePos.lat, mePos.lon], Math.max(map.getZoom(), 16)); toast('Posizione trovata', 1200);
    }, () => toast('Posizione non disponibile: controlla i permessi del GPS'), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  };

  // ---------- ricerca destinazione con suggerimenti (Photon/komoot, dati OSM) ----------
  const sug = $('#suggest'); let sugItems = [], sugIdx = -1, sugT, sugCtl;
  function photonLabel(p) {
    const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
    const where = [p.street && p.name ? [p.street, p.housenumber].filter(Boolean).join(' ') : null, p.postcode, p.city || p.town || p.village || p.county, p.state].filter(Boolean).join(', ');
    return { main: name, sub: where, label: name + (p.city && p.city !== name ? ', ' + p.city : '') };
  }
  async function suggest(q) {
    if (sugCtl) sugCtl.abort(); sugCtl = new AbortController();
    const c = mePos || { lat: map.getCenter().lat, lon: map.getCenter().lng };
    try {
      const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lat=${c.lat}&lon=${c.lon}&zoom=12&location_bias_scale=0.4`, { signal: sugCtl.signal });
      const j = await r.json();
      sugItems = j.features.filter((f) => f.properties.country === 'Italia' || f.properties.countrycode === 'IT').map((f) => Object.assign({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }, photonLabel(f.properties)));
      renderSug();
    } catch (e) { if (e.name !== 'AbortError') { sugItems = []; renderSug(); } }
  }
  function renderSug() {
    sugIdx = -1;
    sug.innerHTML = sugItems.map((s, i) => `<li role="option" data-i="${i}"><span class="m">${esc(s.main)}</span>${s.sub ? `<span class="s">${esc(s.sub)}</span>` : ''}</li>`).join('');
    sug.hidden = !sugItems.length;
  }
  function pickSug(i) { const s = sugItems[i]; if (!s) return; $('#q').value = s.label; sug.hidden = true; sugItems = []; setDest({ lat: s.lat, lon: s.lon, label: s.main }); $('#q').blur(); }
  sug.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pickSug(+li.dataset.i); } });
  $('#q').addEventListener('input', () => { const v = $('#q').value.trim(); $('#qclear').hidden = !v; clearTimeout(sugT); if (v.length < 3) { sug.hidden = true; sugItems = []; return; } sugT = setTimeout(() => suggest(v), 250); });
  $('#q').addEventListener('keydown', (e) => {
    if (sug.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length; [...sug.children].forEach((li, i) => li.setAttribute('aria-selected', i === sugIdx)); }
    else if (e.key === 'Escape') sug.hidden = true;
  });
  $('#q').addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 150));
  $('#q').addEventListener('focus', () => { if (sugItems.length) sug.hidden = false; });
  $('#searchform').onsubmit = async (e) => {
    e.preventDefault(); const v = $('#q').value.trim(); if (!v) return;
    if (sugItems.length) { pickSug(sugIdx >= 0 ? sugIdx : 0); return; }
    toast('Cerco "' + v + '"…', 8000);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=${encodeURIComponent(v)}` + (mePos ? `&viewbox=${mePos.lon - .3},${mePos.lat + .3},${mePos.lon + .3},${mePos.lat - .3}` : '');
      const r = await fetch(url, { headers: { 'Accept-Language': 'it' } }); const j = await r.json();
      if (!j.length) { toast('Nessun risultato per "' + v + '"'); return; }
      setDest({ lat: +j[0].lat, lon: +j[0].lon, label: j[0].display_name.split(',').slice(0, 2).join(',') });
      $('#q').blur();
    } catch (err) { toast('Ricerca non disponibile offline'); }
  };
  function setDest(d) {
    dest = d; showFav = false; $('#tabfav').setAttribute('aria-pressed', 'false');
    if (!destMarker) destMarker = L.marker([d.lat, d.lon], { icon: L.divIcon({ className: '', html: '<div class="dest"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(map);
    destMarker.setLatLng([d.lat, d.lon]);
    L.circle([d.lat, d.lon], { radius: C.RAGGIO_DESTINAZIONE, color: '#ffcc00', weight: 2, fillOpacity: .06, interactive: false }).addTo(map).bringToBack();
    map.setView([d.lat, d.lon], 17); $('#qclear').hidden = false; sheet.classList.remove('min'); setTimeout(syncSide, 260); toast('Destinazione impostata', 1200);
  }
  $('#qclear').onclick = () => { dest = null; $('#q').value = ''; $('#qclear').hidden = true; sug.hidden = true; sugItems = []; if (destMarker) { map.removeLayer(destMarker); destMarker = null; } map.eachLayer((l) => { if (l instanceof L.Circle) map.removeLayer(l); }); refreshList(); };

  // ---------- nuova segnalazione ----------
  let adding = false;
  function setAdding(on) { adding = on; $('#crosshair').hidden = !on; $('#addbar').hidden = !on; $('#side').style.display = on ? 'none' : ''; sheet.hidden = on; if (on) { closeCard(); if (map.getZoom() < 17) map.setZoom(18); toast('Trascina la mappa finché il segnaposto è sullo stallo', 3000); } }
  $('#add').onclick = () => setAdding(true);
  $('#addcancel').onclick = () => setAdding(false);
  $('#addok').onclick = () => {
    const c = map.getCenter(); $('#form').dataset.lat = c.lat.toFixed(6); $('#form').dataset.lon = c.lng.toFixed(6);
    $('#f-pos').textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    $('#crosshair').hidden = true; $('#addbar').hidden = true; $('#form').hidden = false;
  };
  $('#formclose').onclick = () => { $('#form').hidden = true; setAdding(false); $('#newform').reset(); $('#f-fotolbl').textContent = '📷 Scatta o scegli una foto'; };
  $('#f-foto').onchange = (e) => { const f = e.target.files[0]; $('#f-fotolbl').textContent = f ? '✓ ' + f.name : '📷 Scatta o scegli una foto'; };

  async function compress(file, max = 1280) {
    const img = await createImageBitmap(file); const k = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return new Promise((res) => cv.toBlob(res, 'image/jpeg', .82));
  }
  $('#newform').onsubmit = async (e) => {
    e.preventDefault(); const btn = $('#f-send'); btn.disabled = true; btn.textContent = 'Invio…';
    try {
      let foto_url = null; const f = $('#f-foto').files[0];
      if (f) {
        const blob = await compress(f); const path = `${new Date().toISOString().slice(0, 10)}/${deviceId}-${Date.now()}.jpg`;
        const { error: ue } = await sb.storage.from('foto').upload(path, blob, { contentType: 'image/jpeg' });
        if (ue) throw ue; foto_url = sb.storage.from('foto').getPublicUrl(path).data.publicUrl;
      }
      const seg = $('#f-segnale').value;
      const rec = { lat: +$('#form').dataset.lat, lon: +$('#form').dataset.lon, tipo: new FormData(e.target).get('tipo'), posti: +$('#f-posti').value || 1,
        orari: $('#f-orari').value.trim() || null, note: $('#f-note').value.trim() || null, segnale_verticale: seg === '' ? null : seg === 'true', foto_url, stato: 'proposto', fonte: 'utente', device_id: deviceId };
      const { data, error } = await sb.from('stalli').insert(rec).select().single();
      if (error) throw error;
      upsert(data); $('#formclose').onclick(); toast('Grazie! Stallo segnalato, in attesa di verifica', 3500); refreshList();
    } catch (err) { toast('Invio fallito: ' + (err.message || err), 5000); }
    btn.disabled = false; btn.textContent = 'Invia segnalazione';
  };

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  loadData().then(loadRecent);
})();
