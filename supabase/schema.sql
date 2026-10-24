-- Disability Parking — schema v1
-- Da incollare nel SQL Editor di Supabase ed eseguire una sola volta.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------- STALLI ----------
create table if not exists public.stalli (
  id uuid primary key default gen_random_uuid(),
  osm_id text unique,                          -- es. node/123456 (solo per dati importati da OSM)
  lat double precision not null,
  lon double precision not null,
  geom geography(point, 4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)::geography) stored,
  tipo text not null default 'sconosciuto' check (tipo in ('generico','personalizzato','sconosciuto')),
  posti integer not null default 1 check (posti >= 1),
  nome text,
  indirizzo text,
  comune text,
  note text,
  orari text,                                  -- es. "libero per tutti 20:00-08:00"
  segnale_verticale boolean,
  coperto boolean default false,
  foto_url text,
  stato text not null default 'proposto' check (stato in ('proposto','verificato','ufficiale','rifiutato','rimosso')),
  fonte text not null default 'utente' check (fonte in ('osm','utente','opendata','admin')),
  osm_url text,
  device_id text,                              -- chi lo ha proposto (id anonimo del telefono)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stalli_geom_idx on public.stalli using gist (geom);
create index if not exists stalli_stato_idx on public.stalli (stato);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists stalli_touch on public.stalli;
create trigger stalli_touch before update on public.stalli for each row execute function public.touch_updated_at();

-- ---------- CONFERME (verifiche sul posto) ----------
create table if not exists public.conferme (
  id uuid primary key default gen_random_uuid(),
  stallo_id uuid not null references public.stalli(id) on delete cascade,
  esito text not null check (esito in ('esiste','non_esiste','occupato','libero')),
  note text,
  foto_url text,
  device_id text,
  created_at timestamptz not null default now()
);
create index if not exists conferme_stallo_idx on public.conferme (stallo_id, created_at desc);

-- ---------- ADMIN ----------
create table if not exists public.admins (
  email text primary key
);
-- Metti qui la tua email di login (quella con cui ti registrerai nell'app admin)
insert into public.admins (email) values ('andrea.cumin@mela.work') on conflict do nothing;

create or replace function public.is_admin() returns boolean language sql stable security definer as $$
  select exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email'))
$$;

-- ---------- RICERCA GEOGRAFICA ----------
create or replace function public.stalli_vicini(p_lat double precision, p_lon double precision, p_raggio_m integer default 400)
returns table (
  id uuid, lat double precision, lon double precision, tipo text, posti integer, nome text, indirizzo text, comune text,
  note text, orari text, segnale_verticale boolean, coperto boolean, foto_url text, stato text, fonte text, osm_url text,
  distanza_m double precision
) language sql stable as $$
  select s.id, s.lat, s.lon, s.tipo, s.posti, s.nome, s.indirizzo, s.comune, s.note, s.orari, s.segnale_verticale,
         s.coperto, s.foto_url, s.stato, s.fonte, s.osm_url,
         st_distance(s.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography) as distanza_m
  from public.stalli s
  where s.stato in ('proposto','verificato','ufficiale')
    and st_dwithin(s.geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_raggio_m)
  order by distanza_m
$$;

-- stalli dentro un rettangolo (per la mappa)
create or replace function public.stalli_in_bbox(s double precision, w double precision, n double precision, e double precision)
returns setof public.stalli language sql stable as $$
  select * from public.stalli
  where stato in ('proposto','verificato','ufficiale')
    and lat between s and n and lon between w and e
  limit 3000
$$;

-- ---------- SICUREZZA (RLS) ----------
alter table public.stalli enable row level security;
alter table public.conferme enable row level security;
alter table public.admins enable row level security;

-- tutti leggono gli stalli pubblicati
drop policy if exists stalli_read on public.stalli;
create policy stalli_read on public.stalli for select
  using (stato in ('proposto','verificato','ufficiale') or public.is_admin());

-- chiunque può proporre uno stallo (entra come "proposto", fonte "utente")
drop policy if exists stalli_propose on public.stalli;
create policy stalli_propose on public.stalli for insert
  with check (stato = 'proposto' and fonte = 'utente');

-- solo admin modifica/elimina
drop policy if exists stalli_admin_update on public.stalli;
create policy stalli_admin_update on public.stalli for update using (public.is_admin()) with check (true);
drop policy if exists stalli_admin_delete on public.stalli;
create policy stalli_admin_delete on public.stalli for delete using (public.is_admin());

-- conferme: tutti inseriscono e leggono
drop policy if exists conferme_read on public.conferme;
create policy conferme_read on public.conferme for select using (true);
drop policy if exists conferme_insert on public.conferme;
create policy conferme_insert on public.conferme for insert with check (true);

drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins for select using (public.is_admin());

-- ---------- FOTO ----------
insert into storage.buckets (id, name, public) values ('foto', 'foto', true) on conflict (id) do nothing;
drop policy if exists foto_read on storage.objects;
create policy foto_read on storage.objects for select using (bucket_id = 'foto');
drop policy if exists foto_upload on storage.objects;
create policy foto_upload on storage.objects for insert with check (bucket_id = 'foto');

-- ---------- VISTA RIEPILOGO PER ADMIN ----------
create or replace view public.stalli_con_conferme as
select s.*,
  (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'esiste') as conferme_esiste,
  (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'non_esiste') as conferme_non_esiste,
  (select max(c.created_at) from public.conferme c where c.stallo_id = s.id) as ultima_conferma
from public.stalli s;
