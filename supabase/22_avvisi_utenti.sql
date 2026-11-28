-- 22 · Avvisi via email agli utenti: nuovi posti vicino a Casa e Lavoro (21 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni. Solo aggiunte.
--
-- A COSA SERVE: tools/avvisi_utenti.py (una volta al giorno) manda un'email a chi ha attivato "Nuovi posti vicino a Casa e Lavoro".
-- Allo script non si scarica l'elenco degli stalli: gli si dà l'elenco dei punti (Casa/Lavoro degli utenti con l'avviso acceso)
-- e il database risponde SOLO con gli stalli nuovi entro il raggio da ciascun punto. Senza PostGIS (tolto con 06): riquadro
-- in gradi + distanza calcolata (formula di haversine). Funzione solo per la chiave service: nessun permesso ad anon/authenticated.
--
-- "NUOVO" = attivo (verificato o ufficiale; mai proposto, rifiutato o rimosso) e aggiunto o approvato nelle ultime p_ore ore.
-- updated_at NON va bene (cambia anche quando indirizzi.py riempie comune e indirizzo), quindi si aggiunge approvato_il:
-- si compila da solo quando uno stallo passa a verificato/ufficiale; per gli altri vale created_at.
begin;

alter table public.stalli add column if not exists approvato_il timestamptz;

create or replace function public.stalli_segna_approvato() returns trigger language plpgsql as $$
begin
  if new.stato in ('verificato', 'ufficiale') and (tg_op = 'INSERT' or old.stato is distinct from new.stato) then
    new.approvato_il := now();
  end if;
  return new;
end $$;
drop trigger if exists stalli_approvato on public.stalli;
create trigger stalli_approvato before insert or update of stato on public.stalli for each row execute function public.stalli_segna_approvato();

-- Solo gli stalli attivi recenti: l'indice resta minuscolo e la ricerca non guarda tutta la tabella.
create index if not exists stalli_novita_idx on public.stalli ((coalesce(approvato_il, created_at))) where stato in ('verificato', 'ufficiale');

-- p_punti: [{"k":"<chiave del punto>","lat":46.1,"lon":13.2}, ...] (al massimo 5000)
-- Risposta: una riga per ogni coppia punto-stallo, al massimo 30 per punto, dal più vicino. Esclude i posti "personalizzato"
-- (non visibili nell'app) e gli stalli senza coordinate valide.
create or replace function public.stalli_nuovi_vicino(p_punti jsonb, p_ore integer default 24, p_raggio_m integer default 500)
returns table (k text, id uuid, lat double precision, lon double precision, indirizzo text, comune text, nome text, tipo text,
               posti integer, stato text, distanza_m integer, novita_il timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if jsonb_typeof(coalesce(p_punti, '[]'::jsonb)) <> 'array' then raise exception 'p_punti deve essere un array'; end if;
  if jsonb_array_length(coalesce(p_punti, '[]'::jsonb)) > 5000 then raise exception 'troppi punti (massimo 5000)'; end if;
  p_ore := least(greatest(coalesce(p_ore, 24), 1), 168);
  p_raggio_m := least(greatest(coalesce(p_raggio_m, 500), 50), 5000);
  return query
    with recenti as (
      select s.id, s.lat, s.lon, s.indirizzo, s.comune, s.nome, s.tipo, s.posti, s.stato, coalesce(s.approvato_il, s.created_at) as novita
      from public.stalli s
      where s.stato in ('verificato', 'ufficiale') and s.tipo <> 'personalizzato'
        and coalesce(s.approvato_il, s.created_at) >= now() - make_interval(hours => p_ore)
    ), punti as (
      select (x ->> 'k') as k, (x ->> 'lat')::double precision as plat, (x ->> 'lon')::double precision as plon
      from jsonb_array_elements(coalesce(p_punti, '[]'::jsonb)) x
      where x ->> 'k' is not null and x ->> 'lat' is not null and x ->> 'lon' is not null
    ), coppie as (
      select p.k, r.*, 2 * 6371000 * asin(sqrt(least(1, power(sin(radians(r.lat - p.plat) / 2), 2)
             + cos(radians(p.plat)) * cos(radians(r.lat)) * power(sin(radians(r.lon - p.plon) / 2), 2)))) as d
      from punti p join recenti r
        on r.lat between p.plat - p_raggio_m / 111320.0 and p.plat + p_raggio_m / 111320.0
       and r.lon between p.plon - p_raggio_m / (111320.0 * greatest(cos(radians(p.plat)), 0.01)) and p.plon + p_raggio_m / (111320.0 * greatest(cos(radians(p.plat)), 0.01))
    ), ordinate as (
      select c.*, row_number() over (partition by c.k order by c.d) as n from coppie c where c.d <= p_raggio_m
    )
    select o.k, o.id, o.lat, o.lon, o.indirizzo, o.comune, o.nome, o.tipo, o.posti, o.stato, round(o.d)::integer, o.novita
    from ordinate o where o.n <= 30 order by o.k, o.d;
end $$;
revoke all on function public.stalli_nuovi_vicino(jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.stalli_nuovi_vicino(jsonb, integer, integer) to service_role;

commit;

-- Controllo (facoltativo): la funzione deve risultare eseguibile solo dal service_role, e la colonna esistere
select p.proname as funzione, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role,
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stalli' and column_name = 'approvato_il') as colonna_approvato_il
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stalli_nuovi_vicino';
