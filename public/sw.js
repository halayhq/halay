// Service worker: shows Web Push notifications (works with the page closed) and opens the agent when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((d.title ? Promise.resolve(d.title) : fetch('/manifest.webmanifest').then((r) => r.json()).then((m) => m.name, () => 'halay')).then((title) => self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag, // one notification per agent; also dedupes with the page's own Notification
    renotify: !!d.tag, // a repeat with the same tag still alerts (renotify needs a tag)
    icon: '/icon-192.png',
    badge: '/badge-96.png', // monochrome: Android draws only its alpha
    data: { url: d.url || '/' },
  })));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === url.origin);
    if (w) { await w.focus(); w.postMessage({ type: 'goto', hash: url.hash.replace(/^#/, '') || '/' }); return; }
    await self.clients.openWindow(url.href);
  })());
});
