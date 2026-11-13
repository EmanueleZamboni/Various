import { db } from './db.js';
import { safeFetch } from './avatars.js';
import { sendMail } from './mail/send.js';
import { runAction } from './routes/threads.js';
import { log } from './log.js';
import type { AccountRow } from './views.js';

/**
 * "Unsubscribe me from all newsletters": the senders Postino files as newsletters, the request
 * to each (RFC 8058 one-click, or the unsubscribe email the sender asks for), their old mail to
 * Trash, and a block for anyone still writing a week later.
 */


export type NewsletterSender = { email: string; name: string; count: number; latest: string; latestSubject: string; method: 'one-click' | 'email' | 'none'; unsubscribedAt: string | null };

/** Addresses Ema has written to, and his own mailboxes' addresses and domains: never newsletters to drop. */
function protectedSenders(): { emails: Set<string>; domains: Set<string> } {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const a of db.prepare('SELECT email, aliases FROM accounts').all() as { email: string; aliases: string | null }[]) {
    for (const e of [a.email, ...(a.aliases ? (JSON.parse(a.aliases) as string[]) : [])]) {
      emails.add(e.toLowerCase());
      domains.add(e.toLowerCase().split('@')[1] || '');
    }
  }
  for (const r of db.prepare('SELECT to_json, cc_json FROM messages WHERE mine = 1').iterate() as Iterable<{ to_json: string; cc_json: string }>) {
    for (const j of [r.to_json, r.cc_json]) {
      try {
        for (const x of JSON.parse(j || '[]') as { email?: string }[]) if (x.email) emails.add(x.email.toLowerCase());
      } catch {
        // ignore a malformed row
      }
    }
  }
  for (const r of db.prepare('SELECT email FROM safe_senders').all() as { email: string }[]) emails.add(r.email);
  // Brand offers and mail Claude marked important are not "newsletters", whatever their look.
  for (const r of db.prepare("SELECT DISTINCT lower(m.from_email) AS e FROM ai_triage t JOIN messages m ON m.id = t.message_row WHERE t.kind = 'brand_deal' OR t.important = 1").all() as { e: string }[]) emails.add(r.e);
  return { emails, domains };
}

/** Newsletter senders of the last `months` months, most mail first. */
export function newsletterSenders(months = 12): NewsletterSender[] {
  const since = new Date(Date.now() - months * 30 * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT lower(m.from_email) AS email, m.from_json, COUNT(*) AS n, MAX(m.date) AS latest
       FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.category = 'newsletter' AND m.mine = 0 AND m.date >= ? AND f.role IN ('inbox', 'archive', 'other')
       GROUP BY lower(m.from_email) ORDER BY n DESC`,
    )
    .all(since) as { email: string; from_json: string; n: number; latest: string }[];
  const keep = protectedSenders();
  const latestOf = db.prepare("SELECT subject, list_unsubscribe FROM messages WHERE lower(from_email) = ? AND list_unsubscribe IS NOT NULL AND list_unsubscribe != '' ORDER BY date DESC LIMIT 1");
  const subjectOf = db.prepare('SELECT subject FROM messages WHERE lower(from_email) = ? ORDER BY date DESC LIMIT 1');
  const done = db.prepare('SELECT at FROM unsubscribed WHERE email = ?');
  const out: NewsletterSender[] = [];
  for (const r of rows) {
    if (!r.email || keep.emails.has(r.email) || keep.domains.has(r.email.split('@')[1] || '')) continue;
    const u = latestOf.get(r.email) as { subject: string; list_unsubscribe: string } | undefined;
    let name = '';
    try {
      name = (JSON.parse(r.from_json) as { name?: string }).name || '';
    } catch {
      // no name
    }
    out.push({
      email: r.email,
      name,
      count: r.n,
      latest: r.latest,
      latestSubject: (u?.subject ?? (subjectOf.get(r.email) as { subject: string } | undefined)?.subject ?? '').slice(0, 120),
      method: !u ? 'none' : /^mailto:/i.test(u.list_unsubscribe) ? 'email' : 'one-click',
      unsubscribedAt: ((done.get(r.email) as { at: string } | undefined)?.at) ?? null,
    });
  }
  return out;
}

async function requestUnsubscribe(email: string): Promise<{ method: string; result: string }> {
  const m = db
    .prepare("SELECT account_id, list_unsubscribe FROM messages WHERE lower(from_email) = ? AND list_unsubscribe IS NOT NULL AND list_unsubscribe != '' ORDER BY date DESC LIMIT 1")
    .get(email) as { account_id: number; list_unsubscribe: string } | undefined;
  if (!m) return { method: 'none', result: 'no unsubscribe link: will be blocked if it keeps writing' };
  const url = m.list_unsubscribe;
  if (/^mailto:/i.test(url)) {
    const u = new URL(url);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(m.account_id) as AccountRow | undefined;
    if (!account) return { method: 'email', result: 'mailbox gone' };
    await sendMail({ account, to: u.pathname, subject: (u.searchParams.get('subject') || 'Unsubscribe').replace(/[\r\n]/g, ' ').slice(0, 200), text: u.searchParams.get('body') || 'Unsubscribe', attachments: [] });
    return { method: 'email', result: 'unsubscribe email sent' };
  }
  // RFC 8058 one-click: a POST with this exact body. Senders that do not support it just answer
  // with a page; the week-later block covers them.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await safeFetch(url, {
      signal: ctrl.signal,
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      noRedirect: true,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (compatible; Postino)' },
    });
    return { method: 'one-click', result: res.status < 400 ? `accepted (${res.status})` : `refused (${res.status})` };
  } finally {
    clearTimeout(t);
  }
}

/** Unsubscribe from these senders; their mail already received goes to Trash when asked. */
export async function unsubscribeSenders(emails: string[], opts: { trashExisting: boolean }): Promise<{ email: string; method: string; result: string; trashed: number }[]> {
  const known = new Map(newsletterSenders(24).map((s) => [s.email, s]));
  const out: { email: string; method: string; result: string; trashed: number }[] = [];
  for (const raw of [...new Set(emails.map((e) => e.trim().toLowerCase()))].slice(0, 500)) {
    const s = known.get(raw);
    if (!s) {
      out.push({ email: raw, method: 'none', result: 'skipped: not a newsletter sender (or one you wrote to)', trashed: 0 });
      continue;
    }
    let r: { method: string; result: string };
    try {
      r = await requestUnsubscribe(raw);
    } catch (err) {
      r = { method: s.method, result: `failed: ${(err as Error).message}`.slice(0, 200) };
    }
    db.prepare('INSERT INTO unsubscribed(email, name, method, result) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET method = excluded.method, result = excluded.result, at = excluded.at').run(raw, s.name, r.method, r.result);
    let trashed = 0;
    if (opts.trashExisting) {
      // Only conversations that are entirely from this sender (never one with your replies in it).
      const threads = (
        db
          .prepare(
            `SELECT DISTINCT m.thread_id AS id FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE lower(m.from_email) = ? AND f.role IN ('inbox', 'archive', 'other')
               AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.thread_id = m.thread_id AND (x.mine = 1 OR lower(x.from_email) != ?))`,
          )
          .all(raw, raw) as { id: number }[]
      ).map((x) => String(x.id));
      for (let i = 0; i < threads.length; i += 200) {
        try {
          trashed += (await runAction({ threadIds: threads.slice(i, i + 200), action: 'trash', scope: 'all' })).affected;
        } catch (err) {
          log.warn({ sender: raw, err: (err as Error).message }, 'could not trash old newsletters');
        }
      }
    }
    out.push({ email: raw, ...r, trashed });
  }
  return out;
}
