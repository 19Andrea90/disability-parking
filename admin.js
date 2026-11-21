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
    // Questo browser è del gruppo "dispositivi interni": l'app (stessa origine, stesso localStorage) manda interno:true in ogni evento e
    // le statistiche lo escludono (supabase/20). Si imposta solo se l'account è davvero admin.
    sb.rpc('is_admin').then(({ data }) => { if (data === true) lsSet('dp.interno', 1); }, () => {});
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
    const [utenti, proposti, nonce, precisare, cand, pecAtt, pecScad, sugg, problemi] = await Promise.all([
      cnt('stalli_con_conferme', (q) => q.eq('fonte', 'utente').eq('stato', 'proposto')),
      cnt('stalli_con_conferme', (q) => nonApprox(q.eq('stato', 'proposto').neq('fonte', 'utente'))),
      cnt('stalli_con_conferme', qNonce),
      cnt('stalli_con_conferme', (q) => q.eq('stato', 'proposto').ilike('note', APPROX)),
      cnt('candidati', (q) => q.eq('stato', 'nuovo')),
      cnt('pec_comuni', (q) => q.in('stato', ['Inviata', 'Risposta ricevuta'])),
      cnt('pec_comuni', (q) => q.in('stato', ['Inviata', 'Risposta ricevuta']).lte('inviata', giorniFa(23))), // scadenza = invio + 30 giorni: entro 7 giorni (o già scaduta)
      cnt('suggerimenti', (q) => q.eq('stato', 'nuovo')),
      cnt('problemi_posti', (q) => q.eq('stato', 'aperto'))]); // null se la tabella non c'è ancora (supabase/23_problemi_posti.sql): l'app admin non si rompe
    Object.assign(todo, { utenti, proposti, nonce, precisare, cand, pecAtt, pecScad, sugg, problemi });
    const tot = [utenti, proposti, nonce, cand, problemi].reduce((a, n) => a + (n || 0), 0), b = $('#badge');
    b.textContent = tot > 99 ? '99+' : tot; b.hidden = !tot; b.setAttribute('aria-label', tot + ' da controllare');
    renderTodo(); if (typeof renderQTabs === 'function') renderQTabs();
  }
  function renderTodo() {
    const t = todo, v = (n) => (n == null ? '–' : fmt(n));
    const tile = (href, n, l, x) => `<a class="tile ${n > 0 ? 'on' : 'zero'}" href="${href}"><span class="go" aria-hidden="true">›</span><b>${v(n)}</b><span class="l">${l}</span>${x ? `<span class="x">${x}</span>` : ''}</a>`;
    const sErr = (t.sugg == null && t.errori == null) ? null : (t.sugg || 0) + (t.errori || 0);
    $('#todo').innerHTML = tile('#/controllare?t=utenti', t.utenti, 'Segnalazioni degli utenti', 'posti proposti da approvare')
      + tile('#/controllare?t=proposti', t.proposti, 'Posti da approvare', 'proposti da altre fonti')
      + tile('#/controllare?t=problemi', t.problemi, 'Problemi segnalati', 'dalla scheda di un posto: non c\'è più, spostato, targa…')
      + tile('#/controllare?t=precisare', t.precisare, 'Posizione da precisare', 'dagli elenchi dei Comuni, pin solo sulla via')
      + tile('#/controllare?t=nonce', t.nonce, 'Segnalati "non c\'è più"', 'qualcuno dice che il posto non esiste')
      + tile('#/comuni?f=scad7', t.pecAtt, 'PEC in attesa di risposta', `${v(t.pecScad)} in scadenza entro 7 giorni (o già scadute)`)
      + tile('#/suggerimenti', sErr, 'Suggerimenti ed errori', `${v(t.sugg)} suggerimenti nuovi · ${t.errori == null ? '…' : fmt(t.errori)} errori in 24 h`)
      + tile('#/controllare?t=cand', t.cand, 'Candidati da verificare', 'trovati dalla rete sul satellite');
  }

  // ======================================================================
  // DASHBOARD
  // ======================================================================
  // La dashboard ha due schede: "Statistiche dell'app" e "Consumi e limiti gratuiti" (#/dashboard?s=consumi). L'ultima scelta resta in memoria nel browser.
  let dashSez = null;
  PAGES.dashboard = {
    load(forza) { renderTodo(); aggiornaTodo(); kpiFast(); statistiche(); caricaConsumi(); },
    show(params) {
      const s = params.get('s') || lsGet('adm.dashSez', 'stat'); dashSez = s === 'consumi' ? 'consumi' : 'stat';
      if (params.get('s')) lsSet('adm.dashSez', dashSez);
      $$('.dtab').forEach((b) => { const on = b.dataset.s === dashSez; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      $('#dp-stat').hidden = dashSez !== 'stat'; $('#dp-consumi').hidden = dashSez !== 'consumi';
      statDaHash(params);
    }
  };
  function vaiSezione(s, focus) { lsSet('adm.dashSez', s); location.hash = '#/dashboard' + (s === 'consumi' ? '?s=consumi' : '?s=stat'); if (focus) $('#dt-' + s).focus(); }
  document.addEventListener('click', (e) => { const b = e.target.closest('.dtab'); if (b) vaiSezione(b.dataset.s); });
  document.addEventListener('keydown', (e) => { // schede: frecce, Home e Fine, come in una tablist
    const b = e.target.closest && e.target.closest('.dtab'); if (!b) return; const t = $$('.dtab'); let i = t.indexOf(b);
    if (e.key === 'ArrowRight') i = (i + 1) % t.length; else if (e.key === 'ArrowLeft') i = (i - 1 + t.length) % t.length; else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = t.length - 1; else return;
    e.preventDefault(); vaiSezione(t[i].dataset.s, true);
  });
  // conteggi subito dal server, senza scaricare gli stalli
  async function kpiFast() {
    const c = async (f) => { const { count } = await f(sb.from('stalli_con_conferme').select('id', { count: 'exact', head: true })); return count ?? '…'; };
    const [s0, p, v, u, x, t] = await Promise.all([c((q) => q.eq('stato', 'proposto').eq('fonte', 'utente')), c((q) => q.eq('stato', 'proposto')), c((q) => q.eq('stato', 'verificato')), c((q) => q.eq('stato', 'ufficiale')),
      c((q) => q.gt('conferme_non_esiste', 0).neq('stato', 'rifiutato')), c((q) => q.in('stato', ['proposto', 'verificato', 'ufficiale']))]);
    $('#kpi').innerHTML = [['Segnalazioni utenti', s0], ['Da approvare', p], ['Verificati', v], ['Ufficiali', u], ['Con "non esiste"', x], ['Totale attivi', t]].map((k) => `<div>${k[0]}<b>${typeof k[1] === 'number' ? fmt(k[1]) : k[1]}</b></div>`).join('');
  }
  // ---------- statistiche d'uso: filtrabili e interattive (rpc statistiche_admin_filtri, supabase/19_statistiche_filtri.sql) ----------
  // Se la funzione non è ancora nel database la scheda mostra un avviso e ricade sulla vista fissa di statistiche_admin().
  // Dispositivo "reale" = ha fatto almeno un'azione oltre all'apertura ('avvio'): i test automatici e le anteprime aprono e basta.
  const PERIODI = [['oggi', 'Oggi'], ['7g', '7 giorni'], ['30g', '30 giorni'], ['90g', '90 giorni'], ['12m', '12 mesi'], ['pers', 'Personalizzato']];
  const PIATT = [['', 'Tutte'], ['android', 'Android'], ['ios', 'iPhone'], ['web', 'Web da telefono'], ['pc', 'Computer']];
  const PF = { android: 'Android', ios: 'iPhone', web: 'Web da telefono', pc: 'Web da computer', '?': 'Sconosciuta' };
  // un colore e un tratteggio per serie, fissi (la serie non cambia colore se ne accendi altre)
  const SERIE = {
    attivi: { n: 'Dispositivi attivi', c: '#2a78d6', d: '' }, nuovi: { n: 'Nuovi dispositivi', c: '#eb6834', d: '6 3' },
    sessioni: { n: 'Sessioni', c: '#1baf7a', d: '2 3' }, naviga: { n: 'Navigazioni', c: '#6250d6', d: '8 3 2 3' },
    arrivati: { n: 'Arrivati al posto', c: '#008300', d: '' }, occupato: { n: 'Trovato occupato', c: '#c98500', d: '6 3' },
    schede: { n: 'Posti aperti', c: '#d55181', d: '2 3' }, segnalazioni: { n: 'Segnalazioni', c: '#e34948', d: '8 3 2 3' },
    registrazioni: { n: 'Registrazioni', c: '#4a5668', d: '' }, errori: { n: 'Errori', c: '#8c1b14', d: '6 3' } };
  const SERIE_BASE = ['attivi', 'naviga', 'nuovi'];
  const KPI = [['attivi', 'Dispositivi attivi', 'attivi'], ['nuovi', 'Nuovi dispositivi', 'nuovi'], ['sessioni', 'Sessioni (aperture)', 'sessioni'], ['navigazioni', 'Navigazioni avviate', 'naviga'],
    ['arrivati', 'Arrivati al posto', 'arrivati'], ['occupato', 'Trovato occupato', 'occupato'], ['schede', 'Posti aperti', 'schede'], ['segnalazioni', 'Segnalazioni degli utenti', 'segnalazioni'],
    ['registrazioni', 'Registrazioni', 'registrazioni'], ['errori', 'Errori dell\'app', 'errori']];
  // interni: escludi i dispositivi interni (Andrea, Giulia, controlli); soglia: cosa conta come "reale" ('attivo' = resta ~2 minuti; 'azione' = fa almeno un'azione)
  const SOGLIE = [['attivo', 'Chi resta almeno 2 minuti'], ['azione', 'Solo chi fa un\'azione']];
  const SF = { pronto: false, p: '30g', dal: '', al: '', pl: '', reali: true, interni: true, soglia: 'attivo', g: '', serie: SERIE_BASE.slice(), msg: '' };
  const ST = { D: null, chiave: '', vecchia: null, mancante: false, focus: '', hov: -1, n: 0, f4: 0, v20: true, intAperto: false, intElenco: null, intErr: '' };
  const isoD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T12:00:00Z'));
  const addG = (s, n) => new Date(Date.parse(s + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const diffG = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
  const oggiRoma = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const dm = (s) => s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '';
  const giornoLungo = (s) => new Date(s + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  function intervallo() { // [dal, al] scelti, oppure null se la scelta "Personalizzato" non è valida
    const t = oggiRoma(), p = SF.p;
    if (p === 'oggi') return [t, t]; if (p === '7g') return [addG(t, -6), t]; if (p === '30g') return [addG(t, -29), t]; if (p === '90g') return [addG(t, -89), t]; if (p === '12m') return [addG(t, -364), t];
    if (!isoD(SF.dal) || !isoD(SF.al)) { SF.msg = 'Scegli le due date.'; return null; }
    if (SF.dal > SF.al) { SF.msg = 'La data iniziale è dopo quella finale.'; return null; }
    if (SF.al > t) { SF.msg = 'La data finale è nel futuro.'; return null; }
    if (diffG(SF.dal, SF.al) + 1 > 366) { SF.msg = 'Il periodo può essere lungo al massimo 366 giorni.'; return null; }
    return [SF.dal, SF.al];
  }
  const filtriChiave = () => JSON.stringify([SF.p, SF.p === 'pers' ? SF.dal : '', SF.p === 'pers' ? SF.al : '', SF.pl, SF.reali, SF.interni, SF.soglia, SF.g]);
  function filtriDaHash(params) { // #/dashboard?p=30g&pl=android&r=0&g=2026-11-19 (senza parametri: l'ultima scelta ricordata nel browser)
    const m = lsGet('adm.statF', {}), has = ['p', 'pl', 'r', 'i', 't', 'g', 'dal', 'al'].some((k) => params.has(k)), src = has ? { p: params.get('p'), pl: params.get('pl'), r: params.get('r'), i: params.get('i'), t: params.get('t'), g: params.get('g'), dal: params.get('dal'), al: params.get('al') } : { p: m.p, pl: m.pl, r: m.reali === false ? '0' : '1', i: m.interni === false ? '0' : '1', t: m.soglia, g: '', dal: m.dal, al: m.al };
    SF.p = PERIODI.some((x) => x[0] === src.p) ? src.p : '30g';
    SF.pl = PIATT.some((x) => x[0] === (src.pl || '')) ? (src.pl || '') : '';
    SF.reali = src.r !== '0'; SF.interni = src.i !== '0'; SF.soglia = SOGLIE.some((x) => x[0] === src.t) ? src.t : 'attivo'; SF.g = isoD(src.g) ? src.g : ''; SF.dal = isoD(src.dal) ? src.dal : ''; SF.al = isoD(src.al) ? src.al : '';
    if (SF.p === 'pers' && !SF.dal && !SF.al) SF.p = '30g';
    if (has) memoFiltri();
    SF.pronto = true;
  }
  const memoFiltri = () => lsSet('adm.statF', { p: SF.p, dal: SF.dal, al: SF.al, pl: SF.pl, reali: SF.reali, interni: SF.interni, soglia: SF.soglia });
  function hashFiltri() {
    const old = parseHash().params, q = new URLSearchParams(); if (old.get('s')) q.set('s', old.get('s'));
    q.set('p', SF.p); if (SF.p === 'pers') { if (SF.dal) q.set('dal', SF.dal); if (SF.al) q.set('al', SF.al); }
    if (SF.pl) q.set('pl', SF.pl); if (!SF.reali) q.set('r', '0'); if (!SF.interni) q.set('i', '0'); if (SF.soglia !== 'attivo') q.set('t', SF.soglia); if (SF.g) q.set('g', SF.g);
    return '#/dashboard?' + q.toString();
  }
  function cambiaFiltri(mod, focus) { // applica un cambio: ricorda la scelta, aggiorna l'indirizzo (la cronologia del browser segue i filtri) e ricarica
    mod(); SF.msg = ''; ST.focus = focus || ''; ST.hov = -1;
    memoFiltri();
    const h = hashFiltri(); if (location.hash !== h) location.hash = h; statistiche();
  }
  const azzeraFiltri = () => cambiaFiltri(() => { SF.p = '30g'; SF.dal = SF.al = SF.pl = SF.g = ''; SF.reali = true; SF.interni = true; SF.soglia = 'attivo'; SF.serie = SERIE_BASE.slice(); }, 'sf-azzera');
  function statDaHash(params) { // chiamata dal router a ogni cambio di indirizzo della dashboard
    const prima = filtriChiave(), era = SF.pronto; filtriDaHash(params);
    if (!params.get('p') && current === 'dashboard' && location.hash.indexOf('?s=consumi') < 0) { try { history.replaceState(null, '', hashFiltri()); } catch (e) { /* ok */ } }
    if (era && prima !== filtriChiave()) statistiche();
  }
  const msgManca = (e) => e && (e.code === 'PGRST202' || /function|does not exist|schema cache|could not find/i.test(e.message || ''));
  async function statistiche() {
    if (!SF.pronto) filtriDaHash(parseHash().params);
    const box = $('#stat'); if (!box) return; box.setAttribute('aria-busy', 'true');
    const ri = intervallo();
    const vecchia = sb.rpc('statistiche_admin'); // serve a "Da fare oggi" (errori 24 h) e ai numeri non filtrabili; è la vista di riserva
    let nuova = null;
    if (ri) {
      const n = diffG(ri[0], ri[1]) + 1, kr = SF.g ? [SF.g, SF.g] : ri, gr = n === 1 ? [addG(ri[1], -13), ri[1]] : ri; // un solo giorno: il grafico mostra 14 giorni di contesto
      // Con la 20 la funzione ha 6 parametri (interni e soglia); con la sola 19 ne ha 4: se la firma nuova manca si ricade sulla vecchia
      // (e per 5 minuti non si riprova la nuova, per non fare due chiamate a ogni aggiornamento).
      const rpcF = async (r) => {
        const base = { p_dal: r[0], p_al: r[1], p_piattaforma: SF.pl || null, p_solo_reali: SF.reali };
        if (Date.now() - ST.f4 > 3e5) {
          const x = await sb.rpc('statistiche_admin_filtri', Object.assign({}, base, { p_escludi_interni: SF.interni, p_soglia: SF.soglia }));
          if (!(x.error && msgManca(x.error))) { ST.f4 = 0; return x; }
          ST.f4 = Date.now();
        }
        return sb.rpc('statistiche_admin_filtri', base);
      };
      const stessa = kr[0] === gr[0] && kr[1] === gr[1];
      nuova = Promise.all([rpcF(kr), stessa ? null : rpcF(gr)]).then(([a, b]) => ({ a, b, kr, gr, ri, stessa }));
    }
    const [vr, nr] = await Promise.all([vecchia, nuova]);
    box.removeAttribute('aria-busy');
    if (vr.data) { ST.vecchia = vr.data; todo.errori = vr.data.errori_24h; renderTodo(); $('#st-agg').textContent = 'Statistiche aggiornate alle ' + new Date(vr.data.agg).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    if (!ri) { ST.chiave = ''; ST.D = null; rendi(null, null); return; }
    const errore = nr.a.error || (nr.b && nr.b.error);
    if (errore) {
      if (msgManca(errore)) { ST.mancante = true; ST.D = null; ST.chiave = 'manca' + JSON.stringify(vr.data && vr.data.agg ? 1 : 0); box.innerHTML = htmlManca(vr); return; }
      box.innerHTML = `<div class="sf-avviso" role="alert">Errore nelle statistiche: ${esc(errore.message)}</div>`; return;
    }
    ST.mancante = false; ST.v20 = nr.a.data.soglia !== undefined; // la 20 aggiunge 'soglia', 'interni' ecc. alla risposta
    const D = { kpi: nr.a.data, graf: nr.stessa ? nr.a.data : nr.b.data, kr: nr.kr, gr: nr.gr, ri: nr.ri };
    const k = JSON.stringify([filtriChiave(), D.kpi, D.graf, vr.data && [vr.data.conferme_24h, vr.data.suggerimenti_nuovi, vr.data.errori_24h]], (key, v) => (key === 'agg' ? undefined : v));
    ST.agg = D.kpi.agg;
    if (k === ST.chiave) return; // niente è cambiato: non ridisegno (così non si perde un tooltip aperto)
    ST.chiave = k; ST.D = D; rendi(D, vr.data);
  }
  function htmlManca(vr) {
    return `<div class="sf-avviso" role="alert"><b>Statistiche filtrabili non attive.</b> Esegui <b>supabase/19_statistiche_filtri.sql</b> nell'editor SQL di Supabase: poi qui compariranno filtri, confronti e grafici interattivi, senza i test e i robot. Intanto vedi la vista fissa di sempre.</div>`
      + (vr.error ? `<div class="sub" style="margin-top:8px">${/function|does not exist|schema cache/i.test(vr.error.message) ? 'Manca il passo sul database: esegui <b>supabase/09_statistiche_suggerimenti.sql</b> nell\'editor SQL di Supabase.' : 'Errore: ' + esc(vr.error.message)}</div>`
        : `<div class="sf-nota">In questa vista i «nuovi telefoni» e gli utenti includono anche test automatici e anteprime: i numeri possono essere gonfiati.</div>` + htmlVecchia(vr.data));
  }
  const unGiorno = (D) => D.kr[0] === D.kr[1];
  function etichettaPrec(D) { const n = diffG(D.kr[0], D.kr[1]) + 1; return n === 1 ? 'al giorno prima' : `ai ${n} giorni prima`; }
  function variazione(c, p, cattivo, et) {
    c = Number(c || 0); p = Number(p || 0); let t, cl = 'eq';
    if (c === p) t = `= uguale ${et}`; else if (!p) { t = `▲ da 0 a ${fmt(c)} rispetto ${et}`; cl = cattivo ? 'cat' : 'buo'; } else { const d = Math.round((c - p) / p * 100); t = `${d > 0 ? '▲ +' : '▼ '}${d}% rispetto ${et}`; cl = (d > 0) === !!cattivo ? 'cat' : 'buo'; if (d === 0) cl = 'eq'; }
    return `<span class="sf-var ${cl}">${t}</span>`;
  }
  function rendi(D, vecchio) {
    const box = $('#stat'); if (!box) return;
    const ri = intervallo(), t = oggiRoma();
    // ---- barra dei filtri ----
    const periodo = PERIODI.map(([k, l]) => `<button type="button" class="btn sm" data-p="${k}" aria-pressed="${SF.p === k}">${l}</button>`).join('');
    const pers = SF.p === 'pers' ? `<div class="sf-date"><label>Dal <input type="date" id="sf-dal" value="${esc(SF.dal)}" max="${t}"></label><label>Al <input type="date" id="sf-al" value="${esc(SF.al)}" max="${t}"></label></div>` : '';
    const filtri = `<h3 class="sec-h">Come viene usata l'app</h3><div class="sf-bar" role="group" aria-label="Filtri delle statistiche">
      <div class="sf-gr"><span class="sf-lab" id="sf-lp">Periodo</span><div class="sf-seg" role="group" aria-labelledby="sf-lp">${periodo}</div>${pers}</div>
      <div class="sf-gr"><label class="sf-lab" for="sf-pl">Piattaforma</label><select id="sf-pl">${PIATT.map(([k, l]) => `<option value="${k}"${SF.pl === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="sf-sw"><input type="checkbox" id="sf-reali"${SF.reali ? ' checked' : ''}><span>Escludi test e robot</span></label>
      <div class="sf-gr"><label class="sf-lab" for="sf-soglia">Conta come reale</label><select id="sf-soglia"${ST.v20 ? '' : ' disabled'}${SF.reali ? '' : ' title="Vale solo con «Escludi test e robot»"'}>${SOGLIE.map(([k, l]) => `<option value="${k}"${SF.soglia === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="sf-sw"><input type="checkbox" id="sf-int"${SF.interni ? ' checked' : ''}${ST.v20 ? '' : ' disabled'}><span>Escludi dispositivi interni</span></label>
      <button type="button" class="btn sm" id="sf-azzera">Azzera filtri</button></div>`;
    const chips = (SF.g ? `<div class="sf-chips"><button type="button" class="sf-chip" id="sf-g" aria-label="Giorno ${dm(SF.g)} selezionato: tocca per tornare al periodo intero">Giorno: ${dm(SF.g)} <span aria-hidden="true">✕</span></button></div>` : '')
      + (SF.msg ? `<div class="sf-avviso" role="alert">${esc(SF.msg)}</div>` : '');
    if (!D) { box.innerHTML = filtri + chips; ripristinaFocus(); return; }
    const k = D.kpi, et = etichettaPrec(D);
    const kc = k.kpi || {}, kp = k.prec || {}, ad = k.adesso || {};
    const periodoTxt = unGiorno(D) ? `${giornoLungo(D.kr[0])}` : `dal ${dm(D.kr[0])} al ${dm(D.kr[1])}`, precTxt = k.prec_dal === k.prec_al ? dm(k.prec_dal) : `${dm(k.prec_dal)}–${dm(k.prec_al)}`;
    const riass = Number(k.giorni_riassunto || 0);
    const manca20 = k.soglia === undefined, nInt = Number(k.interni || 0);
    const note = [`<div class="sf-nota"><b>${periodoTxt}</b> · confronto con ${precTxt}${SF.pl ? ' · solo ' + (PF[SF.pl] || SF.pl) : ''} · ${SF.reali ? `test e robot esclusi${k.non_reali != null ? ` (${fmt(k.non_reali)} dispositivi: ${k.soglia === 'azione' ? 'non fanno nessuna azione' : 'aprono l\'app e basta'})` : ''}${k.soglia === 'azione' ? ' · conta come reale solo chi fa un\'azione' : ''}` : '<b>test e robot inclusi</b>'}.</div>`];
    if (manca20) note.push(`<div class="sf-avviso" role="status">Per i filtri «dispositivi interni» e «Conta come reale» esegui <b>supabase/20_dispositivi_interni.sql</b> nell'editor SQL di Supabase. Intanto valgono i filtri di prima.</div>`);
    else note.push(`<details class="sf-int" id="sf-intl"${ST.intAperto ? ' open' : ''}><summary>${SF.interni ? `${fmt(nInt)} dispositivi interni esclusi` : `<b>Dispositivi interni inclusi</b> (${fmt(nInt)} nel periodo)`} · elenco</summary><div id="sf-intbody">${htmlInterni()}</div></details>`);
    if (riass > 0) note.push(`<div class="sf-nota">Prima del ${dm(k.dettaglio_da)} restano solo i riassunti giornalieri (pulizia degli eventi vecchi): per ${riass === 1 ? 'quel giorno' : 'quei ' + riass + ' giorni'} ci sono sessioni, navigazioni e azioni, ma non dispositivi attivi o nuovi, e il filtro «test e robot» non si applica.</div>`);
    // ---- indicatori ----
    const adesso = `<div class="st-grid sf-adesso">
      <div class="stc live"><div class="l">Online adesso</div><b>${fmt(ad.online)}</b><div class="x">app aperta negli ultimi 5 minuti${SF.reali ? ' · un telefono conta dopo il primo «attivo» (2 min)' : ''}</div></div>
      <div class="stc"><div class="l">Dispositivi da sempre</div><b>${fmt(ad.telefoni_totali)}</b><div class="x">${SF.reali ? 'esclusi test e robot' : 'compresi test e robot'}${SF.pl ? ' · ' + (PF[SF.pl] || SF.pl) : ''}</div></div></div>`;
    const cards = KPI.map(([key, l, s]) => {
      const x = key === 'registrazioni' ? `<span class="sf-x">accessi: ${fmt(kc.accessi)}</span>` : key === 'nuovi' ? '<span class="sf-x">primo avvio nel periodo</span>' : key === 'attivi' ? '<span class="sf-x">dispositivi, non persone</span>' : key === 'segnalazioni' ? '<span class="sf-x">non filtrate per piattaforma</span>' : '';
      const sel = SF.serie.indexOf(s) >= 0;
      const manca = riass > 0 && (key === 'attivi' || key === 'nuovi');
      return `<button type="button" class="stk${sel ? ' on' : ''}" data-s="${s}" aria-pressed="${sel}" aria-label="${l}: ${fmt(kc[key])}. Mostra nel grafico"><span class="l">${l}</span><b>${fmt(kc[key])}${manca ? '*' : ''}</b>${variazione(kc[key], kp[key], key === 'errori', et)}${x}</button>`;
    }).join('');
    const arrivo = (kc.arrivati || kc.occupato) ? `<div class="sf-nota">Arrivati al posto: ${fmt(kc.arrivati)} · trovato occupato: ${fmt(kc.occupato)} (${pct(kc.occupato, (kc.arrivati || 0) + (kc.occupato || 0))} di chi ha detto com'è andata).</div>` : '';
    const dist = `<div class="st-cols box sf-cols">
        <div class="sf-sub"><div class="st-h">A che ora si usa</div><div class="sf-nota">Dispositivi attivi per ora del giorno, sommati sui giorni del periodo.</div><div class="sf-wrap" id="sf-ore"></div></div>
        <div class="sf-sub"><div class="st-h">Da dove usano l'app</div>${htmlPiattaforme(k)}<div class="st-h" style="margin-top:14px">Versioni in uso</div>${htmlVersioni(k)}</div></div>`;
    const dove = `<div class="st-cols box">
        <div><div class="st-h">Dove cercano ma mancano posti</div>${listaComuni(k.comuni_vuoti, 'Nessuna ricerca senza posti.')}<div class="sub" style="margin-top:6px">Sono i comuni da completare per primi (PEC, open data, scansione).</div></div>
        <div><div class="st-h">Dove si fanno portare</div>${listaComuni(k.comuni_naviga, 'Ancora nessuna navigazione.')}</div></div>`;
    const altri = vecchio ? `<h3 class="sec-h">Altri indicatori (non filtrati)</h3><div class="st-grid">
        <div class="stc"><div class="l">Conferme sul posto (24 h)</div><b>${fmt(vecchio.conferme_24h)}</b><div class="x">"non c'è più" in 7 giorni: ${fmt(vecchio.non_esiste_7g)}</div></div>
        <div class="stc"><div class="l">Suggerimenti da leggere</div><b>${fmt(vecchio.suggerimenti_nuovi)}</b><div class="x"><a href="#/suggerimenti">apri l'elenco</a></div></div>
        <div class="stc"><div class="l">Errori dell'app (24 h)</div><b>${fmt(vecchio.errori_24h)}</b><div class="x">su ${fmt(vecchio.errori_telefoni_24h)} telefoni · <a href="#/suggerimenti">vedi</a></div></div></div>` : '';
    const legenda = `<details class="sf-leg box"><summary>Come leggere questi numeri</summary><ul>
      <li><b>Dispositivi, non persone:</b> lo stesso utente su telefono e computer conta due volte.</li>
      <li><b>Dispositivo reale:</b> ha fatto almeno una cosa oltre ad aprire l'app (restare aperta 2 minuti, cercare, navigare, aprire un posto…). Chi apre e chiude in un attimo senza fare nulla si comporta come un test automatico, un'anteprima o un robot di Google Play, e con «Escludi test e robot» non viene contato.</li>
      <li><b>Sessione:</b> una apertura dell'app (dopo 30 minuti di pausa se ne conta un'altra). <b>Nuovo dispositivo:</b> il suo primissimo evento cade nel periodo.</li>
      <li>Gli eventi arrivano solo da chi non ha spento le statistiche, quindi i numeri sono per difetto. Segnalazioni e registrazioni vengono dal database e non dipendono dai filtri di piattaforma e test.</li></ul></details>`;
    box.innerHTML = filtri + chips + note.join('') + adesso
      + `<h3 class="sec-h">Il periodo in numeri <span class="sf-hint">tocca un indicatore per vederlo nel grafico</span></h3><div class="stk-grid">${cards}</div>${arrivo}`
      + `<h3 class="sec-h">Andamento giorno per giorno</h3><div class="box sf-graf"><div id="sf-main"></div></div>`
      + `<h3 class="sec-h">Quando e da dove</h3>${dist}<h3 class="sec-h">Dove</h3>${dove}${altri}${legenda}`;
    disegnaTutto(); ripristinaFocus();
  }
  function htmlInterni() {
    if (ST.intErr) return `<div class="sub">${esc(ST.intErr)}</div>`;
    const v = ST.intElenco; if (!v) return '<div class="sub">Carico l\'elenco…</div>';
    if (!v.length) return '<div class="sub">Nessun dispositivo interno: apri l\'app con un account admin o tocca 7 volte la versione in «I tuoi posti».</div>';
    return `<table class="sf-tab"><thead><tr><th>Dispositivo</th><th>Piattaforma</th><th>Ultima attività</th><th>Eventi</th></tr></thead><tbody>${v.map((x) => `<tr><td>${esc(String(x.device_id).slice(0, 14))}</td><td>${esc(PF[x.piattaforma] || x.piattaforma || '?')}</td><td>${esc(dataOra(x.ultima))}</td><td>${fmt(x.eventi)}</td></tr>`).join('')}</tbody></table><div class="sf-nota">Interno = ha mandato almeno una volta un evento da un dispositivo segnato come interno; vale anche per i suoi eventi precedenti.</div>`;
  }
  async function caricaInterni() {
    const { data, error } = await sb.rpc('dispositivi_interni_admin');
    ST.intErr = error ? (msgManca(error) ? 'Manca il passo sul database: supabase/20_dispositivi_interni.sql.' : 'Errore: ' + error.message) : ''; ST.intElenco = error ? null : data || [];
    const el = $('#sf-intbody'); if (el) el.innerHTML = htmlInterni();
  }
  function ripristinaFocus() { const f = ST.focus; ST.focus = ''; if (f) { const el = f.indexOf('p:') === 0 ? document.querySelector('[data-p="' + f.slice(2) + '"]') : document.getElementById(f); if (el) el.focus({ preventScroll: true }); } }
  const barraPct = (n, tot) => `<div class="st-bar"><i style="width:${(n / Math.max(1, tot)) * 100}%"></i></div>`;
  function htmlPiattaforme(k) {
    const pf = k.piattaforme || {}, tot = Object.values(pf).reduce((a, b) => a + b, 0), voci = Object.entries(pf).sort((a, b) => b[1] - a[1]);
    if (!voci.length) return '<div class="sub">Nessun dispositivo nel periodo.</div>';
    return `<div class="sf-wrap sf-righe" id="sf-pf">${voci.map(([c, n]) => { const filtrabile = c !== '?'; const att = SF.pl === c;
      return `<button type="button" class="sf-riga${att ? ' on' : ''}" ${filtrabile ? `data-pf="${c}"` : 'disabled'} data-tip="${esc((PF[c] || c) + ': ' + fmt(n) + ' dispositivi (' + pct(n, tot) + ')' + (filtrabile ? (att ? ' · filtro attivo, tocca per toglierlo' : ' · tocca per filtrare') : ''))}" aria-pressed="${att}"><span class="sf-rl"><span>${esc(PF[c] || c)}</span><b>${fmt(n)} · ${pct(n, tot)}</b></span>${barraPct(n, tot)}</button>`; }).join('')}</div>`;
  }
  function htmlVersioni(k) {
    const v = k.versioni || []; if (!v.length) return '<div class="sub">Ancora nessun dato.</div>'; const tot = v.reduce((a, b) => a + b.n, 0), max = Math.max(...v.map((x) => x.n));
    return `<div class="sf-wrap sf-righe">${v.map((x) => `<div class="sf-riga" tabindex="0" data-tip="${esc('Versione ' + x.v + ': ' + fmt(x.n) + ' dispositivi (' + pct(x.n, tot) + ')')}"><span class="sf-rl"><span>${esc(x.v)}</span><b>${fmt(x.n)}</b></span>${barraPct(x.n, max)}</div>`).join('')}</div>`;
  }
  const listaComuni = (v, vuoto) => v && v.length ? `<ul class="st-list">${v.map((x) => `<li><span>${esc(x.c)}</span><b>${fmt(x.n)}</b></li>`).join('')}</ul>` : `<div class="sub">${vuoto}</div>`;

  // ---- grafici a mano in SVG: tooltip al mouse, al tocco e da tastiera ----
  const passo = (max) => { const g = Math.pow(10, Math.floor(Math.log10(Math.max(1, max) / 4))), m = Math.max(1, max) / 4 / g; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * g; };
  function tip(wrap, html, x, y) { // un solo tooltip per grafico, tenuto dentro il riquadro
    let el = wrap.querySelector('.sf-tip'); if (!el) { el = document.createElement('div'); el.className = 'sf-tip'; el.setAttribute('aria-hidden', 'true'); wrap.appendChild(el); }
    if (html == null) { el.hidden = true; return; }
    el.hidden = false; el.innerHTML = html; const w = el.offsetWidth, W = wrap.clientWidth; let l = x + 14; if (l + w > W - 4) l = x - w - 14; el.style.left = Math.max(4, l) + 'px'; el.style.top = Math.max(0, y - 10) + 'px';
  }
  function interattivo(wrap, svg, n, xDi, htmlDi, scegli, nome) {
    // wrap: contenitore relativo; svg: elemento con un <rect class="hit">; n: punti; xDi(i): x del punto; htmlDi(i): contenuto del tooltip; scegli(i): clic/Invio
    const live = wrap.querySelector('.sr-live'), hit = svg.querySelector('.hit'), cur = svg.querySelector('.cur');
    let i0 = ST.hov >= 0 && nome === 'principale' ? Math.min(ST.hov, n - 1) : -1;
    const mostra = (i, y) => { i0 = i; if (nome === 'principale') ST.hov = i; if (cur) { cur.setAttribute('x1', xDi(i)); cur.setAttribute('x2', xDi(i)); cur.style.display = ''; } svg.dispatchEvent(new CustomEvent('punto', { detail: i })); tip(wrap, htmlDi(i), xDi(i), y == null ? 20 : y); if (live) live.textContent = htmlDi(i).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); };
    const nascondi = () => { i0 = -1; if (nome === 'principale') ST.hov = -1; if (cur) cur.style.display = 'none'; svg.dispatchEvent(new CustomEvent('punto', { detail: -1 })); tip(wrap, null); };
    const idx = (ev) => { const r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * (svg.viewBox.baseVal.width / r.width); let b = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = Math.abs(xDi(i) - x); if (d < bd) { bd = d; b = i; } } return b; };
    hit.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'touch') return; const r = svg.getBoundingClientRect(); mostra(idx(ev), ev.clientY - r.top); });
    hit.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch' && document.activeElement !== wrap.firstElementChild) nascondi(); });
    hit.addEventListener('pointerup', (ev) => { const i = idx(ev), r = svg.getBoundingClientRect(); if (ev.pointerType === 'touch' && i0 !== i) { mostra(i, ev.clientY - r.top); return; } if (scegli) scegli(i); });
    const foc = wrap.querySelector('.sf-foc');
    foc.addEventListener('keydown', (e) => {
      let i = i0 < 0 ? (e.key === 'ArrowLeft' || e.key === 'End' ? n - 1 : 0) : i0;
      if (e.key === 'ArrowRight') i = Math.min(n - 1, i0 < 0 ? 0 : i + 1); else if (e.key === 'ArrowLeft') i = Math.max(0, i0 < 0 ? n - 1 : i - 1); else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = n - 1;
      else if ((e.key === 'Enter' || e.key === ' ') && i0 >= 0) { e.preventDefault(); if (scegli) scegli(i0); return; } else if (e.key === 'Escape') { nascondi(); return; } else return;
      e.preventDefault(); mostra(i);
    });
    foc.addEventListener('focus', () => { if (i0 >= 0) mostra(i0); }); foc.addEventListener('blur', () => nascondi());
    if (i0 >= 0) mostra(i0);
  }
  function tabellaDati(titolo, colonne, righe) {
    return `<details class="sf-dati"><summary>Mostra i dati</summary><div class="sf-tw"><table><caption class="sr">${esc(titolo)}</caption><thead><tr>${colonne.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${righe.map((r) => `<tr>${r.map((c, j) => (j ? `<td>${c}</td>` : `<th scope="row">${c}</th>`)).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  }
  function disegnaTutto() { ST.L = ($('#stat') || {}).clientWidth; if (ST.D) { disegnaPrincipale(); disegnaOre(); agganciaRighe(); } }
  function disegnaPrincipale() {
    const el = $('#sf-main'); if (!el || !ST.D) return; const D = ST.D, S = D.graf.serie || [], n = S.length, att = SF.serie.filter((s) => SERIE[s]);
    const W = Math.max(280, el.clientWidth || 600), H = W < 520 ? 230 : 290, L = 40, R = 12, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const val = (d, s) => (d[s] == null ? null : Number(d[s])), max = Math.max(1, ...S.flatMap((d) => att.map((s) => val(d, s) || 0))), st = passo(max), top = Math.ceil(max / st) * st;
    const X = (i) => L + (n < 2 ? pw / 2 : (i * pw) / (n - 1)), Y = (v) => T + ph - (v / top) * ph;
    let g = '';
    for (let v = 0; v <= top; v += st) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e8f0"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#4a5668">${fmt(v)}</text>`;
    const ne = Math.min(n, W < 520 ? 4 : 7); for (let j = 0; j < ne; j++) { const i = ne === 1 ? 0 : Math.round(j * (n - 1) / (ne - 1)); g += `<text x="${X(i)}" y="${H - 7}" text-anchor="${j === 0 && n > 1 ? 'start' : j === ne - 1 && n > 1 ? 'end' : 'middle'}" font-size="11" fill="#4a5668">${dm(S[i].g)}</text>`; }
    const evid = SF.g || (unGiorno(D) ? D.kr[0] : ''), ie = S.findIndex((d) => d.g === evid);
    if (ie >= 0) { const bw = n < 2 ? 40 : Math.max(8, pw / (n - 1)); g += `<rect x="${X(ie) - bw / 2}" y="${T}" width="${bw}" height="${ph}" fill="#ffcc00" opacity=".28"/>`; }
    att.forEach((s) => { let d = '', aperto = false; S.forEach((r, i) => { const v = val(r, s); if (v == null) { aperto = false; return; } d += (aperto ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); aperto = true; });
      g += `<path d="${d}" fill="none" stroke="${SERIE[s].c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${SERIE[s].d && att.length > 1 ? ` stroke-dasharray="${SERIE[s].d}"` : ''}/>`;
      if (n <= 31) S.forEach((r, i) => { const v = val(r, s); if (v != null) g += `<circle cx="${X(i)}" cy="${Y(v)}" r="3" fill="${SERIE[s].c}" stroke="#fff" stroke-width="1.5"/>`; }); });
    const sv = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" class="st-chart sf-svg">${g}<line class="cur" y1="${T}" y2="${T + ph}" stroke="#131a24" stroke-width="1" style="display:none"/><g class="pts"></g><rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" style="cursor:pointer"/></svg>`;
    const legenda = `<div class="st-leg sf-legb" role="group" aria-label="Serie del grafico (accendi o spegni)">${Object.keys(SERIE).map((s) => `<button type="button" class="sf-lg${att.indexOf(s) >= 0 ? ' on' : ''}" data-ser="${s}" aria-pressed="${att.indexOf(s) >= 0}"><svg width="26" height="10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke="${SERIE[s].c}" stroke-width="2.5"${SERIE[s].d ? ` stroke-dasharray="${SERIE[s].d}"` : ''}/></svg>${SERIE[s].n}</button>`).join('')}</div>`;
    const righe = S.map((d) => [dm(d.g) + (d.r ? ' (riassunto)' : ''), ...att.map((s) => (d[s] == null ? 'n.d.' : fmt(d[s])))]);
    el.innerHTML = `${legenda}<div class="sf-wrap" id="sf-mainw"><div class="sf-foc" id="sf-focmain" tabindex="0" role="group" aria-roledescription="grafico interattivo" aria-label="Andamento giorno per giorno, ${n} giorni. Frecce sinistra e destra per scorrere i giorni, Invio per filtrare la pagina su quel giorno, Esc per chiudere.">${sv}</div><div class="sr sr-live" aria-live="polite"></div></div>`
      + `<div class="sf-nota">Un giorno si può toccare o scegliere con Invio: tutta la pagina si riferisce a quel giorno${SF.g ? '. Tocca di nuovo il giorno selezionato per tornare al periodo' : ''}.</div>`
      + tabellaDati('Dati giornalieri del grafico', ['Giorno', ...att.map((s) => SERIE[s].n)], righe);
    const wrap = el.querySelector('#sf-mainw');
    const svgEl = wrap.querySelector('svg'), pts = svgEl.querySelector('.pts');
    svgEl.addEventListener('punto', (e) => { const i = e.detail; pts.innerHTML = i < 0 ? '' : att.map((s) => { const v = val(S[i], s); return v == null ? '' : `<circle cx="${X(i)}" cy="${Y(v)}" r="4.5" fill="${SERIE[s].c}" stroke="#fff" stroke-width="2"/>`; }).join(''); });
    const htmlDi = (i) => { const d = S[i]; return `<b>${giornoLungo(d.g)}</b>${d.r ? '<div class="sf-t2">solo riassunto: attivi e nuovi non disponibili</div>' : ''}` + att.map((s) => `<div><i style="background:${SERIE[s].c}"></i>${SERIE[s].n}: <b>${d[s] == null ? 'n.d.' : fmt(d[s])}</b></div>`).join(''); };
    interattivo(wrap, svgEl, n, X, htmlDi, (i) => cambiaFiltri(() => { SF.g = SF.g === S[i].g ? '' : S[i].g; }, 'sf-focmain'), 'principale');
  }
  function disegnaOre() {
    const el = $('#sf-ore'); if (!el || !ST.D) return; const ore = ST.D.kpi.ore || [], n = ore.length; if (!n) { el.innerHTML = '<div class="sub">Nessun dato.</div>'; return; }
    const W = Math.max(260, el.clientWidth || 400), H = 190, L = 30, R = 4, T = 10, B = 22, pw = W - L - R, ph = H - T - B, max = Math.max(1, ...ore), st = passo(max), top = Math.ceil(max / st) * st, bw = pw / n;
    const X = (i) => L + bw * i + bw / 2, Y = (v) => T + ph - (v / top) * ph; let g = '';
    for (let v = 0; v <= top; v += st) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e8f0"/><text x="${L - 5}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="#4a5668">${fmt(v)}</text>`;
    g += ore.map((v, i) => `<rect class="bar" data-i="${i}" x="${L + bw * i + 1}" y="${Y(v)}" width="${Math.max(1, bw - 2)}" height="${T + ph - Y(v)}" rx="2" fill="#2a78d6"/>`).join('') + [0, 6, 12, 18, 23].map((h) => `<text x="${X(h)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#4a5668">${h}</text>`).join('');
    el.innerHTML = `<div class="sf-foc" tabindex="0" role="group" aria-roledescription="grafico interattivo" aria-label="Dispositivi per ora del giorno. Frecce sinistra e destra per scorrere le ore.">${`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" class="st-chart sf-svg">${g}<line class="cur" y1="${T}" y2="${T + ph}" stroke="#131a24" style="display:none"/><rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/></svg>`}</div><div class="sr sr-live" aria-live="polite"></div>`
      + tabellaDati('Dispositivi per ora del giorno', ['Ora', 'Dispositivi'], ore.map((v, i) => [i + ':00', fmt(v)]));
    const svgEl = el.querySelector('svg'); svgEl.addEventListener('punto', (e) => { $$('.bar', svgEl).forEach((b) => b.setAttribute('fill', +b.dataset.i === e.detail ? '#0b2a5b' : '#2a78d6')); });
    interattivo(el, svgEl, n, X, (i) => `<b>${i}:00–${i}:59</b><div>${fmt(ore[i])} dispositivi</div>`, null, 'ore');
  }
  function agganciaRighe() { // tooltip sulle barre orizzontali (piattaforme, versioni); le piattaforme filtrano con un clic
    $$('.sf-righe').forEach((w) => {
      const mostra = (r) => { const b = r.getBoundingClientRect(), a = w.getBoundingClientRect(); tip(w, esc(r.dataset.tip || ''), Math.min(b.width - 40, 160), b.top - a.top + b.height / 2); };
      $$('.sf-riga', w).forEach((r) => { r.addEventListener('pointerenter', () => mostra(r)); r.addEventListener('pointerleave', () => tip(w, null)); r.addEventListener('focus', () => mostra(r)); r.addEventListener('blur', () => tip(w, null)); });
    });
  }
  // ---- eventi della scheda (delegati: il contenuto si ridisegna) ----
  (function () {
    const box = $('#stat'); if (!box) return;
    box.addEventListener('click', (e) => {
      const t = e.target, b = t.closest && t.closest('button'); if (!b) return;
      if (b.dataset.p) cambiaFiltri(() => { if (b.dataset.p === 'pers' && SF.p !== 'pers') { const [d, a] = [addG(oggiRoma(), -29), oggiRoma()]; SF.dal = SF.dal || d; SF.al = SF.al || a; } SF.p = b.dataset.p; SF.g = ''; }, 'p:' + b.dataset.p);
      else if (b.id === 'sf-azzera') azzeraFiltri();
      else if (b.id === 'sf-g') cambiaFiltri(() => { SF.g = ''; }, '');
      else if (b.dataset.s) { const s = b.dataset.s; SF.serie = SF.serie.length === 1 && SF.serie[0] === s ? SERIE_BASE.slice() : [s]; disegnaPrincipale(); $$('.stk', box).forEach((k) => { const on = SF.serie.indexOf(k.dataset.s) >= 0; k.classList.toggle('on', on); k.setAttribute('aria-pressed', String(on)); }); const kb = box.querySelector(`.stk[data-s="${s}"]`); if (kb) kb.focus({ preventScroll: true }); }
      else if (b.dataset.ser) { const s = b.dataset.ser, i = SF.serie.indexOf(s); if (i >= 0 && SF.serie.length > 1) SF.serie.splice(i, 1); else if (i < 0) SF.serie.push(s); disegnaPrincipale(); $$('.stk', box).forEach((k) => { const on = SF.serie.indexOf(k.dataset.s) >= 0; k.classList.toggle('on', on); k.setAttribute('aria-pressed', String(on)); }); const lb = box.querySelector(`.sf-lg[data-ser="${s}"]`); if (lb) lb.focus({ preventScroll: true }); }
      else if (b.dataset.pf) cambiaFiltri(() => { SF.pl = SF.pl === b.dataset.pf ? '' : b.dataset.pf; }, '');
    });
    box.addEventListener('toggle', (e) => { if (e.target.id === 'sf-intl') { ST.intAperto = e.target.open; if (ST.intAperto) caricaInterni(); } }, true);
    box.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'sf-pl') cambiaFiltri(() => { SF.pl = t.value; }, 'sf-pl');
      else if (t.id === 'sf-reali') cambiaFiltri(() => { SF.reali = t.checked; }, 'sf-reali');
      else if (t.id === 'sf-int') cambiaFiltri(() => { SF.interni = t.checked; }, 'sf-int');
      else if (t.id === 'sf-soglia') cambiaFiltri(() => { SF.soglia = t.value; }, 'sf-soglia');
      else if (t.id === 'sf-dal') cambiaFiltri(() => { SF.dal = t.value; SF.g = ''; }, 'sf-dal');
      else if (t.id === 'sf-al') cambiaFiltri(() => { SF.al = t.value; SF.g = ''; }, 'sf-al');
    });
    let rt = null; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const l = box.clientWidth; if (current === 'dashboard' && ST.D && l && l !== ST.L) disegnaTutto(); }, 150); }); // solo se cambia la larghezza (la barra del browser sul telefono non deve cancellare un tooltip)
  })();
  // ---------- vista fissa di riserva (rpc statistiche_admin): serve finché la 19 non è stata eseguita ----------
  function grafico(serie, chiavi, colori) { // barre affiancate per giorno, senza librerie
    const W = 600, Hh = 150, pad = 18, n = serie.length, max = Math.max(1, ...serie.flatMap((d) => chiavi.map((k) => d[k] || 0)));
    const bw = (W - pad) / n, sub = (bw - 2) / chiavi.length;
    let out = `<svg class="st-chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Andamento ultimi 30 giorni">`;
    out += `<text x="0" y="10" font-size="10" fill="currentColor" opacity=".55">${fmt(max)}</text>`;
    serie.forEach((d, i) => chiavi.forEach((k, j) => { const h = ((d[k] || 0) / max) * (Hh - pad - 4); out += `<rect x="${pad + i * bw + j * sub}" y="${Hh - 14 - h}" width="${Math.max(1, sub - 1)}" height="${h}" fill="${colori[j]}"><title>${d.g}: ${k} ${d[k] || 0}</title></rect>`; }));
    [0, Math.floor(n / 2), n - 1].forEach((i) => { const d = serie[i]; if (d) out += `<text x="${pad + i * bw}" y="${Hh - 2}" font-size="10" fill="currentColor" opacity=".55">${d.g.slice(8, 10)}/${d.g.slice(5, 7)}</text>`; });
    return out + '</svg>';
  }
  function htmlVecchia(d) {
    const card = (l, v, x, cls) => `<div class="stc ${cls || ''}"><div class="l">${l}</div><b>${v}</b>${x ? `<div class="x">${x}</div>` : ''}</div>`;
    const sez = (t, h) => `<h3 class="sec-h">${t}</h3>${h}`;
    const pf = d.piattaforme_30g || {}, totPf = Object.values(pf).reduce((a, b) => a + b, 0), PF = { android: 'Android', ios: 'iPhone', web: 'Web da telefono', pc: 'Web da computer', '?': 'Sconosciuta' };
    const lista = (v, vuoto) => v && v.length ? `<ul class="st-list">${v.map((x) => `<li><span>${esc(x.c || x.v)}</span><b>${fmt(x.n)}</b></li>`).join('')}</ul>` : `<div class="sub">${vuoto}</div>`;
    const ore = d.ore_7g || [], maxO = Math.max(1, ...ore);
    return sez('Utenti', `<div class="st-grid">
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
  // ---------- consumi e limiti gratuiti (rpc consumi_admin, supabase/18_consumi.sql) ----------
  // Traffico in uscita di Supabase per ogni apertura dell'app (KB). Non si può leggere dal database: è una STIMA, da riverificare ogni tanto.
  // Misurato il 20/11/2026: ~250 KB per sessione quando il file di copertura dei comuni stava su Supabase; ~60 KB dopo averlo spostato su Cloudflare.
  const KB_PER_SESSIONE = 60;
  const RIQUADRI_ESRI_PER_APERTURA = 20; // stima del piano: riquadri satellitari scaricati ogni volta che si accende la vista satellitare
  const LINK_SB = 'https://supabase.com/dashboard/org/ucmsslhnlapdjcdmsoms/usage';
  const GB = 1024 ** 3, MB = 1024 ** 2;
  const fmtByte = (b) => b >= GB ? (b / GB).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' GB' : (b / MB).toLocaleString('it-IT', { maximumFractionDigits: b >= 100 * MB ? 0 : 1 }) + ' MB';
  const fmtDataIt = (iso) => new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  const statoDa = (p) => p > 85 ? { k: 'crit', t: 'Critico', i: '✖' } : p >= 60 ? { k: 'att', t: 'Attenzione', i: '⚠' } : { k: 'ok', t: 'Ok', i: '✓' };
  const ORDINE = { nd: 0, ok: 1, att: 2, crit: 3 };
  function proiezione(usato, trascorsi, totali) { const g = Math.max(Number(trascorsi) || 0, 1); return usato / g * totali; }
  // costruisce l'elenco dei servizi da mostrare; "d" è la risposta di consumi_admin() oppure null (funzione mancante: restano solo le informazioni fisse)
  function servizi(d) {
    const ok = !!d, n = (k) => (ok && d[k] != null ? Number(d[k]) : null);
    const pFine = ok && d.periodo_fine ? fmtDataIt(d.periodo_fine) : 'il 24 del mese dopo';
    const meseFine = (() => { const o = new Date(); return new Date(o.getFullYear(), o.getMonth() + 1, 1).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }); })();
    const sess = n('sessioni_periodo'), schede = n('schede_android_mese'), cat = n('categorie_android_mese'), sat = n('satellite_mese');
    const L = [];
    L.push({ id: 'sb-traffico', nome: 'Supabase · traffico in uscita', tipo: 'stimato', limite: 5 * GB, usato: sess == null ? null : sess * KB_PER_SESSIONE * 1024, fmt: fmtByte,
      periodo: `Si azzera il ${pFine} (periodo dal 24 al 24).`, giorni: [n('giorni_periodo_trascorsi'), n('giorni_periodo_totali')], link: LINK_SB, linkT: 'Pannello Supabase (dato preciso)',
      nota: ok ? `Stima: <b>${fmt(sess)} sessioni</b> nel periodo × ${KB_PER_SESSIONE} KB per sessione${n('sessioni_ieri') != null ? ` (ieri ${fmt(n('sessioni_ieri'))} sessioni)` : ''}. Il traffico vero non si legge dal database; chi ha spento le statistiche non è contato, quindi il dato reale può essere più alto.` : `Stima: sessioni del periodo × ${KB_PER_SESSIONE} KB per sessione.` });
    L.push({ id: 'sb-db', nome: 'Supabase · spazio del database', tipo: 'misurato', limite: 500 * MB, usato: n('db_bytes'), fmt: fmtByte,
      periodo: 'Non si azzera: è lo spazio occupato (scende solo cancellando dati; la pulizia notturna degli eventi aiuta).', link: LINK_SB, linkT: 'Pannello Supabase (dato preciso)',
      nota: `Misurato con <code>pg_database_size</code>${ok && d.eventi_righe != null ? ` · righe nella tabella eventi: ${fmt(d.eventi_righe)}` : ''}.` });
    L.push({ id: 'sb-storage', nome: 'Supabase · spazio file (storage)', tipo: 'misurato', limite: 1 * GB, usato: n('storage_bytes'), fmt: fmtByte,
      periodo: 'Non si azzera: è lo spazio occupato dai file.', link: LINK_SB, linkT: 'Pannello Supabase (dato preciso)', nota: 'Misurato: somma delle dimensioni dei file in <code>storage.objects</code>.' });
    L.push({ id: 'sb-mau', nome: 'Supabase · utenti attivi al mese (account)', tipo: 'misurato', limite: 50000, usato: n('mau_30g'), fmt: fmt, unita: 'account',
      periodo: 'Mobile: finestra mobile degli ultimi 30 giorni, non si azzera di colpo.', link: LINK_SB, linkT: 'Pannello Supabase (dato preciso)', nota: 'Misurato: account con un accesso negli ultimi 30 giorni. Chi usa l\'app senza account non conta.' });
    const am = n('account_mese'), ao = n('account_oggi');
    L.push({ id: 'resend', nome: 'Email di iscrizione (Resend)', tipo: 'stimato', unita: 'email', fmt: fmt,
      barre: [{ l: 'Oggi', usato: ao, limite: 100 }, { l: 'Questo mese', usato: am, limite: 3000 }],
      proj: am == null ? null : { usato: am, trascorsi: n('giorni_mese_trascorsi'), totali: n('giorni_mese_totali'), limite: 3000 },
      periodo: `Il limite giornaliero riparte a mezzanotte (UTC); quello mensile il ${meseFine} (qui si usa il mese di calendario).`, link: 'https://resend.com/emails', linkT: 'Pannello Resend (dato preciso)',
      nota: 'Stima: account creati oggi e nel mese (una email di conferma per account). Non conta le email di recupero password o i reinvii.' });
    L.push({ id: 'tt-routing', nome: 'TomTom Routing · tempi con traffico (solo app Android)', tipo: 'stimato', limite: 20000, usato: schede, fmt: fmt, unita: 'richieste',
      proj: schede == null ? null : { usato: schede, trascorsi: n('giorni_mese_trascorsi'), totali: n('giorni_mese_totali'), limite: 20000 },
      periodo: `Si azzera il ${meseFine} (mese di calendario).`, link: 'https://developer.tomtom.com/user/me/analytics', linkT: 'Pannello TomTom, Analytics (dato preciso, con un giorno di ritardo)',
      nota: 'Stima: aperture di un posto (evento «scheda») da Android nel mese; ogni apertura fa al massimo 1 richiesta (spesso meno: ci sono le risposte tenute in memoria).' });
    L.push({ id: 'tt-search', nome: 'TomTom Search · categorie di luoghi (solo riserva, app Android)', tipo: cat == null ? 'non misurato' : 'stimato', limite: 2500, usato: cat, fmt: fmt, unita: 'richieste',
      proj: cat == null ? null : { usato: cat, trascorsi: n('giorni_mese_trascorsi'), totali: n('giorni_mese_totali'), limite: 2500 },
      periodo: `Si azzera il ${meseFine} (mese di calendario).`, link: 'https://developer.tomtom.com/user/me/analytics', linkT: 'Pannello TomTom, Analytics (dato preciso, con un giorno di ritardo)',
      nota: cat == null ? 'Non misurato: nessun evento per l\'apertura delle categorie. Il numero preciso si vede solo sul pannello TomTom.' : 'Stima: eventi «categoria» da Android nel mese. Le categorie ora usano il nostro elenco OpenStreetMap: TomTom si chiama solo se l\'elenco della zona non si scarica, quindi questo numero dovrebbe restare vicino a zero.' });
    L.push({ id: 'esri', nome: 'Esri · vista satellitare', tipo: sat == null ? 'non misurato' : 'stimato', limite: 2000000, usato: sat == null ? null : sat * RIQUADRI_ESRI_PER_APERTURA, fmt: fmt, unita: 'riquadri',
      proj: sat == null ? null : { usato: sat * RIQUADRI_ESRI_PER_APERTURA, trascorsi: n('giorni_mese_trascorsi'), totali: n('giorni_mese_totali'), limite: 2000000 },
      periodo: `Si azzera il ${meseFine} (mese di calendario).`, link: 'https://location.arcgis.com/', linkT: 'Pannello Esri (dato preciso)',
      nota: sat == null ? `Non misurato: l'app non registra la vista satellitare. Stima del piano: ~${RIQUADRI_ESRI_PER_APERTURA} riquadri per apertura; il dato vero è sul pannello Esri.` : `Stima: <b>${fmt(sat)} accensioni</b> della vista satellitare nel mese × ~${RIQUADRI_ESRI_PER_APERTURA} riquadri (stima del piano). Conta solo dalle versioni dell'app che inviano l'evento.` });
    return L;
  }
  function percDi(s) { // [{l, usato, limite, p}] per ogni barra del servizio
    const barre = s.barre || [{ l: '', usato: s.usato, limite: s.limite }];
    return barre.map((b) => Object.assign({}, b, { p: b.usato == null ? null : b.usato / b.limite * 100 }));
  }
  function cardServizio(s) {
    const barre = percDi(s), noti = barre.filter((b) => b.p != null);
    const peggio = noti.length ? statoDa(Math.max(...noti.map((b) => b.p))) : { k: 'nd', t: 'Dato non disponibile', i: '–' };
    const f = s.fmt;
    const corpo = barre.map((b) => {
      if (b.p == null) return `<div class="cs-num"><span>${b.l ? esc(b.l) + ': ' : ''}limite ${f(b.limite)}${s.unita && f === fmt ? ' ' + s.unita : ''}</span></div>`;
      const st = statoDa(b.p), pc = Math.round(b.p * 10) / 10, w = Math.min(100, Math.max(b.p > 0 ? 1 : 0, b.p));
      const nome = `${f(b.usato)} su ${f(b.limite)}${s.unita && f === fmt ? ' ' + s.unita : ''}`;
      return `${b.l ? `<div class="cs-lbl"><span>${esc(b.l)}</span><span>${st.i} ${st.t}</span></div>` : ''}<div class="cs-num"><b>${pc.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%</b><span>${nome}</span></div>
        <div class="cs-bar" role="progressbar" aria-label="${esc(s.nome + (b.l ? ' · ' + b.l : ''))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(100, b.p))}" aria-valuetext="${pc.toLocaleString('it-IT')}% del limite, ${st.t}"><i class="${st.k}" style="width:${w}%"></i></div>`;
    }).join('');
    const tipoT = s.tipo === 'misurato' ? 'misurato' : s.tipo === 'stimato' ? 'stimato' : 'non misurato';
    return `<article class="cs st-${peggio.k}" aria-label="${esc(s.nome)}"><div class="cs-top"><h4>${esc(s.nome)}</h4><span class="cs-tag" title="${s.tipo === 'misurato' ? 'Letto direttamente dal database' : 'Ricavato dagli eventi dell\'app, non è il dato del fornitore'}">${tipoT}</span></div>
      ${corpo}<div><span class="cs-st ${peggio.k}"><span aria-hidden="true">${peggio.i}</span>${peggio.t}</span></div>
      <p class="cs-nota">${s.nota}</p><p class="cs-nota"><b>Quando si azzera:</b> ${s.periodo}</p>
      <div class="cs-foot"><span>Limite gratuito: ${s.barre ? s.barre.map((b) => f(b.limite) + (b.l === 'Oggi' ? ' al giorno' : ' al mese')).join(' · ') : f(s.limite)}${s.unita && f === fmt && !s.barre ? ' ' + s.unita : ''}</span><a href="${s.link}" target="_blank" rel="noopener">${esc(s.linkT)} ↗</a></div></article>`;
  }
  // il servizio che si esaurisce per primo al ritmo attuale
  function proiezioneBox(d, L) {
    const cand = [];
    L.forEach((s) => {
      if (s.id === 'sb-traffico' && s.usato != null) cand.push({ nome: s.nome, usato: s.usato, trascorsi: s.giorni[0], totali: s.giorni[1], limite: s.limite, fmt: s.fmt, fine: d.periodo_fine, ini: d.periodo_inizio });
      else if (s.proj) cand.push(Object.assign({ nome: s.nome, fmt: s.fmt, fine: null, ini: null }, s.proj));
    });
    cand.forEach((c) => { c.media = c.usato / Math.max(Number(c.trascorsi) || 0, 1); c.finale = c.media * c.totali; c.rapporto = c.finale / c.limite; });
    cand.sort((a, b) => b.rapporto - a.rapporto);
    const g = cand[0], tel = d.telefoni_30g;
    let esito = '';
    if (!g) esito = 'Non ci sono ancora dati per stimare quale servizio si esaurisce per primo.';
    else {
      const gg = g.limite / (g.media || 1), oggiG = Number(g.trascorsi) || 0;
      const quando = (g.ini ? new Date(g.ini + 'T12:00:00') : new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12)); quando.setDate(quando.getDate() + Math.floor(gg));
      const nomeB = `<b>${esc(g.nome)}</b>`;
      if (g.rapporto >= 1) esito = `Al ritmo attuale si esaurisce per primo ${nomeB}: proiezione a fine periodo ${g.fmt(g.finale)} su ${g.fmt(g.limite)} (${Math.round(g.rapporto * 100)}%). Il limite verrebbe superato intorno al <b>${quando.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}</b>${gg < oggiG ? ' (già superato secondo la stima)' : ''}.`;
      else esito = `Al ritmo attuale nessun servizio supera il limite entro la fine del periodo. Il più vicino è ${nomeB}: proiezione ${g.fmt(g.finale)} su ${g.fmt(g.limite)} (${Math.round(g.rapporto * 100)}%).`;
    }
    const fissi = L.filter((s) => !s.proj && s.id !== 'sb-traffico' && s.usato != null && s.usato / s.limite >= 0.6).map((s) => `${esc(s.nome)} (${Math.round(s.usato / s.limite * 100)}%)`);
    return `<section class="box cs-proj" aria-labelledby="cs-proj-h"><h3 id="cs-proj-h">Proiezione</h3>
      <p><b>${tel == null ? '–' : fmt(tel)}</b> telefoni distinti attivi negli ultimi 30 giorni.</p><p>${esito}</p>
      ${fissi.length ? `<p>Da tenere d'occhio (spazio occupato, senza proiezione): ${fissi.join(', ')}.</p>` : ''}
      <p class="cs-nota">Proiezione = consumo medio giornaliero finora × giorni del periodo. Serve a capire l'ordine di grandezza: con pochi giorni di dati è molto instabile.</p></section>`;
  }
  async function caricaConsumi() {
    const box = $('#consumi'); if (!box.innerHTML.trim()) box.innerHTML = '<div class="sub">Carico i consumi…</div>';
    const { data: d, error } = await sb.rpc('consumi_admin');
    const info = `<div class="cs-info"><b>Cloudflare e OpenFreeMap:</b> senza limiti pratici sul piano gratuito, non servono controlli.</div>`;
    const badge = $('#dt-consumi-b');
    if (error) {
      const manca = /function|does not exist|schema cache|could not find/i.test(error.message);
      const L = servizi(null);
      box.innerHTML = `<div class="cs-warn" role="alert">${manca ? 'Esegui <b>supabase/18_consumi.sql</b> nell\'editor SQL di Supabase per vedere i consumi.' : 'Errore: ' + esc(error.message)} Qui sotto restano i limiti e i link ai pannelli dei fornitori.</div>
        <div class="cs-grid">${L.map(cardServizio).join('')}</div>${info}`;
      badge.hidden = true; return;
    }
    const L = servizi(d), stati = L.flatMap((s) => percDi(s)).filter((b) => b.p != null).map((b) => statoDa(b.p).k);
    const peggio = stati.sort((a, b) => ORDINE[b] - ORDINE[a])[0];
    badge.hidden = !(peggio === 'att' || peggio === 'crit'); badge.className = 'dtab-b' + (peggio === 'crit' ? ' crit' : ''); badge.textContent = peggio === 'crit' ? 'Critico' : 'Attenzione';
    box.innerHTML = `<p class="cs-nota" style="margin:0 0 12px">Aggiornato alle ${new Date(d.agg).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}. Soglie: Ok sotto il 60%, Attenzione dal 60% all'85%, Critico oltre l'85% del limite gratuito. «Misurato» = letto dal database; «stimato» = ricavato dagli eventi dell'app (il dato preciso è sul pannello del fornitore).</p>
      <div class="cs-grid">${L.map(cardServizio).join('')}</div>${proiezioneBox(d, L)}${info}`;
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
    problemi: 'Problemi segnalati dagli utenti sulla scheda di un posto già in mappa. Guarda mappa e satellite: "Sposta qui" mette il posto nel punto proposto, "Rimuovi il posto" lo toglie dalla strada, "Correggi dati" apre la modifica; poi il problema esce dall\'elenco. Servono le tabelle di supabase/23_problemi_posti.sql.',
    cand: 'La scansione dell\'ortofoto propone i possibili stalli: sopra l\'85% li conferma da sola, sotto il 30% li scarta da sola. Qui controlli quelli in mezzo e, se vuoi, verifichi quelli confermati in automatico.'
  };
  let qTab = 'utenti', cf = 'nuovo', qPag = 0, qItems = [], qTot = 0, qSel = null, qReq = 0, qRip = false, qFlash = '', qBusy = false, cmap = null, cmarker = null, cBase = null, cBaseUser = false;
  const kind = () => (qTab === 'cand' && cf !== 'auto') ? 'cand' : 'stallo';
  const score = (c) => { const m = /punteggio (\d+)%/.exec(c.classe || ''); return m ? +m[1] : -1; }; // confidenza della rete, dal testo "punteggio N%"
  const inFvg = (lat, lon) => lat > 45.58 && lat < 46.65 && lon > 12.3 && lon < 13.95;
  const ignora = (id) => { const l = ignorati(); if (!l.includes(id)) { l.push(id); lsSet('adm.ignNonEsiste', l.slice(-400)); } };

  PAGES.controllare = {
    load(force) {
      const t = parseHash().params.get('t'); if (!force && ['utenti', 'proposti', 'precisare', 'nonce', 'problemi', 'cand'].includes(t)) qTab = t;
      renderQTabs(); qCarica(force ? qPag : 0);
    },
    show(p) {
      const t = p.get('t');
      if (t && ['utenti', 'proposti', 'precisare', 'nonce', 'problemi', 'cand'].includes(t)) { if (t !== qTab) { qTab = t; renderQTabs(); qCarica(0); } history.replaceState(null, '', '#/controllare'); }
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

  const PROB = { non_esiste: 'Non c\'è più', spostato: 'È in un altro punto', targa: 'Riservato a una sola targa', dati_errati: 'Indirizzo o posti sbagliati', altro: 'Altro' };
  const STALLO_PROB = 'id,lat,lon,nome,indirizzo,comune,posti,tipo,stato,fonte,note';
  function qQuery() {
    if (qTab === 'problemi') return sb.from('problemi_posti').select('*, stalli(' + STALLO_PROB + ')', { count: 'exact' }).eq('stato', 'aperto').order('creato', { ascending: false }).order('id');
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
    if (error) { $('#q-list').innerHTML = `<div class="empty">Errore: ${esc(error.message)}${qTab === 'problemi' ? ' — hai eseguito supabase/23_problemi_posti.sql?' : kind() === 'cand' ? ' — hai eseguito supabase/03_candidati.sql?' : ' (sei registrato come admin? controlla la tabella admins)'}</div>`; qVuota(); return; }
    qTot = count ?? data.length; if (!data.length && qTot > 0 && qPag > 0) { qCarica(Math.ceil(qTot / PAGINA) - 1); return; }
    qItems = data; if (kind() === 'cand' && cf === 'nuovo') qItems.sort((a, b) => score(b) - score(a)); // i più sicuri per primi (dentro la pagina)
    renderQList(); if (qItems.length) qSelect(qItems[0].id); else qVuota();
  }
  function qTitolo(x) { return kind() === 'cand' ? (CLASSE_LABEL[x.classe] || x.classe) : `${x.nome || x.indirizzo || TIPO[x.tipo]} · ${x.posti} ${x.posti > 1 ? 'posti' : 'posto'}`; }
  const stalloProb = (x) => x.stalli || { id: x.stallo_id, lat: 0, lon: 0, posti: 1, tipo: 'sconosciuto', stato: 'rifiutato' };
  const rigaProb = (x) => { const s = stalloProb(x); return `<button class="row-item${qSel && qSel.id === x.id ? ' sel' : ''}" data-id="${x.id}"><span><span class="n">${esc(PROB[x.tipo] || x.tipo)} · ${esc(s.nome || s.indirizzo || TIPO[s.tipo] || 'Posto')}</span><br><span class="s">${esc(s.comune || '—')} · ${new Date(x.creato).toLocaleDateString('it-IT')}${x.lat != null ? ' · 📍 posizione proposta' : ''}${x.note ? ' · 💬' : ''}${x.user_id ? ' · con account' : ''}</span></span><span class="s">${esc(x.stato)}</span></button>`; };
  function renderQList() {
    const tot = Math.max(1, Math.ceil(qTot / PAGINA));
    $('#q-list').innerHTML = qItems.length ? qItems.map((x) => qTab === 'problemi' ? rigaProb(x) : kind() === 'cand'
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
    const it = qItems.find((x) => x.id === id); if (!it) return; if (pmarker) { cmap.removeLayer(pmarker); pmarker = null; } if (qTab === 'problemi') { qSelectProb(it); return; } qSel = it; qRip = false; const cand = kind() === 'cand';
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
  // Problemi segnalati: dettaglio con la posizione attuale (pin pieno) e quella proposta (pin giallo con «?»)
  let pmarker = null;
  function qSelectProb(it) {
    qSel = it; qRip = false; const s = stalloProb(it), prop = it.lat != null && it.lon != null;
    $$('#q-list .row-item').forEach((b) => { const on = b.dataset.id === it.id; b.classList.toggle('sel', on); if (on) b.scrollIntoView({ block: 'nearest' }); });
    $('#q-mapbox').hidden = false; ensureCmap(); setTimeout(() => cmap.invalidateSize(), 0);
    if (cmarker) cmap.removeLayer(cmarker);
    cmarker = L.marker([s.lat, s.lon], { zIndexOffset: 2000, icon: icon(s, true) }).addTo(cmap); cmarker.dragging && cmarker.dragging.disable();
    if (prop) { pmarker = L.marker([it.lat, it.lon], { zIndexOffset: 3000, icon: L.divIcon({ className: '', html: '<div class="pin proposto sel" style="background:#ffcc00;color:#2b2300"><b>?</b></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(cmap); cmap.fitBounds([[s.lat, s.lon], [it.lat, it.lon]], { maxZoom: 20, padding: [50, 50] }); }
    else cmap.setView([s.lat, s.lon], 20);
    if (!cBaseUser) cBase.set(inFvg(s.lat, s.lon) ? 'fvg' : 'esri'); else if (cBase.get() === 'fvg' && !inFvg(s.lat, s.lon)) cBase.set('esri');
    const d = prop ? Math.round(L.latLng(s.lat, s.lon).distanceTo([it.lat, it.lon])) : null;
    $('#q-info').innerHTML = `<div class="badges"><span class="badge proposto" style="background:#7c3aed">${esc(PROB[it.tipo] || it.tipo)}</span><span class="badge ${s.stato}">${esc(s.stato)}</span><span class="badge osm">${esc(s.fonte || '')}</span></div>
      ${prop ? `<div class="warn">Posizione proposta a ${fmt(d)} m dal punto in mappa (pin giallo con «?»; il pin blu è dove sta ora).</div>` : ''}
      <dl class="dl"><dt>Posto</dt><dd>${esc(s.nome || s.indirizzo || '–')}</dd><dt>Comune</dt><dd>${esc(s.comune || '–')}</dd><dt>Posti</dt><dd>${s.posti}</dd><dt>Note del posto</dt><dd>${esc(s.note || '–')}</dd>
      <dt>Cosa non va</dt><dd>${esc(PROB[it.tipo] || it.tipo)}</dd><dt>Note dell'utente</dt><dd>${esc(it.note || '–')}</dd><dt>Segnalato il</dt><dd>${dataOra(it.creato)} · ${it.user_id ? 'con account' : 'senza account'}</dd></dl>
      <div class="sub">${s.lat.toFixed(6)}, ${s.lon.toFixed(6)} · <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${s.lat},${s.lon}&layer=c&cbll=${s.lat},${s.lon}">Street View</a></div>`;
    qActs(); $('#q-msg').textContent = qFlash; qFlash = '';
  }
  async function qProb(az) { // azioni sul problema: sposta, rimuovi, risolto, scarta (Correggi dati è un link alla modifica nella mappa)
    const it = qSel; let nota = null;
    if (await qLavora('Salvo…', async () => {
      if (az === 'sposta') { chk(await sb.from('stalli').update({ lat: it.lat, lon: it.lon }).eq('id', it.stallo_id)); nota = 'Posto spostato nel punto proposto'; }
      else if (az === 'rimuovi') { chk(await sb.from('stalli').update({ stato: 'rimosso' }).eq('id', it.stallo_id)); nota = 'Rimosso dalla strada'; }
      const upd = { stato: az === 'scarta' ? 'scartato' : 'risolto', risolto_il: new Date().toISOString() }; if (nota) upd.nota_admin = nota;
      chk(await sb.from('problemi_posti').update(upd).eq('id', it.id));
    })) qFatto(az === 'sposta' ? 'Posto spostato.' : az === 'rimuovi' ? 'Posto rimosso dalla mappa.' : az === 'scarta' ? 'Scartato.' : 'Segnato come risolto.');
  }
  function qActs() {
    if (qTab === 'problemi') {
      const prop = qSel && qSel.lat != null && qSel.lon != null;
      $('#q-acts').innerHTML = `<button class="btn ap" data-act="p-sposta" ${prop ? '' : 'disabled title="L\'utente non ha indicato un punto"'}>📍 Sposta qui</button><button class="btn danger" data-act="p-rimuovi">Rimuovi il posto</button><a class="btn" style="display:inline-flex;align-items:center;text-decoration:none" href="#/mappa?id=${qSel ? qSel.stallo_id : ''}">Correggi dati</a><button class="btn" data-act="p-risolto">✓ Segna risolto</button><button class="btn" data-act="p-scarta">Scarta</button><button class="btn" data-act="skip">Salta › <kbd>→</kbd></button>`; return;
    }
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
    if (a.startsWith('p-')) qProb(a.slice(2)); else if (a === 'ok') qOk(null); else if (a === 'no') qNo(); else if (a === 'skip') qSkip(); else if (a === 'reset') qReset();
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
