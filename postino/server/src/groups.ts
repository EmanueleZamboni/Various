import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { threadView } from './views.js';

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

// When each group was last opened: only mail after that counts as "new" on its bundle line.
db.exec(`CREATE TABLE IF NOT EXISTS group_seen (group_name TEXT PRIMARY KEY, seen_at TEXT NOT NULL)`);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Which conversations belong to a group. Working it out scans every message from grouped
// senders, so it is kept in a small table and recomputed at most once a minute (or at once
// when the groups themselves change), instead of on every list, action and new email.
db.exec(`CREATE TABLE IF NOT EXISTS group_threads (thread_id INTEGER PRIMARY KEY, group_name TEXT NOT NULL)`);
let groupThreadsAt = 0;

export function refreshGroupThreads(force = false): void {
  if (!force && Date.now() - groupThreadsAt < 60_000) return;
  groupThreadsAt = Date.now();
  db.transaction(() => {
    db.exec('DELETE FROM group_threads');
    db.exec(`INSERT INTO group_threads(thread_id, group_name)
      SELECT m.thread_id, MIN(sg.group_name) FROM messages m LEFT JOIN sender_groups sg ON sg.email = lower(m.from_email)
      WHERE m.thread_id IN (SELECT thread_id FROM messages WHERE from_email IN (SELECT email FROM sender_groups))
      GROUP BY m.thread_id
      HAVING SUM(CASE WHEN m.mine = 1 OR sg.email IS NULL THEN 1 ELSE 0 END) = 0 AND COUNT(DISTINCT sg.group_name) = 1`);
  })();
}

