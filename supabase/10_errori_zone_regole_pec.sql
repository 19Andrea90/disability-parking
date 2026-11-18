-- 10 · Errori dell'app, zone senza posti, regole della sosta per comune, PEC ai comuni (18 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase, dopo la 09. Si può rieseguire senza danni.
begin;

-- 1) Eventi: nuovi tipi (errore, recensione, consiglia, regole, stat_off), dettaglio più lungo per i messaggi di errore
--    e posizione della destinazione arrotondata a 0,01° (circa 1 km): serve solo alla mappa delle zone senza posti.
alter table public.eventi drop constraint if exists eventi_tipo_check;
alter table public.eventi add constraint eventi_tipo_check check (tipo in ('avvio','attivo','destinazione','naviga','scheda','streetview',
  'condividi','salva','conferma','segnala','accesso','registrazione','suggerimento','errore','recensione','consiglia','regole','stat_off'));
alter table public.eventi drop constraint if exists eventi_dettaglio_check;
alter table public.eventi add constraint eventi_dettaglio_check check (char_length(dettaglio) <= 300);
alter table public.eventi add column if not exists lat_g numeric(5,2) check (lat_g between 35 and 48);
alter table public.eventi add column if not exists lon_g numeric(5,2) check (lon_g between 6 and 19);

-- 2) Cruscotto (stessa funzione della 09, con errori, recensioni e "consiglia") per il pannello admin: tutti i numeri in una chiamata. Solo per gli admin.
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


-- 3) Errori dell'app, raggruppati per messaggio (ultimi N giorni)
create or replace function public.errori_admin(p_giorni integer default 7)
returns table (messaggio text, volte bigint, telefoni bigint, ultimo timestamptz, piattaforme text, versioni text)
language sql stable security definer set search_path = public as $$
  select dettaglio, count(*), count(distinct device_id), max(creato),
         string_agg(distinct coalesce(piattaforma, '?'), ', '), string_agg(distinct coalesce(versione, '?'), ', ')
  from public.eventi
  where public.is_admin() and tipo = 'errore' and creato > now() - make_interval(days => greatest(1, least(p_giorni, 90)))
  group by dettaglio order by 3 desc, 2 desc limit 50
$$;
revoke all on function public.errori_admin(integer) from public, anon;
grant execute on function public.errori_admin(integer) to authenticated;

-- 4) Zone cercate (celle di circa 1 km) con quante ricerche avevano o non avevano posti attorno
create or replace function public.zone_ricerche_admin(p_giorni integer default 30)
returns table (lat numeric, lon numeric, comune text, ricerche bigint, senza_posti bigint)
language sql stable security definer set search_path = public as $$
  select lat_g, lon_g, mode() within group (order by comune), count(*), count(*) filter (where dettaglio = 'senza_posti')
  from public.eventi
  where public.is_admin() and tipo = 'destinazione' and lat_g is not null and creato > now() - make_interval(days => greatest(1, least(p_giorni, 365)))
  group by lat_g, lon_g order by 5 desc, 4 desc limit 2000
$$;
revoke all on function public.zone_ricerche_admin(integer) from public, anon;
grant execute on function public.zone_ricerche_admin(integer) to authenticated;

-- 5) Regole della sosta per comune (ZTL, note), scritte dall'admin e mostrate nell'app
create table if not exists public.regole_comuni (
  comune text primary key check (char_length(comune) between 2 and 80),
  ztl text check (char_length(ztl) <= 600),
  note text check (char_length(note) <= 1200),
  link text check (char_length(link) <= 400),
  aggiornato timestamptz not null default now()
);
alter table public.regole_comuni enable row level security;
drop policy if exists regole_leggi on public.regole_comuni;
create policy regole_leggi on public.regole_comuni for select using (true);
drop policy if exists regole_admin on public.regole_comuni;
create policy regole_admin on public.regole_comuni for all using (public.is_admin()) with check (public.is_admin());
grant select on public.regole_comuni to anon, authenticated;
grant insert, update, delete on public.regole_comuni to authenticated;

