// Offline support. The whole app is saved on the phone the first time it is
// opened, so it starts with no signal. When there is signal the newest version
// is fetched; when there is not (or it is slow) the saved copy is used.

const CACHE = 'seeley-trail-tracker-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/db.js', 'js/demo.js', 'js/geo.js', 'js/kml.js',
  'js/mapview.js', 'js/merge.js', 'js/reference.js', 'js/tracker.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const OPTIONAL = ['reference.kml'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await Promise.all(OPTIONAL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
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
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  url.search = '';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(url.href);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(url.href, res.clone());
      return res;
    });
    if (!saved) return fresh;
    const giveUp = new Promise((resolve) => setTimeout(() => resolve(saved), 2500));
    return Promise.race([fresh.catch(() => saved), giveUp]);
  })());
});
