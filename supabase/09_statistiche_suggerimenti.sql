-- 09 · Statistiche d'uso anonime e suggerimenti degli utenti (18 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni.
begin;

-- 1) Eventi d'uso dell'app. Nessun dato personale: solo il codice casuale del telefono (lo stesso già usato per
--    "Le mie segnalazioni"), il tipo di azione, la piattaforma, la versione e al massimo il nome del comune.
--    Niente coordinate, niente email, niente indirizzi IP salvati.
create table if not exists public.eventi (
  id bigserial primary key,
  creato timestamptz not null default now(),
  device_id text not null check (char_length(device_id) between 3 and 60),
  tipo text not null check (tipo in ('avvio','attivo','destinazione','naviga','scheda','streetview','condividi','salva',
                                     'conferma','segnala','accesso','registrazione','suggerimento')),
  piattaforma text check (piattaforma in ('android','ios','web','pc')),
  versione text check (char_length(versione) <= 40),
  comune text check (char_length(comune) <= 80),
  dettaglio text check (char_length(dettaglio) <= 80)
);
create index if not exists eventi_creato on public.eventi (creato);
create index if not exists eventi_tipo_creato on public.eventi (tipo, creato);
create index if not exists eventi_device on public.eventi (device_id, creato);
alter table public.eventi enable row level security;
drop policy if exists eventi_inserisci on public.eventi;
create policy eventi_inserisci on public.eventi for insert to anon, authenticated with check (creato > now() - interval '1 minute');
drop policy if exists eventi_admin on public.eventi;
create policy eventi_admin on public.eventi for select using (public.is_admin());
grant insert on public.eventi to anon, authenticated;
grant usage on sequence public.eventi_id_seq to anon, authenticated;

-- 2) Suggerimenti scritti dagli utenti dal profilo dell'app
create table if not exists public.suggerimenti (
  id bigserial primary key,
  creato timestamptz not null default now(),
  device_id text check (char_length(device_id) <= 60),
  categoria text not null default 'idea' check (categoria in ('manca','errore','idea','altro')),
  testo text not null check (char_length(testo) between 3 and 2000),
  email text check (char_length(email) <= 200),
  piattaforma text check (char_length(piattaforma) <= 20),
  versione text check (char_length(versione) <= 40),
  stato text not null default 'nuovo' check (stato in ('nuovo','letto','fatto','scartato')),
  nota text
);
create index if not exists suggerimenti_creato on public.suggerimenti (creato desc);
alter table public.suggerimenti enable row level security;
drop policy if exists sugg_inserisci on public.suggerimenti;
create policy sugg_inserisci on public.suggerimenti for insert to anon, authenticated with check (stato = 'nuovo' and nota is null);
drop policy if exists sugg_admin_leggi on public.suggerimenti;
create policy sugg_admin_leggi on public.suggerimenti for select using (public.is_admin());
drop policy if exists sugg_admin_modifica on public.suggerimenti;
create policy sugg_admin_modifica on public.suggerimenti for update using (public.is_admin()) with check (true);
grant insert on public.suggerimenti to anon, authenticated;
grant select, update on public.suggerimenti to authenticated;
grant usage on sequence public.suggerimenti_id_seq to anon, authenticated;

