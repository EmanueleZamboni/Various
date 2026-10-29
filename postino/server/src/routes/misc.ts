import { isAuthenticated } from '../auth.js';
import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { bus, type AppEvent } from '../events.js';
import { searchThreads, rememberSearch } from '../search.js';
import { threadView } from '../views.js';
import type { ThreadRow } from '../mail/store.js';
import { sendPush } from '../push.js';
import { uiSettings, updateUiSettings } from '../settings.js';
import type { Address } from '../mail/parse.js';
import { manager } from '../mail/manager.js';
import { getAvatar } from '../avatars.js';
import fs from 'node:fs';

export function registerMiscRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { q?: string; account?: string; limit?: string; before?: string } }>('/api/search', async (req) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Number(req.query.before) || 0;
    if (!q) return { threads: [], nextCursor: null, counts: { unread: 0, total: 0 }, highlights: {} };
    const r = searchThreads(q, { accountId: req.query.account ? Number(req.query.account) : null, limit, offset });
    if (offset === 0) rememberSearch(q);
    const stmt = db.prepare('SELECT * FROM threads WHERE id = ?');
    const drafts = new Set((db.prepare('SELECT DISTINCT thread_id FROM drafts WHERE thread_id IS NOT NULL').all() as { thread_id: number }[]).map((x) => x.thread_id));
    const threads = [];
    const highlights: Record<string, string> = {};
    for (const hit of r.results) {
      const t = stmt.get(hit.threadId) as ThreadRow | undefined;
      if (!t) continue;
      threads.push(threadView(t, { draft: drafts.has(t.id) }));
      if (hit.highlight) highlights[String(t.id)] = hit.highlight;
    }
    const next = offset + r.results.length;
    return { threads, nextCursor: next < r.total ? String(next) : null, counts: { unread: threads.filter((t) => t.unread).length, total: r.total }, highlights };
  });

  app.get<{ Querystring: { q?: string } }>('/api/search/suggest', async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const term = q.replace(/^(from|to|cc):/i, '');
    const contacts = term
      ? (db.prepare('SELECT email, name FROM contacts WHERE lower(email) LIKE ? OR lower(name) LIKE ? ORDER BY count DESC LIMIT 6').all(`%${term}%`, `%${term}%`) as Address[])
      : [];
    const recent = (db.prepare('SELECT query FROM recent_searches WHERE query LIKE ? ORDER BY used_at DESC LIMIT 6').all(`%${q}%`) as { query: string }[]).map((r) => r.query);
    return { contacts, recent };
  });

  app.get('/api/settings', async () => uiSettings());

  app.put<{ Body: unknown }>('/api/settings', async (req) => updateUiSettings(req.body || {}));

  app.post<{ Body: { subscription?: { endpoint?: string } } }>('/api/push/subscribe', async (req, reply) => {
    const sub = req.body?.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
    let ok = false;
    try {
      ok = !!sub && typeof sub.endpoint === 'string' && new URL(sub.endpoint).protocol === 'https:' && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string' && JSON.stringify(sub).length < 4000;
    } catch {
      ok = false;
    }
    if (!ok || !sub) return reply.code(400).send({ error: 'invalid', message: 'That push subscription is not valid.' });
    db.prepare('INSERT INTO push_subscriptions(endpoint, subscription_json, user_agent) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json').run(
      sub.endpoint,
      JSON.stringify(sub),
      String(req.headers['user-agent'] || '').slice(0, 200),
    );
    return reply.code(204).send();
  });

  app.delete<{ Body: { endpoint?: string } }>('/api/push/subscribe', async (req, reply) => {
    if (req.body?.endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(req.body.endpoint);
    return reply.code(204).send();
  });

  app.post('/api/push/test', async (_req, reply) => {
    await sendPush({ title: 'Postino', body: 'Notifications are working on this device.', tag: 'test' });
    return reply.code(204).send();
  });

  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const onEvent = (ev: AppEvent) => {
      const { type, ...data } = ev;
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('event', onEvent);
    });
    // Keep the reply open; Fastify will not end it because we hijacked the raw stream.
    reply.hijack();
  });

  app.get<{ Querystring: { email?: string } }>('/api/avatar', async (req, reply) => {
    const email = String(req.query.email || '');
    const a = await getAvatar(email);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (a === 'pending') {
      reply.header('Cache-Control', 'private, max-age=20');
      return reply.code(404).send();
    }
    if (!a) {
      reply.header('Cache-Control', 'private, max-age=86400');
      return reply.code(404).send();
    }
    reply.header('Content-Type', a.contentType);
    reply.header('Cache-Control', 'private, max-age=604800');
    // SVG logos (BIMI) must never run scripts, even if someone opens the URL directly.
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.send(fs.createReadStream(a.file));
  });

  app.get('/api/health', async (req) => (isAuthenticated(req) ? { ok: true, accounts: manager.all().length, uptime: Math.round(process.uptime()) } : { ok: true }));
}
