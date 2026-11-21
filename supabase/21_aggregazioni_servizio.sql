-- 21 · Aggregazioni per gli script di servizio (21 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni. Solo aggiunte: non tocca righe né funzioni esistenti.
--
-- PERCHE': tools/copertura.py e tools/indirizzi.py scaricavano l'elenco intero degli stalli (circa 4-6 MB di traffico in uscita
-- a ogni esecuzione, sul piano Free ci sono 5 GB/mese). Qui il lavoro "da contare" lo fa il database e allo script arriva
-- soltanto l'aggregato. Le funzioni sono PER GLI SCRIPT con la chiave service: nessun permesso ad anon/authenticated.
--
-- COSA NON SI PUO' FARE IN SQL: assegnare uno stallo al suo comune. I confini ISTAT stanno nei file shapefile dello script e
-- PostGIS è stato tolto (06_rimuovi_postgis.sql). Quindi il database raggruppa gli stalli in celle di una griglia (celle a
-- latitudine/longitudine, ancorate allo zero), e per ogni cella dà conteggi e il riquadro che contiene davvero i suoi stalli.
-- Lo script controlla se quel riquadro cade per intero dentro UN solo comune (caso quasi sempre vero): allora assegna in blocco
-- tutta la cella. Le celle a cavallo di un confine vengono rifatte con celle più piccole e, in ultimo, con i singoli punti
-- (copertura_punti). Il risultato è IDENTICO al calcolo punto per punto, non un'approssimazione.
-- Il filtro degli stalli "attivi" è lo stesso di prima: stato in (proposto, verificato, ufficiale).
--
-- Le funzioni restituiscono un solo jsonb (un array di array, senza nomi di colonna: meno byte e una sola fotografia coerente
-- dei dati, senza paginazione). I numeri double passano da to_jsonb, che li scrive con tutte le cifre necessarie: nessuna perdita.
begin;

-- 1) Indici parziali per gli elenchi "da completare" (indirizzi.py): contengono solo gli stalli attivi senza comune / senza
--    indirizzo e si svuotano man mano che lo script li riempie.
create index if not exists stalli_attivi_senza_comune_idx on public.stalli (id)
  where comune is null and stato in ('proposto', 'verificato', 'ufficiale');
create index if not exists stalli_attivi_senza_indirizzo_idx on public.stalli (id)
  where indirizzo is null and stato in ('proposto', 'verificato', 'ufficiale');

-- 2) Celle con conteggi, per copertura.py.
--    p_cella      lato della cella in gradi (sia latitudine sia longitudine), da 0,0001 a 1.
--    p_in         facoltativo: elenco [[iy,ix],...] di celle "genitore" di lato p_cella_in; se presente si contano solo gli stalli
--                 che cadono in quelle celle (serve a raffinare le celle a cavallo di un confine). Senza, si contano tutti.
--    Ogni riga del risultato: [iy, ix, n, vis, opendata, osm, satellite, utente, proposto, lat_min, lat_max, lon_min, lon_max]
--      iy, ix      indici della cella: floor(lat / p_cella), floor(lon / p_cella)
--      n           stalli attivi nella cella
--      vis         quelli con tipo <> 'personalizzato' (cioè visibili nell'app)
--      opendata..utente  quanti per fonte; proposto  quanti con stato 'proposto' (da verificare)
--      lat_min..lon_max  riquadro dei soli stalli della cella, in centomillesimi di grado (1e-5 gradi, circa 1 m) ARROTONDATI VERSO
--                        L'ESTERNO (floor per i minimi, ceil per i massimi): un riquadro appena più largo, mai più stretto;
--                        lo script divide per 100000 e aggiunge comunque 2 m di margine. Sono interi per pesare poco.
create or replace function public.copertura_celle(p_cella double precision, p_in jsonb default null, p_cella_in double precision default null)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_cella is null or p_cella < 0.0001 or p_cella > 1 then
    raise exception 'p_cella non valida (da 0.0001 a 1 gradi)';
  end if;
  if p_in is not null then
    if jsonb_typeof(p_in) <> 'array' or p_cella_in is null or p_cella_in < 0.0001 or p_cella_in > 1 then
      raise exception 'p_in deve essere un array [[iy,ix],...] e p_cella_in un lato valido';
    end if;
    if jsonb_array_length(p_in) > 20000 then raise exception 'troppe celle in p_in (massimo 20000)'; end if;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_array(g.iy, g.ix, g.n, g.vis, g.od, g.osm, g.sat, g.ut, g.pr, g.la0, g.la1, g.lo0, g.lo1) order by g.iy, g.ix)
    from (
      select floor(s.lat / p_cella)::integer as iy, floor(s.lon / p_cella)::integer as ix,
             count(*) as n,
             count(*) filter (where s.tipo <> 'personalizzato') as vis,
             count(*) filter (where s.fonte = 'opendata') as od,
             count(*) filter (where s.fonte = 'osm') as osm,
             count(*) filter (where s.fonte = 'satellite') as sat,
             count(*) filter (where s.fonte = 'utente') as ut,
             count(*) filter (where s.stato = 'proposto') as pr,
             floor(min(s.lat) * 100000)::bigint as la0, ceil(max(s.lat) * 100000)::bigint as la1,
             floor(min(s.lon) * 100000)::bigint as lo0, ceil(max(s.lon) * 100000)::bigint as lo1
      from public.stalli s
      where s.stato in ('proposto', 'verificato', 'ufficiale')
        and (p_in is null or (floor(s.lat / p_cella_in)::integer, floor(s.lon / p_cella_in)::integer) in
               (select (e ->> 0)::integer, (e ->> 1)::integer from jsonb_array_elements(p_in) e))
      group by 1, 2
    ) g), '[]'::jsonb);
