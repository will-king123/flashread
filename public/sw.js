const CACHE = 'quickread-v5';
const PRECACHE = ['/', '/index.html', '/app.js', '/analytics.js', '/styles.css', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/manifest.json', '/og-image.svg', '/privacy.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  if (request.method !== 'GET') return;

  const isAppShell = ['/app.js', '/styles.css', '/index.html'].includes(url.pathname);

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && url.origin === self.location.origin) {
        caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => {
      if (cached) return cached;
      if (isAppShell && url.pathname !== '/index.html') return caches.match('/index.html');
      return Response.error();
    }))
  );
});
