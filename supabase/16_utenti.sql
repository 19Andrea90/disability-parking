-- 16 · Gestione utenti (pannello admin) ed eliminazione dell'account dall'app (20 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni.
--
-- Gli account sono quelli di Supabase Auth (email e password, Google). Stalli, conferme ed eventi sono legati al codice
-- casuale del telefono (device_id), NON all'account: eliminando un account non si tocca nulla di tutto questo
-- (le segnalazioni già fatte restano in mappa, anonime). Si cancellano solo l'account, l'email e i dati salvati
-- nell'account (user_metadata: posti salvati, luoghi, scadenza del contrassegno).
begin;

-- 1) Il cruscotto conta le eliminazioni dall'app con un evento 'account_eliminato' (lo manda l'app dopo l'eliminazione).
--    Il vincolo sui tipi riparte dall'elenco della 14 e aggiunge solo il tipo nuovo: tutti quelli già ammessi restano.
alter table public.eventi drop constraint if exists eventi_tipo_check;
alter table public.eventi add constraint eventi_tipo_check check (tipo in ('avvio','attivo','destinazione','naviga','scheda','streetview',
  'condividi','salva','conferma','segnala','accesso','registrazione','suggerimento','errore','recensione','consiglia','regole','stat_off',
  'parcheggiato','occupato','account_eliminato'));

-- 2) Elenco degli account, solo per gli admin (legge auth.users, che dall'esterno non è raggiungibile)
create or replace function public.utenti_admin()
returns table (id uuid, email text, provider text, created_at timestamptz, last_sign_in_at timestamptz, email_confirmed_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  return query
    select u.id, u.email::text, (u.raw_app_meta_data ->> 'provider')::text, u.created_at, u.last_sign_in_at, u.email_confirmed_at
    from auth.users u
    order by u.created_at desc;
end $$;
revoke all on function public.utenti_admin() from public, anon;
grant execute on function public.utenti_admin() to authenticated;

-- 3) Eliminazione di un account da parte di un admin: mai un altro admin e mai se stessi
create or replace function public.elimina_utente_admin(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  if p_id = auth.uid() then raise exception 'non puoi eliminare il tuo stesso account'; end if;
  select u.email into v_email from auth.users u where u.id = p_id;
  if not found then raise exception 'utente non trovato'; end if;
  if exists (select 1 from public.admins a where lower(a.email) = lower(coalesce(v_email, ''))) then
    raise exception 'non si può eliminare un account amministratore';
  end if;
  delete from auth.users where id = p_id; -- sessioni, identità e token collegati si cancellano a cascata
end $$;
revoke all on function public.elimina_utente_admin(uuid) from public, anon;
grant execute on function public.elimina_utente_admin(uuid) to authenticated;

-- 4) "Elimina account" dall'app: ognuno elimina solo il proprio (serve un accesso valido: con la sola chiave pubblica auth.uid() è nullo)
create or replace function public.elimina_mio_account()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'non hai fatto l''accesso'; end if;
  if public.is_admin() then raise exception 'un account amministratore non si elimina da qui'; end if; -- per sicurezza
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.elimina_mio_account() from public, anon;
grant execute on function public.elimina_mio_account() to authenticated;

commit;

-- Controllo (facoltativo): devono comparire le tre funzioni, eseguibili solo da "authenticated"
select p.proname as funzione, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('utenti_admin', 'elimina_utente_admin', 'elimina_mio_account') order by 1;
