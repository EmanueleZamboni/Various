import { db } from './db.js';
import { safeFetch } from './avatars.js';
import { sendMail } from './mail/send.js';
import { runAction } from './routes/threads.js';
import { log } from './log.js';
import { htmlToText } from './mail/sanitize.js';
import { cleanSnippet } from './mail/parse.js';
import type { AccountRow } from './views.js';

/**
 * "Unsubscribe me from all newsletters": the senders Postino files as newsletters, the request
 * to each (RFC 8058 one-click, or the unsubscribe email the sender asks for), their old mail to
 * Trash, and a block for anyone still writing a week later.
 */


export type NewsletterSender = { email: string; name: string; count: number; latest: string; latestSubject: string; latestSnippet: string; method: 'one-click' | 'email' | 'none'; unsubscribedAt: string | null };

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
  const subjectOf = db.prepare('SELECT subject, snippet FROM messages WHERE lower(from_email) = ? ORDER BY date DESC LIMIT 1');
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
      latestSnippet: cleanSnippet(((subjectOf.get(r.email) as { snippet: string } | undefined)?.snippet ?? '')).slice(0, 160),
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
  return verifyWebUnsubscribe(url);
}

export const CONFIRMED = /(unsubscribed|you('ve| have) been removed|been unsubscribed|no longer (receive|be sent)|successfully (removed|opted out)|opted out|disiscritt|iscrizione (è stata )?(annullata|cancellata)|cancellazione (effettuata|completata|avvenuta)|non riceverai più|sei stat[oa] rimoss|rimoss[oa] dalla|désabonn|desuscrit|dado de baja|abgemeldet|abmeldung (war )?erfolgreich)/i;
const ASKS = /(confirm|conferma|are you sure|sei sicur|click (the button|below|here) to unsubscribe|clicca|unsubscribe from (all|this)|annulla (l'|l’)?iscrizione|cancella (l'|l’)?iscrizione)/i;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&') : null;
}

/** The first form on the page, as the browser would submit it with its first button. */
export function firstForm(html: string, base: string): { url: string; method: 'GET' | 'POST'; body: string } | null {
  const m = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!m) return null;
  const action = attr(m[1], 'action') || base;
  const method = (attr(m[1], 'method') || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const fields = new URLSearchParams();
  let button = false;
  for (const t of m[2].match(/<(input|button)\b[^>]*>/gi) || []) {
    const name = attr(t, 'name');
    const type = (attr(t, 'type') || (t.toLowerCase().startsWith('<button') ? 'submit' : 'text')).toLowerCase();
    if (!name) continue;
    if (type === 'submit' || type === 'image') {
      if (!button) fields.append(name, attr(t, 'value') || '');
      button = true;
      continue;
    }
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(t)) continue;
    fields.append(name, attr(t, 'value') || '');
  }
  const url = new URL(action, base).toString();
  return method === 'POST' ? { url, method, body: fields.toString() } : { url: `${url.split('?')[0]}?${fields.toString()}`, method, body: '' };
}

/**
 * Unsubscribe over the web and check the answer: RFC 8058 one-click first; if the sender instead
 * shows a page, read it, and when it asks for a confirmation press its button once. Only an
 * explicit "you are unsubscribed" counts as confirmed (a page that needs scripts stays unconfirmed).
 */
async function verifyWebUnsubscribe(url: string): Promise<{ method: string; result: string }> {
  const fetchPage = async (u: string, init: { method?: 'GET' | 'POST'; body?: string; type?: string }) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      return await safeFetch(u, {
        signal: ctrl.signal,
        method: init.method ?? 'GET',
        body: init.body,
        noRedirect: init.method === 'POST',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Postino)', accept: 'text/html,*/*', ...(init.type ? { 'content-type': init.type } : {}) },
      });
    } finally {
      clearTimeout(t);
    }
  };
  // 1. One-click.
  let res = await fetchPage(url, { method: 'POST', body: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' });
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await fetchPage(new URL(String(res.headers.get('location')), url).toString(), {});
  let html = await res.text(200_000);
  let text = htmlToText(html);
  if (res.status < 300 && CONFIRMED.test(text)) return { method: 'one-click', result: 'confirmed' };
  if (res.status < 300 && !text.trim()) return { method: 'one-click', result: 'confirmed (one-click accepted)' };
  // 2. The sender wants its page: open it like a browser.
  if (res.status >= 400 || !ASKS.test(text)) {
    res = await fetchPage(url, {});
    html = await res.text(200_000);
    text = htmlToText(html);
    if (res.ok && CONFIRMED.test(text) && !ASKS.test(text)) return { method: 'web page', result: 'confirmed' };
  }
  // 3. A confirmation button: press it once.
  const form = res.ok ? firstForm(html, res.url || url) : null;
  if (form && (ASKS.test(text) || /unsubscri|disiscriv|iscrizione/i.test(html))) {
    let r2 = await fetchPage(form.url, form.method === 'POST' ? { method: 'POST', body: form.body, type: 'application/x-www-form-urlencoded' } : {});
    if (r2.status >= 300 && r2.status < 400 && r2.headers.get('location')) r2 = await fetchPage(new URL(String(r2.headers.get('location')), form.url).toString(), {});
    if (r2.ok && CONFIRMED.test(htmlToText(await r2.text(200_000)))) return { method: 'web page + button', result: 'confirmed' };
  }
  return { method: 'web page', result: `not confirmed: their page needs a manual click (${res.status})` };

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
