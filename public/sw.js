/* Service Worker: Push-Benachrichtigungen + einfacher Offline-Cache der App-Hülle */
const CACHE = 'revierapp-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/icons/icon.svg', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet-draw/leaflet.draw.js', '/vendor/leaflet-draw/leaflet.draw.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const TILE_HOSTS = /tile\.opentopomap\.org|tile\.openstreetmap\.org|arcgisonline\.com/;
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && TILE_HOSTS.test(url.host)) {
    // Kartenkacheln: zuerst aus dem Offline-Speicher, sonst Netz (und dann merken, wenn bereits ein Offline-Bestand existiert)
    e.respondWith(caches.open('revier-tiles').then(async c => {
      const hit = await c.match(e.request.url); if (hit) return hit;
      const res = await fetch(e.request);
      if ((await c.keys()).length) c.put(e.request.url, res.clone()).catch(() => {});
      return res;
    }).catch(() => fetch(e.request)));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'RevierApp', body: '', url: '/' };
  try { data = { ...data, ...e.data.json() }; } catch { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
    data: { url: data.url },
    vibrate: [100, 50, 100],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if ('focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
