-- 14 · Esiti dell'arrivo: «parcheggiato» e «occupato» come tipi di evento propri (novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase, dopo la 12. Si può rieseguire senza danni.
-- Non c'è bisogno di una colonna in più: il posto (l'id dello stallo, oppure 'altrove') sta già in "dettaglio".
-- L'app, finché questa query non è stata eseguita, manda gli stessi esiti come tipo 'conferma' con dettaglio
-- 'parcheggiato:<id>' / 'occupato:<id>' (il database rifiuta il tipo nuovo e l'app ripiega da sola): quelli vecchi restano
-- in tabella, non toccano il cruscotto (che conta le conferme dalla tabella "conferme", non da "eventi") e si possono
-- ricondurre ai tipi nuovi con la parte 3 qui sotto.
begin;

-- 1) Eventi: due tipi nuovi (tutti gli altri restano come nella 10)
alter table public.eventi drop constraint if exists eventi_tipo_check;
alter table public.eventi add constraint eventi_tipo_check check (tipo in ('avvio','attivo','destinazione','naviga','scheda','streetview',
  'condividi','salva','conferma','segnala','accesso','registrazione','suggerimento','errore','recensione','consiglia','regole','stat_off',
  'parcheggiato','occupato'));

-- 2) Cruscotto (stessa funzione della 10, con due numeri in più: parcheggiati e trovati occupati negli ultimi 7 giorni)
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
    'parcheggiati_7g', (select count(*) from e where tipo = 'parcheggiato' and creato > now() - interval '7 days'),
    'occupati_7g', (select count(*) from e where tipo = 'occupato' and creato > now() - interval '7 days'),
    'registrati_24h', (select count(*) from auth.users where created_at > now() - interval '24 hours'),
    'registrati_totali', (select count(*) from auth.users),
    'segnalazioni_24h', (select count(*) from public.stalli where fonte = 'utente' and created_at > now() - interval '24 hours'),
    'segnalazioni_da_vedere', (select count(*) from public.stalli where fonte = 'utente' and stato = 'proposto'),
    'conferme_24h', (select count(*) from public.conferme where created_at > now() - interval '24 hours'),
    'non_esiste_7g', (select count(*) from public.conferme where esito = 'non_esiste' and created_at > now() - interval '7 days'),
    'suggerimenti_nuovi', (select count(*) from public.suggerimenti where stato = 'nuovo'),
    'errori_24h', (select count(*) from e where tipo = 'errore' and creato > now() - interval '24 hours'),
    'errori_telefoni_24h', (select count(distinct device_id) from e where tipo = 'errore' and creato > now() - interval '24 hours'),
    'recensioni_7g', (select count(*) from e where tipo = 'recensione' and creato > now() - interval '7 days'),
    'consigli_7g', (select count(*) from e where tipo = 'consiglia' and creato > now() - interval '7 days'),
    'stat_off_7g', (select count(distinct device_id) from e where tipo = 'stat_off' and creato > now() - interval '7 days'),
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

-- 3) Facoltativo: i pochi esiti arrivati nel formato di ripiego diventano eventi veri (idempotente: dopo la prima volta non trova più nulla)
update public.eventi
   set tipo = split_part(dettaglio, ':', 1), dettaglio = nullif(substr(dettaglio, position(':' in dettaglio) + 1), '')
 where tipo = 'conferma' and dettaglio ~ '^(parcheggiato|occupato):';

commit;
