import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { bus } from '../events.js';
import { manager } from '../mail/manager.js';
import { log } from '../log.js';
import { recomputeThread, type FolderRole } from '../mail/store.js';

type BlockedRow = { id: number; pattern: string; note: string; created_at: string };

export function normalizePattern(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  if (/[%_*?]/.test(p)) return null; // no wildcards: a pattern is one address or one domain
  if (/^@[^@\s]+\.[^@\s]+$/.test(p)) return p; // @domain
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) return p;
  if (/^[^@\s]+\.[^@\s]+$/.test(p)) return '@' + p; // bare domain
  return null;
}

/** True for one of the user's own addresses, aliases, or the domain of one of them. */
export function isOwn(pattern: string): boolean {
  const rows = db.prepare('SELECT lower(email) AS email, aliases FROM accounts').all() as { email: string; aliases: string }[];
  const own = new Set<string>();
  for (const r of rows) {
    own.add(r.email);
    try {
      for (const a of JSON.parse(r.aliases || '[]') as string[]) own.add(String(a).toLowerCase());
    } catch {
      // ignore
    }
  }
  if (own.has(pattern)) return true;
  if (pattern.startsWith('@')) return [...own].some((e) => e.endsWith(pattern));
  return false;
}

function matchSql(pattern: string): { sql: string; params: unknown[] } {
  if (pattern.startsWith('@')) return { sql: "m.from_email LIKE ?", params: [`%${pattern}`] };
  return { sql: 'm.from_email = ?', params: [pattern] };
}

/** Move every inbox message from a blocked sender to each account's Blocked folder. */
async function sweep(pattern: string, fromRole: FolderRole, toRole: FolderRole): Promise<number> {
  const { sql, params } = matchSql(pattern);
  const rows = db
    .prepare(`SELECT m.id, m.uid, m.folder_id, m.account_id, m.thread_id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.role = ? AND ${sql}`)
    .all(fromRole, ...params) as { id: number; uid: number; folder_id: number; account_id: number; thread_id: number }[];
  const byFolder = new Map<number, typeof rows>();
  for (const r of rows) byFolder.set(r.folder_id, [...(byFolder.get(r.folder_id) || []), r]);
  let moved = 0;
  for (const [folderId, list] of byFolder) {
    const sync = manager.get(list[0].account_id);
    if (!sync) continue;
    try {
      if (toRole === 'blocked') await sync.setFlags(folderId, list.map((m) => m.uid), ['\\Seen'], []);
      await sync.moveMessages(folderId, list.map((m) => m.uid), toRole, null);
      moved += list.length;
      const threads = new Set(list.map((m) => m.thread_id));
      for (const t of threads) {
        recomputeThread(t);
        bus.publish({ type: 'thread.updated', threadId: String(t), accountId: String(list[0].account_id) });
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'blocked sweep failed');
      bus.publish({ type: 'action.failed', message: `Could not move mail from ${pattern}: ${(err as Error).message}` });
    }
  }
  return moved;
}

