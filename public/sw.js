const CACHE = 'quickread-v6';
const PRECACHE = [
  '/',
  '/app',
  '/index.html',
  '/app.html',
  '/app.js',
  '/analytics.js',
  '/landing.js',
  '/styles.css',
  '/landing.css',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  '/og-image.svg',
  '/privacy.html',
];

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

function offlinePage(pathname) {
  if (pathname === '/app' || pathname.startsWith('/app/')) return '/app.html';
  return '/index.html';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(offlinePage(url.pathname)))
    );
    return;
  }

  if (request.method !== 'GET') return;

  const isAppShell = ['/app.js', '/styles.css', '/index.html', '/app.html', '/landing.js', '/landing.css'].includes(url.pathname);

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && url.origin === self.location.origin) {
        caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => {
      if (cached) return cached;
      if (isAppShell) return caches.match('/index.html');
      return Response.error();
    }))
  );
});
