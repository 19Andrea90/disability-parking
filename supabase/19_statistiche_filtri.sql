-- 19 · Statistiche filtrabili, senza test e robot (20 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni. NON scrive né cancella dati:
-- crea solo la funzione public.statistiche_admin_filtri(), che il pannello admin (Dashboard > Statistiche dell'app) chiama
-- ogni volta che cambi periodo, piattaforma o l'interruttore "Escludi test e robot".
-- statistiche_admin() (09/10/14) resta com'è: il pannello ci ricade se questa funzione non c'è ancora.
--
-- PERCHÉ: l'app manda un evento 'avvio' 1,5 secondi dopo l'apertura. I test automatici (Playwright), le anteprime
-- *.sostabile.pages.dev e i dispositivi di prova di Google Play aprono l'app e se ne vanno: ogni origine o profilo nuovo
-- crea un codice dispositivo nuovo e il pannello lo contava come "nuovo telefono" (18 "nuovi telefoni" con 2 persone vere).
--
-- DISPOSITIVO REALE (definizione usata dappertutto qui sotto):
--   un device_id è "reale" se nella sua storia ha almeno un evento diverso da 'avvio' (attivo, destinazione, naviga, scheda...).
--   Chi apre e chiude in un attimo senza fare nulla si comporta come un test o un robot e viene escluso.
--   Con la pulizia notturna (17) gli eventi oltre i 90 giorni sono riassunti e cancellati, ma per ogni telefono resta il
--   suo evento PIÙ VECCHIO (spesso un 'avvio'): per non declassare chi usa l'app da mesi, un evento precedente all'orizzonte
--   della pulizia vale come prova di vita (la riga è rimasta proprio perché dopo ce ne furono altre).
--   Limite noto: un telefono reale appena aperto è "reale" solo dopo il primo 'attivo' (2 minuti) o la prima azione,
--   quindi "online adesso" lo conta con quel ritardo.
--
-- DATI OLTRE LA PULIZIA: la tabella eventi_giorno (17) riassume per giorno, tipo e piattaforma gli eventi cancellati, senza
-- il dettaglio per dispositivo. Per i giorni coperti solo dal riassunto la funzione restituisce sessioni, navigazioni, schede,
-- arrivi, errori... (filtrabili per piattaforma ma NON per "reali") e lascia null attivi e nuovi (serie.r = true).
-- Se 17 non è stata eseguita, tutto il periodo ha il dettaglio e il riassunto non serve.
--
-- Prestazioni: ogni lettura di eventi è limitata al periodo scelto più quello precedente (indice eventi_creato); per i soli
-- dispositivi comparsi nel periodo si cerca la storia con l'indice eventi_device (device_id, creato). L'unica lettura senza
-- limite di data è "telefoni_totali" (come già in statistiche_admin).
begin;

create or replace function public.statistiche_admin_filtri(
  p_dal date, p_al date, p_piattaforma text default null, p_solo_reali boolean default true)
returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_oggi  date := (now() at time zone 'Europe/Rome')::date;
  v_dal   date := p_dal;
  v_al    date;
  v_n     int;                 -- giorni del periodo
  v_pdal  date;                -- periodo precedente, di uguale durata, subito prima
  v_pf    text := nullif(btrim(p_piattaforma), '');
  v_orizz date := date '1900-01-01';  -- primo giorno con il dettaglio completo in "eventi" (prima: solo riassunto)
  v_t0 timestamptz; v_t1 timestamptz; v_tp0 timestamptz; v_orizz_ts timestamptz;
  v_sm jsonb := '[]';          -- righe del riassunto giornaliero (giorno, tipo, n) per i giorni prima dell'orizzonte
  v_r jsonb;
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  if p_dal is null or p_al is null then raise exception 'periodo mancante'; end if;
  if v_pf is not null and v_pf not in ('android', 'ios', 'web', 'pc') then raise exception 'piattaforma non valida'; end if;
  v_al := least(p_al, v_oggi);
  if v_al < v_dal then raise exception 'periodo non valido'; end if;
  v_n := v_al - v_dal + 1;
  if v_n > 366 then raise exception 'periodo troppo lungo (massimo 366 giorni)'; end if;
  v_pdal := v_dal - v_n;
  v_t0 := v_dal::timestamp at time zone 'Europe/Rome';
  v_t1 := (v_al + 1)::timestamp at time zone 'Europe/Rome';
  v_tp0 := v_pdal::timestamp at time zone 'Europe/Rome';

  -- Riassunto della pulizia notturna (17), se esiste: dice da quando "eventi" ha il dettaglio completo.
  if to_regclass('public.eventi_giorno') is not null then
    execute 'select coalesce(max(giorno) + 1, date ''1900-01-01'') from public.eventi_giorno' into v_orizz;
    if v_orizz > v_pdal then
      execute 'select coalesce(jsonb_agg(jsonb_build_object(''g'', giorno, ''t'', tipo, ''n'', n)), ''[]'')
               from (select giorno, tipo, sum(n)::bigint as n from public.eventi_giorno
                     where giorno >= $1 and giorno < $2 and ($3::text is null or piattaforma = $3::text) group by 1, 2) x'
        into v_sm using v_pdal, least(v_orizz, v_al + 1), v_pf;
    end if;
  end if;
  v_orizz_ts := v_orizz::timestamp at time zone 'Europe/Rome';

  with
  -- eventi del periodo e di quello precedente (solo dove c'è il dettaglio), tutte le piattaforme
  raw as materialized (
    select device_id, creato, tipo, piattaforma, versione, comune, dettaglio
    from public.eventi
    where creato >= greatest(v_tp0, v_orizz_ts) and creato < v_t1
  ),
  -- un record per dispositivo comparso nel periodo: è "reale"? quando è comparso la prima volta?
  dv as materialized (
    select d.device_id,
           exists (select 1 from public.eventi x where x.device_id = d.device_id and (x.tipo <> 'avvio' or x.creato < v_orizz_ts)) as reale,
           (select min(x.creato) from public.eventi x where x.device_id = d.device_id) as primo
    from (select distinct device_id from raw) d
  ),
  -- eventi da contare: solo dispositivi reali (se richiesto)
  ea as materialized (
    select r.device_id, r.creato, r.tipo, r.piattaforma, r.versione, r.comune, r.dettaglio,
           (r.creato at time zone 'Europe/Rome')::date as g,
           extract(hour from r.creato at time zone 'Europe/Rome')::int as h,
           (r.creato >= v_t0) as cur
    from raw r join dv on dv.device_id = r.device_id
    where dv.reale or not p_solo_reali
  ),
  e as materialized (select * from ea where v_pf is null or piattaforma = v_pf),
  -- conteggi per periodo (cur = true: periodo scelto; false: precedente)
  k as (
    select cur,
      count(distinct device_id) as attivi,
      count(*) filter (where tipo = 'avvio') as sessioni,
      count(*) filter (where tipo = 'naviga') as navigazioni,
      count(*) filter (where tipo = 'parcheggiato' or (tipo = 'conferma' and dettaglio like 'parcheggiato:%')) as arrivati,
      count(*) filter (where tipo = 'occupato' or (tipo = 'conferma' and dettaglio like 'occupato:%')) as occupato,
      count(*) filter (where tipo = 'scheda') as schede,
      count(*) filter (where tipo = 'accesso') as accessi,
      count(*) filter (where tipo = 'errore') as errori,
      count(*) filter (where tipo = 'destinazione') as destinazioni,
      count(*) filter (where tipo = 'destinazione' and dettaglio = 'senza_posti') as senza_posti
    from e group by cur
  ),
  -- dispositivi nuovi: il primo evento in assoluto cade nel periodo
  nu as (
    select (dv.primo >= v_t0) as cur, count(*) as n
    from dv
    where dv.primo >= greatest(v_tp0, v_orizz_ts) and dv.primo < v_t1
      and (dv.reale or not p_solo_reali)
      and dv.device_id in (select device_id from e)
    group by 1
  ),
  -- giorni coperti solo dal riassunto
  sm as (select x.g, x.t, x.n, (x.g >= v_dal) as cur from jsonb_to_recordset(v_sm) as x(g date, t text, n bigint)),
  smk as (
    select cur,
      coalesce(sum(n) filter (where t = 'avvio'), 0) as sessioni,
      coalesce(sum(n) filter (where t = 'naviga'), 0) as navigazioni,
      coalesce(sum(n) filter (where t = 'parcheggiato'), 0) as arrivati,
      coalesce(sum(n) filter (where t = 'occupato'), 0) as occupato,
      coalesce(sum(n) filter (where t = 'scheda'), 0) as schede,
      coalesce(sum(n) filter (where t = 'accesso'), 0) as accessi,
      coalesce(sum(n) filter (where t = 'errore'), 0) as errori,
      coalesce(sum(n) filter (where t = 'destinazione'), 0) as destinazioni
    from sm group by cur
  ),
  cs as (
    select c.cur,
      coalesce(k.attivi, 0) as attivi,
      coalesce(nu.n, 0) as nuovi,
      coalesce(k.sessioni, 0) + coalesce(s.sessioni, 0) as sessioni,
      coalesce(k.navigazioni, 0) + coalesce(s.navigazioni, 0) as navigazioni,
      coalesce(k.arrivati, 0) + coalesce(s.arrivati, 0) as arrivati,
      coalesce(k.occupato, 0) + coalesce(s.occupato, 0) as occupato,
      coalesce(k.schede, 0) + coalesce(s.schede, 0) as schede,
      coalesce(k.accessi, 0) + coalesce(s.accessi, 0) as accessi,
      coalesce(k.errori, 0) + coalesce(s.errori, 0) as errori,
      coalesce(k.destinazioni, 0) + coalesce(s.destinazioni, 0) as destinazioni,
      coalesce(k.senza_posti, 0) as senza_posti
    from (values (true), (false)) c(cur)
    left join k on k.cur = c.cur left join nu on nu.cur = c.cur left join smk s on s.cur = c.cur
  ),
  -- serie giornaliera del periodo scelto
  gd as (
    select g,
      count(distinct device_id) as attivi,
      count(*) filter (where tipo = 'avvio') as sessioni,
      count(*) filter (where tipo = 'naviga') as naviga,
      count(*) filter (where tipo = 'parcheggiato' or (tipo = 'conferma' and dettaglio like 'parcheggiato:%')) as arrivati,
      count(*) filter (where tipo = 'occupato' or (tipo = 'conferma' and dettaglio like 'occupato:%')) as occupato,
      count(*) filter (where tipo = 'scheda') as schede,
      count(*) filter (where tipo = 'accesso') as accessi,
      count(*) filter (where tipo = 'errore') as errori
    from e where cur group by g
  ),
  nd as (
    select (dv.primo at time zone 'Europe/Rome')::date as g, count(*) as nuovi
    from dv
    where dv.primo >= greatest(v_t0, v_orizz_ts) and dv.primo < v_t1 and (dv.reale or not p_solo_reali)
      and dv.device_id in (select device_id from e)
    group by 1
  ),
  sd as (
    select g,
      coalesce(sum(n) filter (where t = 'avvio'), 0) as sessioni,
      coalesce(sum(n) filter (where t = 'naviga'), 0) as naviga,
      coalesce(sum(n) filter (where t = 'parcheggiato'), 0) as arrivati,
      coalesce(sum(n) filter (where t = 'occupato'), 0) as occupato,
      coalesce(sum(n) filter (where t = 'scheda'), 0) as schede,
      coalesce(sum(n) filter (where t = 'accesso'), 0) as accessi,
      coalesce(sum(n) filter (where t = 'errore'), 0) as errori
    from sm where cur group by g
  ),
  sg as (  -- segnalazioni degli utenti (non dipendono da piattaforma o test)
    select (created_at at time zone 'Europe/Rome')::date as g, count(*) as n
    from public.stalli where fonte = 'utente' and created_at >= v_t0 and created_at < v_t1 group by 1
  ),
  rg as (  -- account creati
    select (created_at at time zone 'Europe/Rome')::date as g, count(*) as n
    from auth.users where created_at >= v_t0 and created_at < v_t1 group by 1
  ),
  serie as (
    select jsonb_agg(jsonb_build_object(
        'g', d.g, 'r', (d.g < v_orizz),
        'attivi', case when d.g < v_orizz then null else coalesce(gd.attivi, 0) end,
        'nuovi', case when d.g < v_orizz then null else coalesce(nd.nuovi, 0) end,
        'sessioni', coalesce(gd.sessioni, sd.sessioni, 0),
        'naviga', coalesce(gd.naviga, sd.naviga, 0),
        'arrivati', coalesce(gd.arrivati, sd.arrivati, 0),
        'occupato', coalesce(gd.occupato, sd.occupato, 0),
        'schede', coalesce(gd.schede, sd.schede, 0),
        'accessi', coalesce(gd.accessi, sd.accessi, 0),
        'errori', coalesce(gd.errori, sd.errori, 0),
        'segnalazioni', coalesce(sg.n, 0),
        'registrazioni', coalesce(rg.n, 0)) order by d.g) as j
    from (select (v_dal + i)::date as g from generate_series(0, v_n - 1) i) d
    left join gd on gd.g = d.g left join nd on nd.g = d.g left join sd on sd.g = d.g
    left join sg on sg.g = d.g left join rg on rg.g = d.g
  )
  select jsonb_build_object(
    'agg', now(), 'dal', v_dal, 'al', v_al, 'giorni', v_n, 'prec_dal', v_pdal, 'prec_al', v_dal - 1,
    'piattaforma', v_pf, 'solo_reali', p_solo_reali,
    'dettaglio_da', case when v_orizz > date '1900-01-01' then v_orizz end,          -- prima di questo giorno solo riassunto
    'giorni_riassunto', greatest(0, least(v_orizz, v_al + 1) - v_dal),
    -- "adesso": telefoni online (ultimi 5 minuti) e telefoni totali da sempre, con gli stessi filtri
    'adesso', jsonb_build_object(
      'online', (select count(distinct x.device_id) from public.eventi x
                 where x.creato > now() - interval '5 minutes' and (v_pf is null or x.piattaforma = v_pf)
                   and (not p_solo_reali or exists (select 1 from public.eventi y where y.device_id = x.device_id and (y.tipo <> 'avvio' or y.creato < v_orizz_ts)))),
      'telefoni_totali', (select count(distinct x.device_id) from public.eventi x
                 where (v_pf is null or x.piattaforma = v_pf) and (not p_solo_reali or x.tipo <> 'avvio' or x.creato < v_orizz_ts))),
    -- quanti dispositivi del periodo sono stati considerati test/robot (stessa piattaforma)
    'non_reali', (select count(distinct r.device_id) from raw r join dv on dv.device_id = r.device_id
                  where not dv.reale and r.creato >= v_t0 and (v_pf is null or r.piattaforma = v_pf)),
    'kpi', (select to_jsonb(c) - 'cur' from cs c where c.cur)
           || jsonb_build_object(
                'segnalazioni', (select coalesce(sum(n), 0) from sg),
                'registrazioni', (select coalesce(sum(n), 0) from rg)),
    'prec', (select to_jsonb(c) - 'cur' from cs c where not c.cur)
           || jsonb_build_object(
                'segnalazioni', (select count(*) from public.stalli where fonte = 'utente' and created_at >= v_tp0 and created_at < v_t0),
                'registrazioni', (select count(*) from auth.users where created_at >= v_tp0 and created_at < v_t0)),
    'serie', (select j from serie),
    -- dispositivi per ora del giorno, sommati sui giorni (stesso dispositivo nella stessa ora di un giorno = 1)
    'ore', (select jsonb_agg(coalesce(o.n, 0) order by hh) from generate_series(0, 23) hh
            left join (select h, count(*) as n from (select distinct g, h, device_id from e where cur) z group by h) o on o.h = hh),
    -- dispositivi per piattaforma: tutte le piattaforme, anche se ne hai scelta una (per poter cambiare con un clic)
    'piattaforme', (select coalesce(jsonb_object_agg(k2, n), '{}') from (select coalesce(piattaforma, '?') as k2, count(distinct device_id) as n from ea where cur group by 1) x),
    'versioni', (select coalesce(jsonb_agg(jsonb_build_object('v', v, 'n', n) order by n desc, v), '[]')
                 from (select coalesce(versione, '?') as v, count(distinct device_id) as n from e where cur group by 1 order by 2 desc, 1 limit 8) x),
    'comuni_vuoti', (select coalesce(jsonb_agg(jsonb_build_object('c', c, 'n', n) order by n desc, c), '[]')
                 from (select comune as c, count(*) as n from e where cur and tipo = 'destinazione' and dettaglio = 'senza_posti' and comune is not null group by 1 order by 2 desc, 1 limit 10) x),
    'comuni_naviga', (select coalesce(jsonb_agg(jsonb_build_object('c', c, 'n', n) order by n desc, c), '[]')
                 from (select comune as c, count(*) as n from e where cur and tipo = 'naviga' and comune is not null group by 1 order by 2 desc, 1 limit 10) x)
  ) into v_r;
  return v_r;
end $$;

revoke all on function public.statistiche_admin_filtri(date, date, text, boolean) from public, anon;
grant execute on function public.statistiche_admin_filtri(date, date, text, boolean) to authenticated;

commit;

-- Controllo (facoltativo, sola lettura; dal pannello SQL is_admin() è falso e la funzione risponde "solo admin": provalo dal pannello admin).
-- Permessi: anon deve dire false, authenticated true.
select has_function_privilege('anon', 'public.statistiche_admin_filtri(date,date,text,boolean)', 'execute') as anon,
       has_function_privilege('authenticated', 'public.statistiche_admin_filtri(date,date,text,boolean)', 'execute') as authenticated;
