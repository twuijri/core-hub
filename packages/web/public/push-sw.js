/*
 * Core Hub's service worker for Web Push (DECISIONS §56). It does one thing: show the
 * notice the hub pushed, and open what it points at when it is clicked. No caching, no
 * offline mode — the app is the hub's, and a stale copy of it would be worse than none.
 *
 * The payload is the one every client reads (`packages/server/src/modules/devices/
 * senders.ts`, `pushPayload`): { type, notice_id, kind, title, body, profile, resource }.
 */
/* global self */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Where a notice opens: its conversation, its workflow run, or the inbox. */
function targetOf(notice) {
  const resource = notice && notice.resource;
  if (resource && resource.kind === 'session') return `/chat/${encodeURIComponent(resource.id)}`;
  if (resource && resource.kind === 'workflow_run') {
    const query = new URLSearchParams({ workflow_run: resource.id });
    if (notice.profile) query.set('profile', notice.profile);
    return `/schedules?${query.toString()}`;
  }
  return '/settings/notifications';
}

self.addEventListener('push', (event) => {
  let notice;
  try {
    notice = event.data ? event.data.json() : null;
  } catch {
    notice = null;
  }
  if (!notice || typeof notice.title !== 'string') return;
  event.waitUntil(
    self.registration.showNotification(notice.title, {
      body: notice.body || '',
      tag: notice.notice_id || undefined,
      icon: '/favicon.svg',
      data: { url: targetOf(notice) },
      requireInteraction: notice.kind === 'approval_requested',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus().then((focused) => focused.navigate(url));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
