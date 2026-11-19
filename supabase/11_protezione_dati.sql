-- 11 · Protezione dei dati: niente più scarico in blocco degli stalli (19 novembre 2026)
-- Da eseguire una volta nell'editor SQL di Supabase. Si può rieseguire senza danni. Solo aggiunte: non toglie nulla a nessuno.
-- Dopo questo file l'app nuova legge i posti solo per zona piccola (stalli_zona), a mappa larga vede solo conteggi
-- (stalli_conteggi) e apre un singolo posto per id (stallo). La lettura libera di stalli e stalli_con_conferme si chiude
-- DOPO, con 12_chiudi_lettura_libera.sql, quando le versioni vecchie dell'app non servono più.
begin;

-- 1) Contatore d'uso per indirizzo IP, per il limite di richieste.
--    Una riga per IP e per giorno. "finestra" è l'inizio della finestra di 10 minuti in corso, n_finestra le chiamate
--    fatte in quella finestra, n_giorno quelle del giorno (giorno di Roma), bloccati quante volte è scattato il limite.
create table if not exists public.accessi_dati (
  ip text not null,
  giorno date not null,
  finestra timestamptz not null,
  n_finestra integer not null default 0,
  n_giorno integer not null default 0,
  bloccati integer not null default 0,
  primary key (ip, giorno)
);
create index if not exists accessi_dati_giorno on public.accessi_dati (giorno);
alter table public.accessi_dati enable row level security;
revoke all on table public.accessi_dati from anon, authenticated;
grant select on table public.accessi_dati to authenticated;      -- con la regola sotto vede qualcosa solo l'admin
drop policy if exists accessi_admin on public.accessi_dati;
create policy accessi_admin on public.accessi_dati for select using (public.is_admin());

-- 2) Limite d'uso: la chiamano solo le altre funzioni (security definer), mai l'app.
--    Restituisce true se si può procedere. Se il limite è superato (più di 300 chiamate in 10 minuti oppure più di
--    2000 al giorno per lo stesso IP) conta il blocco e imposta lo stato HTTP 429 con Retry-After, poi restituisce
--    false: la funzione chiamante esce subito con un elenco vuoto.
--    SCELTA SULLO STATO 429: PostgREST permette due vie documentate: (a) raise sqlstate 'PT429' using message = ...,
--    (b) impostare set_config('response.status', '429', true) e finire normalmente. Ho scelto la (b) perché con la (a)
--    l'eccezione annulla l'intera transazione, quindi anche l'aggiornamento di "bloccati", che resterebbe sempre a 0.
--    Con la (b) la transazione si chiude regolarmente, il contatore resta e il corpo della risposta è un elenco vuoto
--    ([]) con stato 429. Se in prova non si ottenesse il 429, la (a) è un cambio di due righe (vedi i commenti sotto).
--    L'IP: si usa cf-connecting-ip (lo imposta Cloudflare, davanti a Supabase, ignorando il valore mandato dal client);
--    se manca, il primo valore di x-forwarded-for; se manca anche quello, 'sconosciuto'. ATTENZIONE: il primo valore di
--    x-forwarded-for lo può scrivere il client, quindi da solo non sarebbe un limite affidabile. Gli indirizzi IPv6
--    sono raggruppati per /64 (chi ha IPv6 ne ha miliardi).
create or replace function public._limite_dati(p_peso integer default 1)
returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_h json;
  v_ip text;
  v_giorno date := (now() at time zone 'Europe/Rome')::date;
  v_fin timestamptz := date_bin(interval '10 minutes', now(), timestamptz '2000-01-01 00:00:00+00');
  v_nf integer;
  v_ng integer;
  v_attesa integer;
begin
  if public.is_admin() then return true; end if;     -- gli admin non hanno limite
  p_peso := greatest(1, least(coalesce(p_peso, 1), 50));
  begin v_h := nullif(current_setting('request.headers', true), '')::json; exception when others then v_h := null; end;
  v_ip := coalesce(nullif(btrim(v_h ->> 'cf-connecting-ip'), ''),
                   nullif(btrim(split_part(coalesce(v_h ->> 'x-forwarded-for', ''), ',', 1)), ''), 'sconosciuto');
  begin
    if position(':' in v_ip) > 0 then v_ip := network(set_masklen(v_ip::inet, 64))::text; end if;
  exception when others then v_ip := left(v_ip, 64);
  end;
  v_ip := left(v_ip, 64);

  insert into public.accessi_dati as a (ip, giorno, finestra, n_finestra, n_giorno)
  values (v_ip, v_giorno, v_fin, p_peso, p_peso)
  on conflict (ip, giorno) do update set
    n_finestra = case when a.finestra = v_fin then a.n_finestra + p_peso else p_peso end,
    finestra = v_fin,
    n_giorno = a.n_giorno + p_peso
  returning a.n_finestra, a.n_giorno into v_nf, v_ng;

  if v_nf > 300 or v_ng > 2000 then
    update public.accessi_dati set bloccati = bloccati + 1 where ip = v_ip and giorno = v_giorno;
    v_attesa := case when v_ng > 2000 then 3600 else greatest(1, extract(epoch from (v_fin + interval '10 minutes' - now()))::integer) end;
    perform set_config('response.status', '429', true);
    perform set_config('response.headers', json_build_array(json_build_object('Retry-After', v_attesa::text))::text, true);
    return false;
    -- variante (a), da usare al posto delle 3 righe sopra se la (b) non desse il 429 (perde però il conteggio dei blocchi):
    --   raise sqlstate 'PT429' using message = 'troppe richieste', detail = 'limite di richieste superato', hint = 'riprova tra qualche minuto';
  end if;

  if v_ng = p_peso then      -- primo accesso del giorno per questo IP: ne approfitto per togliere le righe vecchie
    delete from public.accessi_dati where giorno < v_giorno - 30;
  end if;
  return true;
