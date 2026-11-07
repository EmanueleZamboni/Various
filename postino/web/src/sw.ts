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
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/(privacy|terms)\/?$/, /^\/(oauth|mcp|\.well-known)(\/|$)/, /^\/(segretario|whatsapp|keep)(\/|$)/] }));

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

type PushPayload = { title?: string; body?: string; threadId?: string; accountId?: string; tag?: string; from?: string; account?: string; at?: number };

const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#c5221f', '#12b5cb', '#e52592', '#5f6368', '#0b8043'];

function initialsOf(name: string): string {
  const words = name.replace(/["'<>]/g, '').split(/[\s@._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const two = words.length > 1 && !name.includes('@') ? words[0][0] + words[1][0] : words[0][0];
  return two.toUpperCase();
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/**
 * The round picture on the left of the notification: the sender's photo or logo when Postino has
 * one, otherwise their initials on a colour, like the inbox. Drawn here because the phone shows
 * whatever image it gets, square and uncropped.
 */
async function senderIcon(name: string, email: string): Promise<string | undefined> {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  const size = 192;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  let drawn = false;
  if (email) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`/api/avatar?email=${encodeURIComponent(email)}`, { credentials: 'same-origin', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok && !/svg/i.test(res.headers.get('content-type') || '')) {
        const bmp = await createImageBitmap(await res.blob());
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        // Logos sit inset on white; photos fill the circle.
        const scale = Math.max(size / bmp.width, size / bmp.height);
        const w = bmp.width * scale;
        const h = bmp.height * scale;
        ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
        drawn = true;
      }
    } catch {
      /* fall back to initials */
    }
  }
  if (!drawn) {
    const seed = [...(email || name)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
    ctx.fillStyle = AVATAR_COLORS[seed % AVATAR_COLORS.length];
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    const text = initialsOf(name || email);
    ctx.font = `500 ${text.length > 1 ? 78 : 92}px Roboto, "Google Sans", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 4);
  }
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

self.addEventListener('push', (event) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'Postino', body: event.data?.text() ?? '' };
  }
  const title = data.title || 'New email';
  const isMail = Boolean(data.threadId);
  event.waitUntil(
    (async () => {
      const icon = (isMail ? await senderIcon(title, data.from || '').catch(() => undefined) : undefined) || '/icon-192.png';
      await self.registration.showNotification(title, {
        body: data.body ?? '',
        tag: data.tag ?? data.threadId ?? 'postino',
        icon,
        badge: '/badge-96.png',
        timestamp: data.at || Date.now(),
        data: { threadId: data.threadId, accountId: data.accountId },
        renotify: !!data.tag,
        actions: isMail
          ? [
              { action: 'archive', title: 'Archive' },
              { action: 'read', title: 'Mark as read' },
            ]
          : [],
      } as NotificationOptions);
    })(),
  );
});

/** Archive or mark read straight from the notification, without opening the app. */
async function actOnThread(threadId: string, action: 'archive' | 'read'): Promise<boolean> {
  try {
    const res = await fetch('/api/threads/actions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadIds: [threadId], action, view: 'inbox' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const threadId = (event.notification.data as { threadId?: string } | undefined)?.threadId;
  if (threadId && (event.action === 'archive' || event.action === 'read')) {
    // Signed out or offline: open the conversation instead, so nothing is silently lost.
    event.waitUntil(
      actOnThread(threadId, event.action).then((ok) => (ok ? undefined : self.clients.openWindow(`/t/${encodeURIComponent(threadId)}`).then(() => undefined))),
    );
    return;
  }
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
