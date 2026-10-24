-- Aggiornamento 02: secondo admin + permesso di importazione dalla pagina admin
insert into public.admins (email) values ('27andrea90@gmail.com') on conflict do nothing;

drop policy if exists stalli_admin_insert on public.stalli;
create policy stalli_admin_insert on public.stalli for insert
  with check (public.is_admin());
