-- 20 · Dispositivi interni, soglia "reale" scelta, e (lato app) dispositivi di prova Google Play (20 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase DOPO la 19. Si può rieseguire senza danni. NON cancella né modifica dati esistenti.
--
-- Cosa fa:
--  1) Aggiunge a public.eventi la colonna "interno" (boolean, default false). L'app la manda a true dai dispositivi di Andrea, di Giulia
--     e dai controlli dello sviluppatore: si segna da sola con l'accesso admin, oppure a mano (7 tocchi sulla versione in "I tuoi posti").
--     La policy di inserimento (09: with check (creato > now() - interval '1 minute')) non guarda le colonne e il permesso di insert
--     è sulla tabella intera: la nuova colonna passa senza altre modifiche. Finché questo file non è stato eseguito, l'app che manda
--     "interno" si vede rifiutare l'evento (400): lo rimanda UNA volta senza il campo e per 24 ore non lo rimanda più.
--  2) Un dispositivo è INTERNO se ha MAI mandato un evento con interno = true (vale anche per tutta la sua storia precedente).
--     L'indice parziale eventi_interno rende la ricerca leggera (poche righe).
--  3) Sostituisce statistiche_admin_filtri(): la vecchia firma a 4 parametri (19) viene eliminata e la funzione rinasce con 6:
--       p_escludi_interni boolean default true   -> toglie i dispositivi interni da tutti i conteggi (restituisce anche 'interni' e 'interni_totali')
--       p_soglia text default 'attivo'           -> cosa rende "reale" un dispositivo:
--            'attivo' = resta almeno 2 minuti, cioè almeno un evento diverso da 'avvio' (comportamento della 19);
--            'azione' = fa almeno un'azione (scheda, destinazione, naviga, streetview, salva, conferma, segnala, condividi, parcheggiato,
--                       occupato, categoria, satellite, suggerimento, registrazione, accesso, recensione, consiglia, regole).
--     Il pannello, se trova ancora la firma vecchia, ricade sulla chiamata a 4 parametri.
--     Come nella 19, un evento precedente all'orizzonte della pulizia (17) vale come prova di vita con entrambe le soglie.
--  4) Crea public.dispositivi_interni_admin() (solo admin): l'elenco dei dispositivi interni con piattaforma, ultima attività ed eventi.
--  5) Aggiorna pulisci_eventi() (17) in un solo punto: gli eventi con interno = true non si cancellano mai, così un dispositivo interno
--     resta riconoscibile anche dopo i 90 giorni (sono pochissimi). Il resto della funzione è identico.
begin;

alter table public.eventi add column if not exists interno boolean not null default false;
create index if not exists eventi_interno on public.eventi (device_id) where interno;

drop function if exists public.statistiche_admin_filtri(date, date, text, boolean);

