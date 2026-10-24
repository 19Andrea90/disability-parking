// Proxy per l'ortofoto della Regione FVG: il server WMS regionale non invia le intestazioni CORS,
// quindi il browser non può leggere i pixel. Questa funzione scarica l'immagine e la rigira con CORS aperto.
// Accetta solo richieste GetMap verso il server regionale, nient'altro.
const ALLOWED_HOST = 'irdat-ortofoto.regione.fvg.it';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const u = new URL(req.url);
  const p = u.searchParams;
  const bbox = p.get('bbox'), w = p.get('w') ?? '600', h = p.get('h') ?? '600', layer = p.get('layer') ?? 'trueorto_FVG_1720';
  if (!bbox || !/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(bbox)) return new Response('bbox mancante', { status: 400, headers: CORS });
  if (!/^[\w]+$/.test(layer) || +w > 1024 || +h > 1024) return new Response('parametri non validi', { status: 400, headers: CORS });
  const target = `https://${ALLOWED_HOST}/geoserver/ortofoto/ows?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&SRS=EPSG:4326&BBOX=${bbox}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg`;
  try {
    const r = await fetch(target, { headers: { 'User-Agent': 'disability-parking/0.2' } });
    if (!r.ok) return new Response('WMS ' + r.status, { status: 502, headers: CORS });
    const body = await r.arrayBuffer();
    return new Response(body, { headers: { ...CORS, 'Content-Type': r.headers.get('content-type') ?? 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
  } catch (e) {
    return new Response('errore: ' + (e as Error).message, { status: 502, headers: CORS });
  }
});
