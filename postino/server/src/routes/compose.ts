import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { randomToken } from '../crypto.js';
import { manager } from '../mail/manager.js';
import { parseAddressList, formatAddress } from '../mail/send.js';
import { sendMail } from '../mail/send.js';
import { enqueue, cancel, listQueued, executeSend, type SendJob } from '../mail/outbox.js';
import { uiSettings } from '../settings.js';
import { attachmentPath, touchAttachment, type MessageRow, type FolderRow } from '../mail/store.js';
import type { AccountRow, AttachmentRow } from '../views.js';
import type { Address } from '../mail/parse.js';
import { bus } from '../events.js';
import { log } from '../log.js';
import { signatureById, defaultSignature } from './signatures.js';

const safeList = (v: string | null | undefined): string[] => {
  try {
    return (JSON.parse(v || '[]') as string[]).map((x) => String(x).toLowerCase());
  } catch {
    return [];
  }
};

const esc = (t: string): string => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

type DraftRow = { id: number; account_id: number; thread_id: number | null; in_reply_to: number | null; forward_of: number | null; to_text: string; cc_text: string; bcc_text: string; subject: string; text: string; attachments_json: string; from_address: string; updated_at: string };

const draftView = (d: DraftRow) => ({
  id: String(d.id),
  accountId: String(d.account_id),
  threadId: d.thread_id ? String(d.thread_id) : null,
  inReplyTo: d.in_reply_to ? String(d.in_reply_to) : null,
  forwardOf: d.forward_of ? String(d.forward_of) : null,
  fromAddress: d.from_address || null,
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
  let account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(m.account_id) as AccountRow;
  const allAccounts = db.prepare('SELECT * FROM accounts').all() as AccountRow[];
  const ownerOf = new Map<string, AccountRow>();
  for (const a of allAccounts) {
    ownerOf.set(a.email.toLowerCase(), a);
    for (const al of safeList(a.aliases)) ownerOf.set(al, a);
  }
  const mine = new Set(ownerOf.keys());
  // "Reply from the address the email was sent to": pick the account (or alias) that received it.
  let fromAddress: string | null = null;
  if (uiSettings().compose.replyFromRecipient && !m.mine) {
    const rcpts = [...(JSON.parse(m.to_json) as Address[]), ...(JSON.parse(m.cc_json) as Address[])];
    const hit = rcpts.find((r) => ownerOf.has(r.email));
    if (hit) {
      account = ownerOf.get(hit.email) as AccountRow;
      if (hit.email !== account.email.toLowerCase()) fromAddress = hit.email;
    }
  }
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
    return { accountId: String(account.id), fromAddress, to: '', cc: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${subjectBase}`, quotedText: `\n\n${header}\n\n${text}`, quotedHtml: body?.html || null, headerLine: header };
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
    fromAddress,
    to: toList.map(formatAddress).join(', '),
    cc: ccList.map(formatAddress).join(', '),
    subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${subjectBase}`,
    quotedText: `\n\n${headerLine}\n${quoteText(text)}`,
    quotedHtml: body?.html ? `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${body.html}</blockquote>` : null,
    headerLine,
  };
}

type SendFields = { accountId?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string; html?: string; inReplyTo?: string; forwardOf?: string; draftId?: string; uploadIds?: string | string[]; signatureId?: string; quote?: string; fromAddress?: string; sendAt?: string; now?: string };

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
    const settings = uiSettings();
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(b.accountId)) as AccountRow | undefined;
    if (!account) return reply.code(400).send({ error: 'no_account', message: 'Choose which address to send from.' });
    const to = String(b.to || '').trim();
    if (!parseAddressList(to).length) return reply.code(400).send({ error: 'no_recipient', message: 'Add at least one valid recipient.' });
    for (const [field, val] of [['To', to], ['Cc', String(b.cc || '')], ['Bcc', String(b.bcc || '')]] as const) {
      const raw = val.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      if (raw.length !== parseAddressList(val).length) return reply.code(400).send({ error: 'bad_address', message: `${field} has an address that does not look right.` });
    }
    let bcc = String(b.bcc || '');
    if (settings.compose.bccMyself && !parseAddressList(bcc).some((a) => a.email === account.email)) bcc = bcc ? `${bcc}, ${account.email}` : account.email;
    const uploadIds = (Array.isArray(b.uploadIds) ? b.uploadIds : b.uploadIds ? [b.uploadIds] : []).map((x) => String(x).replace(/[^A-Za-z0-9_-]/g, ''));
    let inReplyTo: SendJob['inReplyTo'] = null;
    let replyRow: MessageRow | undefined;
    if (b.inReplyTo) {
      replyRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(b.inReplyTo)) as MessageRow | undefined;
      if (replyRow?.message_id) {
        const refs = (db.prepare('SELECT ref FROM message_refs WHERE message_row = ?').all(replyRow.id) as { ref: string }[]).map((r) => r.ref);
        inReplyTo = { messageId: replyRow.message_id, references: refs.slice(-20), row: replyRow.id };
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
    // Reply from the alias the mail was sent to, when it belongs to this account.
    let fromAddress: string | undefined;
    if (b.fromAddress) {
      const alias = String(b.fromAddress).toLowerCase();
      const aliases = safeList(account.aliases);
      if (alias === account.email.toLowerCase() || aliases.includes(alias)) fromAddress = alias;
    }
    const job: SendJob = {
      accountId: account.id,
      to,
      cc: String(b.cc || ''),
      bcc,
      subject: String(b.subject || ''),
      text: String(b.text || ''),
      html: b.html ? String(b.html) : undefined,
      inReplyTo,
      forwardOf: b.forwardOf ? Number(b.forwardOf) : null,
      signature,
      quote,
      uploadIds,
      draftId: b.draftId ? Number(b.draftId) : null,
      threadId: replyRow?.thread_id ?? (b.forwardOf ? null : null),
      fromAddress,
    };
    // "Send later" or "Undo send": queue it; otherwise send now.
    let sendAt: Date | null = null;
    if (b.sendAt) {
      const d = new Date(String(b.sendAt));
      if (Number.isNaN(d.getTime())) return reply.code(400).send({ error: 'bad_time', message: 'That send time is not valid.' });
      sendAt = d;
    } else if (settings.compose.undoSendSec > 0 && b.now !== '1') {
      sendAt = new Date(Date.now() + settings.compose.undoSendSec * 1000);
    }
    if (sendAt) {
      const row = enqueue(job, sendAt);
      if (job.draftId) db.prepare('DELETE FROM drafts WHERE id = ?').run(job.draftId);
      return { ok: true, queued: true, outboxId: String(row.id), sendAt: row.send_at, threadId: job.threadId ? String(job.threadId) : null };
    }
    try {
      const r = await executeSend(job);
      return { ok: true, messageId: r.messageId, threadId: r.threadId ? String(r.threadId) : null };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(502).send({ error: 'send_failed', message: /auth|535|credentials/i.test(msg) ? 'The mail server refused the login. Check the account password in Settings.' : `Sending failed: ${msg}` });
    }
  });

  app.get('/api/outbox', async () => ({ items: listQueued() }));

  // Undo: the job comes back as a draft so it can be reopened.
  app.delete<{ Params: { id: string } }>('/api/outbox/:id', async (req, reply) => {
    const job = cancel(Number(req.params.id));
    if (!job) return reply.code(404).send({ error: 'gone', message: 'That email was already sent.' });
    const atts = job.uploadIds.map((id) => {
      const clean = String(id).replace(/[^A-Za-z0-9_-]/g, '');
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(config.uploadsDir, clean + '.json'), 'utf8')) as { filename: string; size: number };
        return { id: clean, filename: meta.filename, size: meta.size };
      } catch {
        return { id: clean, filename: 'attachment', size: 0 };
      }
    });
    const info = db
      .prepare('INSERT INTO drafts(account_id, thread_id, in_reply_to, forward_of, to_text, cc_text, bcc_text, subject, text, attachments_json, from_address) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(job.accountId, job.threadId ?? null, job.inReplyTo?.row ?? null, job.forwardOf ?? null, job.to, job.cc, job.bcc, job.subject, job.text, JSON.stringify(atts), job.fromAddress || '');
    const d = db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid) as DraftRow;
    if (d.thread_id) bus.publish({ type: 'thread.updated', threadId: String(d.thread_id), accountId: String(d.account_id) });
    return { ok: true, draft: draftView(d) };
  });

  app.get('/api/drafts', async () => (db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all() as DraftRow[]).map(draftView));

  const saveDraft = (id: number | null, b: Record<string, unknown>) => {
    const accountId = Number(b.accountId);
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) throw Object.assign(new Error('Unknown account'), { statusCode: 400 });
    const atts = Array.isArray(b.attachments) ? (b.attachments as { id?: string; filename?: string; size?: number }[]).filter((a) => a && a.id).map((a) => ({ id: String(a.id).replace(/[^A-Za-z0-9_-]/g, ''), filename: String(a.filename || 'attachment'), size: Number(a.size) || 0 })) : [];
    const vals = [accountId, b.threadId ? Number(b.threadId) : null, b.inReplyTo ? Number(b.inReplyTo) : null, b.forwardOf ? Number(b.forwardOf) : null, String(b.to || ''), String(b.cc || ''), String(b.bcc || ''), String(b.subject || ''), String(b.text || ''), JSON.stringify(atts), String(b.fromAddress || '').toLowerCase()];
    if (id) {
      db.prepare("UPDATE drafts SET account_id = ?, thread_id = ?, in_reply_to = ?, forward_of = ?, to_text = ?, cc_text = ?, bcc_text = ?, subject = ?, text = ?, attachments_json = ?, from_address = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(...vals, id);
      return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow;
    }
    const info = db.prepare('INSERT INTO drafts(account_id, thread_id, in_reply_to, forward_of, to_text, cc_text, bcc_text, subject, text, attachments_json, from_address) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals);
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
    } else {
      touchAttachment(a.id);
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
