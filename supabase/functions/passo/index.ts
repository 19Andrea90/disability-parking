// Rilascia il «passo» anti-bot (vedi docs/anti-bot.md e supabase/24_passo_anti_bot.sql).
// POST { origine: 'web', prova: '<token Turnstile>' } -> verifica il token con Cloudflare e, se valido, risponde con
// { passo, scade } (passo casuale di 32 byte, valido 30 minuti, salvato nella tabella passi).
// origine 'android': 501, verrà fatto con Play Integrity. Segreti nell'ambiente: TURNSTILE_SECRET, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (gli ultimi due li mette Supabase). Mai nei log: né token né segreti.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const JSON_H = { ...CORS, 'Content-Type': 'application/json' };
const MAX_CORPO = 4096;            // byte: un token Turnstile è lungo poche centinaia di caratteri
const MAX_PROVA = 2048;            // limite di Cloudflare per il token
const DURATA_MS = 30 * 60 * 1000;  // validità del passo
const risp = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: JSON_H });

function nuovoPasso(): string {    // 32 byte casuali in base64url, senza riempimento
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return risp({ errore: 'metodo non consentito' }, 405);
  const dichiarata = Number(req.headers.get('content-length') ?? 0);
  if (dichiarata > MAX_CORPO) return risp({ errore: 'richiesta troppo grande' }, 413);
  let testo: string;
  try { testo = await req.text(); } catch { return risp({ errore: 'richiesta non valida' }, 400); }
  if (new TextEncoder().encode(testo).length > MAX_CORPO) return risp({ errore: 'richiesta troppo grande' }, 413);
  let c: { origine?: unknown; prova?: unknown };
  try { c = JSON.parse(testo); } catch { return risp({ errore: 'JSON non valido' }, 400); }
  if (c.origine === 'android') return risp({ errore: 'non ancora disponibile' }, 501);
  if (c.origine !== 'web') return risp({ errore: 'origine non valida' }, 400);
  if (typeof c.prova !== 'string' || c.prova.length < 1 || c.prova.length > MAX_PROVA) return risp({ errore: 'prova mancante o non valida' }, 400);

  const segreto = Deno.env.get('TURNSTILE_SECRET'), url = Deno.env.get('SUPABASE_URL'), chiave = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!segreto || !url || !chiave) { console.error('passo: configurazione mancante'); return risp({ errore: 'servizio non configurato' }, 503); }
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  try {
    const f = new URLSearchParams({ secret: segreto, response: c.prova });
    if (ip) f.set('remoteip', ip);
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: f });
    if (!v.ok) return risp({ errore: 'verifica non riuscita' }, 502);
    const esito = await v.json();
    if (!esito.success) return risp({ errore: 'prova non valida' }, 403);

    const passo = nuovoPasso(), scade = new Date(Date.now() + DURATA_MS).toISOString();
    const sb = createClient(url, chiave, { auth: { persistSession: false } });
    const { error } = await sb.from('passi').insert({ token: passo, scade, origine: 'web', ip: ip ? ip.slice(0, 64) : null });
    if (error) { console.error('passo: salvataggio non riuscito', error.code); return risp({ errore: 'errore interno' }, 500); }
    if (Math.random() < 0.02) await sb.from('passi').delete().lt('scade', new Date(Date.now() - 86400000).toISOString()); // pulizia: via i passi scaduti da più di un giorno
    return risp({ passo, scade });
  } catch (e) {
    console.error('passo: errore', (e as Error).name);
    return risp({ errore: 'errore interno' }, 502);
  }
});
