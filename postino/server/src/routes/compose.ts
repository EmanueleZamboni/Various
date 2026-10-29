import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { randomToken } from '../crypto.js';
import { manager } from '../mail/manager.js';
import { sendMail, parseAddressList, formatAddress, type OutgoingAttachment } from '../mail/send.js';
import { attachmentPath, type MessageRow, type FolderRow } from '../mail/store.js';
import type { AccountRow, AttachmentRow } from '../views.js';
import type { Address } from '../mail/parse.js';
import { bus } from '../events.js';
import { log } from '../log.js';
import { signatureById, defaultSignature } from './signatures.js';

const esc = (t: string): string => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

type DraftRow = { id: number; account_id: number; thread_id: number | null; in_reply_to: number | null; forward_of: number | null; to_text: string; cc_text: string; bcc_text: string; subject: string; text: string; attachments_json: string; updated_at: string };

const draftView = (d: DraftRow) => ({
  id: String(d.id),
  accountId: String(d.account_id),
  threadId: d.thread_id ? String(d.thread_id) : null,
  inReplyTo: d.in_reply_to ? String(d.in_reply_to) : null,
  forwardOf: d.forward_of ? String(d.forward_of) : null,
  to: d.to_text,
  cc: d.cc_text,
  bcc: d.bcc_text,
  subject: d.subject,
  text: d.text,
  attachments: JSON.parse(d.attachments_json || '[]') as { id: string; filename: string; size: number }[],
  updatedAt: d.updated_at,
});

