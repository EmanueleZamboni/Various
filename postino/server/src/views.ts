import { db } from './db.js';
import type { ThreadRow, MessageRow, FolderRow } from './mail/store.js';
import type { Address } from './mail/parse.js';

export type AccountRow = {
  id: number;
  email: string;
  name: string;
  color: string;
  sort_order: number;
  signature: string;
  username: string;
  password_enc: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  enabled: number;
  status: string;
  last_error: string | null;
  initial_sync_done: number;
};

export const syncProgress = new Map<number, { fetched: number; total: number; done: boolean }>();

export function accountView(a: AccountRow) {
  const unread = db
    .prepare(`SELECT COALESCE(SUM(unseen), 0) AS n FROM folders WHERE account_id = ? AND role = 'inbox' AND present = 1`)
    .get(a.id) as { n: number };
  const p = syncProgress.get(a.id);
  return {
    id: String(a.id),
    email: a.email,
    name: a.name,
    color: a.color,
    order: a.sort_order,
    signature: a.signature,
    status: a.enabled ? a.status : 'disabled',
    error: a.last_error,
    unread: unread.n,
    initialSync: a.initial_sync_done ? null : { done: false, fetched: p?.fetched ?? 0, total: p?.total ?? 0 },
    imap: { host: a.imap_host, port: a.imap_port, secure: Boolean(a.imap_secure) },
    smtp: { host: a.smtp_host, port: a.smtp_port, secure: Boolean(a.smtp_secure) },
    username: a.username,
  };
}

export function folderView(f: FolderRow) {
  return {
    id: String(f.id),
    accountId: String(f.account_id),
    path: f.path,
    name: f.name,
    role: f.role,
    unread: f.unseen,
    total: f.total,
  };
}

const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function threadView(t: ThreadRow, extra?: { draft?: boolean }) {
  const roles = t.roles.split(',').filter(Boolean);
  return {
    id: String(t.id),
    accountId: String(t.account_id),
    subject: t.subject,
    snippet: t.snippet,
    participants: parse<Address[]>(t.participants, []),
    lastFrom: parse<Address>(t.last_from, { name: '', email: '' }),
    lastDate: t.last_date,
    firstDate: t.first_date,
    count: t.msg_count,
    unread: t.unread_count > 0,
    unreadCount: t.unread_count,
    pinned: Boolean(t.pinned),
    answered: Boolean(t.answered),
    hasAttachments: Boolean(t.has_attachments),
    draft: extra?.draft ?? false,
    category: t.category,
    folderRoles: roles,
  };
}

export type AttachmentRow = { id: number; message_row: number; part: string; filename: string; content_type: string; size: number; content_id: string | null; is_inline: number; cached: number };

export function attachmentView(a: AttachmentRow) {
  return {
    id: String(a.id),
    filename: a.filename,
    contentType: a.content_type,
    size: a.size,
    inline: Boolean(a.is_inline),
    url: `/api/attachments/${a.id}`,
  };
}

export function messageView(m: MessageRow, folder: FolderRow | undefined, body?: { text: string | null; html: string | null; quoted: string | null; has_remote_images: number } | null) {
  const atts = db.prepare('SELECT * FROM attachments WHERE message_row = ? ORDER BY id').all(m.id) as AttachmentRow[];
  return {
    id: String(m.id),
    threadId: String(m.thread_id),
    accountId: String(m.account_id),
    folderId: String(m.folder_id),
    folderRole: folder?.role ?? 'other',
    messageId: m.message_id,
    from: parse<Address>(m.from_json, { name: '', email: '' }),
    to: parse<Address[]>(m.to_json, []),
    cc: parse<Address[]>(m.cc_json, []),
    bcc: parse<Address[]>(m.bcc_json, []),
    replyTo: parse<Address[]>(m.reply_to_json, []),
    subject: m.subject,
    date: m.date,
    seen: Boolean(m.seen),
    flagged: Boolean(m.flagged),
    answered: Boolean(m.answered),
    draft: Boolean(m.draft),
    mine: Boolean(m.mine),
    category: m.category,
    snippet: m.snippet,
    attachments: atts.filter((a) => !a.is_inline || !a.content_id).map(attachmentView),
    listUnsubscribe: m.list_unsubscribe,
    body: {
      html: body?.html ?? null,
      text: body?.text ?? null,
      hasRemoteImages: Boolean(body?.has_remote_images),
      quoted: body?.quoted ?? null,
      fetched: Boolean(m.body_fetched),
      error: m.body_error,
    },
  };
}
