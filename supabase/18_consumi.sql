-- 18 · Consumi e limiti gratuiti (pannello admin, Dashboard > "Consumi e limiti gratuiti") (20 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni. Non scrive né cancella dati.
--
-- Cosa fa:
--  1) Ammette due tipi di evento in più: 'categoria' (l'app chiede un elenco di luoghi a TomTom Search) e 'satellite' (l'utente accende
--     la vista satellitare, che scarica riquadri da Esri). Servono a stimare quei due consumi. Il vincolo riparte dall'elenco della 16
--     (che comprendeva già quello della 14) e aggiunge solo i due tipi nuovi: tutti quelli già ammessi restano.
--     Finché non esegui questo file, l'app che li manda se li vede rifiutare dal database e li ignora (nessun effetto per gli utenti).
--  2) Crea public.consumi_admin(): una sola chiamata, solo per gli admin, che restituisce i numeri usati dal pannello.
--     Sono "misurati" quelli letti dal database (spazio, utenti attivi) e "stimati" quelli ricavati dagli eventi dell'app
--     (traffico, email, TomTom, Esri). Gli eventi arrivano solo da chi non ha spento le statistiche: le stime sono quindi per difetto.
begin;

-- 1) Tipi di evento
alter table public.eventi drop constraint if exists eventi_tipo_check;
alter table public.eventi add constraint eventi_tipo_check check (tipo in ('avvio','attivo','destinazione','naviga','scheda','streetview',
  'condividi','salva','conferma','segnala','accesso','registrazione','suggerimento','errore','recensione','consiglia','regole','stat_off',
  'parcheggiato','occupato','account_eliminato','categoria','satellite'));

-- 2) Numeri per il pannello. Tutti i giorni si contano nel fuso Europe/Rome.
create or replace function public.consumi_admin()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_oggi date := (now() at time zone 'Europe/Rome')::date;
  v_ini date;            -- primo giorno del periodo Supabase in corso (il 24 più recente)
  v_fine date;           -- primo giorno del periodo dopo (quando i contatori si azzerano)
  v_ini_ts timestamptz;
  v_mese date := date_trunc('month', v_oggi)::date;
  v_mese_ts timestamptz;
  v_oggi_ts timestamptz;
  v_ieri_ts timestamptz;
  r jsonb;
begin
  if not public.is_admin() then raise exception 'solo admin'; end if;
  -- periodo di fatturazione Supabase: dal 24 di un mese al 24 del successivo
  v_ini := case when extract(day from v_oggi) >= 24 then (v_mese + 23) else ((v_mese - interval '1 month')::date + 23) end;
  v_fine := (v_ini + interval '1 month')::date;
  v_ini_ts := v_ini::timestamp at time zone 'Europe/Rome';
  v_mese_ts := v_mese::timestamp at time zone 'Europe/Rome';
  v_oggi_ts := v_oggi::timestamp at time zone 'Europe/Rome';
  v_ieri_ts := (v_oggi - 1)::timestamp at time zone 'Europe/Rome';

  select jsonb_build_object(
    'agg', now(),
    -- misurati
    'db_bytes', pg_database_size(current_database()),
    'storage_bytes', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o),
    'mau_30g', (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '30 days'),
    -- email di iscrizione (stima: un account creato = un'email di conferma)
    'account_oggi', (select count(*) from auth.users u where u.created_at >= v_oggi_ts),
    'account_mese', (select count(*) from auth.users u where u.created_at >= v_mese_ts),
    -- periodo Supabase e traffico (sessione = evento 'avvio': l'app lo manda all'apertura e dopo 30 minuti di pausa)
    'periodo_inizio', v_ini,
    'periodo_fine', v_fine,
    'giorni_periodo_totali', (v_fine - v_ini),
    'giorni_periodo_trascorsi', round((extract(epoch from (now() - v_ini_ts)) / 86400)::numeric, 2),
    'sessioni_periodo', (select count(*) from public.eventi e where e.tipo = 'avvio' and e.creato >= v_ini_ts),
    'sessioni_ieri', (select count(*) from public.eventi e where e.tipo = 'avvio' and e.creato >= v_ieri_ts and e.creato < v_oggi_ts),
    -- mese di calendario (TomTom, email)
    'giorni_mese_totali', ((v_mese + interval '1 month')::date - v_mese),
    'giorni_mese_trascorsi', round((extract(epoch from (now() - v_mese_ts)) / 86400)::numeric, 2),
    'schede_android_mese', (select count(*) from public.eventi e where e.tipo = 'scheda' and e.piattaforma = 'android' and e.creato >= v_mese_ts),
    -- 'categoria' esiste dopo il passo 1: conta solo da quando l'app aggiornata li invia (prima è 0, non "sconosciuto")
    'categorie_android_mese', (select count(*) from public.eventi e where e.tipo = 'categoria' and e.piattaforma = 'android' and e.creato >= v_mese_ts),
    'satellite_mese', (select count(*) from public.eventi e where e.tipo = 'satellite' and e.creato >= v_mese_ts),
    -- utenti e righe
    'telefoni_30g', (select count(distinct e.device_id) from public.eventi e where e.creato > now() - interval '30 days'),
    'eventi_righe', (select count(*) from public.eventi)
  ) into r;
  return r;
end $$;
revoke all on function public.consumi_admin() from public, anon;
grant execute on function public.consumi_admin() to authenticated;

commit;

-- Controllo (facoltativo, sola lettura): la funzione deve essere eseguibile solo da "authenticated"
select has_function_privilege('anon', 'public.consumi_admin()', 'execute') as anon,
       has_function_privilege('authenticated', 'public.consumi_admin()', 'execute') as authenticated;
