-- 05 · Sicurezza (avviso Supabase "rls_disabled_in_public", 28 ottobre 2026)
-- Eseguire una volta nel SQL Editor di Supabase.

-- 1) spatial_ref_sys è la tabella dei sistemi di coordinate installata da PostGIS (nessun dato nostro).
--    Supabase la segnala perché sta nello schema public senza Row-Level Security; non essendone proprietari
--    non possiamo attivare l'RLS, quindi togliamo ogni accesso agli utenti esterni (l'app non la usa).
revoke all on table public.spatial_ref_sys from anon, authenticated;

-- 2) La vista stalli_con_conferme (usata solo dall'admin) girava con i permessi del proprietario, quindi
--    chiunque poteva leggere anche gli stalli rifiutati/rimossi e le loro note. Con security_invoker la vista
--    rispetta le stesse regole della tabella stalli: il pubblico vede solo gli stalli attivi, l'admin tutto.
alter view public.stalli_con_conferme set (security_invoker = true);

-- Controllo: deve restituire false per spatial_ref_sys e true per le nostre tabelle
select c.relname as tabella, c.relrowsecurity as rls_attiva,
       has_table_privilege('anon', c.oid, 'select') as anon_legge
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
