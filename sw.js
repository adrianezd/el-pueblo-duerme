'use strict';

/* Service worker: guarda el juego en el móvil para poder jugar sin conexión.
   Estrategia «stale-while-revalidate»: responde con la copia guardada y la
   actualiza en segundo plano, así los cambios llegan en la siguiente visita. */

const CACHE = 'el-pueblo-duerme-v1';
const CORE = ['./', 'index.html', 'style.css', 'kit.js', 'sala.js', 'sala.css', 'script.js', 'favicon.svg', 'manifest.json', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const cacheable = url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!cacheable) return;

  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request, { ignoreSearch: url.origin === self.location.origin }).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
