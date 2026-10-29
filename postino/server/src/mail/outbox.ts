import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import { bus } from '../events.js';
import { log } from '../log.js';
import type { AccountRow } from '../views.js';
import { manager } from './manager.js';
import { sendMail, type OutgoingAttachment } from './send.js';
import { attachmentPath, type MessageRow } from './store.js';
import type { AttachmentRow } from '../views.js';

/**
 * Outgoing mail goes through the outbox: it gives "Undo send" (a short delay),
 * "Send later" (a chosen time), and survives a restart because jobs are rows.
 */

export type SendJob = {
  accountId: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: { messageId: string; references: string[]; row: number } | null;
  forwardOf?: number | null;
  signature?: { html: string; text: string } | null;
  quote?: { html: string | null; text: string } | null;
  uploadIds: string[];
  draftId?: number | null;
  threadId?: number | null;
  fromAddress?: string;
};

type OutboxRow = { id: number; account_id: number; payload: string; send_at: string; status: string; error: string | null; created_at: string };

export function outboxView(r: OutboxRow) {
  const p = JSON.parse(r.payload) as SendJob;
  return { id: String(r.id), accountId: String(r.account_id), to: p.to, cc: p.cc, subject: p.subject, text: p.text.slice(0, 200), sendAt: r.send_at, status: r.status, error: r.error, threadId: p.threadId ? String(p.threadId) : null, createdAt: r.created_at };
}

export function enqueue(job: SendJob, sendAt: Date): OutboxRow {
  const info = db.prepare('INSERT INTO outbox(account_id, payload, send_at) VALUES (?, ?, ?)').run(job.accountId, JSON.stringify(job), sendAt.toISOString());
  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(info.lastInsertRowid) as OutboxRow;
  scheduleTick();
  return row;
}

/** Cancel a queued send. Returns the job so the composer can reopen it as a draft. */
export function cancel(id: number): SendJob | null {
  const row = db.prepare("SELECT * FROM outbox WHERE id = ? AND status = 'queued'").get(id) as OutboxRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ?").run(id);
  return JSON.parse(row.payload) as SendJob;
}

export function listQueued() {
  return (db.prepare("SELECT * FROM outbox WHERE status IN ('queued', 'sending', 'failed') ORDER BY send_at").all() as OutboxRow[]).map(outboxView);
}

function uploadsFor(ids: string[]): OutgoingAttachment[] {
  const out: OutgoingAttachment[] = [];
  for (const raw of ids) {
    const id = String(raw).replace(/[^A-Za-z0-9_-]/g, '');
    const metaFile = path.join(config.uploadsDir, id + '.json');
    if (!fs.existsSync(metaFile)) continue;
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { filename: string; contentType: string };
    out.push({ filename: meta.filename, contentType: meta.contentType, path: path.join(config.uploadsDir, id) });
  }
  return out;
}

async function forwardedAttachments(messageRow: number): Promise<OutgoingAttachment[]> {
  const fwd = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageRow) as MessageRow | undefined;
  if (!fwd) return [];
  const atts = db.prepare('SELECT * FROM attachments WHERE message_row = ? AND is_inline = 0').all(fwd.id) as AttachmentRow[];
  const sync = manager.get(fwd.account_id);
  const out: OutgoingAttachment[] = [];
  for (const a of atts) {
    try {
      const file = sync ? await sync.cacheAttachment(a.id) : attachmentPath(a.id);
      out.push({ filename: a.filename, contentType: a.content_type, path: file });
    } catch {
      // skip what we cannot fetch
    }
  }
  return out;
}

/** Actually send a job over SMTP (used for immediate sends and by the outbox worker). */
export async function executeSend(job: SendJob): Promise<{ messageId: string; threadId: number | null }> {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(job.accountId) as AccountRow | undefined;
  if (!account) throw new Error('The sending account no longer exists.');
  const attachments = [...uploadsFor(job.uploadIds), ...(job.forwardOf ? await forwardedAttachments(job.forwardOf) : [])];
  const r = await sendMail({
    account,
    to: job.to,
    cc: job.cc,
    bcc: job.bcc,
    subject: job.subject,
    text: job.text,
    html: job.html,
    inReplyTo: job.inReplyTo ? { messageId: job.inReplyTo.messageId, references: job.inReplyTo.references } : null,
    attachments,
    signature: job.signature,
    quote: job.quote,
    fromAddress: job.fromAddress,
  });
  if (job.inReplyTo?.row) {
    const sync = manager.get(job.accountId);
    sync?.markAnswered(job.inReplyTo.row).catch((err: Error) => log.warn({ err: err.message }, 'could not flag as answered'));
  }
  if (job.draftId) db.prepare('DELETE FROM drafts WHERE id = ?').run(job.draftId);
  for (const id of job.uploadIds) {
    const clean = String(id).replace(/[^A-Za-z0-9_-]/g, '');
    for (const f of [path.join(config.uploadsDir, clean), path.join(config.uploadsDir, clean + '.json')]) fs.promises.unlink(f).catch(() => undefined);
  }
  const sent = db.prepare('SELECT thread_id FROM messages WHERE account_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1').get(account.id, r.messageId) as { thread_id: number } | undefined;
  const threadId = sent?.thread_id ?? job.threadId ?? null;
  if (threadId) bus.publish({ type: 'thread.updated', threadId: String(threadId), accountId: String(account.id) });
  return { messageId: r.messageId, threadId };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

function scheduleTick(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, 1000);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = db.prepare("SELECT * FROM outbox WHERE status = 'queued' AND send_at <= ? ORDER BY send_at LIMIT 5").all(new Date().toISOString()) as OutboxRow[];
    for (const row of due) {
      db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ?").run(row.id);
      try {
        await executeSend(JSON.parse(row.payload) as SendJob);
        db.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").run(row.id);
        bus.publish({ type: 'outbox.updated', id: String(row.id), status: 'sent' } as never);
      } catch (err) {
        const msg = (err as Error).message;
        log.warn({ id: row.id, err: msg }, 'outbox send failed');
        db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?").run(msg.slice(0, 300), row.id);
        bus.publish({ type: 'action.failed', message: `Could not send "${(JSON.parse(row.payload) as SendJob).subject || '(no subject)'}": ${msg}` });
        bus.publish({ type: 'outbox.updated', id: String(row.id), status: 'failed' } as never);
      }
    }
    // Old sent/cancelled rows are not worth keeping.
    db.prepare("DELETE FROM outbox WHERE status IN ('sent', 'cancelled') AND created_at < ?").run(new Date(Date.now() - 7 * 86400_000).toISOString());
  } finally {
    running = false;
    const next = db.prepare("SELECT MIN(send_at) AS t FROM outbox WHERE status = 'queued'").get() as { t: string | null };
    if (next.t) {
      const wait = Math.max(500, Math.min(60_000, new Date(next.t).getTime() - Date.now()));
      timer = setTimeout(() => {
        timer = null;
        void tick();
      }, wait);
    }
  }
}

export function startOutbox(): void {
  // Anything stuck in "sending" from a crash goes back to the queue.
  db.prepare("UPDATE outbox SET status = 'queued' WHERE status = 'sending'").run();
  scheduleTick();
}
