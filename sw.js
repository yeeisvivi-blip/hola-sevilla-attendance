const CACHE_NAME = 'hola-sevilla-production-v9';
const BASE = new URL('./', self.location.href);
const SHELL = ['', 'index.html', 'styles.css?v=20260902-5', 'app.js?v=20260902-5', 'config.js?v=20260902-5', 'manifest.webmanifest', 'icon.svg']
  .map((path) => new URL(path, BASE).href);

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match(new URL('index.html', BASE).href);
        throw new Error('OFFLINE_RESOURCE_UNAVAILABLE');
      }),
  );
});