-- 3) Cruscotto per il pannello admin: tutti i numeri in una chiamata. Solo per gli admin.
create or replace function public.statistiche_admin()
returns jsonb language plpgsql stable security definer set search_path = public, auth as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  with
  e as (select * from public.eventi where creato > now() - interval '35 days'),
  primo as (select device_id, min(creato) as primo from public.eventi group by device_id),
  giorni as (select generate_series((now() at time zone 'Europe/Rome')::date - 29, (now() at time zone 'Europe/Rome')::date, '1 day')::date as g)
  select jsonb_build_object(
    'agg', now(),
    'online', (select count(distinct device_id) from e where creato > now() - interval '5 minutes'),
    'attivi_24h', (select count(distinct device_id) from e where creato > now() - interval '24 hours'),
    'attivi_7g', (select count(distinct device_id) from e where creato > now() - interval '7 days'),
    'attivi_30g', (select count(distinct device_id) from e where creato > now() - interval '30 days'),
    'nuovi_24h', (select count(*) from primo where primo > now() - interval '24 hours'),
    'nuovi_7g', (select count(*) from primo where primo > now() - interval '7 days'),
    'telefoni_totali', (select count(*) from primo),
    'navigazioni_24h', (select count(*) from e where tipo = 'naviga' and creato > now() - interval '24 hours'),
    'navigatori_24h', (select count(distinct device_id) from e where tipo = 'naviga' and creato > now() - interval '24 hours'),
    'navigatori_7g', (select count(distinct device_id) from e where tipo = 'naviga' and creato > now() - interval '7 days'),
    'destinazioni_24h', (select count(*) from e where tipo = 'destinazione' and creato > now() - interval '24 hours'),
    'senza_posti_24h', (select count(*) from e where tipo = 'destinazione' and dettaglio = 'senza_posti' and creato > now() - interval '24 hours'),
    'schede_24h', (select count(*) from e where tipo = 'scheda' and creato > now() - interval '24 hours'),
    'schede_7g_utenti', (select count(distinct device_id) from e where tipo in ('scheda','destinazione') and creato > now() - interval '7 days'),
    'streetview_7g', (select count(*) from e where tipo = 'streetview' and creato > now() - interval '7 days'),
    'condivisioni_7g', (select count(*) from e where tipo = 'condividi' and creato > now() - interval '7 days'),
    'salvati_7g', (select count(*) from e where tipo = 'salva' and creato > now() - interval '7 days'),
    'registrati_24h', (select count(*) from auth.users where created_at > now() - interval '24 hours'),
    'registrati_totali', (select count(*) from auth.users),
    'segnalazioni_24h', (select count(*) from public.stalli where fonte = 'utente' and created_at > now() - interval '24 hours'),
    'segnalazioni_da_vedere', (select count(*) from public.stalli where fonte = 'utente' and stato = 'proposto'),
    'conferme_24h', (select count(*) from public.conferme where created_at > now() - interval '24 hours'),
    'non_esiste_7g', (select count(*) from public.conferme where esito = 'non_esiste' and created_at > now() - interval '7 days'),
    'suggerimenti_nuovi', (select count(*) from public.suggerimenti where stato = 'nuovo'),
    -- tornano: dei telefoni arrivati tra 14 e 7 giorni fa, quanti hanno riaperto l'app negli ultimi 7 giorni
    'ritorno_base', (select count(*) from primo where primo between now() - interval '14 days' and now() - interval '7 days'),
    'ritorno_tornati', (select count(*) from primo p where p.primo between now() - interval '14 days' and now() - interval '7 days'
                          and exists (select 1 from e where e.device_id = p.device_id and e.creato > now() - interval '7 days')),
    'piattaforme_30g', (select coalesce(jsonb_object_agg(k, n), '{}') from (select coalesce(piattaforma, '?') k, count(distinct device_id) n from e where creato > now() - interval '30 days' group by 1) x),
    'versioni_7g', (select coalesce(jsonb_agg(jsonb_build_object('v', v, 'n', n) order by n desc), '[]') from (select coalesce(versione, '?') v, count(distinct device_id) n from e where creato > now() - interval '7 days' group by 1 order by 2 desc limit 6) x),
    'comuni_naviga_30g', (select coalesce(jsonb_agg(jsonb_build_object('c', c, 'n', n) order by n desc), '[]') from (select comune c, count(*) n from e where tipo = 'naviga' and comune is not null and creato > now() - interval '30 days' group by 1 order by 2 desc limit 10) x),
    'comuni_vuoti_30g', (select coalesce(jsonb_agg(jsonb_build_object('c', c, 'n', n) order by n desc), '[]') from (select comune c, count(*) n from e where tipo = 'destinazione' and dettaglio = 'senza_posti' and comune is not null and creato > now() - interval '30 days' group by 1 order by 2 desc limit 10) x),
    'ore_7g', (select coalesce(jsonb_agg(n order by h), '[]') from (select h, (select count(*) from e where creato > now() - interval '7 days' and tipo in ('avvio','attivo') and extract(hour from creato at time zone 'Europe/Rome') = h) n from generate_series(0, 23) h) x),
    'serie', (select jsonb_agg(jsonb_build_object('g', g.g,
                 'attivi', (select count(distinct device_id) from e where (creato at time zone 'Europe/Rome')::date = g.g),
                 'nuovi', (select count(*) from primo where (primo at time zone 'Europe/Rome')::date = g.g),
                 'naviga', (select count(*) from e where tipo = 'naviga' and (creato at time zone 'Europe/Rome')::date = g.g),
                 'registrati', (select count(*) from auth.users where (created_at at time zone 'Europe/Rome')::date = g.g)) order by g.g) from giorni g)
  ) into r;
  return r;
end $$;
revoke all on function public.statistiche_admin() from public, anon;
grant execute on function public.statistiche_admin() to authenticated;

commit;
