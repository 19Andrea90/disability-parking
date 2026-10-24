-- Aggiornamento 04: etichette precise per l'addestramento del rilevatore
-- Per ogni stallo noto l'admin clicca sull'ortofoto la posizione esatta di ogni posto riservato visibile (o lo segna "non visibile").
create table if not exists public.etichette (
  id uuid primary key default gen_random_uuid(),
  ref_id text not null unique,          -- id dello stallo (o del candidato) attorno a cui è stata fatta l'etichetta
  centro_lat double precision not null, -- centro del ritaglio mostrato
  centro_lon double precision not null,
  crop_m real not null default 40,      -- lato del ritaglio in metri
  esito text not null check (esito in ('stalli','non_visibile')),
  punti jsonb not null default '[]',    -- [[lat, lon], ...] centri dei posti riservati visibili
  created_at timestamptz not null default now()
);
alter table public.etichette enable row level security;
drop policy if exists etichette_admin on public.etichette;
create policy etichette_admin on public.etichette for all using (public.is_admin()) with check (public.is_admin());
