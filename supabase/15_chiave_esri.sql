-- 15 · Chiave per la vista satellitare (immagini Esri) letta da app_config (novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase, dopo la 11. Si può rieseguire senza danni. Solo aggiunte.
-- L'app legge la chiave da qui (campo "chiave_esri"), così si può rinnovare senza pubblicare una nuova versione.
-- Se il campo è null o manca, la vista satellitare non compare. La chiave NON è in questo file: va inserita a mano
-- (la chiave Esri ha il solo permesso "Basemap Styles service" ed è limitata per sito: va comunque tenuta fuori dal codice):
--   insert into public.app_config_valori (chiave, valore) values ('chiave_esri', to_jsonb('INCOLLA-QUI-LA-CHIAVE'::text))
--     on conflict (chiave) do update set valore = excluded.valore;
-- Per toglierla (la vista satellitare sparisce dall'app):
--   update public.app_config_valori set valore = 'null'::jsonb where chiave = 'chiave_esri';
begin;

-- 1) Il valore parte vuoto (null) se non c'è già: un eventuale valore inserito a mano non viene toccato.
insert into public.app_config_valori (chiave, valore) values ('chiave_esri', 'null'::jsonb)
  on conflict (chiave) do nothing;

-- 2) app_config() (stessa funzione della 11) con un campo in più
create or replace function public.app_config()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'versione_minima_android', coalesce((select valore from public.app_config_valori where chiave = 'versione_minima_android'), '"0"'::jsonb),
    'messaggio', coalesce((select valore from public.app_config_valori where chiave = 'messaggio'), 'null'::jsonb),
    'chiave_esri', coalesce((select valore from public.app_config_valori where chiave = 'chiave_esri'), 'null'::jsonb))
$$;
revoke all on function public.app_config() from public;
grant execute on function public.app_config() to anon, authenticated;

commit;

-- Controllo dopo l'esecuzione (non cambia nulla; la chiave comparirà in chiaro nel risultato, non incollarlo in giro):
--   select public.app_config() - 'chiave_esri';