end $$;
revoke all on function public._limite_dati(integer) from public, anon, authenticated;

-- 3) Posti di una zona piccola: le stesse colonne che l'app leggeva dalla vista stalli_con_conferme.
--    Al massimo 0,05° di altezza (circa 5,5 km) e 0,075° di larghezza: la vista dell'utente è al massimo 3 km più il
--    margine del 25% per lato. Solo stalli pubblicati e non "personalizzati". Al massimo 400 righe, quelle più vicine
--    al centro della zona richiesta. Errore 400 (PT400) se la zona è troppo ampia o i valori non sono validi.
create or replace function public.stalli_zona(p_s double precision, p_w double precision, p_n double precision, p_e double precision)
returns table (id uuid, lat double precision, lon double precision, tipo text, posti integer, nome text, indirizzo text,
               comune text, note text, coperto boolean, stato text, fonte text,
               conferme_esiste bigint, conferme_non_esiste bigint, ultima_conferma timestamptz)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if p_s is null or p_w is null or p_n is null or p_e is null
     or not (p_s between -90 and 90 and p_n between -90 and 90 and p_w between -180 and 180 and p_e between -180 and 180)
     or p_n < p_s or p_e < p_w or (p_n - p_s) > 0.05 or (p_e - p_w) > 0.075 then
    raise sqlstate 'PT400' using message = 'zona troppo ampia', detail = 'massimo 0,05 gradi di altezza e 0,075 di larghezza', hint = 'avvicina la mappa';
  end if;
  if not public._limite_dati() then return; end if;
  return query
    select s.id, s.lat, s.lon, s.tipo, s.posti, s.nome, s.indirizzo, s.comune, s.note, s.coperto, s.stato, s.fonte,
      (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'esiste'),
      (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'non_esiste'),
      (select max(c.created_at) from public.conferme c where c.stallo_id = s.id)
    from public.stalli s
    where s.stato in ('proposto', 'verificato', 'ufficiale') and s.tipo <> 'personalizzato'
      and s.lat >= p_s and s.lat <= p_n and s.lon >= p_w and s.lon <= p_e
    order by (s.lat - (p_s + p_n) / 2) ^ 2 + ((s.lon - (p_w + p_e) / 2) * 0.7) ^ 2
    limit 400;
end $$;

-- 4) Conteggi a griglia per la mappa larga: per ogni cella il CENTRO della cella (mai la posizione dei posti), il
--    numero di stalli e la somma dei posti. Massimo 200 celle, stessi filtri di stato e tipo.
--    Il lato della cella è 0,02° in latitudine e 0,027° in longitudine moltiplicati per una potenza di 2 (la più vicina
--    a "un sesto della zona"), con la griglia sempre ancorata allo zero: così tutte le griglie sono una dentro l'altra e
--    incrociando più richieste non si può scendere sotto la cella minima (con un lato qualunque, per esempio un sesto
--    esatto della zona, griglie sfalsate permetterebbero di restringere la posizione di un posto). Le celle sono
--    sempre intere (si contano anche i posti appena fuori dalla zona richiesta, per non dare conteggi dimezzati).
create or replace function public.stalli_conteggi(p_s double precision, p_w double precision, p_n double precision, p_e double precision)
returns table (lat double precision, lon double precision, stalli integer, posti integer)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_k integer;
  v_cl double precision;
  v_co double precision;
begin
  if p_s is null or p_w is null or p_n is null or p_e is null
     or not (p_s between -90 and 90 and p_n between -90 and 90 and p_w between -180 and 180 and p_e between -180 and 180)
     or p_n < p_s or p_e < p_w then
    raise sqlstate 'PT400' using message = 'zona non valida', detail = 'coordinate non valide', hint = 'controlla il riquadro';
  end if;
  if not public._limite_dati() then return; end if;
  v_k := least(12, greatest(0, round(log(2::numeric, greatest(1::numeric, ((p_n - p_s) / 6 / 0.02)::numeric, ((p_e - p_w) / 6 / 0.027)::numeric)))::integer));
  v_cl := 0.02 * power(2, v_k);
  v_co := 0.027 * power(2, v_k);
  return query
    with g as (
      select floor(s.lat / v_cl) as iy, floor(s.lon / v_co) as ix, count(*)::integer as n, sum(s.posti)::integer as p
      from public.stalli s
      where s.stato in ('proposto', 'verificato', 'ufficiale') and s.tipo <> 'personalizzato'
        and s.lat >= floor(p_s / v_cl) * v_cl and s.lat < (floor(p_n / v_cl) + 1) * v_cl
        and s.lon >= floor(p_w / v_co) * v_co and s.lon < (floor(p_e / v_co) + 1) * v_co
      group by 1, 2)
    select ((g.iy + 0.5) * v_cl)::double precision, ((g.ix + 0.5) * v_co)::double precision, g.n, g.p
    from g order by g.n desc limit 200;
