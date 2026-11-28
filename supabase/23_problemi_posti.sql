-- 23 · «C'è un problema con questo posto?» (21 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni. NON cancella né modifica dati esistenti.
--
-- Cosa fa:
--  1) Crea public.problemi_posti: le segnalazioni che chi usa l'app fa sulla scheda di un posto già in mappa
--     (non c'è più / è in un altro punto / è riservato a una sola targa / indirizzo o posti sbagliati / altro).
--     Con «è in un altro punto» l'app manda anche la posizione proposta (lat/lon).
--  2) Sicurezza (RLS): nessuno legge la tabella dal pubblico e nessuno la scrive direttamente. L'inserimento passa solo da
--     public.segnala_problema(...), funzione "security definer" che controlla i dati e i limiti. Lettura e modifica: solo admin (public.is_admin()).
--  3) Limiti della funzione, per codice del telefono (device_id): al massimo 10 segnalazioni al giorno e una sola per posto al giorno
--     (il giorno è quello di Roma). La funzione non dà errori HTTP per i limiti: risponde {"ok":false,"errore":"limite"|"gia_segnalato"|...}.
--     Funziona anche senza account: se c'è l'accesso l'app manda il token e la riga ricorda l'utente (user_id), altrimenti user_id resta vuoto.
--  4) Il pannello admin (Da controllare › Problemi segnalati) legge la tabella con il token dell'admin e la aggiorna (stato, risolto_il, nota_admin).
--
-- Finché questo file non è stato eseguito: l'app risponde «Non riusciamo a inviare ora, riprova più tardi» e il pannello admin mostra il
-- contatore "–" e il promemoria di eseguire il file, senza rompersi.
begin;

-- 1) Tabella
create table if not exists public.problemi_posti (
  id          uuid primary key default gen_random_uuid(),
  stallo_id   uuid not null references public.stalli(id) on delete cascade,
  tipo        text not null check (tipo in ('non_esiste','spostato','targa','dati_errati','altro')),
  note        text check (note is null or char_length(note) <= 500),
  lat         double precision check (lat is null or lat between -90 and 90),    -- posizione proposta (solo per tipo 'spostato')
  lon         double precision check (lon is null or lon between -180 and 180),
  device_id   text not null,
  user_id     uuid,                                                              -- chi ha fatto l'accesso (auth.uid()), se c'era
  creato      timestamptz not null default now(),
  stato       text not null default 'aperto' check (stato in ('aperto','risolto','scartato')),
  risolto_il  timestamptz,
  nota_admin  text
);
create index if not exists problemi_posti_stato_idx  on public.problemi_posti (stato, creato desc);
create index if not exists problemi_posti_stallo_idx on public.problemi_posti (stallo_id);
create index if not exists problemi_posti_device_idx on public.problemi_posti (device_id, creato desc);

-- 2) RLS: niente accesso diretto dal pubblico; admin legge e aggiorna
alter table public.problemi_posti enable row level security;
drop policy if exists problemi_posti_read_admin   on public.problemi_posti;
drop policy if exists problemi_posti_update_admin on public.problemi_posti;
create policy problemi_posti_read_admin   on public.problemi_posti for select using (public.is_admin());
create policy problemi_posti_update_admin on public.problemi_posti for update using (public.is_admin()) with check (public.is_admin());
revoke all on public.problemi_posti from anon, authenticated;
grant select, update on public.problemi_posti to authenticated;   -- le policy lasciano passare solo gli admin

-- 3) Funzione di invio (l'unico modo di scrivere nella tabella)
create or replace function public.segnala_problema(
  p_stallo uuid, p_tipo text, p_note text default null,
  p_lat double precision default null, p_lon double precision default null, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inizio timestamptz := date_trunc('day', now() at time zone 'Europe/Rome') at time zone 'Europe/Rome';  -- mezzanotte di Roma
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_s      record;
  v_m      double precision;
begin
  if p_tipo is null or p_tipo not in ('non_esiste','spostato','targa','dati_errati','altro') then return jsonb_build_object('ok', false, 'errore', 'tipo'); end if;
  if p_device is null or char_length(p_device) not between 8 and 80 then return jsonb_build_object('ok', false, 'errore', 'dispositivo'); end if;
  select lat, lon into v_s from public.stalli where id = p_stallo and stato in ('proposto','verificato','ufficiale');
  if not found then return jsonb_build_object('ok', false, 'errore', 'posto'); end if;
  -- posizione proposta: solo con "è in un altro punto", entro 500 m dal punto in mappa (distanza approssimata, senza PostGIS)
  if p_tipo = 'spostato' and p_lat is not null and p_lon is not null then
    if p_lat not between -90 and 90 or p_lon not between -180 and 180 then return jsonb_build_object('ok', false, 'errore', 'posizione'); end if;
    v_m := 111320 * sqrt(power(p_lat - v_s.lat, 2) + power((p_lon - v_s.lon) * cos(radians(v_s.lat)), 2));
    if v_m > 500 then return jsonb_build_object('ok', false, 'errore', 'lontano'); end if;
  else
    p_lat := null; p_lon := null;
  end if;
  -- limiti: 10 al giorno per telefono, una per posto al giorno
  if (select count(*) from public.problemi_posti where device_id = p_device and creato >= v_inizio) >= 10 then return jsonb_build_object('ok', false, 'errore', 'limite'); end if;
  if exists (select 1 from public.problemi_posti where device_id = p_device and stallo_id = p_stallo and creato >= v_inizio) then return jsonb_build_object('ok', false, 'errore', 'gia_segnalato'); end if;
  insert into public.problemi_posti (stallo_id, tipo, note, lat, lon, device_id, user_id)
  values (p_stallo, p_tipo, v_note, p_lat, p_lon, p_device, auth.uid());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.segnala_problema(uuid, text, text, double precision, double precision, text) from public;
grant execute on function public.segnala_problema(uuid, text, text, double precision, double precision, text) to anon, authenticated;

commit;

-- Controllo (da lanciare a mano dopo): deve rispondere {"ok": false, "errore": "posto"} (il posto finto non esiste) e nessuna riga nuova.
--   select public.segnala_problema('00000000-0000-0000-0000-000000000000', 'altro', null, null, null, 'd-prova-00000');
-- E dal pubblico la tabella non si legge: con la chiave anon, GET /rest/v1/problemi_posti deve dare 401/permission denied.