create or replace function public.statistiche_admin_filtri(
  p_dal date, p_al date, p_piattaforma text default null, p_solo_reali boolean default true,
  p_escludi_interni boolean default true, p_soglia text default 'attivo')
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
  v_az boolean := (coalesce(nullif(btrim(p_soglia), ''), 'attivo') = 'azione');   -- soglia "reale": solo chi fa un'azione
  -- eventi che contano come "azione" con la soglia 'azione' (tutto ciò che non è apertura, segnale di vita o errore)
  v_azioni text[] := array['scheda','destinazione','naviga','streetview','salva','conferma','segnala','condividi','parcheggiato','occupato',
                           'categoria','satellite','suggerimento','registrazione','accesso','recensione','consiglia','regole'];
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  if p_dal is null or p_al is null then raise exception 'periodo mancante'; end if;
  if coalesce(nullif(btrim(p_soglia), ''), 'attivo') not in ('attivo', 'azione') then raise exception 'soglia non valida'; end if;
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
           exists (select 1 from public.eventi x where x.device_id = d.device_id
                   and (x.creato < v_orizz_ts or (case when v_az then x.tipo = any(v_azioni) else x.tipo <> 'avvio' end))) as reale,
           -- interno: ha MAI mandato un evento con interno = true (retroattivo su tutta la sua storia; usa l'indice parziale eventi_interno)
           exists (select 1 from public.eventi x where x.device_id = d.device_id and x.interno) as interno,
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
    where (dv.reale or not p_solo_reali) and not (dv.interno and p_escludi_interni)
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
      and (dv.reale or not p_solo_reali) and not (dv.interno and p_escludi_interni)
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
    where dv.primo >= greatest(v_t0, v_orizz_ts) and dv.primo < v_t1 and (dv.reale or not p_solo_reali) and not (dv.interno and p_escludi_interni)
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
  ),
  -- tutti i dispositivi interni di sempre (pochi: indice parziale eventi_interno)
  ints as materialized (select distinct device_id from public.eventi where interno)
  select jsonb_build_object(
    'agg', now(), 'dal', v_dal, 'al', v_al, 'giorni', v_n, 'prec_dal', v_pdal, 'prec_al', v_dal - 1,
    'piattaforma', v_pf, 'solo_reali', p_solo_reali,
    'escludi_interni', p_escludi_interni, 'soglia', case when v_az then 'azione' else 'attivo' end,
    'dettaglio_da', case when v_orizz > date '1900-01-01' then v_orizz end,          -- prima di questo giorno solo riassunto
    'giorni_riassunto', greatest(0, least(v_orizz, v_al + 1) - v_dal),
    -- "adesso": telefoni online (ultimi 5 minuti) e telefoni totali da sempre, con gli stessi filtri
    'adesso', jsonb_build_object(
      'online', (select count(distinct x.device_id) from public.eventi x
                 where x.creato > now() - interval '5 minutes' and (v_pf is null or x.piattaforma = v_pf)
                   and (not p_escludi_interni or not exists (select 1 from ints i where i.device_id = x.device_id))
                   and (not p_solo_reali or exists (select 1 from public.eventi y where y.device_id = x.device_id
                          and (y.creato < v_orizz_ts or (case when v_az then y.tipo = any(v_azioni) else y.tipo <> 'avvio' end))))),
      'telefoni_totali', (select count(distinct x.device_id) from public.eventi x
                 where (v_pf is null or x.piattaforma = v_pf)
                   and (not p_escludi_interni or not exists (select 1 from ints i where i.device_id = x.device_id))
                   and (not p_solo_reali or x.creato < v_orizz_ts or (case when v_az then x.tipo = any(v_azioni) else x.tipo <> 'avvio' end)))),
    -- quanti dispositivi del periodo sono stati considerati test/robot (stessa piattaforma)
    'non_reali', (select count(distinct r.device_id) from raw r join dv on dv.device_id = r.device_id
                  where not dv.reale and not (dv.interno and p_escludi_interni) and r.creato >= v_t0 and (v_pf is null or r.piattaforma = v_pf)),
    -- dispositivi interni comparsi nel periodo (stessa piattaforma) e interni da sempre: sono quelli che "Escludi dispositivi interni" toglie
    'interni', (select count(distinct r.device_id) from raw r join dv on dv.device_id = r.device_id
                where dv.interno and r.creato >= v_t0 and (v_pf is null or r.piattaforma = v_pf)),
    'interni_totali', (select count(*) from ints),
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

revoke all on function public.statistiche_admin_filtri(date, date, text, boolean, boolean, text) from public, anon;
grant execute on function public.statistiche_admin_filtri(date, date, text, boolean, boolean, text) to authenticated;

-- Elenco dei dispositivi interni (solo admin): serve alla scheda Statistiche del pannello.
create or replace function public.dispositivi_interni_admin()
returns table (device_id text, piattaforma text, ultima timestamptz, eventi bigint)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  return query
    select e.device_id, (array_agg(e.piattaforma order by e.creato desc))[1], max(e.creato), count(*)
    from public.eventi e
    where e.device_id in (select x.device_id from public.eventi x where x.interno)
    group by e.device_id
    order by max(e.creato) desc;
end $$;
revoke all on function public.dispositivi_interni_admin() from public, anon;
grant execute on function public.dispositivi_interni_admin() to authenticated;

-- pulisci_eventi (17): uguale a prima, con una riga in più (and not e.interno)
create or replace function public.pulisci_eventi(p_giorni int default 90, p_giorni_zone int default 400)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_g int := greatest(coalesce(p_giorni, 90), 35); v_z int := greatest(coalesce(p_giorni_zone, 400), 365, greatest(coalesce(p_giorni, 90), 35)); v_n bigint;
begin
  with vecchi as (
    delete from public.eventi e
    where e.creato < now() - make_interval(days => v_g)
      and e.tipo <> 'account_eliminato'
      and not e.interno
      and not (e.tipo = 'destinazione' and e.lat_g is not null and e.creato >= now() - make_interval(days => v_z))
      -- si tiene il primo evento di ogni telefono (serve a statistiche_admin per "nuovi" e "telefoni_totali")
      and exists (select 1 from public.eventi x where x.device_id = e.device_id and (x.creato, x.id) < (e.creato, e.id))
    returning e.creato, e.tipo, e.piattaforma
  ), giorni as (
    select (creato at time zone 'Europe/Rome')::date as giorno, tipo, coalesce(piattaforma, '?') as piattaforma, count(*)::int as n
    from vecchi group by 1, 2, 3
  ), somma as (
    insert into public.eventi_giorno (giorno, tipo, piattaforma, n)
    select giorno, tipo, piattaforma, n from giorni
    on conflict (giorno, tipo, piattaforma) do update set n = public.eventi_giorno.n + excluded.n
    returning 1
  )
  select count(*) into v_n from vecchi;
  return v_n;
end $$;
revoke all on function public.pulisci_eventi(int, int) from public, anon, authenticated;

commit;

-- Controlli (facoltativi, sola lettura). Permessi: anon deve dire false, authenticated true per tutte e due le funzioni.
select has_function_privilege('anon', 'public.statistiche_admin_filtri(date,date,text,boolean,boolean,text)', 'execute') as anon_stat,
       has_function_privilege('authenticated', 'public.statistiche_admin_filtri(date,date,text,boolean,boolean,text)', 'execute') as auth_stat,
       has_function_privilege('anon', 'public.dispositivi_interni_admin()', 'execute') as anon_int,
       has_function_privilege('authenticated', 'public.dispositivi_interni_admin()', 'execute') as auth_int;
-- Deve esserci UNA sola statistiche_admin_filtri (6 parametri):
select pg_get_function_identity_arguments(p.oid) from pg_proc p where p.proname = 'statistiche_admin_filtri' and p.pronamespace = 'public'::regnamespace;
