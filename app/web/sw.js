/* Lets phones install Party Line to the home screen, and shows push notifications (private messages,
   @mentions, calls) when Party Line is closed. Everything else still comes fresh from the server. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    // Party Line just opened in a tab: the app shows its own notification, so don't double up.
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    return self.registration.showNotification(d.title || 'Party Line', {
      body: d.body || '', tag: d.tag, renotify: !!d.tag, icon: '/icon-512.png', badge: '/icon-512.png',
      data: { url: d.url || '/' }, requireInteraction: !!d.call, vibrate: d.call ? [300, 150, 300, 150, 300] : [120],
    });
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((x) => new URL(x.url).origin === url.origin);
    if (w) { w.postMessage({ open: url.pathname + url.search }); return w.focus(); }
    return self.clients.openWindow(url.href);
  }));
});
