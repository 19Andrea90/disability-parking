-- 07 · Avvisi "WARN" del Security Advisor di Supabase (28 ottobre 2026)

begin;

-- 1) Function Search Path Mutable: fisso lo schema di ricerca delle funzioni
--    (importante soprattutto per is_admin, che gira con privilegi elevati)
alter function public.is_admin() set search_path = public, pg_temp;
alter function public.touch_updated_at() set search_path = public, pg_temp;
alter function public.stalli_in_bbox(double precision, double precision, double precision, double precision) set search_path = public, pg_temp;

-- 2) RLS Policy Always True su stalli: la modifica era già permessa solo agli admin (USING is_admin()),
--    ora anche la riga modificata deve passare lo stesso controllo
alter policy stalli_admin_update on public.stalli using (public.is_admin()) with check (public.is_admin());

-- 3) Public Bucket Allows Listing: chiunque poteva ottenere l'elenco di tutti i file del bucket "foto".
--    I link pubblici alle foto funzionano anche senza questa regola; l'elenco resta possibile solo agli admin
--    (serve all'admin per sovrascrivere i ritagli già caricati).
drop policy if exists foto_read on storage.objects;
create policy foto_read_admin on storage.objects for select using (bucket_id = 'foto' and public.is_admin());

commit;

-- Avvisi lasciati volutamente così:
-- • conferme_insert WITH CHECK (true): chiunque, anche senza account, può dire "esiste / libero / occupato / non esiste";
--   è la funzione dell'app. Il database accetta solo i 4 valori previsti e solo per stalli esistenti.
-- • is_admin() eseguibile da anon/authenticated: le regole di sicurezza la chiamano per ogni visitatore;
--   togliendo il permesso l'app smetterebbe di funzionare. Restituisce solo vero/falso per chi la chiama.
-- • Leaked Password Protection: si attiva da Authentication → Settings (non da SQL), se il piano lo consente.
