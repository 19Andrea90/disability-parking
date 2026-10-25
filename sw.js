/* Service worker: app shell offline + cache delle tile già viste */
const VERSION = 'dp-v0.5.3';
const SHELL = ['./', './index.html', './admin.html', './app.css', './app.js', './admin.js', './config.js', './model.json', './manifest.json', './icons/icon-192.png', './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'];
const TILE_CACHE = 'dp-tiles'; const TILE_MAX = 1500;

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.includes('supabase.co') || u.hostname.includes('nominatim')) return; // sempre in rete
  const isTile = /tile\.openstreetmap\.org|arcgisonline\.com/.test(u.hostname);
  if (isTile) {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok) { c.put(e.request, r.clone()); trimTiles(c); } return r; } catch (err) { return new Response('', { status: 503 }); }
    }));
    return;
  }
  // shell: rete prima (per avere aggiornamenti), cache se offline
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && (u.origin === location.origin || SHELL.includes(e.request.url))) caches.open(VERSION).then((c) => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request).then((h) => h || caches.match('./index.html'))));
});
async function trimTiles(c) { const ks = await c.keys(); if (ks.length > TILE_MAX) for (const k of ks.slice(0, ks.length - TILE_MAX)) c.delete(k); }
