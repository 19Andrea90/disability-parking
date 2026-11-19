-- 12 · Chiude la lettura libera di stalli e stalli_con_conferme
--
-- ####################################################################################################################
-- ##  DA NON ESEGUIRE ORA.                                                                                          ##
-- ##  Va eseguito solo DOPO: (1) aver eseguito 11_protezione_dati.sql; (2) aver pubblicato la nuova app web e la    ##
-- ##  nuova app Android (quelle che usano stalli_zona / stalli_conteggi / stallo); (3) aver deciso che le versioni  ##
-- ##  vecchie dell'app possono smettere di funzionare (vedi app_config: versione_minima_android obbliga ad          ##
-- ##  aggiornare). Appena questo file gira, le app vecchie non caricano più nessun posto.                           ##
-- ####################################################################################################################
--
-- Cosa fa: da quel momento la chiave pubblica (anon) non può più leggere le tabelle degli stalli e delle conferme,
-- quindi non si può più scaricare tutto l'archivio; i posti si ottengono solo dalle funzioni di 11, che chiedono una
-- zona piccola e hanno un limite di richieste per IP. Si può rieseguire senza danni.
--
-- COSA RESTA FUNZIONANTE (controllato su supabase/*.sql, admin.js e mobile/www/app.js):
--  • Segnalare un posto nuovo (app: POST /rest/v1/stalli): serve solo il permesso di INSERT e la regola stalli_propose
--    (stato = 'proposto' e fonte = 'utente'), che qui non si toccano. L'app nuova non chiede più "return=representation"
--    (che richiederebbe il permesso di lettura): manda un id generato dal telefono e "return=minimal". Stesso schema già
--    usato da eventi e suggerimenti (09), che hanno solo INSERT per anon e funzionano.
--  • Confermare un posto (POST /rest/v1/conferme): solo INSERT (conferme_insert) con return=minimal; il controllo della
--    chiave esterna verso stalli lo fa il database con i suoi permessi, non servono permessi di lettura.
--  • "Le mie segnalazioni": la funzione mie_segnalazioni è security definer, legge stalli con i permessi del proprietario.
--  • Pannello admin (utente autenticato con email in public.admins): le regole "solo admin" qui sotto lo lasciano
--    leggere stalli, stalli_con_conferme (la vista è security_invoker: l'admin vede stalli e conferme), candidati,
--    etichette, suggerimenti, eventi, pec_comuni. Scrive come prima (policy admin di 02, 07).
--  • Strumenti con la service key (tools/*.py, workflow GitHub): la service key salta le regole di sicurezza e i permessi
--    di anon/authenticated non la riguardano.
--  • Le funzioni di 11 (stalli_zona, stalli_conteggi, stallo, app_config): sono security definer, leggono le tabelle con
--    i permessi del proprietario.
--
-- COSA RESTA LEGGIBILE CON LA CHIAVE PUBBLICA, E PERCHÉ:
--  • regole_comuni (select per tutti, 10): sono le regole di sosta per comune mostrate nella scheda, dati pubblici,
--    pochi record (al massimo uno per comune), non rivelano la posizione di nessun posto.
--  • Foto e file nel bucket "foto" (storage): i link pubblici funzionano ancora (le foto dei posti, il riepilogo
--    copertura/riepilogo.json con i soli totali per regione, provincia e comune). L'ELENCO dei file è già solo admin (07).
--  • Le funzioni stalli_zona, stalli_conteggi, stallo, app_config, mie_segnalazioni (queste ultime due ricevono un id o
--    un codice telefono che solo chi ha già il dato conosce), is_admin (restituisce solo vero/falso per chi la chiama).
--  • Non leggibili già oggi dal pubblico (nessuna modifica): eventi, suggerimenti, candidati, etichette, pec_comuni,
--    admins, accessi_dati, app_config_valori (solo INSERT per anon, o solo admin).
--
-- DECISIONI PRESE IN PIÙ rispetto alla richiesta (si possono togliere dal file senza toccare il resto):
--  • Anche conferme viene chiusa in lettura: la regola conferme_read (select per tutti) permetteva di scaricare tutti
--    gli id degli stalli con una conferma e i codici dei telefoni di chi ha confermato; l'app non la usa mai (legge i
--    conteggi dalla vista), l'admin continua a leggerla.
--  • Viene tolto il permesso di eseguire stalli_in_bbox (schema.sql): era una funzione "stalli dentro un rettangolo,
--    fino a 3000 righe" chiamabile da chiunque, un altro modo di scaricare tutto. Non la usa nessuno.
begin;

-- 1) stalli: la lettura passa agli admin
drop policy if exists stalli_read on public.stalli;
create policy stalli_read on public.stalli for select using (public.is_admin());
revoke select on public.stalli from anon;

-- 2) la vista (security_invoker): senza permesso su stalli non avrebbe comunque righe, ma si toglie anche il permesso sulla vista
revoke select on public.stalli_con_conferme from anon;

-- 3) conferme: lettura solo admin (l'inserimento resta aperto)
drop policy if exists conferme_read on public.conferme;
drop policy if exists conferme_read_admin on public.conferme;
create policy conferme_read_admin on public.conferme for select using (public.is_admin());
revoke select on public.conferme from anon;

-- 4) funzione di scarico per rettangolo, non più usata
revoke all on function public.stalli_in_bbox(double precision, double precision, double precision, double precision) from public, anon, authenticated;

commit;

-- Controllo (da lanciare a mano dopo): anon_legge deve essere false per stalli, conferme e stalli_con_conferme
select c.relname as tabella, c.relrowsecurity as rls_attiva,
       has_table_privilege('anon', c.oid, 'select') as anon_legge,
       has_table_privilege('anon', c.oid, 'insert') as anon_inserisce
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'v')
order by 1;
