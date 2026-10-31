import { describe, it, expect } from 'vitest';
import { db } from './db.js';
import { applyPendingFor, buildBackup, pendingMailboxes, restoreBackup } from './backup.js';

const addAccount = (id: number, email: string) =>
  db.prepare("INSERT INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (?, ?, 'Me', '#123456', 'imap.x.test', 993, 1, 'smtp.x.test', 465, 1, ?, 'secret-enc')").run(id, email, email);

describe('backup', () => {
  it('round-trips templates, blocked senders, signatures and drafts, never passwords', () => {
    db.exec("DELETE FROM accounts WHERE email = 'one@bk.test'; DELETE FROM templates");
    addAccount(501, 'one@bk.test');
    db.prepare("INSERT INTO signatures(account_id, name, html, text, is_default) VALUES (501, 'Main', '<b>Ema</b>', 'Ema', 1)").run();
    db.prepare("INSERT INTO drafts(account_id, to_text, subject, text) VALUES (501, 'a@b.test', 'Hello', 'Body')").run();
    db.prepare("INSERT OR IGNORE INTO blocked_senders(pattern, note) VALUES ('spam@bad.test', '')").run();
    db.prepare("INSERT INTO templates(name, subject, text) VALUES ('Mine', 'S', 'T')").run();
    const b = buildBackup();
    const json = JSON.stringify(b);
    expect(json).not.toContain('secret-enc');
    expect(json).not.toContain('password_enc');
    expect(b.accounts.find((a) => a.email === 'one@bk.test')?.imap.host).toBe('imap.x.test');

    // A fresh server: wipe everything the backup should bring back.
    db.exec("DELETE FROM accounts WHERE id = 501; DELETE FROM templates; DELETE FROM blocked_senders WHERE pattern = 'spam@bad.test'");
    const r = restoreBackup(JSON.parse(json));
    expect(r.mailboxes.map((m) => m.email)).toContain('one@bk.test');
    expect(db.prepare("SELECT count(*) AS n FROM templates WHERE name = 'Mine'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM blocked_senders WHERE pattern = 'spam@bad.test'").get()).toEqual({ n: 1 });

    // The mailbox is added again with its password: its own things come back.
    addAccount(502, 'one@bk.test');
    applyPendingFor(502);
    expect(db.prepare('SELECT html FROM signatures WHERE account_id = 502').get()).toEqual({ html: '<b>Ema</b>' });
    expect(db.prepare('SELECT subject FROM drafts WHERE account_id = 502').get()).toEqual({ subject: 'Hello' });
    expect(pendingMailboxes().map((m) => m.email)).not.toContain('one@bk.test');
  });

  it('refuses files that are not Postino backups', () => {
    expect(() => restoreBackup({ hello: 1 })).toThrow(/not a Postino backup/);
    expect(() => restoreBackup({ format: 'postino-backup', version: 99 })).toThrow(/newer/);
  });
});
