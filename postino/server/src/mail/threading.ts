import { db } from '../db.js';
import { bus } from '../events.js';
import { normalizeSubject, hasReplyPrefix, type Address } from './parse.js';

type ThreadRow = { id: number; first_date: string; participants: string };

/**
 * Find or create the thread for a message, JWZ-style: join whatever thread the
 * referenced messages belong to (merging threads if the references bridge
 * several), and fall back to subject matching for replies without references.
 */
export function assignThread(opts: {
  accountId: number;
  messageId: string;
  references: string[];
  inReplyTo: string;
  subject: string;
  date: string;
  participants: Address[];
}): number {
  const refs = new Set<string>(opts.references.slice(-50)); // a References header is at most the last 50 ids
  if (opts.inReplyTo) refs.add(opts.inReplyTo);
  refs.delete(opts.messageId);
  const subjectNorm = normalizeSubject(opts.subject);

  const candidates = new Set<number>();
  if (opts.messageId) {
    // Same Message-ID already stored (copy in another folder) or messages that reference us.
    for (const r of db
      .prepare('SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND message_id = ?')
      .all(opts.accountId, opts.messageId) as { thread_id: number }[])
      candidates.add(r.thread_id);
    for (const r of db
      .prepare('SELECT DISTINCT m.thread_id FROM message_refs mr JOIN messages m ON m.id = mr.message_row WHERE mr.account_id = ? AND mr.ref = ?')
      .all(opts.accountId, opts.messageId) as { thread_id: number }[])
      candidates.add(r.thread_id);
  }
  if (refs.size) {
    const list = [...refs];
    const placeholders = list.map(() => '?').join(',');
    for (const r of db
      .prepare(`SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND message_id IN (${placeholders})`)
      .all(opts.accountId, ...list) as { thread_id: number }[])
      candidates.add(r.thread_id);
    // Messages that share any reference with us (same root) belong together too.
    for (const r of db
      .prepare(`SELECT DISTINCT m.thread_id FROM message_refs mr JOIN messages m ON m.id = mr.message_row WHERE mr.account_id = ? AND mr.ref IN (${placeholders})`)
      .all(opts.accountId, ...list) as { thread_id: number }[])
      candidates.add(r.thread_id);
  }

  if (!candidates.size && subjectNorm && (hasReplyPrefix(opts.subject) || refs.size)) {
    // Subject fallback: a reply with a matching subject in the last 60 days that shares a participant.
    const since = new Date(new Date(opts.date).getTime() - 60 * 86400_000).toISOString();
    const until = new Date(new Date(opts.date).getTime() + 60 * 86400_000).toISOString();
    const rows = db
      .prepare('SELECT id, first_date, participants FROM threads WHERE account_id = ? AND subject_norm = ? AND last_date >= ? AND first_date <= ? ORDER BY last_date DESC LIMIT 10')
      .all(opts.accountId, subjectNorm, since, until) as ThreadRow[];
    const mine = new Set(opts.participants.map((p) => p.email));
    for (const t of rows) {
      let parts: Address[] = [];
      try {
        parts = JSON.parse(t.participants) as Address[];
      } catch {
        parts = [];
      }
      if (parts.some((p) => mine.has(p.email))) {
        candidates.add(t.id);
        break;
      }
    }
  }

  if (!candidates.size) {
    const info = db
      .prepare('INSERT INTO threads(account_id, subject, subject_norm, first_date, last_date) VALUES (?, ?, ?, ?, ?)')
      .run(opts.accountId, opts.subject, subjectNorm, opts.date, opts.date);
    return Number(info.lastInsertRowid);
  }

  const ids = [...candidates].sort((a, b) => a - b);
  const keep = ids[0];
  if (ids.length > 1) {
    const merge = db.prepare('UPDATE messages SET thread_id = ? WHERE thread_id = ?');
    const del = db.prepare('DELETE FROM threads WHERE id = ?');
    const draft = db.prepare('UPDATE drafts SET thread_id = ? WHERE thread_id = ?');
    for (const other of ids.slice(1)) {
      merge.run(keep, other);
      draft.run(keep, other);
      del.run(other);
      bus.publish({ type: 'thread.removed', threadId: String(other) });
    }
  }
  return keep;
}
