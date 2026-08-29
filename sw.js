/* Zahra's Maths Hub — service worker.
   Deliberately NETWORK-FIRST for the app itself: the teacher pushes updates
   often, and a cached copy must never hide a new version. The cache is only a
   fallback for when the phone is offline. */
const CACHE = 'mathhub-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(()=>{})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   /* leave Firebase, cdnjs etc. alone */

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});

/* ───────── notifications ───────── */
self.addEventListener('push', e => {
  let d = { title: "Zahra's Maths Hub", body: 'Open the app to see what is new.', url: './' };
  try { if (e.data) d = Object.assign(d, e.data.json()); } catch (err) { try { d.body = e.data.text(); } catch (e2) {} }
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: d.url || './' },
    tag: d.tag || 'mathhub',
    renotify: true
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }   /* already open — bring it forward */
    if (clients.openWindow) return clients.openWindow(target);
  }));
});