end $$;

-- 5) Un solo posto per id: serve ad aprire un posto da link, condivisione o elenco dei posti salvati.
create or replace function public.stallo(p_id uuid)
returns table (id uuid, lat double precision, lon double precision, tipo text, posti integer, nome text, indirizzo text,
               comune text, note text, coperto boolean, stato text, fonte text,
               conferme_esiste bigint, conferme_non_esiste bigint, ultima_conferma timestamptz)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if p_id is null then raise sqlstate 'PT400' using message = 'id mancante'; end if;
  if not public._limite_dati() then return; end if;
  return query
    select s.id, s.lat, s.lon, s.tipo, s.posti, s.nome, s.indirizzo, s.comune, s.note, s.coperto, s.stato, s.fonte,
      (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'esiste'),
      (select count(*) from public.conferme c where c.stallo_id = s.id and c.esito = 'non_esiste'),
      (select max(c.created_at) from public.conferme c where c.stallo_id = s.id)
    from public.stalli s
    where s.id = p_id and s.stato in ('proposto', 'verificato', 'ufficiale') and s.tipo <> 'personalizzato';
end $$;

-- 6) Configurazione dell'app, modificabile solo dagli admin: per ora serve a poter obbligare ad aggiornare l'app Android
--    (versione_minima_android: l'app con una versione più bassa mostra "Aggiorna l'app per continuare"; "0" = nessun obbligo)
--    e a mostrare un messaggio (per ora non usato). Esempio per obbligare dalla 1.0.20 in su:
--      update public.app_config_valori set valore = '"1.0.20"' where chiave = 'versione_minima_android';
create table if not exists public.app_config_valori (
  chiave text primary key,
  valore jsonb not null
);
alter table public.app_config_valori enable row level security;
revoke all on table public.app_config_valori from anon, authenticated;
grant select, insert, update, delete on table public.app_config_valori to authenticated;
drop policy if exists app_config_admin on public.app_config_valori;
create policy app_config_admin on public.app_config_valori for all using (public.is_admin()) with check (public.is_admin());
insert into public.app_config_valori (chiave, valore) values ('versione_minima_android', '"0"'::jsonb), ('messaggio', 'null'::jsonb)
  on conflict (chiave) do nothing;

create or replace function public.app_config()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'versione_minima_android', coalesce((select valore from public.app_config_valori where chiave = 'versione_minima_android'), '"0"'::jsonb),
    'messaggio', coalesce((select valore from public.app_config_valori where chiave = 'messaggio'), 'null'::jsonb))
$$;

-- 7) Permessi: l'app (anon) e gli utenti con account (authenticated) possono chiamare solo queste quattro funzioni.
--    Per ora NON si toglie nulla: la vista stalli_con_conferme resta leggibile finché non si esegue il file 12.
revoke all on function public.stalli_zona(double precision, double precision, double precision, double precision) from public;
revoke all on function public.stalli_conteggi(double precision, double precision, double precision, double precision) from public;
revoke all on function public.stallo(uuid) from public;
revoke all on function public.app_config() from public;
grant execute on function public.stalli_zona(double precision, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.stalli_conteggi(double precision, double precision, double precision, double precision) to anon, authenticated;
grant execute on function public.stallo(uuid) to anon, authenticated;
grant execute on function public.app_config() to anon, authenticated;

commit;

-- Controlli dopo l'esecuzione (da lanciare a mano, non cambiano nulla):
--   select * from public.stalli_zona(46.05, 13.22, 46.07, 13.25);              -- dal SQL Editor: gira come postgres, senza limite d'uso
--   select * from public.stalli_conteggi(45.9, 13.0, 46.2, 13.5);
--   select public.app_config();
-- Dall'esterno (con la chiave anon) il 429 si prova con più di 300 chiamate a stalli_zona in 10 minuti: la risposta
-- deve avere stato 429, un'intestazione Retry-After e corpo []. Per vedere quale IP legge il database:
--   curl -s -X POST "$SB/rest/v1/rpc/stalli_zona" -H "apikey: $ANON" -H 'Content-Type: application/json' -d '{"p_s":46.05,"p_w":13.22,"p_n":46.07,"p_e":13.25}'
--   select * from public.accessi_dati order by giorno desc, n_giorno desc limit 5;
