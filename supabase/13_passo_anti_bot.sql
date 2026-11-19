-- 13 · Passo anti-bot, predisposto ma SPENTO (19 novembre 2026)
-- Da eseguire a mano nell'editor SQL di Supabase, DOPO 11_protezione_dati.sql. Si può rieseguire senza danni. Solo aggiunte.
-- Idea: oggi il limite d'uso è per indirizzo IP e chi ruota molti IP lo aggira. Con questo file i dati si possono servire solo
-- a chi presenta un «passo» valido (intestazione x-dp-passo), che la funzione Edge «passo» rilascia a chi dimostra di essere
-- un browser reale (Cloudflare Turnstile) o, in futuro, l'app Android vera (Play Integrity). Vedi docs/anti-bot.md.
-- Appena eseguito NON cambia nulla: il modo parte da "spento". Modi (chiave anti_bot di app_config_valori, campo "modo"):
--   spento  = nessun controllo (come prima di questo file);
--   osserva = si serve a tutti, ma si contano le richieste con e senza passo (accessi_dati.con_passo / senza_passo);
--   obbliga = senza passo valido non si servono dati: stato HTTP 401 e corpo [].
-- ATTENZIONE: "obbliga" blocca anche l'app Android finché non ha il suo passo: vedi docs/anti-bot.md prima di accenderlo.
-- Cambio di modo (come admin, o dal SQL Editor):
--   update public.app_config_valori set valore = '{"modo":"osserva"}'::jsonb where chiave = 'anti_bot';
begin;

-- 1) I passi rilasciati. Il token è casuale (32 byte); scade dopo 30 minuti (lo decide la funzione Edge).
--    Nessun accesso per anon/authenticated: li scrive la funzione Edge con la service key, li legge solo _passo_valido().
create table if not exists public.passi (
  token text primary key,
  creato timestamptz not null default now(),
  scade timestamptz not null,
  origine text check (origine in ('web', 'android')),
  ip text
);
create index if not exists passi_scade on public.passi (scade);
alter table public.passi enable row level security;
revoke all on table public.passi from public, anon, authenticated;
grant all on table public.passi to service_role;

-- 2) Configurazione: il modo parte da "spento". Se la riga c'è già non si tocca.
insert into public.app_config_valori (chiave, valore) values ('anti_bot', '{"modo":"spento"}'::jsonb)
  on conflict (chiave) do nothing;

-- 3) Due contatori in più nell'uso per IP, per guardare in modalità "osserva" quanti arrivano con e senza passo.
alter table public.accessi_dati add column if not exists con_passo integer not null default 0;
alter table public.accessi_dati add column if not exists senza_passo integer not null default 0;

-- 4) Il passo mandato dal client nell'intestazione x-dp-passo è valido se esiste in passi e non è scaduto. Solo uso interno.
create or replace function public._passo_valido()
returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_h json;
  v_t text;
begin
  begin v_h := nullif(current_setting('request.headers', true), '')::json; exception when others then return false; end;
  v_t := btrim(coalesce(v_h ->> 'x-dp-passo', ''));
  if v_t = '' or length(v_t) > 100 then return false; end if;
  return exists (select 1 from public.passi p where p.token = v_t and p.scade > now());
end $$;
revoke all on function public._passo_valido() from public, anon, authenticated;

-- 5) _limite_dati: la logica del file 11 (limite per IP, 429) resta IDENTICA; in più, secondo il modo, conta o pretende il passo.
--    In "obbliga" senza passo valido: stato 401 con la stessa tecnica del 429 (set_config di response.status, senza eccezione,
--    così il conteggio senza_passo resta salvato) e restituisce false: la funzione chiamante esce con un elenco vuoto.
--    Gli admin sono sempre esenti. Un modo sconosciuto o illeggibile vale "spento" (mai bloccare per un errore di configurazione).
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
  v_modo text;
  v_passo boolean := false;
  v_cp integer := 0;
  v_sp integer := 0;
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

  begin select valore ->> 'modo' into v_modo from public.app_config_valori where chiave = 'anti_bot'; exception when others then v_modo := null; end;
  if v_modo is null or v_modo not in ('osserva', 'obbliga') then v_modo := 'spento'; end if;
  if v_modo <> 'spento' then
    v_passo := public._passo_valido();
    v_cp := case when v_passo then 1 else 0 end;
    v_sp := 1 - v_cp;
    if v_modo = 'obbliga' and not v_passo then
      -- niente dati: si conta solo il tentativo senza passo (non consuma il limite dell'IP)
      insert into public.accessi_dati as a (ip, giorno, finestra, n_finestra, n_giorno, senza_passo)
      values (v_ip, v_giorno, v_fin, 0, 0, 1)
      on conflict (ip, giorno) do update set senza_passo = a.senza_passo + 1;
      perform set_config('response.status', '401', true);
      return false;
    end if;
  end if;

  insert into public.accessi_dati as a (ip, giorno, finestra, n_finestra, n_giorno, con_passo, senza_passo)
  values (v_ip, v_giorno, v_fin, p_peso, p_peso, v_cp, v_sp)
  on conflict (ip, giorno) do update set
    n_finestra = case when a.finestra = v_fin then a.n_finestra + p_peso else p_peso end,
    finestra = v_fin,
    n_giorno = a.n_giorno + p_peso,
    con_passo = a.con_passo + v_cp,
    senza_passo = a.senza_passo + v_sp
  returning a.n_finestra, a.n_giorno into v_nf, v_ng;

  if v_nf > 300 or v_ng > 2000 then
    update public.accessi_dati set bloccati = bloccati + 1 where ip = v_ip and giorno = v_giorno;
    v_attesa := case when v_ng > 2000 then 3600 else greatest(1, extract(epoch from (v_fin + interval '10 minutes' - now()))::integer) end;
    perform set_config('response.status', '429', true);
    perform set_config('response.headers', json_build_array(json_build_object('Retry-After', v_attesa::text))::text, true);
    return false;
  end if;

  if v_ng = p_peso then      -- primo accesso del giorno per questo IP: ne approfitto per togliere le righe vecchie e i passi scaduti
    delete from public.accessi_dati where giorno < v_giorno - 30;
    delete from public.passi where scade < now();
  end if;
  return true;
end $$;
revoke all on function public._limite_dati(integer) from public, anon, authenticated;

-- 6) app_config(): in più il modo anti-bot, perché l'app sappia se chiedere il passo ("spento" se la chiave manca).
create or replace function public.app_config()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'versione_minima_android', coalesce((select valore from public.app_config_valori where chiave = 'versione_minima_android'), '"0"'::jsonb),
    'messaggio', coalesce((select valore from public.app_config_valori where chiave = 'messaggio'), 'null'::jsonb),
    'anti_bot_modo', coalesce((select to_jsonb(valore ->> 'modo') from public.app_config_valori where chiave = 'anti_bot'), '"spento"'::jsonb))
$$;
revoke all on function public.app_config() from public;
grant execute on function public.app_config() to anon, authenticated;

commit;

-- Controlli dopo l'esecuzione (non cambiano nulla):
--   select public.app_config();                                   -- deve contenere "anti_bot_modo": "spento"
--   select valore from public.app_config_valori where chiave = 'anti_bot';
--   select ip, giorno, n_giorno, con_passo, senza_passo from public.accessi_dati order by giorno desc, n_giorno desc limit 10;