/** Thread ids whose every message comes from senders of one single group (optionally a given one). */
export function groupedThreadsSql(group?: string): { sql: string; params: unknown[] } {
  refreshGroupThreads();
  return group !== undefined
    ? { sql: 'SELECT thread_id FROM group_threads WHERE group_name = ?', params: [group] }
    : { sql: 'SELECT thread_id FROM group_threads', params: [] };
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
const KEEP = /(fattur|invoice|billing|pagament|payment|paypal|bank|banca|ticket|bigliett|biglietteria|register|verify|code|otp|revolut|n26|nexi|satispay|pagopa|sumup|binance|klarna|trenitalia|italotreno|booking|airbnb|ryanair|fedex|dhl|ups\.com|brt|gls|poste|sanitari|millewin|psicogest|iren|plenitude|enel|iliad|corrente|io\.italia|agenziaentrate|inps)/i;

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

/**
 * Grouped mail that still deserves a look: money that did not go through, codes and sign-ins,
 * sales and shipping labels, deliveries in trouble, bills, things about to expire.
 * Shown under the Groups row while unread, never hidden inside a group.
 */
const IMPORTANT = new RegExp(
  [
    // Routine sign-in alerts ("Security alert", "new sign-in") stay inside their group: they come
    // for every login, often to two mailboxes. Unusual activity still stands out.
    'unusual', 'insolit', 'suspicious', 'sospett', 'password', 'codice', 'verification code', '\\bcode\\b', '\\botp\\b', 'verific',
    'payment (failed|declined|unsuccessful)', 'pagamento (non riuscito|rifiutato|fallito|non andato)', 'declined', 'rifiutat', 'insolut', 'overdue', 'scadut', 'in scadenza', 'expir', 'scade',
    'rimborso', 'refund', 'fattura', 'invoice', 'ricevuta di pagamento',
    'hai venduto', 'venduto', 'you sold', 'etichetta di spedizione', 'shipping label', 'da spedire', 'ricorda di spedire', 'offerta', 'new offer', 'ti ha (scritto|inviato)', 'nuovo messaggio', 'new message',
    'consegna (non riuscita|fallita|tentata)', 'delivery (failed|attempt|exception)', 'giacenza', 'da ritirare', 'ready for pickup', 'reso', 'return',
    'sospes', 'suspend', 'bloccat', 'locked', 'azione richiesta', 'action required', 'urgent', 'importante', 'important', 'disputa', 'dispute', 'reclamo', 'problema', 'problem', 'annullat', 'cancel',
  ].join('|'),
  'i',
);
export const isImportant = (subject: string, snippet = '') => IMPORTANT.test(subject) || IMPORTANT.test(snippet.slice(0, 200));

type SummaryRow = { id: number; last_date: string; unread_count: number; last_from: string; subject: string; snippet: string; g: string };

/** Inbox threads that belong to a group, newest first, with the group name. */
export function groupedInboxThreads(accountId: number | null, group?: string): SummaryRow[] {
  refreshGroupThreads();
  const params: unknown[] = [];
  let where = "t.roles LIKE '%,inbox,%'";
  if (accountId) {
    where += ' AND t.account_id = ?';
    params.push(accountId);
  }
  if (group !== undefined) {
    where += ' AND gt.group_name = ?';
    params.push(group);
  }
  return db
    .prepare(
      `SELECT t.id, t.last_date, t.unread_count, t.last_from, t.subject, t.snippet, gt.group_name AS g FROM threads t
       JOIN group_threads gt ON gt.thread_id = t.id
       WHERE ${where} ORDER BY t.last_date DESC, t.id DESC`,
    )
    .all(...params) as SummaryRow[];
}

/**
 * One line per group for the inbox: where it sits in time (its newest mail), what that mail is,
 * how many conversations it holds, and how many arrived unread since the group was last opened.
 */
export function groupSummaries(accountId: number | null) {
  const seen = new Map((db.prepare(`SELECT sg.group_name AS g, COALESCE(gs.seen_at, MIN(sg.created_at)) AS seen FROM sender_groups sg LEFT JOIN group_seen gs ON gs.group_name = sg.group_name GROUP BY sg.group_name`).all() as { g: string; seen: string }[]).map((r) => [r.g, r.seen]));
  const out = new Map<string, { name: string; latestDate: string; latestThreadId: string; latestFrom: { name: string; email: string }; latestSubject: string; total: number; fresh: number; important: number }>();
  for (const r of groupedInboxThreads(accountId)) {
    let g = out.get(r.g);
    if (!g) {
      let from = { name: '', email: '' };
      try {
        from = JSON.parse(r.last_from) as typeof from;
      } catch {
        /* keep empty */
      }
      g = { name: r.g, latestDate: r.last_date, latestThreadId: String(r.id), latestFrom: from, latestSubject: r.subject, total: 0, fresh: 0, important: 0 };
      out.set(r.g, g);
    }
    g.total++;
    if (r.unread_count > 0 && r.last_date > (seen.get(r.g) ?? '')) g.fresh++;
    if (r.unread_count > 0 && isImportant(r.subject, r.snippet)) g.important++;
  }
  return [...out.values()];
}

/** Unread grouped conversations that look important, newest first. */
export function importantGroupedThreadIds(accountId: number | null, limit = 5): number[] {
  // The same alert often reaches two of your mailboxes (e.g. Google copies security alerts to the
  // recovery address): show it once.
  const seen = new Set<string>();
  return groupedInboxThreads(accountId)
    .filter((r) => r.unread_count > 0 && isImportant(r.subject, r.snippet))
    .filter((r) => {
      const key = `${r.g}|${r.last_date.slice(0, 16)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map((r) => r.id);
}

export function markGroupSeen(name: string): void {
  db.prepare("INSERT INTO group_seen(group_name, seen_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(group_name) DO UPDATE SET seen_at = excluded.seen_at").run(name);
}

/** All groups with their senders. */
export function listGroups(): { name: string; senders: string[]; notify: boolean; lastUsed: string }[] {
  const rows = db.prepare('SELECT email, group_name, notify, created_at FROM sender_groups ORDER BY group_name, email').all() as { email: string; group_name: string; notify: number; created_at: string }[];
  const groups = new Map<string, { name: string; senders: string[]; notify: boolean; lastUsed: string }>();
  for (const r of rows) {
    const g = groups.get(r.group_name) ?? { name: r.group_name, senders: [], notify: true, lastUsed: '' };
    g.senders.push(r.email);
    g.notify = g.notify && Boolean(r.notify);
    if (r.created_at > g.lastUsed) g.lastUsed = r.created_at; // when a sender was last put in it
    groups.set(r.group_name, g);
  }
  return [...groups.values()];
}

/**
 * Put exact sender addresses in a group. `move` re-files senders already in another group;
 * otherwise they are left where they are. Your own addresses and non-addresses are skipped.
 */
export function addSenders(group: string, senders: string[], move = false): { added: number; skipped: string[] } {
  const name = String(group || '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('Give the group a name.'), { statusCode: 400 });
  const own = new Set((db.prepare('SELECT lower(email) AS e FROM accounts').all() as { e: string }[]).map((r) => r.e));
  const ins = db.prepare(move ? `INSERT INTO sender_groups(email, group_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET group_name = excluded.group_name, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')` : 'INSERT OR IGNORE INTO sender_groups(email, group_name) VALUES (?, ?)');
  let added = 0;
  const skipped: string[] = [];
  db.transaction(() => {
    for (const raw of senders.slice(0, 200)) {
      const email = String(raw).trim().toLowerCase();
      if (!EMAIL.test(email) || own.has(email)) {
        skipped.push(String(raw));
        continue;
      }
      const n = ins.run(email, name).changes;
      if (n) added += n;
      else skipped.push(email);
    }
  })();
  if (added) refreshGroupThreads(true);
  return { added, skipped };
}

export function removeSender(email: string): boolean {
  const gone = db.prepare('DELETE FROM sender_groups WHERE email = ?').run(String(email).trim().toLowerCase()).changes > 0;
  if (gone) refreshGroupThreads(true);
  return gone;
}

export function updateGroup(name: string, change: { newName?: string; notify?: boolean }): number {
  let n = 0;
  if (typeof change.notify === 'boolean') n = db.prepare('UPDATE sender_groups SET notify = ? WHERE group_name = ?').run(change.notify ? 1 : 0, name).changes;
  const newName = String(change.newName || '').trim().slice(0, 60);
  if (newName) {
    n = db.prepare('UPDATE sender_groups SET group_name = ? WHERE group_name = ?').run(newName, name).changes;
    db.prepare('UPDATE OR REPLACE group_seen SET group_name = ? WHERE group_name = ?').run(newName, name);
    refreshGroupThreads(true);
  }
  return n;
}

export function registerGroupRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { account?: string } }>('/api/groups/summary', async (req) => ({ groups: groupSummaries(req.query.account ? Number(req.query.account) : null) }));

  app.get<{ Querystring: { account?: string } }>('/api/groups/important', async (req) => {
    const ids = importantGroupedThreadIds(req.query.account ? Number(req.query.account) : null);
    const stmt = db.prepare('SELECT * FROM threads WHERE id = ?');
    return { threads: ids.map((id) => stmt.get(id)).filter(Boolean).map((t) => threadView(t as never)) };
  });

  app.post<{ Body: { name?: string } }>('/api/groups/seen', async (req) => {
    if (req.body?.name) markGroupSeen(String(req.body.name).slice(0, 60));
    return { ok: true };
  });

  app.get('/api/groups/suggestions', async () => ({ suggestions: groupSuggestions() }));

  app.post<{ Body: { groups?: { name?: string; senders?: string[] }[] } }>('/api/groups/bulk', async (req) => {
    let n = 0;
    for (const g of (req.body?.groups ?? []).slice(0, 50)) {
      if (!String(g.name || '').trim()) continue;
      n += addSenders(String(g.name), (g.senders ?? []).map(String)).added;
    }
    return { added: n };
  });

  app.get('/api/groups', async () => ({ groups: listGroups() }));

  app.post<{ Body: { email?: string; group?: string } }>('/api/groups', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const group = String(req.body?.group || '').trim().slice(0, 60);
    if (!EMAIL.test(email)) return reply.code(400).send({ error: 'bad_email', message: 'That is not an email address.' });
    if (!group) return reply.code(400).send({ error: 'bad_group', message: 'Give the group a name.' });
    const own = db.prepare('SELECT 1 FROM accounts WHERE lower(email) = ?').get(email);
    if (own) return reply.code(400).send({ error: 'own_address', message: 'Your own addresses cannot be grouped.' });
    db.prepare(`INSERT INTO sender_groups(email, group_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET group_name = excluded.group_name, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(email, group);
    refreshGroupThreads(true);
    return { ok: true };
  });

  app.delete<{ Params: { email: string } }>('/api/groups/sender/:email', async (req) => {
    removeSender(req.params.email);
    return { ok: true };
  });

  app.patch<{ Body: { name?: string; newName?: string; notify?: boolean } }>('/api/groups', async (req, reply) => {
    const name = String(req.body?.name || '');
    if (!name) return reply.code(400).send({ error: 'bad_group', message: 'Which group?' });
    updateGroup(name, { newName: req.body?.newName, notify: req.body?.notify });
    return { ok: true };
  });
}
