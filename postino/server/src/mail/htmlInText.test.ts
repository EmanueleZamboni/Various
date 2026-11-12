import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { bodyFromParsed, looksLikeHtml } from './parse.js';
import { db, setSetting } from '../db.js';
import { fixHtmlInTextOnce } from './repair.js';

// A made-up itinerary whose only part is text/plain but holds a whole HTML page.
const page = `<!DOCTYPE html><html><head><style type="text/css">body{margin:0}${'.c{color:#123456;font-family:Arial}'.repeat(300)}</style></head>
<body><!--[if mso]><table><tr><td><![endif]--><table><tr><td><div>Outbound flight</div><div>Gotham 08:10 to Metropolis 10:20</div></td></tr>
<tr><td><div>Return flight</div><div>Metropolis 18:00 to Gotham 20:15</div></td></tr></table></body></html>`;
const raw = `From: Air <trips@example.com>\r\nTo: me@example.com\r\nSubject: Your trip\r\nMessage-ID: <trip1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${page}\r\n`;

describe('HTML code sent as plain text', () => {
  it('is recognised and read as HTML: words only, nothing cut', async () => {
    expect(looksLikeHtml(page)).toBe(true);
    expect(looksLikeHtml('Hi, <b>see</b> you at 5 <3')).toBe(false);
    const b = bodyFromParsed(await simpleParser(raw), () => undefined);
    expect(b.text).toContain('Outbound flight');
    expect(b.text).toContain('Return flight');
    expect(b.text).not.toContain('font-family');
    expect(b.text!.length).toBeLessThan(400);
    expect(b.html).toContain('Return flight');
    expect(b.snippet).toMatch(/^Outbound flight/);
  });

  it('repairs mail stored before the fix', () => {
    setSetting('migr.htmlInText', false);
    db.prepare("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, enabled) VALUES (91, 'trip@test.local', 'T', '#000', 'h', 1, 1, 'h', 1, 1, 'u', 'x', 0)").run();
    const folder = db.prepare("INSERT INTO folders(account_id, path, name, role) VALUES (91, ?, 'Inbox', 'inbox')").run(`trip-${Date.now()}`).lastInsertRowid;
    const thread = db.prepare("INSERT INTO threads(account_id, subject, last_date) VALUES (91, 'Your trip', '2026-01-01')").run().lastInsertRowid;
    const msg = Number(db.prepare("INSERT INTO messages(account_id, folder_id, uid, thread_id, subject, date, from_json, to_json, cc_json, bcc_json, snippet, body_fetched) VALUES (91, ?, 1, ?, 'Your trip', '2026-01-01', '{}', '[]', '[]', '[]', '<!DOCTYPE html>', 1)").run(folder, thread).lastInsertRowid);
    db.prepare('INSERT INTO bodies(message_row, text, html) VALUES (?, ?, ?)').run(msg, page, '<pre>escaped code</pre>');
    expect(fixHtmlInTextOnce()).toBeGreaterThanOrEqual(1);
    const b = db.prepare('SELECT text, html FROM bodies WHERE message_row = ?').get(msg) as { text: string; html: string };
    expect(b.text).toContain('Return flight');
    expect(b.text).not.toContain('<td>');
    expect(b.html).toContain('Return flight');
    expect((db.prepare('SELECT snippet FROM messages WHERE id = ?').get(msg) as { snippet: string }).snippet).toMatch(/^Outbound flight/);
    expect(fixHtmlInTextOnce()).toBe(0); // once only
  });
});
