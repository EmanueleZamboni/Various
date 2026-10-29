import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { bus } from '../events.js';
import { assignThread } from './threading.js';
import { normalizeSubject, makeSnippet, categorize, type Address, type Category, type ParsedHeaders, type ParsedBody } from './parse.js';

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash' | 'blocked' | 'other';

export type FolderRow = {
  id: number;
  account_id: number;
  path: string;
  name: string;
  delimiter: string;
  role: FolderRole;
  uidvalidity: number | null;
  uidnext: number;
  highestmodseq: number | null;
  total: number;
  unseen: number;
  last_sync_at: string | null;
  present: number;
};

export type MessageRow = {
  id: number;
  account_id: number;
  folder_id: number;
  uid: number;
  thread_id: number;
  message_id: string;
  in_reply_to: string;
  subject: string;
  subject_norm: string;
  from_json: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  from_email: string;
  date: string;
  internal_date: string | null;
  size: number;
  seen: number;
  flagged: number;
  answered: number;
  draft: number;
  mine: number;
  category: Category;
  has_attachments: number;
  snippet: string;
  list_unsubscribe: string | null;
  body_fetched: number;
  body_error: string | null;
  structure_json: string | null;
};

export type ThreadRow = {
  id: number;
  account_id: number;
  subject: string;
  subject_norm: string;
  snippet: string;
  participants: string;
  last_from: string;
  last_date: string;
  first_date: string;
  msg_count: number;
  unread_count: number;
  pinned: number;
  answered: number;
  has_attachments: number;
  category: Category;
  roles: string;
  inbox_date: string;
  role_dates: string;
};

export const myAddresses = (): Set<string> => {
  const rows = db.prepare('SELECT email, aliases FROM accounts').all() as { email: string; aliases: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.email.toLowerCase());
    try {
      for (const a of JSON.parse(r.aliases || '[]') as string[]) if (a) out.add(a.toLowerCase());
    } catch {
      // ignore bad json
    }
  }
  return out;
};

export function senderOverride(email: string): Category | null {
  const r = db.prepare('SELECT category FROM sender_overrides WHERE email = ?').get(email.toLowerCase()) as { category: Category } | undefined;
  return r?.category ?? null;
}

export type HeaderInsert = {
  accountId: number;
  folder: FolderRow;
  uid: number;
  headers: ParsedHeaders;
  flags: Set<string>;
  internalDate: Date | null;
  size: number;
  hasAttachments: boolean;
  structureJson: string | null;
};