end $$;

-- 3) Punti singoli di alcune celle, per le celle a cavallo di un confine che neppure le celle piccole risolvono.
--    p_in = [[iy,ix],...] di lato p_cella_in (massimo 5000 celle per chiamata).
--    Ogni riga: [lat, lon, fonte, stato, tipo]: le stesse cinque colonne che copertura.py leggeva per ogni stallo.
create or replace function public.copertura_punti(p_in jsonb, p_cella_in double precision)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_in is null or jsonb_typeof(p_in) <> 'array' or p_cella_in is null or p_cella_in < 0.0001 or p_cella_in > 1 then
    raise exception 'p_in deve essere un array [[iy,ix],...] e p_cella_in un lato valido';
  end if;
  if jsonb_array_length(p_in) > 5000 then raise exception 'troppe celle in p_in (massimo 5000)'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_array(s.lat, s.lon, s.fonte, s.stato, s.tipo) order by s.lat, s.lon, s.id)
    from public.stalli s
    where s.stato in ('proposto', 'verificato', 'ufficiale')
      and (floor(s.lat / p_cella_in)::integer, floor(s.lon / p_cella_in)::integer) in
            (select (e ->> 0)::integer, (e ->> 1)::integer from jsonb_array_elements(p_in) e)
  ), '[]'::jsonb);
end $$;

-- 4) Stalli attivi che hanno ancora bisogno di comune o di indirizzo, per indirizzi.py. Paginata a chiave: si parte con
--    p_dopo = null e si richiama con l'ultimo id ricevuto finché non arrivano meno di p_limite righe.
--    p_campo = 'comune' | 'indirizzo'. Ogni riga: [id, lat, lon], in ordine di id. Massimo 10000 righe per chiamata.
create or replace function public.stalli_da_completare(p_campo text, p_dopo uuid default null, p_limite integer default 5000)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_lim integer := greatest(1, least(coalesce(p_limite, 5000), 10000));
begin
  if p_campo = 'comune' then
    return coalesce((select jsonb_agg(jsonb_build_array(t.id, t.lat, t.lon) order by t.id)
      from (select s.id, s.lat, s.lon from public.stalli s
            where s.comune is null and s.stato in ('proposto', 'verificato', 'ufficiale') and (p_dopo is null or s.id > p_dopo)
            order by s.id limit v_lim) t), '[]'::jsonb);
  elsif p_campo = 'indirizzo' then
    return coalesce((select jsonb_agg(jsonb_build_array(t.id, t.lat, t.lon) order by t.id)
      from (select s.id, s.lat, s.lon from public.stalli s
            where s.indirizzo is null and s.stato in ('proposto', 'verificato', 'ufficiale') and (p_dopo is null or s.id > p_dopo)
            order by s.id limit v_lim) t), '[]'::jsonb);
  end if;
  raise exception 'p_campo deve essere comune oppure indirizzo';
end $$;

-- 5) Permessi: solo gli script con la chiave service (service_role). Né anon né gli utenti con account.
--    ("revoke ... from public" da solo non basta su Supabase: anon e authenticated ricevono i permessi anche in modo diretto.)
revoke all on function public.copertura_celle(double precision, jsonb, double precision) from public, anon, authenticated;
revoke all on function public.copertura_punti(jsonb, double precision) from public, anon, authenticated;
revoke all on function public.stalli_da_completare(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.copertura_celle(double precision, jsonb, double precision) to service_role;
grant execute on function public.copertura_punti(jsonb, double precision) to service_role;
grant execute on function public.stalli_da_completare(text, uuid, integer) to service_role;

commit;

-- osm_import_italia.py non ha bisogno di funzioni: non scarica l'elenco degli stalli (carica con upsert su osm_id che ignora i
-- duplicati, risposta minima, e conta le righe con una richiesta HEAD).

-- Controlli dopo l'esecuzione (dall'editor SQL, non cambiano nulla):
--   select jsonb_array_length(public.copertura_celle(0.02));                      -- numero di celle a 0,02 gradi
--   select public.copertura_celle(0.02) -> 0;                                      -- la prima cella
--   select jsonb_array_length(public.stalli_da_completare('indirizzo', null, 10)); -- al massimo 10
--   select has_function_privilege('anon', 'public.copertura_celle(double precision, jsonb, double precision)', 'execute');  -- false
