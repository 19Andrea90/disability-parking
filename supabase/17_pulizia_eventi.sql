-- 17 · Pulizia notturna degli eventi d'uso (20 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni.
--
-- Perché: la tabella "eventi" (statistiche anonime, 09) cresce a ogni avvio dell'app e il piano gratuito di Supabase ha
-- uno spazio limitato. Gli eventi più vecchi di 90 giorni non servono più al cruscotto: vengono riassunti per giorno,
-- tipo e piattaforma in "eventi_giorno" e poi cancellati. Ogni notte, da solo, con pg_cron.
--
-- Cosa NON si cancella (controllato sulle funzioni del cruscotto, 09/10/14/16):
--  • statistiche_admin() guarda al massimo gli ultimi 35 giorni, TRANNE "primo" (data del primo evento di ogni telefono, su
--    tutta la storia): da lì vengono "telefoni_totali", "nuovi" e "ritorno". Per non alterarli si conserva sempre, per ogni
--    telefono, il suo evento più vecchio (una riga a telefono). Quella riga non entra nel riassunto: resta tra gli eventi.
--  • Il pannello "Zone cercate" (zone_ricerche_admin) può guardare fino a 365 giorni, con le coordinate arrotondate degli
--    eventi 'destinazione': quelli con coordinate si tengono per 400 giorni (parametro p_giorni_zone).
--  • errori_admin() arriva a 90 giorni: coperto. Gli eventi 'account_eliminato' (il pannello Utenti li conta su tutta la
--    storia) non si cancellano mai: sono pochissimi.
--
-- pg_cron: su Supabase va abilitato da Database > Extensions (cerca "pg_cron" e attivalo). Se il "create extension" qui sotto
-- non riesce, lo script va avanti lo stesso (tabella e funzione si creano comunque) e stampa un avviso: abilita l'estensione
-- dal pannello e riesegui questo file, che a quel punto pianifica il lavoro notturno.
begin;

-- 1) Riassunto giornaliero. Nessun accesso pubblico: RLS attiva e nessuna policy (la scrive solo la funzione, che è SECURITY DEFINER).
--    La piattaforma vuota si salva come '?' (come fa già il cruscotto), perché le colonne della chiave primaria non possono essere nulle.
create table if not exists public.eventi_giorno (
  giorno date not null,                 -- giorno nel fuso Europe/Rome
  tipo text not null,
  piattaforma text not null default '?',
  n integer not null check (n >= 0),
  primary key (giorno, tipo, piattaforma)
);
alter table public.eventi_giorno enable row level security;
revoke all on public.eventi_giorno from public, anon, authenticated;

-- 2) La pulizia. Una sola istruzione: cancella, riassume e somma nel riepilogo (upsert), quindi o fa tutto o niente.
--    p_giorni: età oltre la quale gli eventi si riassumono e si cancellano (minimo 35, i giorni che usa il cruscotto).
--    p_giorni_zone: età oltre la quale si cancellano anche le ricerche con coordinate (minimo 365).
--    Restituisce quante righe di "eventi" ha cancellato.
create or replace function public.pulisci_eventi(p_giorni int default 90, p_giorni_zone int default 400)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_g int := greatest(coalesce(p_giorni, 90), 35); v_z int := greatest(coalesce(p_giorni_zone, 400), 365, greatest(coalesce(p_giorni, 90), 35)); v_n bigint;
begin
  with vecchi as (
    delete from public.eventi e
    where e.creato < now() - make_interval(days => v_g)
      and e.tipo <> 'account_eliminato'
      and not (e.tipo = 'destinazione' and e.lat_g is not null and e.creato >= now() - make_interval(days => v_z))
      -- si tiene il primo evento di ogni telefono (serve a statistiche_admin per "nuovi" e "telefoni_totali")
      and exists (select 1 from public.eventi x where x.device_id = e.device_id and (x.creato, x.id) < (e.creato, e.id))
    returning e.creato, e.tipo, e.piattaforma
  ), giorni as (
    select (creato at time zone 'Europe/Rome')::date as giorno, tipo, coalesce(piattaforma, '?') as piattaforma, count(*)::int as n
    from vecchi group by 1, 2, 3
  ), somma as (
    insert into public.eventi_giorno (giorno, tipo, piattaforma, n)
    select giorno, tipo, piattaforma, n from giorni
    on conflict (giorno, tipo, piattaforma) do update set n = public.eventi_giorno.n + excluded.n
    returning 1
  )
  select count(*) into v_n from vecchi;
  return v_n;
end $$;
-- Solo il lavoro pianificato (che gira come "postgres") la esegue: né l'app (anon) né gli utenti con accesso (authenticated).
revoke all on function public.pulisci_eventi(int, int) from public, anon, authenticated;

commit;

-- 3) Pianificazione ogni notte alle 02:10 UTC (03:10 o 04:10 in Italia) con nome fisso: rieseguire il file non crea doppioni.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron non attivabile da qui (%): abilitalo da Database > Extensions e riesegui questo file.', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'pulisci-eventi';
    perform cron.schedule('pulisci-eventi', '10 2 * * *', 'select public.pulisci_eventi()');
    raise notice 'Pulizia notturna pianificata (job "pulisci-eventi", 02:10 UTC).';
  end if;
end $$;

-- Controllo (facoltativo, sola lettura):
--  a) il lavoro pianificato (una riga; vuota se pg_cron non è attivo) e la funzione (anon e authenticated devono dire false)
select j.jobname, j.schedule, j.command, j.active from cron.job j where j.jobname = 'pulisci-eventi';
select has_function_privilege('anon', 'public.pulisci_eventi(int,int)', 'execute') as anon,
       has_function_privilege('authenticated', 'public.pulisci_eventi(int,int)', 'execute') as authenticated;
--  b) quanti eventi sarebbero cancellati ora (senza cancellare nulla) e cosa c'è già nel riassunto
select count(*) as da_cancellare
from public.eventi e
where e.creato < now() - interval '90 days' and e.tipo <> 'account_eliminato'
  and not (e.tipo = 'destinazione' and e.lat_g is not null and e.creato >= now() - interval '400 days')
  and exists (select 1 from public.eventi x where x.device_id = e.device_id and (x.creato, x.id) < (e.creato, e.id));
select count(*) as righe_riassunto, coalesce(sum(n), 0) as eventi_riassunti, min(giorno) as dal, max(giorno) as al from public.eventi_giorno;