/** Insert (or refresh) a message from its headers. Returns the row id and whether it was new. */
export function upsertHeader(h: HeaderInsert): { id: number; isNew: boolean; threadId: number } {
  const existing = db.prepare('SELECT id, thread_id FROM messages WHERE folder_id = ? AND uid = ?').get(h.folder.id, h.uid) as
    | { id: number; thread_id: number }
    | undefined;
  const flags = flagsFromSet(h.flags);
  if (existing) {
    db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ?, draft = ? WHERE id = ?').run(flags.seen, flags.flagged, flags.answered, flags.draft, existing.id);
    return { id: existing.id, isNew: false, threadId: existing.thread_id };
  }
  const mine = myAddresses();
  const date = (h.headers.date && !Number.isNaN(h.headers.date.getTime()) ? h.headers.date : h.internalDate || new Date()).toISOString();
  const participants = uniqueAddresses([h.headers.from, ...h.headers.to, ...h.headers.cc]);
  // A message is "mine" only when it sits in my Sent/Drafts: a From header can be spoofed.
  const isMine = ['sent', 'drafts'].includes(h.folder.role) && mine.has(h.headers.from.email);
  const category = categorize(h.headers, senderOverride(h.headers.from.email));

  const tx = db.transaction(() => {
    const threadId = assignThread({
      accountId: h.accountId,
      messageId: h.headers.messageId,
      references: h.headers.references,
      inReplyTo: h.headers.inReplyTo,
      subject: h.headers.subject,
      date,
      participants,
    });
    const info = db
      .prepare(
        `INSERT INTO messages(account_id, folder_id, uid, thread_id, message_id, in_reply_to, subject, subject_norm,
          from_json, to_json, cc_json, bcc_json, reply_to_json, from_email, date, internal_date, size,
          seen, flagged, answered, draft, mine, category, has_attachments, snippet, list_unsubscribe, body_fetched, structure_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      )
      .run(
        h.accountId,
        h.folder.id,
        h.uid,
        threadId,
        h.headers.messageId,
        h.headers.inReplyTo,
        h.headers.subject,
        normalizeSubject(h.headers.subject),
        JSON.stringify(h.headers.from),
        JSON.stringify(h.headers.to),
        JSON.stringify(h.headers.cc),
        JSON.stringify(h.headers.bcc),
        JSON.stringify(h.headers.replyTo),
        h.headers.from.email,
        date,
        h.internalDate ? h.internalDate.toISOString() : null,
        h.size,
        flags.seen,
        flags.flagged,
        flags.answered,
        flags.draft,
        isMine ? 1 : 0,
        category,
        h.hasAttachments ? 1 : 0,
        '',
        h.headers.listUnsubscribe,
        h.structureJson,
      );
    const id = Number(info.lastInsertRowid);
    const refs = new Set(h.headers.references);
    if (h.headers.inReplyTo) refs.add(h.headers.inReplyTo);
    const ins = db.prepare('INSERT INTO message_refs(message_row, account_id, ref) VALUES (?, ?, ?)');
    for (const r of refs) ins.run(id, h.accountId, r);
    // Searchable right away by subject and addresses; the body is added when fetched.
    db.prepare('INSERT INTO fts(rowid, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)').run(
      id,
      h.headers.subject,
      addressText([h.headers.from]),
      addressText([...h.headers.to, ...h.headers.cc, ...h.headers.bcc]),
      '',
    );
    touchContacts(h.headers, isMine);
    recomputeThread(threadId);
    return { id, threadId };
  });
  const r = tx();
  return { id: r.id, isNew: true, threadId: r.threadId };
}

export function flagsFromSet(flags: Set<string>): { seen: number; flagged: number; answered: number; draft: number } {
  return {
    seen: flags.has('\\Seen') ? 1 : 0,
    flagged: flags.has('\\Flagged') ? 1 : 0,
    answered: flags.has('\\Answered') ? 1 : 0,
    draft: flags.has('\\Draft') ? 1 : 0,
  };
}

export function updateFlags(folderId: number, uid: number, flags: Set<string>): { changed: boolean; threadId: number | null } {
  const row = db.prepare('SELECT id, thread_id, seen, flagged, answered, draft FROM messages WHERE folder_id = ? AND uid = ?').get(folderId, uid) as
    | { id: number; thread_id: number; seen: number; flagged: number; answered: number; draft: number }
    | undefined;
  if (!row) return { changed: false, threadId: null };
  const f = flagsFromSet(flags);
  if (row.seen === f.seen && row.flagged === f.flagged && row.answered === f.answered && row.draft === f.draft) return { changed: false, threadId: row.thread_id };
  db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ?, draft = ? WHERE id = ?').run(f.seen, f.flagged, f.answered, f.draft, row.id);
  recomputeThread(row.thread_id);
  return { changed: true, threadId: row.thread_id };
}

export function storeBody(messageRow: number, body: ParsedBody): void {
  const tx = db.transaction(() => {
    const msg = db.prepare('SELECT id, thread_id, subject, from_json, to_json, cc_json, bcc_json FROM messages WHERE id = ?').get(messageRow) as
      | { id: number; thread_id: number; subject: string; from_json: string; to_json: string; cc_json: string; bcc_json: string }
      | undefined;
    if (!msg) return;
    db.prepare('INSERT INTO bodies(message_row, text, html, quoted, has_remote_images, calendar_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_row) DO UPDATE SET text = excluded.text, html = excluded.html, quoted = excluded.quoted, has_remote_images = excluded.has_remote_images, calendar_json = excluded.calendar_json').run(
      messageRow,
      body.text,
      body.html,
      body.quoted,
      body.hasRemoteImages ? 1 : 0,
      body.calendar ? JSON.stringify(body.calendar) : null,
    );
    const hasAtt = body.attachments.some((a) => !a.inline) ? 1 : 0;
    db.prepare('UPDATE messages SET body_fetched = 1, body_error = NULL, snippet = ?, has_attachments = ? WHERE id = ?').run(body.snippet, hasAtt, messageRow);
    const bodyText = (body.text || '').slice(0, 200_000);
    const from = JSON.parse(msg.from_json) as Address;
    const to = [...(JSON.parse(msg.to_json) as Address[]), ...(JSON.parse(msg.cc_json) as Address[]), ...(JSON.parse(msg.bcc_json) as Address[])];
    db.prepare('DELETE FROM fts WHERE rowid = ?').run(messageRow);
    db.prepare('INSERT INTO fts(rowid, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)').run(
      messageRow,
      msg.subject,
      addressText([from]),
      addressText(to),
      bodyText + ' ' + body.attachments.map((a) => a.filename).join(' '),
    );
    recomputeThread(msg.thread_id);
  });
  tx();
}

/** Record why a body could not be fetched. With folder/uid given, a message that moved meanwhile is left alone. */
export function markBodyError(messageRow: number, error: string, folderId?: number, uid?: number): void {
  if (folderId !== undefined && uid !== undefined) {
    db.prepare('UPDATE messages SET body_error = ? WHERE id = ? AND folder_id = ? AND uid = ?').run(error.slice(0, 500), messageRow, folderId, uid);
    return;
  }
  db.prepare('UPDATE messages SET body_error = ? WHERE id = ?').run(error.slice(0, 500), messageRow);
}

/** Save an attachment's bytes to disk and register it. Returns the attachment id. */
export function storeAttachment(messageRow: number, a: ParsedBody['attachments'][number] & { part?: string }): number {
  const info = db
    .prepare('INSERT INTO attachments(message_row, part, filename, content_type, size, content_id, is_inline, cached) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(messageRow, a.part || '', a.filename, a.contentType, a.size, a.contentId, a.inline ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  fs.writeFileSync(attachmentPath(id), a.content);
  return id;
}

export function registerAttachmentMeta(messageRow: number, a: { part: string; filename: string; contentType: string; size: number; contentId: string | null; inline: boolean }): number {
  const info = db
    .prepare('INSERT INTO attachments(message_row, part, filename, content_type, size, content_id, is_inline, cached) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .run(messageRow, a.part, a.filename, a.contentType, a.size, a.contentId, a.inline ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export function attachmentPath(id: number): string {
  return path.join(config.attachmentsDir, String(id));
}

/**
 * Files attached to a draft that was never sent stay in data/uploads. Drop the ones
 * older than a week that no draft and no queued email still references.
 */
export function pruneUploads(maxAgeMs = 7 * 86_400_000): number {
  let names: string[];
  try {
    names = fs.readdirSync(config.uploadsDir);
  } catch {
    return 0;
  }
  const referenced = new Set<string>();
  for (const r of db.prepare('SELECT attachments_json FROM drafts').all() as { attachments_json: string }[]) {
    try {
      for (const a of JSON.parse(r.attachments_json || '[]') as { id?: string }[]) if (a.id) referenced.add(a.id);
    } catch {
      // ignore a malformed row
    }
  }
  for (const r of db.prepare("SELECT payload FROM outbox WHERE status IN ('queued', 'sending', 'failed')").all() as { payload: string }[]) {
    try {
      for (const id of (JSON.parse(r.payload) as { uploadIds?: string[] }).uploadIds || []) referenced.add(id);
    } catch {
      // ignore
    }
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const n of names) {
    const id = n.replace(/\.json$/, '');
    if (referenced.has(id)) continue;
    const file = path.join(config.uploadsDir, n);
    try {
      if (fs.statSync(file).mtimeMs > cutoff) continue;
      fs.unlinkSync(file);
      removed++;
    } catch {
      // vanished meanwhile
    }
  }
  return removed;
}

/** Mark a cached attachment as recently used so pruning drops it last. */
export function touchAttachment(id: number): void {
  try {
    const now = new Date();
    fs.utimesSync(attachmentPath(id), now, now);
  } catch {
    // not cached
  }
}

/**
 * Keep the attachment cache under config.attachmentCacheBytes by removing the
 * least recently used files. Dropped attachments are fetched again on demand.
 */
export function pruneAttachmentCache(limit = config.attachmentCacheBytes): { removed: number; freed: number } {
  let names: string[];
  try {
    names = fs.readdirSync(config.attachmentsDir);
  } catch {
    return { removed: 0, freed: 0 };
  }
  const files: { id: number; size: number; mtime: number }[] = [];
  let total = 0;
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const st = fs.statSync(path.join(config.attachmentsDir, n));
      files.push({ id: Number(n), size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch {
      // vanished meanwhile
    }
  }
  if (total <= limit) return { removed: 0, freed: 0 };
  files.sort((a, b) => a.mtime - b.mtime);
  const uncache = db.prepare('UPDATE attachments SET cached = 0 WHERE id = ?');
  let removed = 0;
  let freed = 0;
  for (const f of files) {
    if (total - freed <= limit) break;
    try {
      fs.unlinkSync(attachmentPath(f.id));
      uncache.run(f.id);
      removed++;
      freed += f.size;
    } catch {
      // ignore
    }
  }
  return { removed, freed };
}

export function deleteMessagesByIds(ids: number[]): void {
  if (!ids.length) return;
  const tx = db.transaction(() => {
    const threads = new Set<number>();
    const sel = db.prepare('SELECT thread_id FROM messages WHERE id = ?');
    const atts = db.prepare('SELECT id FROM attachments WHERE message_row = ?');
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    const delFts = db.prepare('DELETE FROM fts WHERE rowid = ?');
    for (const id of ids) {
      const r = sel.get(id) as { thread_id: number } | undefined;
      if (!r) continue;
      threads.add(r.thread_id);
      for (const a of atts.all(id) as { id: number }[]) {
        try {
          fs.unlinkSync(attachmentPath(a.id));
        } catch {
          // not cached
        }
      }
      delFts.run(id);
      del.run(id);
    }
    for (const t of threads) recomputeThread(t);
  });
  tx();
}

export function deleteFolderMessages(folderId: number): void {
  const ids = (db.prepare('SELECT id FROM messages WHERE folder_id = ?').all(folderId) as { id: number }[]).map((r) => r.id);
  deleteMessagesByIds(ids);
}

/**
 * Recompute a thread's cached aggregates from its messages. Removes the thread
 * when it has no messages left.
 */
export function recomputeThread(threadId: number): void {
  const rows = db
    .prepare(
      `SELECT m.id, m.message_id, m.date, m.seen, m.flagged, m.answered, m.has_attachments, m.snippet, m.category, m.mine,
              m.from_json, m.to_json, m.cc_json, m.subject, f.role
       FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.thread_id = ? ORDER BY m.date ASC`,
    )
    .all(threadId) as {
    id: number;
    message_id: string;
    date: string;
    seen: number;
    flagged: number;
    answered: number;
    has_attachments: number;
    snippet: string;
    category: Category;
    mine: number;
    from_json: string;
    to_json: string;
    cc_json: string;
    subject: string;
    role: FolderRole;
  }[];
  if (!rows.length) {
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    bus.publish({ type: 'thread.removed', threadId: String(threadId) });
    return;
  }
  // De-duplicate copies of the same message living in several folders.
  const seenIds = new Set<string>();
  const unique = rows.filter((r) => {
    if (!r.message_id) return true;
    if (seenIds.has(r.message_id)) return false;
    seenIds.add(r.message_id);
    return true;
  });
  const mine = myAddresses();
  const participants: Address[] = [];
  const seenEmails = new Set<string>();
  for (const r of [...unique].reverse()) {
    const list: Address[] = [JSON.parse(r.from_json) as Address, ...(JSON.parse(r.to_json) as Address[]), ...(JSON.parse(r.cc_json) as Address[])];
    for (const a of list) {
      if (!a.email || seenEmails.has(a.email)) continue;
      seenEmails.add(a.email);
      participants.push(a);
    }
  }
  const others = participants.filter((p) => !mine.has(p.email));
  const shown = others.length ? others : participants;
  const last = unique[unique.length - 1];
  const lastIncoming = [...unique].reverse().find((r) => !r.mine) || last;
  const roles = new Set(rows.map((r) => r.role));
  const roleDates: Record<string, string> = {};
  for (const r of rows) {
    if (!roleDates[r.role] || roleDates[r.role] < r.date) roleDates[r.role] = r.date;
  }
  const inboxDate = roleDates['inbox'] || '';
  const withSnippet = [...unique].reverse().find((r) => r.snippet) || last;
  db.prepare(
    `UPDATE threads SET subject = ?, subject_norm = ?, snippet = ?, participants = ?, last_from = ?, last_date = ?, first_date = ?,
       msg_count = ?, unread_count = ?, pinned = ?, answered = ?, has_attachments = ?, category = ?, roles = ?, inbox_date = ?, role_dates = ?
     WHERE id = ?`,
  ).run(
    (unique.find((r) => r.subject) || last).subject,
    normalizeSubject((unique.find((r) => r.subject) || last).subject),
    makeSnippet(withSnippet.snippet || ''),
    JSON.stringify(shown.slice(0, 8)),
    last.from_json,
    last.date,
    unique[0].date,
    unique.length,
    unique.filter((r) => !r.seen).length,
    rows.some((r) => r.flagged) ? 1 : 0,
    rows.some((r) => r.answered) ? 1 : 0,
    rows.some((r) => r.has_attachments) ? 1 : 0,
    lastIncoming.category,
    ',' + [...roles].join(',') + ',',
    inboxDate,
    JSON.stringify(roleDates),
    threadId,
  );
}

export function uniqueAddresses(list: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    if (!a || !a.email || seen.has(a.email)) continue;
    seen.add(a.email);
    out.push(a);
  }
  return out;
}

function addressText(list: Address[]): string {
  return list.map((a) => `${a.name || ''} ${a.email || ''}`.trim()).join(' ');
}

function touchContacts(h: ParsedHeaders, mine: boolean): void {
  const my = myAddresses();
  const up = db.prepare(
    `INSERT INTO contacts(email, name, count, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET count = count + excluded.count, last_seen = max(last_seen, excluded.last_seen),
       name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END`,
  );
  const when = (h.date || new Date()).toISOString();
  if (mine) {
    for (const a of [...h.to, ...h.cc]) if (a.email && !my.has(a.email)) up.run(a.email, a.name, 3, when);
  } else if (h.from.email && !my.has(h.from.email)) {
    up.run(h.from.email, h.from.name, 1, when);
  }
}

/** Does this sender match a blocked pattern (exact address or @domain)? */
export function isBlocked(email: string): boolean {
  const e = (email || '').toLowerCase();
  if (!e) return false;
  const domain = '@' + (e.split('@')[1] || '');
  const r = db.prepare('SELECT 1 FROM blocked_senders WHERE pattern = ? OR pattern = ? LIMIT 1').get(e, domain);
  return Boolean(r);
}

export function folderByRole(accountId: number, role: FolderRole): FolderRow | undefined {
  return db.prepare('SELECT * FROM folders WHERE account_id = ? AND role = ? AND present = 1 ORDER BY id LIMIT 1').get(accountId, role) as FolderRow | undefined;
}

export function foldersByRole(accountId: number, role: FolderRole): FolderRow[] {
  return db.prepare('SELECT * FROM folders WHERE account_id = ? AND role = ? AND present = 1 ORDER BY id').all(accountId, role) as FolderRow[];
}

export function refreshFolderCounts(folderId: number): void {
  const r = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) AS unseen FROM messages WHERE folder_id = ?').get(folderId) as { total: number; unseen: number | null };
  db.prepare('UPDATE folders SET total = ?, unseen = ?, last_sync_at = ? WHERE id = ?').run(r.total, r.unseen || 0, nowIso(), folderId);
}