-- 6) PEC di accesso civico ai comuni (prima nel foglio "Accesso civico stalli disabili"): solo admin
create table if not exists public.pec_comuni (
  comune text primary key,
  provincia text, regione text,
  pec text,
  inviata date,
  stato text not null default 'Da inviare' check (stato in ('Da inviare','Inviata','Risposta ricevuta','Dati importati','Rifiutata')),
  protocollo text,
  note text,
  aggiornato timestamptz not null default now()
);
alter table public.pec_comuni enable row level security;
drop policy if exists pec_admin on public.pec_comuni;
create policy pec_admin on public.pec_comuni for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.pec_comuni to authenticated;

-- 7) Stato delle PEC al 18/11/2026 (copiato dal foglio). Se il comune c'è già non viene toccato.
insert into public.pec_comuni (comune, provincia, regione, pec, inviata, stato, protocollo, note) values
  ('Roma', 'RM', 'Lazio', 'protocollo.segretariato@pec.comune.roma.it', '2026-11-16', 'Risposta ricevuta', 'RC/2026/0035536', '16/11: istanza protocollata e inoltrata al Dipartimento Mobilità Sostenibile e Trasporti. In attesa dei dati. Scadenza 30 giorni: 16/12/2026.'),
  ('Milano', 'MI', 'Lombardia', 'protocollo@postacert.comune.milano.it', null, 'Da inviare', null, null),
  ('Napoli', 'NA', 'Campania', 'protocollo@pec.comune.napoli.it', '2026-11-16', 'Inviata', null, 'Scadenza 30 giorni: 16/12/2026.'),
  ('Palermo', 'PA', 'Sicilia', 'protocollo@cert.comune.palermo.it', '2026-11-16', 'Risposta ricevuta', 'AREG/1594561/2026 del 16/11', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 16/12/2026.'),
  ('Genova', 'GE', 'Liguria', 'comunegenova@postemailcertificata.it', null, 'Da inviare', null, null),
  ('Bari', 'BA', 'Puglia', 'archiviogenerale.comunebari@pec.rupar.puglia.it', null, 'Da inviare', null, null),
  ('Catania', 'CT', 'Sicilia', 'comune.catania@pec.it', null, 'Da inviare', null, null),
  ('Venezia', 'VE', 'Veneto', 'protocolloinformatico@pec.comune.venezia.it', null, 'Da inviare', null, null),
  ('Messina', 'ME', 'Sicilia', 'protocollo@pec.comune.messina.it', null, 'Da inviare', null, null),
  ('Padova', 'PD', 'Veneto', 'protocollo.generale@pec.comune.padova.it', null, 'Da inviare', null, null),
  ('Trieste', 'TS', 'Friuli-Venezia Giulia', 'comune.trieste@certgov.fvg.it', null, 'Da inviare', null, null),
  ('Parma', 'PR', 'Emilia-Romagna', 'comunediparma@postemailcertificata.it', null, 'Da inviare', null, null),
  ('Taranto', 'TA', 'Puglia', 'protocollo.comunetaranto@pec.rupar.puglia.it', '2026-11-17', 'Risposta ricevuta', '0275365/2026 del 17/11', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Reggio di Calabria', 'RC', 'Calabria', 'protocollo@pec.reggiocal.it', '2026-11-17', 'Inviata', null, 'Scadenza 30 giorni: 17/12/2026.'),
  ('Perugia', 'PG', 'Umbria', 'comune.perugia@postacert.umbria.it', '2026-11-16', 'Risposta ricevuta', '0281217/2026', '18/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 16/12/2026.'),
  ('Cagliari', 'CA', 'Sardegna', 'protocollogenerale@comune.cagliari.legalmail.it', '2026-11-18', 'Risposta ricevuta', '0338583 del 18/11', '17/11: prima PEC partita con oggetto troncato ("R"), non protocollata. 18/11: reinviata con oggetto completo e istanza in PDF allegata; protocollata. In attesa dei dati. Scadenza 30 giorni: 18/12/2026.'),
  ('Rimini', 'RN', 'Emilia-Romagna', 'protocollo.generale@pec.comune.rimini.it', null, 'Da inviare', null, null),
  ('Salerno', 'SA', 'Campania', 'protocollo@pec.comune.salerno.it', null, 'Da inviare', null, null),
  ('Bergamo', 'BG', 'Lombardia', 'protocollo@cert.comune.bergamo.it', null, 'Da inviare', null, null),
  ('Chieti', 'CH', 'Abruzzo', 'protocollo@pec.comune.chieti.it', null, 'Da inviare', null, null),
  ('L''Aquila', 'AQ', 'Abruzzo', 'protocollo@comune.laquila.postecert.it', null, 'Da inviare', null, null),
  ('Pescara', 'PE', 'Abruzzo', 'protocollo@pec.comune.pescara.it', null, 'Da inviare', null, null),
  ('Teramo', 'TE', 'Abruzzo', 'affarigenerali@comune.teramo.pecpa.it', '2026-11-17', 'Risposta ricevuta', '76752 del 17/11', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Potenza', 'PZ', 'Basilicata', 'protocollo@pec.comune.potenza.it', '2026-11-17', 'Risposta ricevuta', '0100420/2026', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Catanzaro', 'CZ', 'Calabria', 'ufficio.protocollo@certificata.comune.catanzaro.it', '2026-11-17', 'Risposta ricevuta', '126640 del 18/11', '18/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Cosenza', 'CS', 'Calabria', 'protocollo@pec.comune.cosenza.it', '2026-11-17', 'Risposta ricevuta', '140997/2026', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Crotone', 'KR', 'Calabria', 'protocollocomune@pec.comune.crotone.it', '2026-11-17', 'Inviata', null, 'Scadenza 30 giorni: 17/12/2026.'),
  ('Vibo Valentia', 'VV', 'Calabria', 'protocollocomunevibo@pec.it', '2026-11-17', 'Risposta ricevuta', '2026/66804', '18/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Avellino', 'AV', 'Campania', 'ufficioprotocollo@cert.comune.avellino.it', '2026-11-17', 'Risposta ricevuta', '0095795/2026', '18/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Benevento', 'BN', 'Campania', 'protocollogenerale@pec.comunebn.it', null, 'Da inviare', null, null),
  ('Caserta', 'CE', 'Campania', 'postacertificata@pec.comune.caserta.it', '2026-11-17', 'Risposta ricevuta', '127841/2026', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Forlì', 'FC', 'Emilia-Romagna', 'comune.forli@pec.comune.forli.fc.it', null, 'Da inviare', null, null),
  ('Piacenza', 'PC', 'Emilia-Romagna', 'protocollo.generale@cert.comune.piacenza.it', null, 'Da inviare', null, null),
  ('Ravenna', 'RA', 'Emilia-Romagna', 'comune.ravenna@legalmail.it', null, 'Da inviare', null, null),
  ('Reggio nell''Emilia', 'RE', 'Emilia-Romagna', 'comune.reggioemilia@pec.municipio.re.it', null, 'Da inviare', null, null),
  ('Gorizia', 'GO', 'Friuli-Venezia Giulia', 'comune.gorizia@certgov.fvg.it', null, 'Da inviare', null, null),
  ('Pordenone', 'PN', 'Friuli-Venezia Giulia', 'comune.pordenone@certgov.fvg.it', null, 'Da inviare', null, null),
  ('Udine', 'UD', 'Friuli-Venezia Giulia', 'protocollo@pec.comune.udine.it', null, 'Da inviare', null, null),
  ('Frosinone', 'FR', 'Lazio', 'pec@pec.comune.frosinone.it', '2026-11-18', 'Risposta ricevuta', '74931/2026', '18/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 18/12/2026.'),
  ('Latina', 'LT', 'Lazio', 'protocollo@pec.comune.latina.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Rieti', 'RI', 'Lazio', 'protocollo@pec.comune.rieti.it', '2026-11-17', 'Risposta ricevuta', '94385', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Viterbo', 'VT', 'Lazio', 'protocollo@pec.comuneviterbo.it', null, 'Da inviare', null, null),
  ('Imperia', 'IM', 'Liguria', 'protocollo@pec.comune.imperia.it', null, 'Da inviare', null, null),
  ('La Spezia', 'SP', 'Liguria', 'protocollo.comune.laspezia@legalmail.it', null, 'Da inviare', null, null),
  ('Savona', 'SV', 'Liguria', 'posta@pec.comune.savona.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Como', 'CO', 'Lombardia', 'protocollo@comune.pec.como.it', null, 'Da inviare', null, null),
  ('Lecco', 'LC', 'Lombardia', 'comune@pec.comunedilecco.it', null, 'Da inviare', null, null),
  ('Lodi', 'LO', 'Lombardia', 'comunedilodi@legalmail.it', null, 'Da inviare', null, null),
  ('Mantova', 'MN', 'Lombardia', 'comune.mantova.aoo@legalmail.it', null, 'Da inviare', null, null),
  ('Sondrio', 'SO', 'Lombardia', 'protocollo@cert.comune.sondrio.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Varese', 'VA', 'Lombardia', 'protocollo@comune.varese.legalmail.it', null, 'Da inviare', null, null),
  ('Ancona', 'AN', 'Marche', 'comune.ancona@emarche.it', null, 'Da inviare', null, null),
  ('Ascoli Piceno', 'AP', 'Marche', 'comune.ap@pec.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Fermo', 'FM', 'Marche', 'protocollo@pec.comune.fermo.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Macerata', 'MC', 'Marche', 'comune.macerata@legalmail.it', null, 'Da inviare', null, null),
  ('Pesaro', 'PU', 'Marche', 'comune.pesaro@emarche.it', null, 'Da inviare', null, null),
  ('Campobasso', 'CB', 'Molise', 'comune.campobasso.protocollo@pec.it', '2026-11-16', 'Dati importati', '84892 del 17/11', '17/11: risposta con mappa Google My Maps. Importati 158 stalli (120 generici, 38 personalizzati) come dati ufficiali. Ringraziamento inviato il 17/11.'),
  ('Isernia', 'IS', 'Molise', 'comuneisernia@pec.it', '2026-11-17', 'Risposta ricevuta', '0057745/2026', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Alessandria', 'AL', 'Piemonte', 'protocollo@pec.comune.alessandria.it', null, 'Da inviare', null, null),
  ('Asti', 'AT', 'Piemonte', 'protocollo.comuneasti@pec.it', null, 'Da inviare', null, null),
  ('Biella', 'BI', 'Piemonte', 'protocollo@cert.comune.biella.it', null, 'Da inviare', null, null),
  ('Cuneo', 'CN', 'Piemonte', 'protocollo.comune.cuneo@legalmail.it', null, 'Da inviare', null, null),
  ('Novara', 'NO', 'Piemonte', 'archivio@pec.comune.novara.it', null, 'Da inviare', null, null),
  ('Verbania', 'VB', 'Piemonte', 'istituzionale.verbania@legalmail.it', null, 'Da inviare', null, null),
  ('Vercelli', 'VC', 'Piemonte', 'protocollo@cert.comune.vercelli.it', null, 'Da inviare', null, null),
  ('Andria', 'BT', 'Puglia', 'protocollo@cert.comune.andria.bt.it', null, 'Da inviare', null, null),
  ('Barletta', 'BT', 'Puglia', 'protocollo@cert.comune.barletta.bt.it', null, 'Da inviare', null, null),
  ('Brindisi', 'BR', 'Puglia', 'ufficioprotocollo@pec.comune.brindisi.it', null, 'Da inviare', null, null),
  ('Foggia', 'FG', 'Puglia', 'protocollo.generale@cert.comune.foggia.it', null, 'Da inviare', null, null),
  ('Lecce', 'LE', 'Puglia', 'protocollo@pec.comune.lecce.it', null, 'Da inviare', null, null),
  ('Trani', 'BT', 'Puglia', 'protocollo@cert.comune.trani.bt.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Carbonia', 'SU', 'Sardegna', 'comcarbonia@pec.comcarbonia.org', null, 'Da inviare', null, null),
  ('Nuoro', 'NU', 'Sardegna', 'protocollo@pec.comune.nuoro.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Oristano', 'OR', 'Sardegna', 'istituzionale@pec.comune.oristano.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Sassari', 'SS', 'Sardegna', 'protocollo@pec.comune.sassari.it', null, 'Da inviare', null, null),
  ('Agrigento', 'AG', 'Sicilia', 'servizio.protocollo@pec.comune.agrigento.it', '2026-11-17', 'Risposta ricevuta', '81437 del 18/11', '18/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Caltanissetta', 'CL', 'Sicilia', 'protocollo@pec.comune.caltanissetta.it', '2026-11-18', 'Inviata', null, 'Scadenza 30 giorni: 18/12/2026.'),
  ('Enna', 'EN', 'Sicilia', 'protocollo@pec.comune.enna.it', null, 'Da inviare', null, null),
  ('Ragusa', 'RG', 'Sicilia', 'protocollo@pec.comune.ragusa.it', null, 'Da inviare', null, null),
  ('Siracusa', 'SR', 'Sicilia', 'protocollo@comune.siracusa.legalmail.it', null, 'Da inviare', null, null),
  ('Trapani', 'TP', 'Sicilia', 'protocollo@pec.comune.trapani.it', '2026-11-17', 'Risposta ricevuta', '2026/97969', '18/11: istanza protocollata (ricevuta automatica). In attesa dei dati. Scadenza 30 giorni: 17/12/2026.'),
  ('Arezzo', 'AR', 'Toscana', 'comune.arezzo@postacert.toscana.it', null, 'Da inviare', null, null),
  ('Grosseto', 'GR', 'Toscana', 'comune.grosseto@postacert.toscana.it', null, 'Da inviare', null, null),
  ('Lucca', 'LU', 'Toscana', 'comune.lucca@postacert.toscana.it', null, 'Da inviare', null, null),
  ('Massa', 'MS', 'Toscana', 'comune.massa@postacert.toscana.it', '2026-11-16', 'Risposta ricevuta', '89475', '17/11: istanza protocollata. In attesa dei dati. Scadenza 30 giorni: 16/12/2026.'),
  ('Pisa', 'PI', 'Toscana', 'comune.pisa@postacert.toscana.it', null, 'Da inviare', null, null),
  ('Pistoia', 'PT', 'Toscana', 'comune.pistoia@postacert.toscana.it', null, 'Da inviare', null, null),
  ('Bolzano', 'BZ', 'Trentino-Alto Adige/Südtirol', 'bz@legalmail.it', null, 'Da inviare', null, null),
  ('Terni', 'TR', 'Umbria', 'comune.terni@postacert.umbria.it', null, 'Da inviare', null, null),
  ('Aosta', 'AO', 'Valle d''Aosta/Vallée d''Aoste', 'protocollo@pec.comune.aosta.it', null, 'Da inviare', null, null),
  ('Belluno', 'BL', 'Veneto', 'belluno.bl@cert.ip-veneto.net', null, 'Da inviare', null, null),
  ('Rovigo', 'RO', 'Veneto', 'comunerovigo@legalmail.it', '2026-11-16', 'Inviata', null, 'Scadenza 30 giorni: 16/12/2026.'),
  ('Treviso', 'TV', 'Veneto', 'postacertificata@cert.comune.treviso.it', null, 'Da inviare', null, null),
  ('Vicenza', 'VI', 'Veneto', 'vicenza@cert.comune.vicenza.it', null, 'Da inviare', null, null)
on conflict (comune) do nothing;


commit;
