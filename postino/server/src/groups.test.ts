import { describe, it, expect } from 'vitest';
import { db } from './db.js';
import { groupSummaries, markGroupSeen } from './groups.js';
import { listThreads } from './routes/threads.js';

describe('sender groups', () => {
  it('groups only conversations made entirely of the exact grouped address', () => {
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (77, 'me@grp.test', 'me', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (770, 77, 'INBOX', 'INBOX', 'inbox')");
    const thread = (id: number) => db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, inbox_date, roles, msg_count) VALUES (?, 77, 's', 's', '2026-11-01', '2026-11-01', ',inbox,', 1)").run(id);
    const msg = (id: number, t: number, from: string, mine = 0) =>
      db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size, mine) VALUES (?, 77, 770, ?, ?, ?, 's', 's', ?, '2026-11-01', 1, ?)").run(id, t, id, `m${id}@x`, from, mine);
    thread(7701); msg(77011, 7701, 'alerts@amazon.test');                    // only the grouped sender
    thread(7702); msg(77021, 7702, 'alerts@amazon.test'); msg(77022, 7702, 'me@grp.test', 1); // I replied: stays normal
    thread(7703); msg(77031, 7703, 'person@amazon.test');                    // same domain, other address: stays normal
    db.exec("DELETE FROM sender_groups; INSERT INTO sender_groups(email, group_name) VALUES ('alerts@amazon.test', 'Amazon')");
    const ids = (r: ReturnType<typeof listThreads>) => r.threads.map((t) => Number(t.id)).filter((id) => id >= 7701 && id <= 7703).sort();
    expect(ids(listThreads({ view: 'inbox', account: '77', group: 'Amazon' }))).toEqual([7701]);
    expect(ids(listThreads({ view: 'inbox', account: '77', group: 'none' }))).toEqual([7702, 7703]);
    expect(ids(listThreads({ view: 'inbox', account: '77' }))).toEqual([7701, 7702, 7703]);
    // The bundle line: one group, one conversation, and old unread mail is not "new".
    db.exec("UPDATE threads SET unread_count = 1 WHERE id = 7701");
    const s = groupSummaries(77);
    expect(s.map((g) => [g.name, g.total, g.fresh, g.latestThreadId])).toEqual([['Amazon', 1, 0, '7701']]);
    db.exec("UPDATE threads SET last_date = '2999-01-01' WHERE id = 7701");
    expect(groupSummaries(77)[0].fresh).toBe(1);
    markGroupSeen('Amazon');
    db.exec("UPDATE threads SET last_date = '2026-11-01' WHERE id = 7701");
    expect(groupSummaries(77)[0].fresh).toBe(0);
    db.exec('DELETE FROM sender_groups; DELETE FROM group_seen');
  });
});

describe('group suggestions', () => {
  it('offers regular automatic senders, never people, payments or my own threads', async () => {
    const { groupSuggestions } = await import('./groups.js');
    db.exec("DELETE FROM sender_groups; DELETE FROM messages WHERE account_id = 77; DELETE FROM threads WHERE account_id = 77");
    const today = new Date().toISOString();
    let id = 78000;
    const add = (from: string, mine = 0) => {
      id++;
      db.prepare("INSERT INTO threads(id, account_id, subject, subject_norm, last_date) VALUES (?, 77, 's', 's', ?)").run(id, today);
      db.prepare("INSERT INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size, mine) VALUES (?, 77, 770, ?, ?, ?, 's', 's', ?, ?, 1, ?)").run(id, id, id, `s${id}@x`, from, today, mine);
    };
    for (let i = 0; i < 4; i++) add('associates@amazon.de');
    for (let i = 0; i < 3; i++) add('no-reply@vinted.it');
    for (let i = 0; i < 5; i++) add('anna@studio.test');          // a person
    for (let i = 0; i < 4; i++) add('no-reply@payments.paypal.it'); // money: kept in the inbox
    add('no-reply@youtube.com');                                   // only once: not regular
    const s = groupSuggestions();
    const names = Object.fromEntries(s.map((g) => [g.name, g.senders.map((x) => x.email)]));
    expect(names.Affiliates).toEqual(['associates@amazon.de']);
    expect(names.Vinted).toEqual(['no-reply@vinted.it']);
    expect(JSON.stringify(s)).not.toContain('anna@');
    expect(JSON.stringify(s)).not.toContain('paypal');
    expect(JSON.stringify(s)).not.toContain('youtube');
    db.exec("DELETE FROM messages WHERE account_id = 77; DELETE FROM threads WHERE account_id = 77");
  });
});

