const CACHE = 'undercut-v3';
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/glow.js',
  '/fonts/instrument-sans-latin-wght-normal.woff2',
  '/fonts/bricolage-grotesque-latin-opsz-normal.woff2',
  '/fonts/jetbrains-mono-latin-wght-normal.woff2',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request.mode === 'navigate' ? '/' : event.request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(event.request.mode === 'navigate' ? '/' : event.request);
      return cached ?? Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Undercut price alert', {
    body: data.body || 'A player dropped under your price.',
    tag: data.tag || 'undercut',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        return client.navigate(target.href).catch(() => client);
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
