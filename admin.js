(function () {
  'use strict';
  // Pannello admin a pagine (routing con #/pagina). Ogni pagina carica i suoi dati solo quando la apri.
  // Il server restituisce al massimo 1000 righe per richiesta: fetchAll scarica a pagine (serve solo allo strumento "Raggruppa").
  async function fetchAll(mk) {
    const out = []; let i = 0, done = false, err = null;
    while (!done && !err) {
      const batch = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => mk().range(i + k * 1000, i + k * 1000 + 999)));
      for (const { data, error } of batch) { if (error) { err = error; break; } out.push(...data); if (data.length < 1000) { done = true; break; } }
      i += 6000;
    }
    return err ? { data: out, error: err } : { data: out };
  }
  const C = window.DP_CONFIG; const $ = (s) => document.querySelector(s); const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const TIPO = { generico: 'Generico', personalizzato: 'Personalizzato', sconosciuto: 'Sconosciuto' };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* senza memoria locale si va avanti lo stesso */ } };
  const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('it-IT'));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  const dataOra = (d, o) => new Date(d).toLocaleString('it-IT', o || { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const MANCA10 = 'Manca il passo sul database: supabase/10_errori_zone_regole_pec.sql.';
  let logged = false, current = '';

  // ---------- auth ----------
  async function session() { const { data } = await sb.auth.getSession(); return data.session; }
  async function boot() {
    const s = await session(); if (!s) return;
    logged = true; $('#login').hidden = true; $('#shell').hidden = false;
    route(); aggiornaTodo();
    setInterval(() => { if (document.visibilityState !== 'visible') return; aggiornaTodo(); if (current === 'dashboard') statistiche(); }, 30000);
  }
  $('#l-in').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : ''; if (!error) boot(); };
  $('#l-up').onclick = async () => { $('#l-msg').textContent = '…'; const { error } = await sb.auth.signUp({ email: $('#l-email').value.trim(), password: $('#l-pass').value }); $('#l-msg').textContent = error ? error.message : 'Registrazione inviata: se Supabase richiede la conferma, controlla la posta e poi premi "Entra".'; };
  $('#logout').onclick = async () => { await sb.auth.signOut(); location.hash = ''; location.reload(); };

  // ---------- routing: #/pagina?parametri ----------
  const PAGES = {};
  const TITOLI = { dashboard: 'Dashboard', mappa: 'Mappa', controllare: 'Da controllare', comuni: 'Comuni', utenti: 'Utenti', suggerimenti: 'Suggerimenti ed errori', strumenti: 'Strumenti' };
  function parseHash() { const h = location.hash.replace(/^#\/?/, ''); const i = h.indexOf('?'); return { page: (i < 0 ? h : h.slice(0, i)) || 'dashboard', params: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) }; }
  function route() {
    if (!logged) return;
    let { page, params } = parseHash(); if (!PAGES[page]) { page = 'dashboard'; params = new URLSearchParams(); }
    const cambio = page !== current; current = page;
    $$('.page').forEach((el) => { el.hidden = el.id !== 'p-' + page; });
    $$('.side a[data-p]').forEach((a) => { if (a.dataset.p === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.title = 'SostAbile — Admin · ' + TITOLI[page];
    const P = PAGES[page];
    if (!P.done) { P.done = true; P.load(false); } // i dati si caricano una sola volta: dopo, col pulsante "Aggiorna"
    if (P.show) P.show(params);
    if (cambio) { window.scrollTo(0, 0); const h = $('#h-' + page); if (h) h.focus({ preventScroll: true }); }
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-refresh]'); if (b && PAGES[b.dataset.refresh]) PAGES[b.dataset.refresh].load(true); });

  // ---------- conteggi "da fare" (solo conteggi dal server, mai gli stalli) ----------
  let todo = {};
  const cnt = async (tab, f) => { const { count, error } = await f(sb.from(tab).select('*', { count: 'exact', head: true })); return error ? null : count; };
  const ignorati = () => lsGet('adm.ignNonEsiste', []);
  // "non c'è più": stalli attivi con almeno una conferma "non esiste", tolti quelli che l'admin ha già controllato e lasciato (lista locale)
  // "posizione da precisare": posti da elenchi ufficiali con solo l'indirizzo, messi sulla via in modo approssimato (nota dell'importazione)
  const APPROX = '%posizione approssimata%';
  const nonApprox = (q) => q.or('note.is.null,note.not.ilike.*approssimata*');
  function qNonce(q) { q = q.gt('conferme_non_esiste', 0).in('stato', ['proposto', 'verificato', 'ufficiale']); const ig = ignorati(); return ig.length ? q.not('id', 'in', '(' + ig.join(',') + ')') : q; }
  const giorniFa = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  async function aggiornaTodo() {
    const [utenti, proposti, nonce, precisare, cand, pecAtt, pecScad, sugg] = await Promise.all([
      cnt('stalli_con_conferme', (q) => q.eq('fonte', 'utente').eq('stato', 'proposto')),
      cnt('stalli_con_conferme', (q) => nonApprox(q.eq('stato', 'proposto').neq('fonte', 'utente'))),
      cnt('stalli_con_conferme', qNonce),
      cnt('stalli_con_conferme', (q) => q.eq('stato', 'proposto').ilike('note', APPROX)),
      cnt('candidati', (q) => q.eq('stato', 'nuovo')),
      cnt('pec_comuni', (q) => q.in('stato', ['Inviata', 'Risposta ricevuta'])),
      cnt('pec_comuni', (q) => q.in('stato', ['Inviata', 'Risposta ricevuta']).lte('inviata', giorniFa(23))), // scadenza = invio + 30 giorni: entro 7 giorni (o già scaduta)
      cnt('suggerimenti', (q) => q.eq('stato', 'nuovo'))]);
    Object.assign(todo, { utenti, proposti, nonce, precisare, cand, pecAtt, pecScad, sugg });
    const tot = [utenti, proposti, nonce, cand].reduce((a, n) => a + (n || 0), 0), b = $('#badge');
    b.textContent = tot > 99 ? '99+' : tot; b.hidden = !tot; b.setAttribute('aria-label', tot + ' da controllare');
    renderTodo(); if (typeof renderQTabs === 'function') renderQTabs();
  }
  function renderTodo() {
    const t = todo, v = (n) => (n == null ? '–' : fmt(n));
    const tile = (href, n, l, x) => `<a class="tile ${n > 0 ? 'on' : 'zero'}" href="${href}"><span class="go" aria-hidden="true">›</span><b>${v(n)}</b><span class="l">${l}</span>${x ? `<span class="x">${x}</span>` : ''}</a>`;
    const sErr = (t.sugg == null && t.errori == null) ? null : (t.sugg || 0) + (t.errori || 0);
    $('#todo').innerHTML = tile('#/controllare?t=utenti', t.utenti, 'Segnalazioni degli utenti', 'posti proposti da approvare')
      + tile('#/controllare?t=proposti', t.proposti, 'Posti da approvare', 'proposti da altre fonti')
      + tile('#/controllare?t=precisare', t.precisare, 'Posizione da precisare', 'dagli elenchi dei Comuni, pin solo sulla via')
      + tile('#/controllare?t=nonce', t.nonce, 'Segnalati "non c\'è più"', 'qualcuno dice che il posto non esiste')
      + tile('#/comuni?f=scad7', t.pecAtt, 'PEC in attesa di risposta', `${v(t.pecScad)} in scadenza entro 7 giorni (o già scadute)`)
      + tile('#/suggerimenti', sErr, 'Suggerimenti ed errori', `${v(t.sugg)} suggerimenti nuovi · ${t.errori == null ? '…' : fmt(t.errori)} errori in 24 h`)
      + tile('#/controllare?t=cand', t.cand, 'Candidati da verificare', 'trovati dalla rete sul satellite');
  }

  // ======================================================================
  // DASHBOARD
  // ======================================================================
  PAGES.dashboard = { load() { renderTodo(); aggiornaTodo(); kpiFast(); statistiche(); } };
  // conteggi subito dal server, senza scaricare gli stalli
  async function kpiFast() {
    const c = async (f) => { const { count } = await f(sb.from('stalli_con_conferme').select('id', { count: 'exact', head: true })); return count ?? '…'; };
    const [s0, p, v, u, x, t] = await Promise.all([c((q) => q.eq('stato', 'proposto').eq('fonte', 'utente')), c((q) => q.eq('stato', 'proposto')), c((q) => q.eq('stato', 'verificato')), c((q) => q.eq('stato', 'ufficiale')),
      c((q) => q.gt('conferme_non_esiste', 0).neq('stato', 'rifiutato')), c((q) => q.in('stato', ['proposto', 'verificato', 'ufficiale']))]);
    $('#kpi').innerHTML = [['Segnalazioni utenti', s0], ['Da approvare', p], ['Verificati', v], ['Ufficiali', u], ['Con "non esiste"', x], ['Totale attivi', t]].map((k) => `<div>${k[0]}<b>${typeof k[1] === 'number' ? fmt(k[1]) : k[1]}</b></div>`).join('');
  }
  // ---------- statistiche d'uso (rpc statistiche_admin) ----------
  function grafico(serie, chiavi, colori) { // barre affiancate per giorno, senza librerie
    const W = 600, Hh = 150, pad = 18, n = serie.length, max = Math.max(1, ...serie.flatMap((d) => chiavi.map((k) => d[k] || 0)));
    const bw = (W - pad) / n, sub = (bw - 2) / chiavi.length;
    let out = `<svg class="st-chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Andamento ultimi 30 giorni">`;
    out += `<text x="0" y="10" font-size="10" fill="currentColor" opacity=".55">${fmt(max)}</text>`;
    serie.forEach((d, i) => chiavi.forEach((k, j) => { const h = ((d[k] || 0) / max) * (Hh - pad - 4); out += `<rect x="${pad + i * bw + j * sub}" y="${Hh - 14 - h}" width="${Math.max(1, sub - 1)}" height="${h}" fill="${colori[j]}"><title>${d.g}: ${k} ${d[k] || 0}</title></rect>`; }));
    [0, Math.floor(n / 2), n - 1].forEach((i) => { const d = serie[i]; if (d) out += `<text x="${pad + i * bw}" y="${Hh - 2}" font-size="10" fill="currentColor" opacity=".55">${d.g.slice(8, 10)}/${d.g.slice(5, 7)}</text>`; });
    return out + '</svg>';
  }
  async function statistiche() {
    const { data: d, error } = await sb.rpc('statistiche_admin');
    if (error) { $('#stat').innerHTML = `<div class="sub" style="margin-top:8px">${/function|does not exist|schema cache/i.test(error.message) ? 'Manca il passo sul database: esegui <b>supabase/09_statistiche_suggerimenti.sql</b> nell\'editor SQL di Supabase.' : 'Errore: ' + esc(error.message)}</div>`; return; }
    $('#st-agg').textContent = 'Statistiche aggiornate alle ' + new Date(d.agg).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    todo.errori = d.errori_24h; renderTodo();
    const card = (l, v, x, cls) => `<div class="stc ${cls || ''}"><div class="l">${l}</div><b>${v}</b>${x ? `<div class="x">${x}</div>` : ''}</div>`;
    const sez = (t, h) => `<h3 class="sec-h">${t}</h3>${h}`;
    const pf = d.piattaforme_30g || {}, totPf = Object.values(pf).reduce((a, b) => a + b, 0), PF = { android: 'Android', ios: 'iPhone', web: 'Web da telefono', pc: 'Web da computer', '?': 'Sconosciuta' };
    const lista = (v, vuoto) => v && v.length ? `<ul class="st-list">${v.map((x) => `<li><span>${esc(x.c || x.v)}</span><b>${fmt(x.n)}</b></li>`).join('')}</ul>` : `<div class="sub">${vuoto}</div>`;
    const ore = d.ore_7g || [], maxO = Math.max(1, ...ore);
    $('#stat').innerHTML =
      sez('Utenti', `<div class="st-grid">
        ${card('Online adesso', fmt(d.online), 'app aperta negli ultimi 5 minuti', 'live')}
        ${card('Utenti nelle ultime 24 ore', fmt(d.attivi_24h), `7 giorni: ${fmt(d.attivi_7g)} · 30 giorni: ${fmt(d.attivi_30g)}`)}
        ${card('Registrati nelle ultime 24 ore', fmt(d.registrati_24h), `totale account: ${fmt(d.registrati_totali)} · <a href="#/utenti">vedi l'elenco</a>`)}
        ${card('Nuovi telefoni (24 h)', fmt(d.nuovi_24h), `7 giorni: ${fmt(d.nuovi_7g)} · da sempre: ${fmt(d.telefoni_totali)}`)}
        ${card('Tornano dopo una settimana', pct(d.ritorno_tornati, d.ritorno_base), `${fmt(d.ritorno_tornati)} su ${fmt(d.ritorno_base)} arrivati 7-14 giorni fa`)}
        ${card('Usano davvero l\'app (7 giorni)', pct(d.navigatori_7g, d.attivi_7g), `hanno avviato il navigatore: ${fmt(d.navigatori_7g)} su ${fmt(d.attivi_7g)}`)}
      </div>`)
      + sez('Ricerche e navigazione', `<div class="st-grid">
        ${card('Hanno navigato verso un posto (24 h)', fmt(d.navigatori_24h), `${fmt(d.navigazioni_24h)} navigazioni avviate`)}
        ${card('Destinazioni cercate (24 h)', fmt(d.destinazioni_24h), `senza posti attorno: ${fmt(d.senza_posti_24h)} (${pct(d.senza_posti_24h, d.destinazioni_24h)})`)}
        ${d.parcheggiati_7g == null ? '' : card('Arrivati al posto (7 giorni)', fmt(d.parcheggiati_7g), `hanno parcheggiato: ${fmt(d.parcheggiati_7g)} · trovato occupato: ${fmt(d.occupati_7g)}`)}
        ${card('Posti aperti (24 h)', fmt(d.schede_24h), `Street View 7 g: ${fmt(d.streetview_7g)} · condivisi: ${fmt(d.condivisioni_7g)} · salvati: ${fmt(d.salvati_7g)}`)}
      </div>`)
      + sez('Contributi degli utenti', `<div class="st-grid">
        ${card('Segnalazioni nuove (24 h)', fmt(d.segnalazioni_24h), `da approvare: ${fmt(d.segnalazioni_da_vedere)} · <a href="#/controllare?t=utenti">controlla</a>`)}
        ${card('Conferme sul posto (24 h)', fmt(d.conferme_24h), `"non c'è più" in 7 giorni: ${fmt(d.non_esiste_7g)}`)}
        ${card('Suggerimenti da leggere', fmt(d.suggerimenti_nuovi), '<a href="#/suggerimenti">apri l\'elenco</a>')}
        ${card('Passaparola (7 giorni)', fmt(d.consigli_7g), `"Consiglia l'app" toccato · inviti a recensire: ${fmt(d.recensioni_7g)} · statistiche spente: ${fmt(d.stat_off_7g)}`)}
        ${card('Errori dell\'app (24 h)', fmt(d.errori_24h), `su ${fmt(d.errori_telefoni_24h)} telefoni · <a href="#/suggerimenti">vedi</a>`)}
      </div>`)
      + sez('Andamento', `<div class="st-cols box">
        <div><div class="st-h">Ultimi 30 giorni</div>${grafico(d.serie || [], ['attivi', 'naviga', 'nuovi'], ['#0b2a5b', '#e0a800', '#7aa7e0'])}
          <div class="st-leg"><span><i style="background:#0b2a5b"></i>utenti attivi</span><span><i style="background:#e0a800"></i>navigazioni</span><span><i style="background:#7aa7e0"></i>nuovi telefoni</span></div></div>
        <div><div class="st-h">A che ora si usa (ultimi 7 giorni)</div>
          <svg class="st-chart" viewBox="0 0 480 150" role="img" aria-label="Utilizzo per ora del giorno">${ore.map((n, h) => `<rect x="${h * 20 + 2}" y="${136 - (n / maxO) * 126}" width="16" height="${(n / maxO) * 126}" fill="#0b2a5b"><title>${h}:00 · ${n}</title></rect>`).join('')}${[0, 6, 12, 18, 23].map((h) => `<text x="${h * 20 + 2}" y="148" font-size="10" fill="currentColor" opacity=".55">${h}</text>`).join('')}</svg></div>
      </div>`)
      + sez('Dove', `<div class="st-cols box">
        <div><div class="st-h">Dove si fanno portare (30 giorni)</div>${lista(d.comuni_naviga_30g, 'Ancora nessuna navigazione.')}</div>
        <div><div class="st-h">Dove cercano ma mancano posti (30 giorni)</div>${lista(d.comuni_vuoti_30g, 'Nessuna ricerca senza posti.')}<div class="sub" style="margin-top:6px">Sono i comuni da completare per primi (PEC, open data, scansione).</div></div>
      </div>`)
      + sez('Dispositivi', `<div class="st-cols box">
        <div><div class="st-h">Da dove usano l'app (30 giorni)</div>${Object.keys(pf).length ? Object.entries(pf).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:14px"><span>${PF[k] || esc(k)}</span><b>${fmt(n)} · ${pct(n, totPf)}</b></div><div class="st-bar"><i style="width:${(n / Math.max(1, totPf)) * 100}%"></i></div></div>`).join('') : '<div class="sub">Ancora nessun dato.</div>'}</div>
        <div><div class="st-h">Versioni in uso (7 giorni)</div>${lista(d.versioni_7g, 'Ancora nessun dato.')}</div>
      </div>`);
  }
  // ======================================================================
  // SUGGERIMENTI ED ERRORI
  // ======================================================================
  PAGES.suggerimenti = { load() { loadSugg(); loadErrori(); } };
  // ---------- suggerimenti degli utenti ----------
  let sgFiltro = 'nuovo';
  const CAT = { manca: 'Manca una funzione', errore: 'Qualcosa non va', idea: 'Idea', altro: 'Altro' };
  async function loadSugg() {
    const { data, error } = await sb.from('suggerimenti').select('*').eq('stato', sgFiltro).order('creato', { ascending: false }).limit(200);
    if (error) { $('#sug-rows').innerHTML = `<div class="sub">${/relation|does not exist|schema cache/i.test(error.message) ? 'Manca il passo sul database (supabase/09_statistiche_suggerimenti.sql).' : esc(error.message)}</div>`; return; }
    const { count } = await sb.from('suggerimenti').select('id', { count: 'exact', head: true }).eq('stato', 'nuovo');
    $('#sug-count').textContent = count ? `· ${count} da leggere` : '';
    todo.sugg = count ?? todo.sugg; renderTodo();
    $('#sug-rows').innerHTML = data.length ? data.map((x) => `<div class="sg" data-id="${x.id}"><div class="h"><span class="tag">${CAT[x.categoria] || esc(x.categoria)}</span><span>${new Date(x.creato).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><span>${esc(x.piattaforma || '')} ${esc(x.versione || '')}</span>${x.email ? `<a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : ''}</div>
      <div class="t">${esc(x.testo)}</div>
      <div class="a">${['letto', 'fatto', 'scartato', 'nuovo'].filter((st) => st !== x.stato).map((st) => `<button class="btn" data-st="${st}">${{ letto: 'Segna come letto', fatto: 'Fatto', scartato: 'Scarta', nuovo: 'Rimetti tra i nuovi' }[st]}</button>`).join('')}</div></div>`).join('') : '<div class="sub">Nessun suggerimento qui.</div>';
  }
  document.querySelectorAll('[data-sg]').forEach((b) => b.onclick = () => { document.querySelectorAll('[data-sg]').forEach((x) => x.classList.toggle('active', x === b)); sgFiltro = b.dataset.sg; loadSugg(); });
  $('#sug-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-st]'); if (!b) return; const id = +b.closest('[data-id]').dataset.id;
    b.disabled = true; const { error } = await sb.from('suggerimenti').update({ stato: b.dataset.st }).eq('id', id);
    if (error) { alert('Non riesco a salvare: ' + error.message); b.disabled = false; return; }
    loadSugg(); aggiornaTodo();
  });

  // ---------- errori dell'app ----------
  async function loadErrori() {
    const { data, error } = await sb.rpc('errori_admin', { p_giorni: 7 });
    if (error) { $('#err-rows').innerHTML = `<div class="sub">${/function|schema cache/i.test(error.message) ? 'Manca il passo sul database: supabase/10_errori_zone_regole_pec.sql.' : esc(error.message)}</div>`; return; }
    $('#err-count').textContent = data.length ? `· ${data.length} tipi di errore` : '· nessuno';
    $('#err-rows').innerHTML = data.length ? data.map((x) => `<div class="err"><code>${esc(x.messaggio)}</code><div class="s">${fmt(x.volte)} volte su ${fmt(x.telefoni)} telefoni · ultimo ${new Date(x.ultimo).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${esc(x.piattaforme)} · ${esc(x.versioni)}</div></div>`).join('') : '<div class="sub">Nessun errore negli ultimi 7 giorni.</div>';
  }

  // ======================================================================
  // COMUNI: PEC, regole della sosta, zone cercate, scheda del comune
  // ======================================================================
  PAGES.comuni = { load() { loadPec(); loadRegole(); if ($('#zone-box').open) loadZone(); },
    show(p) { const f = p.get('f'); if (f && f !== pecFiltro) { pecFiltro = f; $$('[data-pf]').forEach((x) => x.classList.toggle('active', x.dataset.pf === f)); if (pec.length) renderPec(); }
      if (zmap) setTimeout(() => zmap.invalidateSize(), 50); } };
  // ---------- zone cercate e posti mancanti ----------
  let zmap, zlayer;
  async function loadZone() {
    if (!zmap) { zmap = L.map('zmap').setView([42.3, 12.5], 6); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(zmap); zlayer = L.layerGroup().addTo(zmap); }
    setTimeout(() => zmap.invalidateSize(), 50);
    const { data, error } = await sb.rpc('zone_ricerche_admin', { p_giorni: +$('#zone-g').value });
    if (error) { $('#zone-list').innerHTML = `<div class="sub">${/function|schema cache/i.test(error.message) ? 'Manca il passo sul database: supabase/10_errori_zone_regole_pec.sql.' : esc(error.message)}</div>`; return; }
    zlayer.clearLayers(); const max = Math.max(1, ...data.map((z) => +z.ricerche));
    data.forEach((z) => { const vuote = +z.senza_posti, tot = +z.ricerche, frac = vuote / tot;
      L.circleMarker([+z.lat + 0.005, +z.lon + 0.005], { radius: 5 + 18 * Math.sqrt(tot / max), color: frac > 0.5 ? '#c62828' : frac > 0 ? '#e0a800' : '#1a7f3c', weight: 1, fillOpacity: 0.45 })
        .bindTooltip(`${esc(z.comune || 'zona')} · ${tot} ricerche, ${vuote} senza posti`).addTo(zlayer); });
    const vuote = data.filter((z) => +z.senza_posti > 0).sort((a, b) => b.senza_posti - a.senza_posti).slice(0, 15);
    $('#zone-count').textContent = `· ${data.length} zone, ${vuote.length ? data.filter((z) => +z.senza_posti > 0).length + ' con ricerche senza posti' : 'nessuna senza posti'}`;
    $('#zone-list').innerHTML = vuote.length ? `<div class="st-h">Zone con più ricerche senza posti</div><ul class="st-list">${vuote.map((z) => `<li><span>${esc(z.comune || '?')} <span class="sub">(${(+z.lat).toFixed(2)}, ${(+z.lon).toFixed(2)})</span></span><b>${fmt(z.senza_posti)} su ${fmt(z.ricerche)}</b></li>`).join('')}</ul>` : '';
  }
  $('#zone-box').addEventListener('toggle', () => { if ($('#zone-box').open) loadZone(); });
  $('#zone-g').onchange = loadZone;

  // ---------- regole della sosta per comune ----------
  let regole = [];
  async function loadRegole() {
    const { data, error } = await sb.from('regole_comuni').select('*').order('comune');
    if (error) { $('#reg-rows').innerHTML = `<div class="sub">${/relation|schema cache/i.test(error.message) ? 'Manca il passo sul database: supabase/10_errori_zone_regole_pec.sql.' : esc(error.message)}</div>`; return; }
    regole = data; $('#reg-count').textContent = `· ${data.length} comuni`;
    $('#reg-rows').innerHTML = data.length ? data.map((r) => `<div class="sg" data-c="${esc(r.comune)}"><div class="h"><b style="color:var(--fg)">${esc(r.comune)}</b><span>aggiornato ${new Date(r.aggiornato).toLocaleDateString('it-IT')}</span></div>${r.ztl ? `<div class="t"><b>ZTL:</b> ${esc(r.ztl)}</div>` : ''}${r.note ? `<div class="t">${esc(r.note)}</div>` : ''}${r.link ? `<div class="sub"><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.link)}</a></div>` : ''}<div class="a"><button class="btn" data-r="mod">Modifica</button><button class="btn danger" data-r="del">Elimina</button></div></div>`).join('') : '<div class="sub">Ancora nessun comune.</div>';
  }
  const regForm = (r) => { $('#reg-comune').value = r ? r.comune : ''; $('#reg-link').value = r ? r.link || '' : ''; $('#reg-ztl').value = r ? r.ztl || '' : ''; $('#reg-note').value = r ? r.note || '' : ''; $('#reg-msg').textContent = ''; };
  $('#reg-nuovo').onclick = () => regForm(null);
  $('#reg-salva').onclick = async () => {
    const comune = $('#reg-comune').value.trim(); if (comune.length < 2) { $('#reg-msg').textContent = 'Scrivi il nome del comune.'; return; }
    const rec = { comune, link: $('#reg-link').value.trim() || null, ztl: $('#reg-ztl').value.trim() || null, note: $('#reg-note').value.trim() || null, aggiornato: new Date().toISOString() };
    const { error } = await sb.from('regole_comuni').upsert(rec); $('#reg-msg').textContent = error ? 'Errore: ' + error.message : 'Salvato.'; if (!error) loadRegole();
  };
  $('#reg-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return; const c = b.closest('[data-c]').dataset.c, r = regole.find((x) => x.comune === c);
    if (b.dataset.r === 'mod') { regForm(r); $('#reg-comune').scrollIntoView({ block: 'center' }); }
    else if (confirm(`Eliminare le regole di ${c}?`)) { await sb.from('regole_comuni').delete().eq('comune', c); loadRegole(); }
  });

  // ---------- PEC di accesso civico ai comuni ----------
  let pec = [], pecFiltro = '', riepilogoComuni = null;
  const scadenza = (r) => r.inviata ? new Date(new Date(r.inviata).getTime() + 30 * 864e5) : null;
  async function loadPec() {
    const { data, error } = await sb.from('pec_comuni').select('*').order('comune');
    if (error) { $('#pec-rows').innerHTML = `<tr><td colspan="9" class="sub">${/relation|schema cache/i.test(error.message) ? 'Manca il passo sul database: supabase/10_errori_zone_regole_pec.sql.' : esc(error.message)}</td></tr>`; return; }
    pec = data;
    if (!riepilogoComuni) { try { const j = await (await fetch(C.SUPABASE_URL + '/storage/v1/object/public/foto/copertura/riepilogo.json')).json(); riepilogoComuni = new Map(j.comuni.map((c) => [c.n.toLowerCase(), c.t])); } catch (e) { riepilogoComuni = new Map(); } }
    renderPec();
  }
  function renderPec() {
    const oggi = new Date(), aperta = (r) => r.stato === 'Inviata' || r.stato === 'Risposta ricevuta';
    const fra7 = new Date(oggi.getTime() + 7 * 864e5);
    const v = pec.filter((r) => !pecFiltro || (pecFiltro === 'scadute' ? aperta(r) && scadenza(r) && scadenza(r) < oggi : pecFiltro === 'scad7' ? aperta(r) && scadenza(r) && scadenza(r) <= fra7 : r.stato === pecFiltro));
    const n = (st) => pec.filter((r) => r.stato === st).length, scad = pec.filter((r) => aperta(r) && scadenza(r) && scadenza(r) < oggi).length;
    $('#pec-count').textContent = `· ${pec.length} comuni: ${n('Inviata')} inviate, ${n('Risposta ricevuta')} protocollate, ${n('Dati importati')} con dati, ${n('Da inviare')} da inviare${scad ? `, ${scad} scadute` : ''}`;
    const ST = ['Da inviare', 'Inviata', 'Risposta ricevuta', 'Dati importati', 'Rifiutata'];
    $('#pec-rows').innerHTML = v.map((r) => { const sc = scadenza(r), x = aperta(r) && sc && sc < oggi;
      return `<tr data-c="${esc(r.comune)}" class="${x ? 'scad' : ''}"><td class="c"><button class="lnk" data-open="${esc(r.comune)}">${esc(r.comune)}</button></td><td>${esc(r.provincia || '')}</td><td>${riepilogoComuni && riepilogoComuni.has(r.comune.toLowerCase()) ? fmt(riepilogoComuni.get(r.comune.toLowerCase())) : '–'}</td><td><span class="sub">${esc(r.pec || '')}</span></td>
        <td><input type="date" data-k="inviata" value="${r.inviata || ''}"></td><td class="sc ${x ? 'x' : ''}">${sc ? sc.toLocaleDateString('it-IT') : ''}</td>
        <td><select data-k="stato">${ST.map((s) => `<option${s === r.stato ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
        <td><input class="p" data-k="protocollo" value="${esc(r.protocollo || '')}"></td><td><textarea data-k="note">${esc(r.note || '')}</textarea></td></tr>`; }).join('') || '<tr><td colspan="9" class="sub">Nessun comune.</td></tr>';
  }
  document.querySelectorAll('[data-pf]').forEach((b) => b.onclick = () => { document.querySelectorAll('[data-pf]').forEach((x) => x.classList.toggle('active', x === b)); pecFiltro = b.dataset.pf; renderPec(); });
  $('#pec-rows').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) apriComune(b.dataset.open); });
  $('#pec-rows').addEventListener('change', async (e) => {
    const el = e.target.closest('[data-k]'); if (!el) return; const c = el.closest('[data-c]').dataset.c, k = el.dataset.k, val = el.value.trim() || null;
    const { error } = await sb.from('pec_comuni').update({ [k]: val, aggiornato: new Date().toISOString() }).eq('comune', c);
    if (error) { alert('Non riesco a salvare: ' + error.message); return; }
    const r = pec.find((x) => x.comune === c); if (r) r[k] = val; el.style.outline = '2px solid #1a9e4b'; setTimeout(() => { el.style.outline = ''; renderPec(); }, 700);
  });


  // ---------- scheda del comune ----------
  let schedaDa = null;
  function chiudiScheda() { $('#c-scheda').hidden = true; if (schedaDa && schedaDa.isConnected) schedaDa.focus(); schedaDa = null; }
  function apriComune(nome) {
    schedaDa = document.activeElement; const r = pec.find((x) => x.comune === nome), g = regole.find((x) => x.comune.toLowerCase() === nome.toLowerCase());
    const sc = r && scadenza(r), gg = sc ? Math.ceil((sc - new Date()) / 864e5) : null, aperta = r && (r.stato === 'Inviata' || r.stato === 'Risposta ricevuta');
    const nStalli = riepilogoComuni && riepilogoComuni.has(nome.toLowerCase()) ? fmt(riepilogoComuni.get(nome.toLowerCase())) : '–';
    $('#c-scheda').innerHTML = `<div style="display:flex;gap:8px;align-items:center"><h3 id="c-titolo" style="flex:1">${esc(nome)}</h3><button class="btn" id="c-chiudi" aria-label="Chiudi la scheda">✕</button></div>
      ${r ? `<div class="sub">${esc(r.provincia || '')}${r.regione ? ' · ' + esc(r.regione) : ''} · ${nStalli} stalli in mappa</div>
      <h4 class="sec-h" style="margin:6px 0 0">PEC di accesso civico</h4>
      <dl class="dl"><dt>Stato</dt><dd><b>${esc(r.stato)}</b></dd><dt>Indirizzo PEC</dt><dd>${esc(r.pec || '–')}</dd><dt>Inviata il</dt><dd>${r.inviata ? new Date(r.inviata).toLocaleDateString('it-IT') : '–'}</dd>
        <dt>Scadenza</dt><dd>${sc ? sc.toLocaleDateString('it-IT') + (aperta ? (gg < 0 ? ` <b style="color:#b3261e">(scaduta da ${-gg} giorni)</b>` : ` (tra ${gg} giorni)`) : '') : '–'}</dd><dt>Protocollo</dt><dd>${esc(r.protocollo || '–')}</dd><dt>Note</dt><dd style="white-space:pre-wrap">${esc(r.note || '–')}</dd></dl>
      <div class="sub">Per cambiare stato, data, protocollo o note usa la tabella: si salva da sola.</div>` : '<div class="sub">Questo comune non è nell\'elenco delle PEC.</div>'}
      <h4 class="sec-h" style="margin:6px 0 0">Regole della sosta</h4>
      ${g ? `${g.ztl ? `<div><b>ZTL:</b> ${esc(g.ztl)}</div>` : ''}${g.note ? `<div style="white-space:pre-wrap">${esc(g.note)}</div>` : ''}${g.link ? `<div class="sub"><a href="${esc(g.link)}" target="_blank" rel="noopener">${esc(g.link)}</a></div>` : ''}${!g.ztl && !g.note && !g.link ? '<div class="sub">Scheda vuota.</div>' : ''}` : '<div class="sub">Nessuna regola scritta per questo comune.</div>'}
      <div class="acts"><button class="btn primary" id="c-mappa">🗺️ Apri sulla mappa</button><button class="btn" id="c-regole">${g ? 'Modifica le regole' : 'Scrivi le regole'}</button></div><div class="sub" id="c-msg" role="status"></div>`;
    $('#c-scheda').hidden = false; $('#c-chiudi').focus();
    $('#c-chiudi').onclick = chiudiScheda;
    $('#c-regole').onclick = () => { regForm(g || null); if (!g) $('#reg-comune').value = nome; $('#reg-box').open = true; chiudiScheda(); $('#reg-comune').scrollIntoView({ block: 'center' }); $('#reg-comune').focus(); };
    $('#c-mappa').onclick = () => mappaComune(nome);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#c-scheda').hidden) chiudiScheda(); });
  // centro della mappa sul comune: media delle posizioni di alcuni suoi stalli (una sola richiesta piccola); senza stalli si usa la ricerca per nome
  async function mappaComune(nome) {
    $('#c-msg').textContent = 'Cerco il comune…';
    const { data } = await sb.from('stalli').select('lat,lon').ilike('comune', nome.replace(/[%_*,()]/g, ' ').trim()).in('stato', ['proposto', 'verificato', 'ufficiale']).limit(50);
    chiudiScheda();
    if (data && data.length) { const m = (k) => data.reduce((a, x) => a + x[k], 0) / data.length; location.hash = `#/mappa?lat=${m('lat').toFixed(5)}&lon=${m('lon').toFixed(5)}&z=14`; }
    else location.hash = '#/mappa?q=' + encodeURIComponent(nome);
  }

  // ======================================================================
  // MAPPA (stalli per area visibile, ricerca sul server)
  // ======================================================================
  // livelli di base: strade, satellite Esri, TrueOrtofoto FVG 2020 (WMS regionale, 10-20 cm/px). Un'istanza per ogni mappa.
  const CRS900913 = L.extend({}, L.CRS.EPSG3857, { code: 'EPSG:900913' });
  const mkBases = () => ({
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' }),
    esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Esri, Maxar' }),
    fvg: L.tileLayer.wms('https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows', { layers: 'trueorto_FVG_1720', format: 'image/jpeg', version: '1.1.1', crs: CRS900913, maxZoom: 22, tileSize: 512, attribution: 'TrueOrtofoto 2020 © Regione FVG / Insiel' })
  });
  // scelta della base con veri radio: restituisce { set(k), get() }
  function baseCtl(m, bs, el, nome, iniz) {
    let cur = null;
    el.innerHTML = [['osm', 'Strade'], ['esri', 'Satellite (Esri)'], ['fvg', 'Ortofoto FVG 2020']].map(([k, t]) => `<label><input type="radio" name="${nome}" value="${k}"> ${t}</label>`).join('');
    const set = (k) => { if (!bs[k] || k === cur) return; if (cur) m.removeLayer(bs[cur]); bs[k].addTo(m).bringToBack(); cur = k; $$('input', el).forEach((r) => { r.checked = r.value === k; }); };
    el.addEventListener('change', (e) => { if (e.target.name === nome) set(e.target.value); });
    set(iniz); return { set, get: () => cur };
  }
  const pinClass = (s) => s.stato === 'proposto' ? 'proposto' : s.tipo;
  const icon = (s, on) => L.divIcon({ className: '', html: `<div class="pin ${pinClass(s)}${on ? ' sel' : ''}"><b>${s.posti > 1 ? s.posti : '♿'}</b></div>`, iconSize: [30, 30], iconAnchor: [15, 30] });

  const LIM = 2000, ZMIN = 11;
  let map, layer, mBase, rows = [], sel = null, nuovaPos = null, sposto = false, mFiltro = 'tutti', mFonte = '', mode = 'bbox', mReq = 0, markers = new Map(), trovati = [];
  const FILTRI = {
    tutti: (q) => q.in('stato', ['proposto', 'verificato', 'ufficiale']),
    utenti: (q) => q.eq('fonte', 'utente').eq('stato', 'proposto'),
    proposto: (q) => q.eq('stato', 'proposto'),
    verificato: (q) => q.eq('stato', 'verificato'),
    ufficiale: (q) => q.eq('stato', 'ufficiale'),
    rifiutato: (q) => q.eq('stato', 'rifiutato'),
    segnalati: (q) => q.gt('conferme_non_esiste', 0).neq('stato', 'rifiutato')
  };
  const filtra = (q) => { q = FILTRI[mFiltro](q); return mFonte ? q.eq('fonte', mFonte) : q; };
  function nota(t) { const n = $('#m-note'); n.textContent = t || ''; n.hidden = !t; }

  PAGES.mappa = {
    load() {
      map = L.map('amap').setView([C.HOME.lat, C.HOME.lon], 13);
      mBase = baseCtl(map, mkBases(), $('#m-bases'), 'base', 'osm');
      layer = L.layerGroup().addTo(map);
      let mvT; map.on('moveend', () => { clearTimeout(mvT); mvT = setTimeout(caricaArea, 350); });
      caricaArea();
    },
    show(p) {
      if (!map) return; setTimeout(() => map.invalidateSize(), 30);
      const id = p.get('id'), q = p.get('q'), lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
      if (id) { apri(id); history.replaceState(null, '', '#/mappa'); }
      else if (q) { $('#q-st').value = q; cerca(q); history.replaceState(null, '', '#/mappa'); }
      else if (isFinite(lat) && isFinite(lon)) { chiudiRicerca(); map.setView([lat, lon], +p.get('z') || 14); history.replaceState(null, '', '#/mappa'); }
    }
  };
  // la mappa mostra SEMPRE tutti i posti della zona visibile; una ricerca aggiunge i suoi risultati (elenco a destra) senza nascondere gli altri
  async function caricaArea() {
    if (map.getZoom() < ZMIN) { rows = trovati.slice(); drawPins(); nota('Ingrandisci la mappa per vedere i posti.'); return; }
    const b = map.getBounds().pad(0.1), my = ++mReq; nota('Carico i posti di quest\'area…');
    const { data, error } = await filtra(sb.from('stalli_con_conferme').select('*').gte('lat', b.getSouth()).lte('lat', b.getNorth()).gte('lon', b.getWest()).lte('lon', b.getEast())).order('id').limit(LIM + 1);
    if (my !== mReq) return;
    if (error) { nota('Errore: ' + error.message + ' (sei registrato come admin?)'); return; }
    rows = data.slice(0, LIM); const ids = new Set(rows.map((r) => r.id)); trovati.forEach((r) => { if (!ids.has(r.id)) rows.push(r); }); if (sel) sel = rows.find((r) => r.id === sel.id) || sel;
    nota(data.length > LIM ? `Più di ${fmt(LIM)} posti in quest'area: ne vedi solo una parte. Ingrandisci la mappa.` : rows.length === 1 ? '1 posto in quest\'area' : fmt(rows.length) + ' posti in quest\'area');
    drawPins(); if (!sel) vuota();
  }
  function drawPins() {
    layer.clearLayers(); markers.clear();
    const vis = sel && !rows.some((r) => r.id === sel.id) ? rows.concat([sel]) : rows;
    for (const r of vis) {
      const isSel = sel && sel.id === r.id;
      const m = L.marker(isSel && nuovaPos ? nuovaPos : [r.lat, r.lon], { icon: icon(r, isSel), draggable: isSel && sposto, zIndexOffset: isSel ? 1000 : 0, keyboard: true, title: r.nome || r.indirizzo || TIPO[r.tipo] }); m.on('click', () => select(r.id));
      if (isSel && sposto) m.on('dragend', () => { const p = m.getLatLng(); nuovaPos = [+p.lat.toFixed(6), +p.lng.toFixed(6)]; mostraSposta(); }); // il pin selezionato si trascina nel punto giusto
      layer.addLayer(m); markers.set(r.id, m);
    }
  }
  // pannello a destra quando non c'è uno stallo aperto: l'elenco dei risultati di una ricerca, altrimenti un promemoria
  function vuota() {
    if (sel) return;
    $('#edit').innerHTML = mode === 'search' ? (trovati.length ? `<div class="sub"><b>${trovati.length === 200 ? 'Almeno 200' : trovati.length}</b> risultati${trovati.length === 200 ? ' (mostro i primi 200: scrivi più parole)' : ''}. Tocca un posto per aprirlo. Sulla mappa vedi anche gli altri posti della zona.</div>`
        + trovati.map((r) => `<button class="row-item" data-id="${r.id}"><span><span class="n">${esc(r.nome || r.indirizzo || TIPO[r.tipo])} · ${r.posti} ${r.posti > 1 ? 'posti' : 'posto'}</span><br><span class="s">${TIPO[r.tipo]} · ${esc(r.comune || '—')} · ${esc(r.fonte)}</span></span><span class="s">${esc(r.stato)}</span></button>`).join('')
      : `<div class="empty">Nessuno stallo trovato${mFiltro !== 'tutti' || mFonte ? ' con questi filtri: prova "Tutti gli attivi"' : ''}. Prova con meno parole.</div>`)
      : '<div class="sub">Seleziona uno stallo sulla mappa, oppure cerca un indirizzo.</div>';
  }
  $('#edit').addEventListener('click', (e) => { const it = e.target.closest('.row-item'); if (it) select(it.dataset.id); });
  $$('#m-stati [data-f]').forEach((b) => b.onclick = () => { $$('#m-stati [data-f]').forEach((x) => x.setAttribute('aria-pressed', x === b)); mFiltro = b.dataset.f; ricarica(); });
  $('#m-fonte').onchange = (e) => { mFonte = e.target.value; ricarica(); };
  function ricarica() { const t = $('#q-st').value.trim(); if (mode === 'search' && t) cerca(t); else caricaArea(); }
  $('#q-form').onsubmit = (e) => { e.preventDefault(); chiudiSugg(); const t = $('#q-st').value.trim(); if (t) cerca(t); else chiudiRicerca(); };
  $('#q-x').onclick = () => { $('#q-st').value = ''; chiudiSugg(); chiudiRicerca(); };
  // ---------- suggerimenti mentre scrivi: stalli dal nostro database + indirizzi (Photon, OpenStreetMap) ----------
  // Scegliendo un indirizzo la mappa va lì e mostra TUTTI gli stalli attorno (non solo quelli che contengono le parole cercate).
  let sgT = 0, sgCtl = null, sgVoci = [], sgI = -1;
  const sgEl = $('#q-sugg'), sgIn = $('#q-st');
  function chiudiSugg() { sgEl.hidden = true; sgEl.innerHTML = ''; sgVoci = []; sgI = -1; sgIn.setAttribute('aria-expanded', 'false'); sgIn.removeAttribute('aria-activedescendant'); }
  function mostraSugg(stalli, indirizzi) {
    sgVoci = []; let h = '';
    const voce = (v, t, sub) => { const i = sgVoci.push(v) - 1; return `<li role="option" id="sg-${i}" data-i="${i}" aria-selected="false"><b>${esc(t)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</li>`; };
    if (stalli.length) h += '<li class="h" role="presentation">Stalli</li>' + stalli.map((s) => voce({ k: 's', id: s.id }, `${s.nome || s.indirizzo || TIPO[s.tipo]}`, `${s.comune || '—'} · ${s.stato} · ${s.posti} ${s.posti > 1 ? 'posti' : 'posto'}`)).join('');
    if (indirizzi.length) h += '<li class="h" role="presentation">Indirizzi e luoghi</li>' + indirizzi.map((a) => voce({ k: 'a', lat: a.lat, lon: a.lon, strada: a.strada }, a.t, a.sub)).join('');
    if (!h) { chiudiSugg(); return; }
    sgEl.innerHTML = h; sgEl.hidden = false; sgI = -1; sgIn.setAttribute('aria-expanded', 'true');
  }
  async function suggerisci(t) {
    if (sgCtl) sgCtl.abort(); sgCtl = new AbortController(); const mio = sgCtl;
    const parole = t.replace(/[%,()*\\"]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
    let q = sb.from('stalli_con_conferme').select('id,nome,indirizzo,comune,stato,posti,tipo'); parole.forEach((w) => { q = q.or(`indirizzo.ilike.%${w}%,nome.ilike.%${w}%,comune.ilike.%${w}%`); });
    const c = map ? map.getCenter() : { lat: 42.5, lng: 12.5 };
    const [st, ind] = await Promise.all([
      q.in('stato', ['proposto', 'verificato', 'ufficiale']).limit(5).then((r) => r.data || [], () => []),
      fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(t)}&limit=6&lat=${c.lat}&lon=${c.lng}&location_bias_scale=0.3`, { signal: mio.signal }).then((r) => r.ok ? r.json() : { features: [] }).then((j) => (j.features || [])
        .filter((f) => { const p = f.properties || {}; return !p.countrycode || p.countrycode === 'IT'; }).slice(0, 5)
        .map((f) => { const p = f.properties || {}, via = [p.street, p.housenumber].filter(Boolean).join(' '), citta = p.city || p.town || p.village || p.county || '';
          const tt = p.name || via || citta; return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], strada: p.osm_key === 'highway', t: tt, sub: [p.name && via, citta !== tt && citta, p.state].filter(Boolean).join(', ') }; }), () => [])]);
    if (mio !== sgCtl || sgIn.value.trim() !== t) return;
    mostraSugg(st, ind);
  }
  function scegliSugg(i) {
    const v = sgVoci[i]; if (!v) return; chiudiSugg();
    if (v.k === 's') { apri(v.id); return; }
    // indirizzo: si esce dalla ricerca testuale e si guarda la zona, con tutti gli stalli attorno
    $('#q-x').hidden = false; mode = 'bbox'; trovati = []; sel = null; vuota(); map.setView([v.lat, v.lon], v.strada ? 17 : 18);
  }
  sgIn.addEventListener('input', () => { clearTimeout(sgT); const t = sgIn.value.trim(); if (t.length < 3) { chiudiSugg(); return; } sgT = setTimeout(() => suggerisci(t), 300); });
  sgIn.addEventListener('keydown', (e) => {
    if (sgEl.hidden || !sgVoci.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sgI = (sgI + (e.key === 'ArrowDown' ? 1 : -1) + sgVoci.length) % sgVoci.length;
      sgEl.querySelectorAll('[role=option]').forEach((o) => o.setAttribute('aria-selected', +o.dataset.i === sgI)); sgIn.setAttribute('aria-activedescendant', 'sg-' + sgI); $('#sg-' + sgI).scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && sgI >= 0) { e.preventDefault(); scegliSugg(sgI); }
    else if (e.key === 'Escape') chiudiSugg();
  });
  sgEl.addEventListener('mousedown', (e) => { const o = e.target.closest('[role=option]'); if (o) { e.preventDefault(); scegliSugg(+o.dataset.i); } });
  sgIn.addEventListener('blur', () => setTimeout(chiudiSugg, 150));
  function chiudiRicerca() { $('#q-x').hidden = true; trovati = []; if (mode === 'search') { mode = 'bbox'; sel = null; caricaArea(); vuota(); } }
  // ricerca sul server: tutte le parole devono comparire in indirizzo, nome o comune (al massimo 200 risultati), poi la mappa si centra sui risultati
  async function cerca(testo) {
    const parole = testo.replace(/[%,()*\\"]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6); if (!parole.length) return;
    mode = 'search'; sel = null; nuovaPos = null; sposto = false; $('#e-sposta').hidden = true; $('#q-x').hidden = false; mReq++; nota('Cerco…');
    let q = sb.from('stalli_con_conferme').select('*'); parole.forEach((w) => { q = q.or(`indirizzo.ilike.%${w}%,nome.ilike.%${w}%,comune.ilike.%${w}%`); });
    const { data, error } = await filtra(q).limit(200);
    if (error) { nota('Errore: ' + error.message); return; }
    trovati = data; rows = data.slice(); drawPins(); vuota(); nota(rows.length ? '' : 'Nessun risultato');
    if (rows.length) { map.fitBounds(rows.map((r) => [r.lat, r.lon]), { padding: [30, 30], maxZoom: 17 }); setTimeout(caricaArea, 450); } // poi carica anche gli altri posti della zona
  }

  // ---------- scheda dello stallo ----------
  async function apri(id, opz) {
    let s = rows.find((r) => r.id === id);
    if (!s) { const { data } = await sb.from('stalli_con_conferme').select('*').eq('id', id).maybeSingle(); if (!data) { nota('Stallo non trovato.'); return; } s = data; rows = rows.concat([s]); }
    select(id, opz);
  }
  function select(id, opz) {
    sel = rows.find((r) => r.id === id); if (!sel) return; nuovaPos = null; sposto = false; $('#e-sposta').hidden = true;
    map.setView([sel.lat, sel.lon], Math.max(map.getZoom(), 17)); drawPins();
    const s = sel;
    $('#edit').innerHTML = `
      <div class="acts" style="justify-content:space-between"><div class="badges"><span class="badge ${s.tipo}">${TIPO[s.tipo]}</span><span class="badge ${s.stato}">${s.stato}</span><span class="badge osm">${s.fonte}</span></div><button class="btn sm" id="e-close">✕ Chiudi la scheda</button></div>
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
        <button class="btn" id="e-move">📍 Riposiziona sulla mappa</button>
      </div>
      <div class="sub" id="e-msg" role="status"></div>`;
    $('#edit').querySelectorAll('[data-st]').forEach((b) => b.onclick = () => {
      const extra = { stato: b.dataset.st };
      if (sel.fonte === 'utente' && b.dataset.st === 'rifiutato') { // il motivo lo legge chi ha fatto la segnalazione, in "Le mie segnalazioni"
        const m = prompt('Motivo del rifiuto (lo vedrà chi ha fatto la segnalazione). Lascia vuoto per non indicarlo.', sel.motivo_rifiuto || '');
        if (m === null) return; extra.motivo_rifiuto = m.trim() || null;
      }
      save(extra);
    });
    $('#e-close').onclick = () => { sel = null; nuovaPos = null; sposto = false; $('#e-sposta').hidden = true; vuota(); drawPins(); };
    $('#e-save').onclick = () => save({});
    $('#e-move').onclick = avviaSposta;
    $('#e-sposta-ok').onclick = async () => { if (!nuovaPos) return; const ok = await save({ lat: nuovaPos[0], lon: nuovaPos[1] }); if (ok) { nuovaPos = null; sposto = false; select(sel.id); $('#e-msg').textContent = 'Posizione salvata ' + new Date().toLocaleTimeString('it-IT'); } };
    $('#e-sposta-no').onclick = () => { nuovaPos = null; sposto = false; $('#e-sposta').hidden = true; const m = $('#e-move'); if (m) m.hidden = false; drawPins(); };
    if (opz && opz.sposta) avviaSposta();
  }
  function avviaSposta() { // modalità sposta: la mappa va vicinissima al pin, il pin si può trascinare, poi Salva
    sposto = true; nuovaPos = null; const m = $('#e-move'); if (m) m.hidden = true; $('#e-sposta').hidden = false; $('#e-sposta-ok').disabled = true;
    $('#e-sposta-t').textContent = 'Trascina il pin nel punto giusto (puoi usare la vista satellite), poi premi Salva.';
    map.setView([sel.lat, sel.lon], 19); drawPins(); $('#amap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function mostraSposta() {
    const d = Math.round(L.latLng(sel.lat, sel.lon).distanceTo(nuovaPos));
    $('#e-sposta-t').textContent = `Nuova posizione: ${nuovaPos[0].toFixed(6)}, ${nuovaPos[1].toFixed(6)} (spostato di ${d} m)`; $('#e-sposta').hidden = false; $('#e-sposta-ok').disabled = false;
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
    if (error) { $('#e-msg').textContent = 'Errore: ' + error.message; return false; }
    Object.assign(sel, patch); const inLista = rows.find((r) => r.id === sel.id); if (inLista && inLista !== sel) Object.assign(inLista, patch);
    $('#e-msg').textContent = 'Salvato ' + new Date().toLocaleTimeString('it-IT'); drawPins(); if ('stato' in extra) aggiornaTodo(); return true;
  }
  // nuovo stallo: nasce al centro della mappa, 'verificato' e con fonte 'admin' (valore ammesso dal vincolo stalli_fonte_check); poi si trascina nel punto giusto
  $('#m-new').onclick = async () => {
    const c = map.getCenter(), b = $('#m-new'); b.disabled = true; nota('Creo lo stallo…');
    const rec = { lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), tipo: 'sconosciuto', posti: 1, stato: 'verificato', fonte: 'admin' };
    const { data, error } = await sb.from('stalli').insert(rec).select().single(); b.disabled = false;
    if (error) { nota('Non riesco a creare lo stallo: ' + error.message); return; }
    nota('Stallo creato: trascinalo nel punto giusto e salva.');
    rows = rows.concat([Object.assign({ conferme_esiste: 0, conferme_non_esiste: 0, ultima_conferma: null }, data)]);
    if (mode === 'search') { mode = 'bbox'; trovati = []; $('#q-x').hidden = true; }
    select(data.id, { sposta: true }); aggiornaTodo();
  };

  // ======================================================================
  // DA CONTROLLARE: coda di lavoro (segnalazioni utenti, da approvare, "non c'è più", candidati dal satellite)
  // Lista paginata dal server (50 alla volta); dopo ogni decisione si passa al successivo.
  // ======================================================================
  const PAGINA = 50;
  const CLASSE_LABEL = { 'information--disabled-persons--g1': 'Pannello "disabili"', 'information--disabled-persons--g2': 'Pannello "disabili"', 'information--disabled-persons--g3': 'Pannello "disabili"', 'complementary--disabled-persons--g1': 'Pannello integrativo "disabili"', 'regulatory--reserved-parking--g1': 'Parcheggio riservato' };
  const LEDE = {
    utenti: 'Posti segnalati dagli utenti dell\'app. Guarda foto e satellite, poi approva o rifiuta: chi ha segnalato vede il motivo del rifiuto.',
    proposti: 'Posti proposti da altre fonti, in attesa di approvazione.',
    precisare: 'Posti degli elenchi ufficiali dei Comuni che danno solo l\'indirizzo: il pin è messo sulla via in modo approssimato. Cerca lo stallo sul satellite, poi "Riposiziona e approva"; se non lo trovi, "Salta" e restano qui.',
    nonce: 'Posti per cui qualcuno ha toccato "non c\'è più". "Esiste ancora" lo toglie da questo elenco (solo su questo browser); "Rimuovi" lo toglie dalla mappa.',
    cand: 'La scansione dell\'ortofoto propone i possibili stalli: sopra l\'85% li conferma da sola, sotto il 30% li scarta da sola. Qui controlli quelli in mezzo e, se vuoi, verifichi quelli confermati in automatico.'
  };
  let qTab = 'utenti', cf = 'nuovo', qPag = 0, qItems = [], qTot = 0, qSel = null, qReq = 0, qRip = false, qFlash = '', qBusy = false, cmap = null, cmarker = null, cBase = null, cBaseUser = false;
  const kind = () => (qTab === 'cand' && cf !== 'auto') ? 'cand' : 'stallo';
  const score = (c) => { const m = /punteggio (\d+)%/.exec(c.classe || ''); return m ? +m[1] : -1; }; // confidenza della rete, dal testo "punteggio N%"
  const inFvg = (lat, lon) => lat > 45.58 && lat < 46.65 && lon > 12.3 && lon < 13.95;
  const ignora = (id) => { const l = ignorati(); if (!l.includes(id)) { l.push(id); lsSet('adm.ignNonEsiste', l.slice(-400)); } };

  PAGES.controllare = {
    load(force) {
      const t = parseHash().params.get('t'); if (!force && ['utenti', 'proposti', 'precisare', 'nonce', 'cand'].includes(t)) qTab = t;
      renderQTabs(); qCarica(force ? qPag : 0);
    },
    show(p) {
      const t = p.get('t');
      if (t && ['utenti', 'proposti', 'precisare', 'nonce', 'cand'].includes(t)) { if (t !== qTab) { qTab = t; renderQTabs(); qCarica(0); } history.replaceState(null, '', '#/controllare'); }
      if (cmap) setTimeout(() => cmap.invalidateSize(), 30);
    }
  };
  function renderQTabs() {
    $$('#q-tabs [data-q]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.q === qTab));
    $$('#q-tabs [data-n]').forEach((s) => { const n = todo[s.dataset.n]; s.textContent = n == null ? '' : fmt(n); s.hidden = !n; });
    $('#cand-sub').hidden = qTab !== 'cand'; $$('#cand-sub [data-cf]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.cf === cf));
    $('#q-lede').textContent = LEDE[qTab];
  }
  $('#q-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (!b || b.dataset.q === qTab) return; qTab = b.dataset.q; renderQTabs(); qCarica(0); });
  $('#cand-sub').addEventListener('click', (e) => { const b = e.target.closest('[data-cf]'); if (!b || b.dataset.cf === cf) return; cf = b.dataset.cf; renderQTabs(); qCarica(0); });

  function qQuery() {
    if (kind() === 'cand') return sb.from('candidati').select('*', { count: 'exact' }).eq('stato', cf).order('created_at', { ascending: false }).order('id');
    let q = sb.from('stalli_con_conferme').select('*', { count: 'exact' });
    if (qTab === 'utenti') q = q.eq('fonte', 'utente').eq('stato', 'proposto').order('created_at', { ascending: false });
    else if (qTab === 'proposti') q = nonApprox(q.eq('stato', 'proposto').neq('fonte', 'utente')).order('created_at', { ascending: false });
    else if (qTab === 'precisare') q = q.eq('stato', 'proposto').ilike('note', APPROX).order('comune').order('indirizzo');
    else if (qTab === 'nonce') q = qNonce(q).order('ultima_conferma', { ascending: false, nullsFirst: false });
    else q = q.eq('stato', 'verificato').like('note', 'Confermato in automatico%').not('note', 'like', '%controllato%').order('created_at', { ascending: false }); // candidati accettati dalla rete da verificare
    return q.order('id');
  }
  async function qCarica(pag) {
    const my = ++qReq; qPag = Math.max(0, pag || 0); qSel = null; qRip = false;
    $('#q-list').innerHTML = '<div class="empty">Carico…</div>'; $('#q-pg').innerHTML = '';
    const { data, error, count } = await qQuery().range(qPag * PAGINA, qPag * PAGINA + PAGINA - 1);
    if (my !== qReq) return;
    if (error) { $('#q-list').innerHTML = `<div class="empty">Errore: ${esc(error.message)}${kind() === 'cand' ? ' — hai eseguito supabase/03_candidati.sql?' : ' (sei registrato come admin? controlla la tabella admins)'}</div>`; qVuota(); return; }
    qTot = count ?? data.length; if (!data.length && qTot > 0 && qPag > 0) { qCarica(Math.ceil(qTot / PAGINA) - 1); return; }
    qItems = data; if (kind() === 'cand' && cf === 'nuovo') qItems.sort((a, b) => score(b) - score(a)); // i più sicuri per primi (dentro la pagina)
    renderQList(); if (qItems.length) qSelect(qItems[0].id); else qVuota();
  }
  function qTitolo(x) { return kind() === 'cand' ? (CLASSE_LABEL[x.classe] || x.classe) : `${x.nome || x.indirizzo || TIPO[x.tipo]} · ${x.posti} ${x.posti > 1 ? 'posti' : 'posto'}`; }
  function renderQList() {
    const tot = Math.max(1, Math.ceil(qTot / PAGINA));
    $('#q-list').innerHTML = qItems.length ? qItems.map((x) => kind() === 'cand'
      ? `<button class="row-item${qSel && qSel.id === x.id ? ' sel' : ''}" data-id="${x.id}"><span><span class="n">${esc(qTitolo(x))}</span><br><span class="s">${esc(x.comune || '—')} · visto ${x.last_seen ? new Date(x.last_seen).toLocaleDateString('it-IT') : '—'} · ${esc(x.fonte)}${score(x) >= 0 ? ' · ' + score(x) + '%' : ''}</span></span><span class="s">${esc(x.stato)}</span></button>`
      : `<button class="row-item${qSel && qSel.id === x.id ? ' sel' : ''}" data-id="${x.id}"><span><span class="n">${esc(qTitolo(x))}</span><br><span class="s">${TIPO[x.tipo]} · ${esc(x.comune || '—')} · ${esc(x.fonte)} · ${new Date(x.created_at).toLocaleDateString('it-IT')}${x.conferme_esiste ? ` · ✓${x.conferme_esiste}` : ''}${x.conferme_non_esiste ? ` · ✗${x.conferme_non_esiste}` : ''}${x.foto_url ? ' · 📷' : ''}</span></span><span class="s">${esc(x.stato)}</span></button>`).join('')
      : '<div class="empty">Niente da controllare qui. 🎉</div>';
    $('#q-pg').innerHTML = qTot > PAGINA ? `<button class="btn sm" data-pg="-1" ${qPag === 0 ? 'disabled' : ''}>‹ Prima</button><span>Pagina ${qPag + 1} di ${tot} · ${fmt(qTot)}</span><button class="btn sm" data-pg="1" ${qPag + 1 >= tot ? 'disabled' : ''}>Dopo ›</button>` : `<span>${fmt(qTot)} ${qTot === 1 ? 'elemento' : 'elementi'}</span>`;
  }
  $('#q-pg').addEventListener('click', (e) => { const b = e.target.closest('[data-pg]'); if (b) qCarica(qPag + (+b.dataset.pg)); });
  $('#q-list').addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) qSelect(b.dataset.id); });

  function ensureCmap() {
    if (cmap) return; cmap = L.map('cmap').setView([C.HOME.lat, C.HOME.lon], 18);
    cBase = baseCtl(cmap, mkBases(), $('#c-bases'), 'cbase', 'esri');
    $('#c-bases').addEventListener('change', () => { cBaseUser = true; });
  }
  function qVuota(msg) {
    qSel = null; $('#q-info').innerHTML = `<div class="empty">${esc(msg || '')} ${qTot ? '' : 'Finito: non c\'è altro in questo elenco. 🎉'}</div>`; $('#q-mapbox').hidden = true; $('#q-acts').innerHTML = ''; $('#q-msg').textContent = '';
  }
  function qSelect(id) {
    const it = qItems.find((x) => x.id === id); if (!it) return; qSel = it; qRip = false; const cand = kind() === 'cand';
    $$('#q-list .row-item').forEach((b) => { const on = b.dataset.id === id; b.classList.toggle('sel', on); if (on) b.scrollIntoView({ block: 'nearest' }); });
    $('#q-mapbox').hidden = false; ensureCmap(); setTimeout(() => cmap.invalidateSize(), 0);
    if (cmarker) cmap.removeLayer(cmarker);
    cmarker = L.marker([it.lat, it.lon], { draggable: true, zIndexOffset: 2000, icon: cand ? L.divIcon({ className: '', html: '<div class="pin generico sel"><b>♿</b></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) : icon(it, true) }).addTo(cmap);
    cmarker.dragging.disable(); cmarker.on('dragend', () => { const p = cmarker.getLatLng(); flash(`Nuova posizione: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} (spostato di ${Math.round(L.latLng(it.lat, it.lon).distanceTo(p))} m)`); });
    cmap.setView([it.lat, it.lon], 20);
    if (!cBaseUser) cBase.set(inFvg(it.lat, it.lon) ? 'fvg' : 'esri'); else if (cBase.get() === 'fvg' && !inFvg(it.lat, it.lon)) cBase.set('esri');
    const coord = `${it.lat.toFixed(6)}, ${it.lon.toFixed(6)} · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${it.lat},${it.lon}&layer=c&cbll=${it.lat},${it.lon}">Street View</a>`;
    if (cand) {
      const c = it, ritaglio = c.fonte === 'satellite' && c.note && /^https?:/.test(c.note);
      $('#q-info').innerHTML = `<div class="badges"><span class="badge proposto" style="background:#7c3aed">${esc(CLASSE_LABEL[c.classe] || c.classe)}</span><span class="badge osm">${esc(c.fonte)}</span><span class="badge osm">${esc(c.stato)}</span>${score(c) >= 0 ? `<span class="badge osm">sicurezza ${score(c)}%</span>` : ''}</div>
        <div class="sub">${coord} · visto dal ${c.first_seen ? new Date(c.first_seen).toLocaleDateString('it-IT') : '—'} al ${c.last_seen ? new Date(c.last_seen).toLocaleDateString('it-IT') : '—'}${c.fonte === 'mapillary' ? ` · <a target="_blank" rel="noopener" href="https://www.mapillary.com/app/?lat=${c.lat}&lng=${c.lon}&z=18${c.image_id ? '&pKey=' + c.image_id : ''}">Apri in Mapillary</a>` : ''}</div>
        <div id="q-near"></div>
        ${ritaglio ? `<a href="${esc(c.note)}" target="_blank" rel="noopener"><img src="${esc(c.note)}" alt="Ritaglio dell'ortofoto attorno al candidato" style="max-width:360px"></a>` : ''}
        ${cf === 'nuovo' ? `<div class="field two"><label>Tipo<select id="c-tipo"><option value="generico">Generico</option><option value="personalizzato">Personalizzato</option><option value="sconosciuto">Sconosciuto</option></select></label><label>Posti<input type="number" id="c-posti" min="1" value="1"></label></div>
        <label class="field">Note<input type="text" id="c-note" placeholder="es. davanti al civico 12"></label>` : ''}`;
      sb.from('stalli').select('nome,indirizzo,tipo,lat,lon').neq('stato', 'rifiutato').gte('lat', c.lat - 0.0005).lte('lat', c.lat + 0.0005).gte('lon', c.lon - 0.0008).lte('lon', c.lon + 0.0008).limit(20).then(({ data }) => {
        const v = (data || []).filter((r) => L.latLng(r.lat, r.lon).distanceTo([c.lat, c.lon]) <= 40), n = $('#q-near');
        if (v.length && qSel === it && n) n.innerHTML = `<div class="warn">Attenzione: ${v.length} stallo/i già presenti entro 40 m (${v.map((r) => esc(r.nome || r.indirizzo || r.tipo)).join(', ')}). Forse è lo stesso.</div>`;
      });
    } else {
      const s = it, nonce = qTab === 'nonce';
      $('#q-info').innerHTML = `<div class="badges"><span class="badge ${s.tipo}">${TIPO[s.tipo]}</span><span class="badge ${s.stato}">${esc(s.stato)}</span><span class="badge osm">${esc(s.fonte)}</span></div>
        ${nonce ? `<div class="warn">${fmt(s.conferme_non_esiste)} ${s.conferme_non_esiste === 1 ? 'persona dice' : 'persone dicono'} che non c'è più${s.ultima_conferma ? ' (ultima il ' + new Date(s.ultima_conferma).toLocaleDateString('it-IT') + ')' : ''} · ${fmt(s.conferme_esiste)} dicono che esiste.</div>` : ''}
        ${s.foto_url ? `<a href="${esc(s.foto_url)}" target="_blank" rel="noopener"><img src="${esc(s.foto_url)}" alt="Foto dello stallo"></a>` : ''}
        <dl class="dl"><dt>Indirizzo</dt><dd>${esc(s.indirizzo || '–')}</dd><dt>Comune</dt><dd>${esc(s.comune || '–')}</dd><dt>Nome</dt><dd>${esc(s.nome || '–')}</dd><dt>Posti</dt><dd>${s.posti}</dd><dt>Note</dt><dd>${esc(s.note || '–')}</dd>
        <dt>Segnalato il</dt><dd>${dataOra(s.created_at)}</dd>${!nonce ? `<dt>Conferme</dt><dd>esiste ${fmt(s.conferme_esiste)} · non esiste ${fmt(s.conferme_non_esiste)}</dd>` : ''}</dl>
        <div class="sub">${coord} · <a href="#/mappa?id=${s.id}">Modifica tutti i campi nella mappa</a></div>`;
    }
    qActs(); $('#q-msg').textContent = qFlash; qFlash = '';
  }
  function qActs() {
    const cand = kind() === 'cand'; let h;
    if (qRip) h = `<button class="btn ap" data-act="ripok">✓ Salva posizione e approva <kbd>R</kbd></button><button class="btn" data-act="ripno">Annulla <kbd>Esc</kbd></button>`;
    else if (cand && cf !== 'nuovo') h = `<button class="btn" data-act="reset">Rimetti tra i "da verificare"</button><button class="btn" data-act="skip">Salta ›</button>`;
    else {
      const T = qTab === 'nonce' ? ['Esiste ancora', 'Riposiziona e lascia', 'Rimuovi dalla mappa'] : qTab === 'cand' && !cand ? ['Giusto', 'Riposiziona e conferma', 'Sbagliato: togli dalla mappa'] : cand ? ['Approva: crea lo stallo', 'Riposiziona e approva', 'Scarta'] : ['Approva', 'Riposiziona e approva', 'Rifiuta'];
      h = `<button class="btn ap" data-act="ok">✓ ${T[0]} <kbd>A</kbd></button><button class="btn" data-act="rip">📍 ${T[1]} <kbd>R</kbd></button><button class="btn danger" data-act="no">✗ ${T[2]} <kbd>X</kbd></button><button class="btn" data-act="skip">Salta › <kbd>→</kbd></button>`;
    }
    $('#q-acts').innerHTML = h;
  }
  const flash = (t) => { $('#q-msg').textContent = t || ''; };
  $('#q-acts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !qSel || qBusy) return; const a = b.dataset.act;
    if (a === 'ok') qOk(null); else if (a === 'no') qNo(); else if (a === 'skip') qSkip(); else if (a === 'reset') qReset();
    else if (a === 'rip') { qRip = true; cmarker.dragging.enable(); cmap.setView([qSel.lat, qSel.lon], 20); qActs(); flash('Trascina il pin nel punto giusto (puoi cambiare la vista della mappa), poi premi "Salva posizione e approva".'); const m = $('#cmap'); if (m) m.scrollIntoView({ block: 'nearest' }); }
    else if (a === 'ripno') { qRip = false; cmarker.dragging.disable(); cmarker.setLatLng([qSel.lat, qSel.lon]); qActs(); flash(''); }
    else if (a === 'ripok') { const p = cmarker.getLatLng(); qOk([+p.lat.toFixed(6), +p.lng.toFixed(6)]); }
  });
  // scorciatoie: solo se il focus non è in un campo di testo
  document.addEventListener('keydown', (e) => {
    if (current !== 'controllare' || !qSel || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target; if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const k = e.key.toLowerCase(), go = (s) => { const b = $(s); if (b) { e.preventDefault(); b.click(); } };
    if (qRip) { if (k === 'a' || k === 'r') go('[data-act=ripok]'); else if (k === 'escape') go('[data-act=ripno]'); return; }
    if (k === 'a') go('[data-act=ok]'); else if (k === 'r') go('[data-act=rip]'); else if (k === 'x') go('[data-act=no]'); else if (k === 'arrowright') go('[data-act=skip]');
  });

  // dopo una decisione: toglie l'elemento dall'elenco e apre il successivo
  function qFatto(msg) {
    const id = qSel.id, i = qItems.findIndex((x) => x.id === id); qItems.splice(i, 1); qTot = Math.max(0, qTot - 1); qRip = false; aggiornaTodo();
    if (!qItems.length) { if (qTot > 0) { qFlash = msg; qCarica(Math.min(qPag, Math.ceil(qTot / PAGINA) - 1)); } else { renderQList(); qVuota(msg); } return; }
    renderQList(); qFlash = msg + ' Ecco il prossimo.'; qSelect(qItems[Math.min(i, qItems.length - 1)].id);
  }
  function qSkip() {
    const i = qItems.findIndex((x) => x.id === qSel.id);
    if (i < qItems.length - 1) qSelect(qItems[i + 1].id);
    else if ((qPag + 1) * PAGINA < qTot) qCarica(qPag + 1);
    else if (qItems.length > 1) qSelect(qItems[0].id); else flash('Non ci sono altri elementi.');
  }
  async function qLavora(msg, fn) {
    qBusy = true; flash(msg);
    try { const ok = await fn(); if (ok !== false) return true; } catch (e) { flash('Errore: ' + (e.message || e)); } finally { qBusy = false; }
    return false;
  }
  const chk = (r) => { if (r.error) throw r.error; return r; };
  // Approva / Giusto / Esiste ancora (pos = nuova posizione se si è riposizionato)
  async function qOk(pos) {
    const it = qSel;
    if (await qLavora('Salvo…', async () => {
      if (kind() === 'cand') {
        const c = it, p = pos || [c.lat, c.lon];
        const rec = { lat: p[0], lon: p[1], tipo: $('#c-tipo').value, posti: +$('#c-posti').value || 1, note: $('#c-note').value.trim() || null, comune: c.comune, stato: 'verificato', fonte: c.fonte, segnale_verticale: c.fonte === 'mapillary' ? true : null, nome: null };
        const { data } = chk(await sb.from('stalli').insert(rec).select().single());
        const r2 = await sb.from('candidati').update({ stato: 'accettato', stallo_id: data.id }).eq('id', c.id); if (r2.error) alert('Stallo creato, ma il candidato non è stato aggiornato: ' + r2.error.message);
        return;
      }
      const upd = {}; if (pos) { upd.lat = pos[0]; upd.lon = pos[1]; }
      if (qTab === 'utenti' || qTab === 'proposti' || qTab === 'precisare') upd.stato = 'verificato'; else if (qTab === 'cand') upd.note = (it.note || '') + ' · controllato';
      if (qTab === 'precisare') upd.note = (it.note || '').replace(/posizione approssimata sulla via: da verificare;?\s*/i, pos ? 'posizione controllata sul satellite; ' : 'approvato senza spostare il pin; ').trim() || null;
      if (Object.keys(upd).length) chk(await sb.from('stalli').update(upd).eq('id', it.id));
      if (qTab === 'nonce') ignora(it.id);
    })) qFatto(kind() === 'cand' ? 'Stallo creato.' : qTab === 'nonce' ? 'Lasciato in mappa.' : qTab === 'cand' ? 'Confermato.' : 'Approvato.');
  }
  // Rifiuta / Scarta / Rimuovi / Sbagliato
  async function qNo() {
    const it = qSel; let motivo = null;
    if (qTab === 'utenti') { // il motivo lo legge chi ha fatto la segnalazione, in "Le mie segnalazioni"
      const m = prompt('Motivo del rifiuto (lo vedrà chi ha fatto la segnalazione). Lascia vuoto per non indicarlo.', ''); if (m === null) return; motivo = m.trim() || null;
    }
    if (await qLavora('Salvo…', async () => {
      if (kind() === 'cand') { chk(await sb.from('candidati').update({ stato: 'scartato' }).eq('id', it.id)); return; }
      if (qTab === 'nonce') { chk(await sb.from('stalli').update({ stato: 'rimosso' }).eq('id', it.id)); return; }
      if (qTab === 'cand') { chk(await sb.from('stalli').update({ stato: 'rifiutato', note: (it.note || '') + ' · controllato: sbagliato' }).eq('id', it.id)); await sb.from('candidati').update({ stato: 'scartato' }).eq('stallo_id', it.id); return; }
      const patch = { stato: 'rifiutato' }; if (qTab === 'utenti') patch.motivo_rifiuto = motivo;
      let { error } = await sb.from('stalli').update(patch).eq('id', it.id);
      if (error && 'motivo_rifiuto' in patch && /motivo_rifiuto/.test(error.message)) { delete patch.motivo_rifiuto; ({ error } = await sb.from('stalli').update(patch).eq('id', it.id)); if (!error) alert('Rifiutato, ma il motivo non è stato salvato: manca ancora la colonna nel database (file supabase/08_mie_segnalazioni.sql).'); }
      if (error) throw error;
    })) qFatto(kind() === 'cand' ? 'Scartato.' : qTab === 'nonce' ? 'Tolto dalla mappa.' : qTab === 'cand' ? 'Tolto dalla mappa.' : 'Rifiutato.');
  }
  async function qReset() { const it = qSel; if (await qLavora('Salvo…', async () => { chk(await sb.from('candidati').update({ stato: 'nuovo' }).eq('id', it.id)); })) qFatto('Rimesso tra i da verificare.'); }

  // ======================================================================
  // UTENTI (account dell'app: rpc utenti_admin / elimina_utente_admin, vedi supabase/16_utenti.sql)
  // ======================================================================
  let utenti = [];
  const MANCA16 = 'Esegui supabase/16_utenti.sql nell\'editor SQL di Supabase.';
  PAGES.utenti = { load() { loadUtenti(); } };
  async function loadUtenti() {
    $('#u-msg').textContent = 'Carico gli utenti…';
    const { data, error } = await sb.rpc('utenti_admin');
    if (error) { utenti = []; $('#u-rows').innerHTML = ''; $('#u-tot').textContent = ''; $('#u-n').textContent = ''; $('#u-msg').innerHTML = /function|schema cache|does not exist/i.test(error.message) ? esc(MANCA16) : 'Errore: ' + esc(error.message); return; }
    utenti = data; $('#u-msg').textContent = '';
    $('#u-tot').textContent = `· ${fmt(data.length)} ${data.length === 1 ? 'account' : 'account in totale'}`;
    const { count } = await sb.from('eventi').select('id', { count: 'exact', head: true }).eq('tipo', 'account_eliminato');
    if (count) $('#u-tot').textContent += ` · ${fmt(count)} eliminati dall'app`;
    renderUtenti();
  }
  const PROV = { google: 'Google', email: 'Email e password' };
  function renderUtenti() {
    const q = $('#u-q').value.trim().toLowerCase(), v = utenti.filter((u) => !q || (u.email || '').toLowerCase().includes(q));
    $('#u-n').textContent = q ? `${fmt(v.length)} trovati` : '';
    const dt = (d) => d ? new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
    $('#u-rows').innerHTML = (v.slice(0, 300).map((u) => `<tr data-id="${esc(u.id)}"><td>${esc(u.email || '(senza email)')}</td><td>${esc(PROV[u.provider] || u.provider || '–')}</td><td>${dt(u.created_at)}</td><td>${dt(u.last_sign_in_at)}</td>
      <td>${u.email_confirmed_at ? '<span class="tag2 ok">sì</span>' : '<span class="tag2 no">no</span>'}</td><td><button class="btn danger sm" data-del="${esc(u.id)}" aria-label="Elimina l'account ${esc(u.email || '')}">Elimina</button></td></tr>`).join('') || '<tr><td colspan="6" class="sub">Nessun utente.</td></tr>')
      + (v.length > 300 ? `<tr><td colspan="6" class="sub">Mostro i primi 300: restringi la ricerca.</td></tr>` : '');
  }
  let uT; $('#u-q').addEventListener('input', () => { clearTimeout(uT); uT = setTimeout(renderUtenti, 150); });
  $('#u-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return; const u = utenti.find((x) => x.id === b.dataset.del); if (!u) return;
    if (!confirm(`Eliminare definitivamente l'account ${u.email || u.id}?\n\nSi cancellano l'account, l'email e i dati salvati nell'account (preferiti, scadenza del contrassegno). I posti segnalati e le conferme restano, anonimi. L'operazione non si può annullare.`)) return;
    b.disabled = true; const { error } = await sb.rpc('elimina_utente_admin', { p_id: u.id });
    if (error) { b.disabled = false; $('#u-msg').textContent = /function|schema cache|does not exist/i.test(error.message) ? MANCA16 : 'Non riesco a eliminare: ' + error.message; return; }
    utenti = utenti.filter((x) => x.id !== u.id); $('#u-msg').textContent = 'Account eliminato.'; renderUtenti(); $('#u-tot').textContent = `· ${fmt(utenti.length)} account in totale`;
  });

  // ======================================================================
  // STRUMENTI (raggruppa stalli vicini, OpenStreetMap, contesto per la scansione)
  // ======================================================================
  PAGES.strumenti = { load() {} };

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
      // quali ci sono già: lo chiedo al server a gruppetti (senza scaricare tutti gli stalli)
      const have = new Set(), tuttiId = [...new Set(els.map((el) => `${el.type}/${el.id}`))];
      for (let i = 0; i < tuttiId.length; i += 100) { const { data, error } = await sb.from('stalli').select('osm_id').in('osm_id', tuttiId.slice(i, i + 100)); if (error) throw error; data.forEach((r) => have.add(r.osm_id)); }
      const recs = els.map((el) => osmConvert(el, (el.tags && (el.tags['addr:city'] || el.tags['is_in:city'])) || null)).filter((r) => r && !have.has(r.osm_id));
      ilog(`Nuovi stalli da aggiungere: ${recs.length} (già presenti: ${els.length - recs.length}).`);
      for (let i = 0; i < recs.length; i += 200) { const { error } = await sb.from('stalli').upsert(recs.slice(i, i + 200), { onConflict: 'osm_id', ignoreDuplicates: true }); if (error) throw error; ilog(`  salvati ${Math.min(i + 200, recs.length)}/${recs.length}`); }
      ilog('Fatto.'); aggiornaTodo();
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


  $('#l-app').href = $('.nv-foot a').getAttribute('href'); // stesso indirizzo dell'altro link all'app (cambia con la disposizione di pubblicazione)
  $('#ver').textContent = 'v' + C.VERSION;
  boot();
})();
