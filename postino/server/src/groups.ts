import type { FastifyInstance } from 'fastify';
import { db } from './db.js';

/**
 * Sender groups: mail from a few exact addresses (e.g. Amazon Associates, Google security
 * alerts) collapses into one line in the inbox instead of flooding it. Matching is on the
 * exact sender address only — never a domain, never a guess — and a conversation stays in
 * the normal list as soon as anyone else (you included) has written in it.
 * Notifications keep coming for grouped senders.
 */

db.exec(`CREATE TABLE IF NOT EXISTS sender_groups (
  email TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Thread ids whose every message comes from senders of one single group (optionally a given one). */
export function groupedThreadsSql(group?: string): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT m.thread_id FROM messages m LEFT JOIN sender_groups sg ON sg.email = lower(m.from_email)
          WHERE m.thread_id IN (SELECT thread_id FROM messages WHERE from_email IN (SELECT email FROM sender_groups))
          GROUP BY m.thread_id
          HAVING SUM(CASE WHEN m.mine = 1 OR sg.email IS NULL THEN 1 ELSE 0 END) = 0
             AND COUNT(DISTINCT sg.group_name) = 1${group !== undefined ? ' AND MIN(sg.group_name) = ?' : ''}`,
    params: group !== undefined ? [group] : [],
  };
}

export function hasGroups(): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sender_groups LIMIT 1').get());
}

/** True when this sender is grouped and should still notify. */
export function groupedSenderNotifies(email: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sender_groups WHERE email = ? AND notify = 1').get(email.toLowerCase()));
}

const BRANDS: Record<string, string> = {
  amazon: 'Amazon', aliexpress: 'AliExpress', google: 'Google', vinted: 'Vinted', tiktok: 'TikTok', youtube: 'YouTube', impact: 'Impact',
  instagram: 'Instagram', facebookmail: 'Facebook', linkedin: 'LinkedIn', imile: 'AliExpress', temu: 'Temu', shein: 'Shein', ebay: 'eBay', zalando: 'Zalando',
};
// Automatic senders: no-reply robots, notification and newsletter addresses, shop updates, affiliate programmes.
const ROBOT = /^(no-?reply|noreply.*|do-?not-?reply|notifications?|notice|news(letter)?|updates?|alerts?|mailer|marketing|shipment-tracking|order-update|conferma-.*|shipping|associates|affiliate|partner|message|notes|product_team|ita)$/i;
// Never suggested: money, bills, tickets and account codes stay in the inbox.
const KEEP = /(fattur|invoice|billing|pagament|payment|paypal|bank|banca|ticket|bigliett|biglietteria|register|verify|code|otp)/i;

/** Who sends you regular automatic mail and is not grouped yet: offered as ready-made groups. */
export function groupSuggestions(): { name: string; senders: { email: string; count: number }[] }[] {
  const rows = db
    .prepare(
      `SELECT m.from_email AS email, COUNT(*) AS n, MAX(m.category) AS cat
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.mine = 0 AND m.date >= strftime('%Y-%m-%d', 'now', '-120 days') AND f.role IN ('inbox', 'archive')
         AND m.from_email <> '' AND m.from_email NOT IN (SELECT email FROM sender_groups)
         AND m.from_email NOT IN (SELECT lower(email) FROM accounts)
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.thread_id AND r.mine = 1)
       GROUP BY m.from_email HAVING n >= 3 ORDER BY n DESC LIMIT 200`,
    )
    .all() as { email: string; n: number; cat: string }[];
  const groups = new Map<string, { email: string; count: number }[]>();
  for (const r of rows) {
    const [local, domain = ''] = r.email.split('@');
    if (KEEP.test(r.email)) continue;
    if (!ROBOT.test(local) && r.cat === 'person') continue;
    const labels = domain.toLowerCase().split('.');
    const brandKey = labels.find((l) => BRANDS[l]) ?? labels[Math.max(0, labels.length - 2)];
    const name = /associates|affiliate|^partner$/i.test(local) || brandKey === 'impact' ? 'Affiliates' : BRANDS[brandKey] ?? brandKey.charAt(0).toUpperCase() + brandKey.slice(1);
    groups.set(name, [...(groups.get(name) ?? []), { email: r.email, count: r.n }]);
  }
  return [...groups].map(([name, senders]) => ({ name, senders })).sort((a, b) => b.senders.reduce((n, s) => n + s.count, 0) - a.senders.reduce((n, s) => n + s.count, 0));
}

export function registerGroupRoutes(app: FastifyInstance): void {
  app.get('/api/groups/suggestions', async () => ({ suggestions: groupSuggestions() }));

  app.post<{ Body: { groups?: { name?: string; senders?: string[] }[] } }>('/api/groups/bulk', async (req) => {
    const ins = db.prepare('INSERT OR IGNORE INTO sender_groups(email, group_name) VALUES (?, ?)');
    const own = new Set((db.prepare('SELECT lower(email) AS e FROM accounts').all() as { e: string }[]).map((r) => r.e));
    let n = 0;
    db.transaction(() => {
      for (const g of (req.body?.groups ?? []).slice(0, 50)) {
        const name = String(g.name || '').trim().slice(0, 60);
        if (!name) continue;
        for (const raw of (g.senders ?? []).slice(0, 200)) {
          const email = String(raw).trim().toLowerCase();
          if (EMAIL.test(email) && !own.has(email)) n += ins.run(email, name).changes;
        }
      }
    })();
    return { added: n };
  });


  app.get('/api/groups', async () => {
    const rows = db.prepare('SELECT email, group_name, notify FROM sender_groups ORDER BY group_name, email').all() as { email: string; group_name: string; notify: number }[];
    const groups = new Map<string, { name: string; senders: string[]; notify: boolean }>();
    for (const r of rows) {
      const g = groups.get(r.group_name) ?? { name: r.group_name, senders: [], notify: true };
      g.senders.push(r.email);
      g.notify = g.notify && Boolean(r.notify);
      groups.set(r.group_name, g);
    }
    return { groups: [...groups.values()] };
  });

  app.post<{ Body: { email?: string; group?: string } }>('/api/groups', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const group = String(req.body?.group || '').trim().slice(0, 60);
    if (!EMAIL.test(email)) return reply.code(400).send({ error: 'bad_email', message: 'That is not an email address.' });
    if (!group) return reply.code(400).send({ error: 'bad_group', message: 'Give the group a name.' });
    const own = db.prepare('SELECT 1 FROM accounts WHERE lower(email) = ?').get(email);
    if (own) return reply.code(400).send({ error: 'own_address', message: 'Your own addresses cannot be grouped.' });
    db.prepare('INSERT INTO sender_groups(email, group_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET group_name = excluded.group_name').run(email, group);
    return { ok: true };
  });

  app.delete<{ Params: { email: string } }>('/api/groups/sender/:email', async (req) => {
    db.prepare('DELETE FROM sender_groups WHERE email = ?').run(String(req.params.email).toLowerCase());
    return { ok: true };
  });

  app.patch<{ Body: { name?: string; newName?: string; notify?: boolean } }>('/api/groups', async (req, reply) => {
    const name = String(req.body?.name || '');
    if (typeof req.body?.notify === 'boolean') db.prepare('UPDATE sender_groups SET notify = ? WHERE group_name = ?').run(req.body.notify ? 1 : 0, name);
    const newName = String(req.body?.newName || '').trim().slice(0, 60);
    if (newName) db.prepare('UPDATE sender_groups SET group_name = ? WHERE group_name = ?').run(newName, name);
    if (!name) return reply.code(400).send({ error: 'bad_group', message: 'Which group?' });
    return { ok: true };
  });
}
