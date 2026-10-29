import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { db } from '../db.js';
import { config } from '../config.js';
import { pruneAttachmentCache, attachmentPath, touchAttachment, pruneUploads } from './store.js';

describe('attachment cache pruning', () => {
  it('drops the least recently used files beyond the cap and marks them uncached', () => {
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (99, 't@x.test', 't', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (990, 99, 'INBOX', 'INBOX', 'inbox')");
    db.exec("INSERT OR IGNORE INTO threads(id, account_id, subject_norm) VALUES (990, 99, 'x')");
    db.exec("INSERT OR IGNORE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size) VALUES (990, 99, 990, 990, 1, 'm@x', 'x', 'x', 'a@x.test', '2026-01-01', 10)");
    for (const n of fs.readdirSync(config.attachmentsDir)) fs.unlinkSync(`${config.attachmentsDir}/${n}`);
    db.exec('DELETE FROM attachments');
    const ins = db.prepare("INSERT INTO attachments(id, message_row, part, filename, content_type, size, cached) VALUES (?, 990, '', ?, 'text/plain', 100, 1)");
    for (const id of [1, 2, 3, 4]) {
      ins.run(id, `f${id}.txt`);
      fs.writeFileSync(attachmentPath(id), Buffer.alloc(100));
      fs.utimesSync(attachmentPath(id), id * 1000, id * 1000); // 1 is oldest
    }
    touchAttachment(1); // 1 was just opened: now the newest
    const r = pruneAttachmentCache(250);
    expect(r.removed).toBe(2);
    expect(fs.existsSync(attachmentPath(2))).toBe(false);
    expect(fs.existsSync(attachmentPath(3))).toBe(false);
    expect(fs.existsSync(attachmentPath(1))).toBe(true);
    expect(fs.existsSync(attachmentPath(4))).toBe(true);
    expect((db.prepare('SELECT cached FROM attachments WHERE id = 2').get() as { cached: number }).cached).toBe(0);
    expect((db.prepare('SELECT cached FROM attachments WHERE id = 1').get() as { cached: number }).cached).toBe(1);
    expect(pruneAttachmentCache(250).removed).toBe(0);
  });
});

describe('upload cleanup', () => {
  it('removes old unreferenced uploads only', () => {
    for (const n of fs.readdirSync(config.uploadsDir)) fs.unlinkSync(`${config.uploadsDir}/${n}`);
    db.exec('DELETE FROM drafts');
    const mk = (id: string, ageDays: number) => {
      for (const f of [id, id + '.json']) {
        fs.writeFileSync(`${config.uploadsDir}/${f}`, 'x');
        const t = (Date.now() - ageDays * 86_400_000) / 1000;
        fs.utimesSync(`${config.uploadsDir}/${f}`, t, t);
      }
    };
    mk('old-unused', 10);
    mk('old-in-draft', 10);
    mk('fresh', 1);
    db.prepare("INSERT INTO drafts(account_id, to_text, cc_text, bcc_text, subject, text, attachments_json) VALUES (99, '', '', '', '', '', ?)").run(JSON.stringify([{ id: 'old-in-draft', filename: 'a', size: 1 }]));
    expect(pruneUploads()).toBe(2);
    expect(fs.existsSync(`${config.uploadsDir}/old-unused`)).toBe(false);
    expect(fs.existsSync(`${config.uploadsDir}/old-in-draft`)).toBe(true);
    expect(fs.existsSync(`${config.uploadsDir}/fresh.json`)).toBe(true);
  });
});