function view(r: BlockedRow, counts?: Map<string, number>) {
  let count = counts?.get(r.pattern);
  if (count === undefined) {
    const { sql, params } = matchSql(r.pattern);
    count = (db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${sql}`).get(...params) as { n: number }).n;
  }
  return { id: String(r.id), pattern: r.pattern, note: r.note, createdAt: r.created_at, count };
}

/** One pass over the senders instead of a scan per blocked pattern. */
function countsFor(rows: BlockedRow[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!rows.length) return out;
  const senders = db.prepare('SELECT from_email AS email, COUNT(*) AS n FROM messages GROUP BY from_email').all() as { email: string; n: number }[];
  for (const r of rows) out.set(r.pattern, 0);
  for (const s of senders) {
    const domain = '@' + (s.email.split('@')[1] || '');
    for (const key of [s.email, domain]) if (out.has(key)) out.set(key, (out.get(key) || 0) + s.n);
  }
  return out;
}

export function registerBlockedRoutes(app: FastifyInstance): void {
  app.get('/api/blocked', async () => {
    const rows = db.prepare('SELECT * FROM blocked_senders ORDER BY created_at DESC').all() as BlockedRow[];
    const counts = countsFor(rows);
    return { senders: rows.map((r) => view(r, counts)) };
  });

  app.post<{ Body: { pattern?: string; note?: string } }>('/api/blocked', async (req, reply) => {
    const pattern = normalizePattern(String(req.body?.pattern || ''));
    if (!pattern) return reply.code(400).send({ error: 'invalid_pattern', message: 'Enter an email address or a domain like @example.com.' });
    if (isOwn(pattern)) return reply.code(400).send({ error: 'own_address', message: pattern.startsWith('@') ? 'That is the domain of one of your own addresses.' : 'That is one of your own addresses.' });
    db.prepare('INSERT INTO blocked_senders(pattern, note) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET note = excluded.note').run(pattern, String(req.body?.note || '').slice(0, 200));
    const row = db.prepare('SELECT * FROM blocked_senders WHERE pattern = ?').get(pattern) as BlockedRow;
    void sweep(pattern, 'inbox', 'blocked');
    return reply.code(201).send(view(row));
  });

  app.delete<{ Params: { id: string } }>('/api/blocked/:id', async (req, reply) => {
    db.prepare('DELETE FROM blocked_senders WHERE id = ?').run(Number(req.params.id));
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/blocked/:id/restore', async (req, reply) => {
    const row = db.prepare('SELECT * FROM blocked_senders WHERE id = ?').get(Number(req.params.id)) as BlockedRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const moved = await sweep(row.pattern, 'blocked', 'inbox');
    return { moved };
  });

  // Spark kept blocked mail in a "Blocked" folder; turn its senders into rules so new mail is caught too.
  app.get('/api/blocked/import', async () => {
    const rows = db
      .prepare(`SELECT m.from_email AS email, COUNT(*) AS n FROM messages m JOIN folders f ON f.id = m.folder_id
                WHERE f.role = 'blocked' AND m.from_email <> '' AND m.from_email NOT IN (SELECT pattern FROM blocked_senders)
                GROUP BY m.from_email ORDER BY n DESC`)
      .all() as { email: string; n: number }[];
    return { candidates: rows.map((r) => ({ email: r.email, count: r.n })) };
  });
  app.post('/api/blocked/import', async () => {
    const rows = db
      .prepare(`SELECT DISTINCT m.from_email AS email FROM messages m JOIN folders f ON f.id = m.folder_id
                WHERE f.role = 'blocked' AND m.from_email <> '' AND m.from_email NOT IN (SELECT pattern FROM blocked_senders)`)
      .all() as { email: string }[];
    const ins = db.prepare("INSERT OR IGNORE INTO blocked_senders(pattern, note) VALUES (?, 'Imported from the Blocked folder')");
    let added = 0;
    for (const r of rows) {
      if (isOwn(r.email)) continue;
      ins.run(r.email);
      added++;
    }
    return { added };
  });

  app.post<{ Body: { email?: string; category?: string } }>('/api/senders/category', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const category = String(req.body?.category || '');
    if (!email || !['person', 'notification', 'newsletter'].includes(category)) return reply.code(400).send({ error: 'invalid', message: 'Email and category are required.' });
    db.prepare('INSERT INTO sender_overrides(email, category) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET category = excluded.category').run(email, category);
    db.prepare('UPDATE messages SET category = ? WHERE from_email = ?').run(category, email);
    const threads = (db.prepare('SELECT DISTINCT thread_id FROM messages WHERE from_email = ?').all(email) as { thread_id: number }[]).map((r) => r.thread_id);
    for (const t of threads) {
      recomputeThread(t);
      bus.publish({ type: 'thread.updated', threadId: String(t), accountId: '' });
    }
    return { ok: true, threads: threads.length };
  });
}
