-- 25 · Tester Android: chi usa davvero l'app Android durante il test chiuso di Google Play (solo admin).
-- Conta telefoni (device_id anonimi), mai persone: nessun dato personale. Esclude i dispositivi interni (Andrea, Giulia: eventi.interno).
-- Rieseguibile. Da eseguire nell'editor SQL di Supabase.
--
-- tester_android_admin(p_dal date) -> jsonb con:
--   giorni:   [{g, dispositivi, eventi}]  telefoni Android diversi e eventi per giorno, dal p_dal a oggi
--   totale:   telefoni Android diversi dal p_dal
--   attivi7:  telefoni Android diversi negli ultimi 7 giorni
--   ricorrenti: telefoni usati in almeno 3 giorni diversi
--   versioni: [{v, dispositivi}]  ultima versione vista per telefono
--   azioni:   [{tipo, n}]  eventi per tipo (ricerche, navigazioni, schede…)

create or replace function public.tester_android_admin(p_dal date default date '2026-11-27')
returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_t0 timestamptz := p_dal::timestamp at time zone 'Europe/Rome';
  v_r jsonb;
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  with e as (
    select device_id, creato, tipo, versione, (creato at time zone 'Europe/Rome')::date as g
    from public.eventi
    where piattaforma = 'android' and creato >= v_t0 and not coalesce(interno, false)
  ),
  per_giorno as (
    select g, count(distinct device_id) as dispositivi, count(*) as eventi from e group by g
  ),
  per_dev as (
    select device_id, count(distinct g) as giorni, (array_agg(versione order by creato desc))[1] as versione from e group by device_id
  )
  select jsonb_build_object(
    'dal', p_dal,
    'giorni', coalesce((select jsonb_agg(jsonb_build_object('g', g, 'dispositivi', dispositivi, 'eventi', eventi) order by g) from per_giorno), '[]'),
    'totale', (select count(*) from per_dev),
    'attivi7', (select count(distinct device_id) from e where creato >= now() - interval '7 days'),
    'ricorrenti', (select count(*) from per_dev where giorni >= 3),
    'versioni', coalesce((select jsonb_agg(jsonb_build_object('v', coalesce(versione, '?'), 'dispositivi', n) order by n desc)
                          from (select versione, count(*) as n from per_dev group by versione) x), '[]'),
    'azioni', coalesce((select jsonb_agg(jsonb_build_object('tipo', tipo, 'n', n) order by n desc)
                        from (select tipo, count(*) as n from e where tipo not in ('avvio', 'attivo') group by tipo) y), '[]')
  ) into v_r;
  return v_r;
end $$;
revoke all on function public.tester_android_admin(date) from public, anon;
grant execute on function public.tester_android_admin(date) to authenticated;
