import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { stageAttachments, downloadUrl } from './mcpAttachments.js';
import { attachmentPath } from './mail/store.js';
import { cleanSnippet } from './mail/parse.js';

describe('connector attachments', () => {
  it('stores a base64 file like an app upload', async () => {
    const [f] = await stageAttachments([{ filename: 'quote.pdf', content_base64: Buffer.from('%PDF-1.4 made up').toString('base64') }]);
    expect(f.filename).toBe('quote.pdf');
    const meta = JSON.parse(fs.readFileSync(path.join(config.uploadsDir, f.id + '.json'), 'utf8'));
    expect(meta.contentType).toBe('application/pdf');
    expect(fs.readFileSync(path.join(config.uploadsDir, f.id), 'utf8')).toBe('%PDF-1.4 made up');
  });

  it('reuses an attachment of an email already in Postino', async () => {
    db.prepare("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (77, 'att@test.local', 'A', '#000', 'h', 1, 1, 'h', 1, 1, 'u', 'x')").run();
    const folder = db.prepare("INSERT INTO folders(account_id, path, name, role) VALUES (77, ?, 'Inbox', 'other')").run(`att-${Date.now()}`).lastInsertRowid;
    const thread = db.prepare("INSERT INTO threads(account_id, subject, last_date) VALUES (77, 'x', '2026-01-01')").run().lastInsertRowid;
    const msg = db
      .prepare("INSERT INTO messages(account_id, folder_id, uid, thread_id, subject, date, from_json, to_json, cc_json, bcc_json) VALUES (77, ?, 1, ?, 'x', '2026-01-01', '{}', '[]', '[]', '[]')")
      .run(folder, thread).lastInsertRowid;
    const att = Number(db.prepare("INSERT INTO attachments(message_row, part, filename, content_type, size, cached) VALUES (?, '2', 'photo.jpg', 'image/jpeg', 4, 1)").run(msg).lastInsertRowid);
    fs.mkdirSync(path.dirname(attachmentPath(att)), { recursive: true });
    fs.writeFileSync(attachmentPath(att), 'jpeg');
    const [f] = await stageAttachments([{ attachment_id: String(att) }]);
    expect(f).toMatchObject({ filename: 'photo.jpg', size: 4 });
  });

  it('refuses unclear or oversized input and leaves nothing behind', async () => {
    await expect(stageAttachments([{ url: 'https://example.com/a.pdf', content_base64: 'AA==' }])).rejects.toThrow(/exactly one/);
    await expect(stageAttachments([{ content_base64: 'AA==' }])).rejects.toThrow(/filename/);
    await expect(stageAttachments([{ attachment_id: '999999999' }])).rejects.toThrow(/No attachment/);
    await expect(stageAttachments([{ url: 'file:///etc/passwd' }])).rejects.toThrow(/web link/);
    const before = fs.readdirSync(config.uploadsDir).length;
    const big = Buffer.alloc(26 * 1024 * 1024).toString('base64');
    await expect(stageAttachments([{ filename: 'a.bin', content_base64: big }])).rejects.toThrow(/too big/);
    expect(fs.readdirSync(config.uploadsDir).length).toBe(before);
  });

  it('turns sharing links into download links', () => {
    expect(downloadUrl('https://drive.google.com/file/d/AbC_123-x/view?usp=sharing')).toBe('https://drive.usercontent.google.com/download?id=AbC_123-x&export=download&confirm=t');
    expect(downloadUrl('https://docs.google.com/document/d/Doc1/edit')).toBe('https://docs.google.com/document/d/Doc1/export?format=pdf');
    expect(downloadUrl('https://www.dropbox.com/s/x/file.pdf?dl=0')).toContain('dl=1');
  });
});

describe('preview text without link addresses', () => {
  it('keeps the words and drops the URLs, like Gmail', () => {
    expect(cleanSnippet('Your Orders https://shop.example/orders?ref=1 Your Account https://shop.example/account')).toBe('Your Orders Your Account');
    expect(cleanSnippet('Read more ( https://news.example/a?b=c ) and follow us <https://x.example> today')).toBe('Read more and follow us today');
    expect(cleanSnippet('Hi Ema,͏ ‌ ͏ see [image: Logo] the plan')).toBe('Hi Ema, see the plan');
    expect(cleanSnippet('Write to me at someone@example.com or visit www.example.com')).toBe('Write to me at someone@example.com or visit');
  });
});