describe('important grouped mail', () => {
  it('spots sales, codes, failed payments and deliveries, not plain news', async () => {
    const { isImportant } = await import('./groups.js');
    for (const s of ['Hai venduto Lettore Dvd Sony', 'Your verification code', 'Pagamento non riuscito', 'Spedizione da ritirare', 'Etichetta di spedizione - da usare entro il 09/10']) expect(isImportant(s), s).toBe(true);
    for (const s of ['4 new image styles to try', 'Il tuo riepilogo settimanale', 'Barcode scanner deals', 'Security alert for ezamboni96@gmail.com', 'Offerta in scadenza: ottieni il primo mese gratis con Go', 'Introduzione della procedura di verifica di sicurezza sull’account', 'Promemoria sul tracciamento dell’apertura delle e-mail', '[Alert] D1 daily operation limit exceeded for account', 'Il tuo quesito ad Amazon.it']) expect(isImportant(s), s).toBe(false);
  });
});

describe('important grouped mail', () => {
  it('shows an alert copied to two mailboxes once, across accounts', async () => {
    const { importantGroupedThreadIds, refreshGroupThreads, listGroups, addSenders } = await import('./groups.js');
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (78, 'me2@grp.test', 'me2', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (780, 78, 'INBOX', 'INBOX', 'inbox')");
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    const put = (id: number, acc: number, folder: number, subject: string) => {
      db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, inbox_date, roles, msg_count, unread_count) VALUES (?, ?, ?, ?, ?, '2026-11-05', ',inbox,', 1, 1)").run(id, acc, subject, subject, now);
      db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'no-reply@accounts.google.test', ?, 1)").run(id, acc, folder, id, id, `g${id}@x`, subject, subject, now);
    };
    put(7801, 77, 770, 'Unusual sign-in activity');
    put(7802, 78, 780, 'Unusual sign-in activity for me@grp.test');
    db.exec('DELETE FROM sender_groups');
    addSenders('Google Alert', ['no-reply@accounts.google.test']);
    refreshGroupThreads(true);
    expect(importantGroupedThreadIds(null)).toHaveLength(1);
    expect(listGroups()[0].lastUsed).toMatch(/^\d{4}-/);
    db.exec('DELETE FROM sender_groups; DELETE FROM messages WHERE id IN (7801, 7802); DELETE FROM threads WHERE id IN (7801, 7802)');
  });
});

describe('routine sign-in alerts', () => {
  it('stay inside their group', async () => {
    const { isImportant } = await import('./groups.js');
    expect(isImportant('Security alert', 'A new sign-in on Mac OS ezamboni96@gmail.com We noticed a new sign-in to your Google Account')).toBe(false);
    expect(isImportant('Security alert for ezamboni96@gmail.com', 'This is a copy of a security alert sent to ezamboni96@gmail.com.')).toBe(false);
    expect(isImportant('Suspicious sign-in prevented', '')).toBe(true);
    expect(isImportant('Il tuo codice di verifica', '')).toBe(true);
  });
});

describe('new mail under the Groups line', () => {
  it('shows unread mail that arrived since the group was opened, three at a time', async () => {
    const { groupPreview, addSenders, refreshGroupThreads, markGroupSeen } = await import('./groups.js');
    db.exec('DELETE FROM sender_groups; DELETE FROM group_seen');
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const id = 7950 + i;
      const at = new Date(now - i * 60_000).toISOString();
      db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, inbox_date, roles, msg_count, unread_count) VALUES (?, 77, 'Weekly news', 'weekly news', ?, ?, ',inbox,', 1, 1)").run(id, at, at);
      db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size) VALUES (?, 77, 770, ?, ?, ?, 'Weekly news', 'weekly news', 'news@shop.test', ?, 1)").run(id, id, id, `p${id}@x`, at);
    }
    db.exec("INSERT INTO group_seen(group_name, seen_at) VALUES ('Shop', '2000-01-01T00:00:00Z')");
    addSenders('Shop', ['news@shop.test']);
    refreshGroupThreads(true);
    const p = groupPreview(77);
    expect(p.ids).toEqual([7950, 7951, 7952]);
    expect(p.more).toBe(2);
    markGroupSeen('Shop'); // opening the group: nothing is new any more
    expect(groupPreview(77).ids).toEqual([]);
    db.exec('DELETE FROM sender_groups; DELETE FROM group_seen; DELETE FROM messages WHERE id BETWEEN 7950 AND 7954; DELETE FROM threads WHERE id BETWEEN 7950 AND 7954');
  });
});
