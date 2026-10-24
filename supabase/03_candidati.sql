-- Aggiornamento 03: candidati rilevati automaticamente (Mapillary, ortofoto) da verificare in admin
alter table public.stalli drop constraint if exists stalli_fonte_check;
alter table public.stalli add constraint stalli_fonte_check check (fonte in ('osm','utente','opendata','admin','mapillary','satellite'));

create table if not exists public.candidati (
  id uuid primary key default gen_random_uuid(),
  fonte text not null check (fonte in ('mapillary','satellite')),
  ext_id text unique,                 -- id del rilevamento nella fonte (es. id map feature Mapillary)
  classe text,                        -- es. information--disabled-persons--g1
  lat double precision not null,
  lon double precision not null,
  comune text,
  image_id text,                      -- immagine Mapillary di riferimento
  first_seen timestamptz,
  last_seen timestamptz,
  stato text not null default 'nuovo' check (stato in ('nuovo','accettato','scartato')),
  stallo_id uuid references public.stalli(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists candidati_stato_idx on public.candidati (stato, created_at desc);

alter table public.candidati enable row level security;
drop policy if exists candidati_admin on public.candidati;
create policy candidati_admin on public.candidati for all using (public.is_admin()) with check (public.is_admin());

-- candidati vicini a uno stallo già esistente (per non riproporre ciò che c'è già)
create or replace function public.stalli_entro(p_lat double precision, p_lon double precision, p_m integer default 25)
returns setof public.stalli language sql stable as $$
  select * from public.stalli
  where stato <> 'rifiutato'
    and st_dwithin(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_m)
$$;
