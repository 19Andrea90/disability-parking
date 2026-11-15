-- 08 · "Le mie segnalazioni" nell'app e motivo del rifiuto
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni.
begin;

-- 1) Motivo del rifiuto, scritto dall'admin e mostrato solo a chi ha fatto la segnalazione
alter table public.stalli add column if not exists motivo_rifiuto text;

-- 2) La vista dell'admin va ricreata perché veda la nuova colonna
drop view if exists public.stalli_con_conferme;
create view public.stalli_con_conferme with (security_invoker = true) as
select s.*,
  (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'esiste') as conferme_esiste,
  (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'non_esiste') as conferme_non_esiste,
  (select max(c.created_at) from public.conferme c where c.stallo_id = s.id) as ultima_conferma
from public.stalli s;
grant select on public.stalli_con_conferme to anon, authenticated;

-- 3) Le segnalazioni fatte da uno o più telefoni, comprese quelle rifiutate (che il pubblico non vede).
--    Il codice del telefono è casuale e lo conosce solo l'app che lo ha creato: chi lo presenta vede le proprie.
create or replace function public.mie_segnalazioni(p_device text[])
returns table (id uuid, lat double precision, lon double precision, indirizzo text, comune text, posti integer,
               stato text, motivo_rifiuto text, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.lat, s.lon, s.indirizzo, s.comune, s.posti, s.stato, s.motivo_rifiuto, s.created_at, s.updated_at
  from public.stalli s
  where s.fonte = 'utente' and coalesce(array_length(p_device, 1), 0) between 1 and 20 and s.device_id = any(p_device)
  order by s.created_at desc limit 200
$$;
revoke all on function public.mie_segnalazioni(text[]) from public;
grant execute on function public.mie_segnalazioni(text[]) to anon, authenticated;

commit;
