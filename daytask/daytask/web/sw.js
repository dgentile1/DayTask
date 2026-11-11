// DayTask service worker: keeps the app's own files on the device so it opens offline.
// Strategy: network first (so updates arrive as soon as you're online), falling back to the
// stored copy when offline or when the network is too slow. Supabase traffic is never touched;
// task data offline is handled by js/data/sync.js.
const CACHE = 'daytask-app-v3';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'manifest.webmanifest',
  'icon.svg',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'vendor/supabase.js',
  'vendor/Sortable.min.js',
  'js/app.js',
  'js/host.js',
  'js/theme.js',
  'js/version.js',
  'js/core/colors.js',
  'js/core/daily.js',
  'js/core/dates.js',
  'js/core/outbox.js',
  'js/core/schedule.js',
  'js/core/subtasks.js',
  'js/core/timer.js',
  'js/data/store.js',
  'js/data/sync.js',
  'js/integrations/granola/importer.js',
  'js/integrations/granola/parser.js',
  'js/integrations/granola/sources.js',
];
const SLOW_NETWORK_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // Supabase etc.: straight through
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const fromNetwork = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const fallback = async () => (await cache.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? cache.match('index.html') : undefined);
  try {
    // A stored copy wins if the network is very slow (one bar of signal); the fresh copy still lands in the cache.
    const timeout = new Promise((resolve) => setTimeout(() => resolve('slow'), SLOW_NETWORK_MS));
    const first = await Promise.race([fromNetwork, timeout]);
    if (first !== 'slow') return first;
    return (await fallback()) || (await fromNetwork);
  } catch {
    return (await fallback()) || Response.error();
  }
}
