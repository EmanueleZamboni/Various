import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { bus } from '../events.js';
import { manager } from '../mail/manager.js';
import { log } from '../log.js';
import { recomputeThread, type FolderRole } from '../mail/store.js';

type BlockedRow = { id: number; pattern: string; note: string; created_at: string };

function normalizePattern(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  if (/^@[^@\s]+\.[^@\s]+$/.test(p)) return p; // @domain
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) return p;
  if (/^[^@\s]+\.[^@\s]+$/.test(p)) return '@' + p; // bare domain
  return null;
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

function view(r: BlockedRow) {
  const { sql, params } = matchSql(r.pattern);
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${sql}`).get(...params) as { n: number }).n;
  return { id: String(r.id), pattern: r.pattern, note: r.note, createdAt: r.created_at, count };
}

export function registerBlockedRoutes(app: FastifyInstance): void {
  app.get('/api/blocked', async () => {
    const rows = db.prepare('SELECT * FROM blocked_senders ORDER BY created_at DESC').all() as BlockedRow[];
    return { senders: rows.map(view) };
  });

  app.post<{ Body: { pattern?: string; note?: string } }>('/api/blocked', async (req, reply) => {
    const pattern = normalizePattern(String(req.body?.pattern || ''));
    if (!pattern) return reply.code(400).send({ error: 'invalid_pattern', message: 'Enter an email address or a domain like @example.com.' });
    const mine = db.prepare('SELECT 1 FROM accounts WHERE lower(email) = ?').get(pattern);
    if (mine) return reply.code(400).send({ error: 'own_address', message: 'That is one of your own addresses.' });
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
      const mine = db.prepare('SELECT 1 FROM accounts WHERE lower(email) = ?').get(r.email);
      if (mine) continue;
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
