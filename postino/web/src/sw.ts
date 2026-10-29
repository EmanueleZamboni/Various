/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { clientsClaim } from 'workbox-core';

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// App shell for navigations, except API and attachment URLs.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

// Session state is never served from cache: after signing out, nothing must look signed in.
const NEVER_CACHE = ['/api/me/', '/api/setup', '/api/login', '/api/logout', '/api/events', '/api/attachments', '/api/passkeys', '/api/google'];
const neverCache = (p: string) => p === '/api/me' || NEVER_CACHE.some((x) => p.startsWith(x));
// Reads are network-first with a bounded cache so the app opens offline with the last state.
registerRoute(
  ({ url, request }) => request.method === 'GET' && url.pathname.startsWith('/api/') && !neverCache(url.pathname),
  new NetworkFirst({ cacheName: 'postino-api', networkTimeoutSeconds: 8, plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 3 * 86400 })] }),
);
// The app asks the worker to forget everything on sign-out.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'postino:purge') event.waitUntil(caches.delete('postino-api'));
});
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());

type PushPayload = { title?: string; body?: string; threadId?: string; accountId?: string; tag?: string };

self.addEventListener('push', (event) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'Postino', body: event.data?.text() ?? '' };
  }
  const title = data.title || 'New email';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body ?? '',
      tag: data.tag ?? data.threadId ?? 'postino',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { threadId: data.threadId, accountId: data.accountId },
      renotify: !!data.tag,
    } as NotificationOptions),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const threadId = (event.notification.data as { threadId?: string } | undefined)?.threadId;
  const url = threadId ? `/t/${encodeURIComponent(threadId)}` : '/inbox';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) await (c as WindowClient).navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
