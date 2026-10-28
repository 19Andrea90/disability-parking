-- 06 · Rimozione di PostGIS (avviso Supabase "rls_disabled_in_public" su spatial_ref_sys, 28 ottobre 2026)
-- spatial_ref_sys appartiene a supabase_admin: non possiamo né attivarne l'RLS né revocarne i permessi.
-- PostGIS non serve all'app (l'app e l'admin filtrano per lat/lon e calcolano le distanze nel browser),
-- quindi lo togliamo insieme alla colonna geom e alle due funzioni mai usate: spatial_ref_sys sparisce con lui.
-- Tutto in una transazione: se un passo fallisce non cambia nulla.

begin;

-- la vista dell'admin dipende da geom (era stata creata con s.*): la tolgo e la ricreo sotto
drop view if exists public.stalli_con_conferme;

-- funzioni geografiche mai chiamate dall'app né dall'admin
drop function if exists public.stalli_vicini(double precision, double precision, integer);
drop function if exists public.stalli_entro(double precision, double precision, integer);

-- colonna calcolata e indice spaziale
drop index if exists public.stalli_geom_idx;
alter table public.stalli drop column if exists geom;

-- indice semplice su lat/lon per le ricerche per area
create index if not exists stalli_lat_lon_idx on public.stalli (lat, lon);

-- senza cascade: se qualcos'altro usasse ancora PostGIS il comando fallisce e la transazione si annulla
drop extension if exists postgis;

-- vista dell'admin ricreata, questa volta con i permessi di chi la interroga (avviso security_definer_view)
create view public.stalli_con_conferme with (security_invoker = true) as
select s.*,
  (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'esiste') as conferme_esiste,
  (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'non_esiste') as conferme_non_esiste,
  (select max(c.created_at) from public.conferme c where c.stallo_id = s.id) as ultima_conferma
from public.stalli s;
grant select on public.stalli_con_conferme to anon, authenticated;

commit;