const fmtDate = (iso: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function quoteText(text: string): string {
  return text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

/** Values to prefill a reply/forward form for a message. */
export function replyPrefill(m: MessageRow, mode: 'reply' | 'replyAll' | 'forward') {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(m.account_id) as AccountRow;
  const mine = new Set((db.prepare('SELECT email FROM accounts').all() as { email: string }[]).map((r) => r.email.toLowerCase()));
  const from = JSON.parse(m.from_json) as Address;
  const to = JSON.parse(m.to_json) as Address[];
  const cc = JSON.parse(m.cc_json) as Address[];
  const replyTo = JSON.parse(m.reply_to_json) as Address[];
  const body = db.prepare('SELECT text, html FROM bodies WHERE message_row = ?').get(m.id) as { text: string | null; html: string | null } | undefined;
  const text = body?.text || '';
  const subjectBase = m.subject.replace(/^\s*((re|r|aw|wg|fw|fwd|tr|rif|i)\s*:\s*)+/i, '').trim();
  const headerLine = `On ${fmtDate(m.date)}, ${formatAddress(from)} wrote:`;
  if (mode === 'forward') {
    const header = [`---------- Forwarded message ----------`, `From: ${formatAddress(from)}`, `Date: ${fmtDate(m.date)}`, `Subject: ${m.subject}`, `To: ${to.map(formatAddress).join(', ')}`, cc.length ? `Cc: ${cc.map(formatAddress).join(', ')}` : '']
      .filter(Boolean)
      .join('\n');
    return { accountId: String(account.id), to: '', cc: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${subjectBase}`, quotedText: `\n\n${header}\n\n${text}`, quotedHtml: body?.html || null, headerLine: header };
  }
  const primary = m.mine ? to : replyTo.length ? replyTo : [from];
  let toList = primary;
  let ccList: Address[] = [];
  if (mode === 'replyAll') {
    const seen = new Set(toList.map((a) => a.email));
    const extra = [...to, ...cc].filter((a) => !mine.has(a.email) && !seen.has(a.email));
    if (m.mine) ccList = cc;
    else {
      toList = [...toList, ...extra.filter((a) => to.some((t) => t.email === a.email))];
      ccList = extra.filter((a) => !to.some((t) => t.email === a.email));
    }
  }
  toList = toList.filter((a) => !mine.has(a.email) || m.mine);
  if (!toList.length) toList = [from];
  return {
    accountId: String(account.id),
    to: toList.map(formatAddress).join(', '),
    cc: ccList.map(formatAddress).join(', '),
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${subjectBase}`,
    quotedText: `\n\n${headerLine}\n${quoteText(text)}`,
    quotedHtml: body?.html ? `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${body.html}</blockquote>` : null,
    headerLine,
  };
}

type SendFields = { accountId?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string; html?: string; inReplyTo?: string; forwardOf?: string; draftId?: string; uploadIds?: string | string[]; signatureId?: string; quote?: string };

export function registerComposeRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { mode?: string } }>('/api/messages/:id/reply', async (req, reply) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id)) as MessageRow | undefined;
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const mode = req.query.mode === 'replyAll' ? 'replyAll' : req.query.mode === 'forward' ? 'forward' : 'reply';
    return replyPrefill(m, mode);
  });

  // Attachments are uploaded first (so drafts can keep them), then referenced by id when sending.
  app.post('/api/uploads', async (req, reply) => {
    const parts = req.parts({ limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
    const out: { id: string; filename: string; size: number; contentType: string }[] = [];
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const id = randomToken(12);
      const dest = path.join(config.uploadsDir, id);
      await fs.promises.writeFile(dest, await part.toBuffer());
      const size = (await fs.promises.stat(dest)).size;
      const meta = { id, filename: part.filename || 'file', size, contentType: part.mimetype || 'application/octet-stream' };
      await fs.promises.writeFile(dest + '.json', JSON.stringify(meta));
      out.push(meta);
    }
    return reply.code(201).send({ uploads: out });
  });

  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async (req, reply) => {
    const id = req.params.id.replace(/[^A-Za-z0-9_-]/g, '');
    for (const f of [path.join(config.uploadsDir, id), path.join(config.uploadsDir, id + '.json')]) {
      try {
        await fs.promises.unlink(f);
      } catch {
        // already gone
      }
    }
    return reply.code(204).send();
  });

  app.post<{ Body: SendFields }>('/api/send', async (req, reply) => {
    let b: SendFields = req.body || {};
    // The web app sends multipart/form-data (fields + "attachments" files).
    if (req.isMultipart()) {
      const fields: Record<string, string> = {};
      const uploadIds: string[] = [];
      for await (const part of req.parts({ limits: { fileSize: 25 * 1024 * 1024, files: 10 } })) {
        if (part.type === 'file') {
          const id = randomToken(12);
          const dest = path.join(config.uploadsDir, id);
          await fs.promises.writeFile(dest, await part.toBuffer());
          const size = (await fs.promises.stat(dest)).size;
          await fs.promises.writeFile(dest + '.json', JSON.stringify({ id, filename: part.filename || 'file', size, contentType: part.mimetype || 'application/octet-stream' }));
          uploadIds.push(id);
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      b = { ...fields, uploadIds: [...uploadIds, ...(fields.uploadIds ? fields.uploadIds.split(',') : [])] };
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(b.accountId)) as AccountRow | undefined;
    if (!account) return reply.code(400).send({ error: 'no_account', message: 'Choose which address to send from.' });
    const to = String(b.to || '').trim();
    if (!parseAddressList(to).length) return reply.code(400).send({ error: 'no_recipient', message: 'Add at least one valid recipient.' });
    for (const [field, val] of [['To', to], ['Cc', String(b.cc || '')], ['Bcc', String(b.bcc || '')]] as const) {
      const raw = val.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      if (raw.length !== parseAddressList(val).length) return reply.code(400).send({ error: 'bad_address', message: `${field} has an address that does not look right.` });
    }
    const attachments: OutgoingAttachment[] = [];
    const uploadIds = (Array.isArray(b.uploadIds) ? b.uploadIds : b.uploadIds ? [b.uploadIds] : []).map((s) => String(s).replace(/[^A-Za-z0-9_-]/g, ''));
    for (const id of uploadIds) {
      const metaFile = path.join(config.uploadsDir, id + '.json');
      if (!fs.existsSync(metaFile)) continue;
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { filename: string; contentType: string };
      attachments.push({ filename: meta.filename, contentType: meta.contentType, path: path.join(config.uploadsDir, id) });
    }
    let inReplyTo: { messageId: string; references: string[] } | null = null;
    let replyRow: MessageRow | undefined;
    if (b.inReplyTo) {
      replyRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(b.inReplyTo)) as MessageRow | undefined;
      if (replyRow?.message_id) {
        const refs = (db.prepare('SELECT ref FROM message_refs WHERE message_row = ?').all(replyRow.id) as { ref: string }[]).map((r) => r.ref);
        inReplyTo = { messageId: replyRow.message_id, references: refs.slice(-20) };
      }
    }
    if (b.forwardOf) {
      const fwd = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(b.forwardOf)) as MessageRow | undefined;
      if (fwd) {
        const atts = db.prepare('SELECT * FROM attachments WHERE message_row = ? AND is_inline = 0').all(fwd.id) as AttachmentRow[];
        const sync = manager.get(fwd.account_id);
        for (const a of atts) {
          try {
            const file = sync ? await sync.cacheAttachment(a.id) : attachmentPath(a.id);
            attachments.push({ filename: a.filename, contentType: a.content_type, path: file });
          } catch {
            // skip attachments we cannot fetch
          }
        }
      }
    }
    // Signature: an explicit id, "none", or the account's default.
    let signature: { html: string; text: string } | null = null;
    if (b.signatureId !== 'none') {
      const sig = b.signatureId ? signatureById(Number(b.signatureId)) : defaultSignature(account.id);
      if (sig && sig.account_id === account.id) signature = { html: sig.html, text: sig.text };
    }
    // Quoted original (reply/forward), built here so HTML mail is quoted as HTML.
    let quote: { html: string | null; text: string } | null = null;
    if (b.quote === '1') {
      const src = replyRow || (b.forwardOf ? (db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(b.forwardOf)) as MessageRow | undefined) : undefined);
      if (src) {
        const pre = replyPrefill(src, b.forwardOf ? 'forward' : 'reply');
        quote = { html: pre.quotedHtml ? `<div>${esc(pre.headerLine).replace(/\n/g, '<br>')}</div>${pre.quotedHtml}` : null, text: pre.quotedText.trim() };
      }
    }
    try {
      const r = await sendMail({ account, to, cc: String(b.cc || ''), bcc: String(b.bcc || ''), subject: String(b.subject || ''), text: String(b.text || ''), html: b.html ? String(b.html) : undefined, inReplyTo, attachments, signature, quote });
      if (replyRow) {
        const sync = manager.get(replyRow.account_id);
        sync?.markAnswered(replyRow.id).catch((err: Error) => log.warn({ err: err.message }, 'could not flag as answered'));
      }
      if (b.draftId) db.prepare('DELETE FROM drafts WHERE id = ?').run(Number(b.draftId));
      for (const id of uploadIds) {
        for (const f of [path.join(config.uploadsDir, id), path.join(config.uploadsDir, id + '.json')]) fs.promises.unlink(f).catch(() => undefined);
      }
      const sent = db.prepare('SELECT id, thread_id FROM messages WHERE account_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1').get(account.id, r.messageId) as { id: number; thread_id: number } | undefined;
      const threadId = sent?.thread_id ?? replyRow?.thread_id ?? null;
      if (threadId) bus.publish({ type: 'thread.updated', threadId: String(threadId), accountId: String(account.id) });
      return { ok: true, messageId: r.messageId, threadId: threadId ? String(threadId) : null };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(502).send({ error: 'send_failed', message: /auth|535|credentials/i.test(msg) ? 'The mail server refused the login. Check the account password in Settings.' : `Sending failed: ${msg}` });
    }
  });

  app.get('/api/drafts', async () => (db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all() as DraftRow[]).map(draftView));

  const saveDraft = (id: number | null, b: Record<string, unknown>) => {
    const accountId = Number(b.accountId);
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw Object.assign(new Error('Unknown account'), { statusCode: 400 });
    const vals = [accountId, b.threadId ? Number(b.threadId) : null, b.inReplyTo ? Number(b.inReplyTo) : null, b.forwardOf ? Number(b.forwardOf) : null, String(b.to || ''), String(b.cc || ''), String(b.bcc || ''), String(b.subject || ''), String(b.text || ''), JSON.stringify(b.attachments || [])];
    if (id) {
      db.prepare("UPDATE drafts SET account_id = ?, thread_id = ?, in_reply_to = ?, forward_of = ?, to_text = ?, cc_text = ?, bcc_text = ?, subject = ?, text = ?, attachments_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(...vals, id);
      return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow;
    }
    const info = db.prepare('INSERT INTO drafts(account_id, thread_id, in_reply_to, forward_of, to_text, cc_text, bcc_text, subject, text, attachments_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...vals);
    return db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid) as DraftRow;
  };

  app.post<{ Body: Record<string, unknown> }>('/api/drafts', async (req, reply) => {
    const d = saveDraft(null, req.body || {});
    if (d.thread_id) bus.publish({ type: 'thread.updated', threadId: String(d.thread_id), accountId: String(d.account_id) });
    return reply.code(201).send(draftView(d));
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/drafts/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    return draftView(saveDraft(id, req.body || {}));
  });

  app.delete<{ Params: { id: string } }>('/api/drafts/:id', async (req, reply) => {
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id)) as DraftRow | undefined;
    db.prepare('DELETE FROM drafts WHERE id = ?').run(Number(req.params.id));
    if (d?.thread_id) bus.publish({ type: 'thread.updated', threadId: String(d.thread_id), accountId: String(d.account_id) });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/contacts', async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 8, 30);
    const rows = q
      ? (db.prepare('SELECT email, name FROM contacts WHERE lower(email) LIKE ? OR lower(name) LIKE ? ORDER BY count DESC, last_seen DESC LIMIT ?').all(`%${q}%`, `%${q}%`, limit) as Address[])
      : (db.prepare('SELECT email, name FROM contacts ORDER BY count DESC, last_seen DESC LIMIT ?').all(limit) as Address[]);
    return rows;
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/api/attachments/:id', async (req, reply) => {
    const a = db.prepare('SELECT a.*, m.account_id FROM attachments a JOIN messages m ON m.id = a.message_row WHERE a.id = ?').get(Number(req.params.id)) as (AttachmentRow & { account_id: number }) | undefined;
    if (!a) return reply.code(404).send({ error: 'not_found' });
    let file = attachmentPath(a.id);
    if (!a.cached || !fs.existsSync(file)) {
      const sync = manager.get(a.account_id);
      if (!sync) return reply.code(503).send({ error: 'offline', message: 'The account is not connected right now.' });
      file = await sync.cacheAttachment(a.id);
    }
    const inline = req.query.inline === '1';
    const type = a.content_type.toLowerCase();
    const safeInline = inline && (/^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(type) || type === 'application/pdf' || type.startsWith('audio/') || type.startsWith('video/') || type === 'text/plain');
    const stat = await fs.promises.stat(file);
    const name = encodeURIComponent(a.filename.replace(/[\r\n"]/g, '_'));
    reply.header('Content-Type', safeInline ? type : 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    return reply.send(fs.createReadStream(file));
  });

  app.post<{ Params: { id: string } }>('/api/messages/:id/unsubscribe', async (req, reply) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id)) as MessageRow | undefined;
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const url = m.list_unsubscribe;
    if (!url) return { ok: true, method: 'none' };
    if (/^mailto:/i.test(url)) {
      const u = new URL(url);
      const addr = u.pathname;
      const subject = u.searchParams.get('subject') || 'Unsubscribe';
      const bodyText = u.searchParams.get('body') || 'Unsubscribe';
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(m.account_id) as AccountRow;
      try {
        await sendMail({ account, to: addr, subject, text: bodyText, attachments: [] });
      } catch (err) {
        return reply.code(502).send({ error: 'send_failed', message: (err as Error).message });
      }
      return { ok: true, method: 'mailto' };
    }
    return { ok: true, method: 'http', url };
  });

  app.get<{ Params: { id: string } }>('/api/messages/:id/raw', async (req, reply) => {
    // Handy for debugging: the stored folder/uid of a message.
    const m = db.prepare('SELECT m.id, m.uid, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(Number(req.params.id)) as { id: number; uid: number; path: string } | undefined;
    if (!m) return reply.code(404).send({ error: 'not_found' });
    return m;
  });

  void ((_f: FolderRow) => undefined);
}
