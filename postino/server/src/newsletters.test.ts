import { describe, it, expect } from 'vitest';
import { db } from './db.js';
import { newsletterSenders, unsubscribeSenders } from './newsletters.js';
import { ignoresUnsubscribe } from './mail/store.js';

describe('unsubscribe from newsletters', () => {
  const stamp = Date.now();
  db.prepare("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, enabled) VALUES (93, 'me@nl.test', 'Me', '#000', 'h', 1, 1, 'h', 1, 1, 'u', 'x', 0)").run();
  const folder = db.prepare("INSERT INTO folders(account_id, path, name, role) VALUES (93, ?, 'Inbox', 'inbox')").run(`nl-${stamp}`).lastInsertRowid;
  let uid = 1;
  const add = (from: string, opts: { mine?: boolean; to?: string; category?: string; unsub?: string | null } = {}) => {
    const thread = db.prepare("INSERT INTO threads(account_id, subject, last_date) VALUES (93, 'Weekly', ?)").run(new Date().toISOString()).lastInsertRowid;
    return Number(
      db
        .prepare("INSERT INTO messages(account_id, folder_id, uid, thread_id, subject, date, from_json, from_email, to_json, cc_json, bcc_json, category, mine, list_unsubscribe) VALUES (93, ?, ?, ?, 'Weekly deals', ?, ?, ?, ?, '[]', '[]', ?, ?, ?)")
        .run(folder, uid++, thread, new Date().toISOString(), JSON.stringify({ name: 'Shop', email: from }), from, JSON.stringify(opts.to ? [{ email: opts.to }] : []), opts.category ?? 'newsletter', opts.mine ? 1 : 0, opts.unsub ?? null).lastInsertRowid,
    );
  };
  const news = `news-${stamp}@shop.test`;
  const friend = `friend-${stamp}@people.test`;
  const brand = `brand-${stamp}@brand.test`;
  add(news);
  add(news);
  add(friend);
  add('me@nl.test', { mine: true, to: friend, category: 'person' });
  const b = add(brand);
  db.prepare("INSERT INTO ai_triage(message_row, thread_id, kind, important, reason) VALUES (?, 0, 'brand_deal', 0, 'offer')").run(b);

  it('lists newsletter senders, leaving out people you wrote to and brand offers', () => {
    const list = newsletterSenders(12);
    const mine = list.filter((x) => x.email.endsWith('.test') && x.email.includes(String(stamp)));
    expect(mine.map((x) => x.email)).toEqual([news]);
    expect(mine[0]).toMatchObject({ count: 2, method: 'none' });
  });

  it('records the request, refuses senders not on the list, and blocks one still writing a week later', async () => {
    const r = await unsubscribeSenders([news, friend], { trashExisting: false });
    expect(r.find((x) => x.email === news)?.result).toMatch(/no unsubscribe link/);
    expect(r.find((x) => x.email === friend)?.result).toMatch(/skipped/);
    expect(ignoresUnsubscribe(news)).toBe(false);
    db.prepare('UPDATE unsubscribed SET at = ? WHERE email = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString(), news);
    expect(ignoresUnsubscribe(news)).toBe(true);
    expect(ignoresUnsubscribe(friend)).toBe(false);
  });
});

describe('reading unsubscribe pages', () => {
  it('finds the confirmation form and recognises a confirmation', async () => {
    const { firstForm, CONFIRMED } = await import('./newsletters.js');
    const page = `<html><body><p>Are you sure?</p><form action="/unsub/confirm" method="post"><input type="hidden" name="token" value="abc&amp;1"><input type="checkbox" name="all"><button type="submit" name="go" value="yes">Unsubscribe</button></form></body></html>`;
    expect(firstForm(page, 'https://mail.shop.test/u/1')).toEqual({ url: 'https://mail.shop.test/unsub/confirm', method: 'POST', body: 'token=abc%261&go=yes' });
    expect(CONFIRMED.test('You have been unsubscribed.')).toBe(true);
    expect(CONFIRMED.test('La tua iscrizione è stata annullata')).toBe(true);
    expect(CONFIRMED.test('Manage your preferences')).toBe(false);
  });
});

describe('background unsubscribe run', () => {
  it('starts, refuses a second run while busy, and reports per sender', async () => {
    const { startUnsubscribe, unsubscribeStatus } = await import('./newsletters.js');
    const a = startUnsubscribe(['nobody-here@void.test'], { trashExisting: false });
    expect(a.started).toBe(true);
    expect(startUnsubscribe(['x@void.test'], { trashExisting: false }).started).toBe(false);
    for (let i = 0; i < 50 && unsubscribeStatus().running; i++) await new Promise((r) => setTimeout(r, 20));
    const s = unsubscribeStatus();
    expect(s.running).toBe(false);
    expect(s.done).toBe(1);
  });
});
