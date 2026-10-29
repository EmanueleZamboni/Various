import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { bus } from '../events.js';
import { manager } from '../mail/manager.js';
import { log } from '../log.js';
import { threadView, messageView } from '../views.js';
import { recomputeThread, refreshFolderCounts, type ThreadRow, type MessageRow, type FolderRow, type FolderRole } from '../mail/store.js';

type ListQuery = { view?: string; account?: string; category?: string; unread?: string; before?: string; limit?: string };

const concreteRoles: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash', 'blocked'];

/** Build the WHERE clause for a thread view. */
function viewWhere(view: string, accountId: number | null, category: string | null, unread: boolean): { where: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (accountId) {
    where.push('t.account_id = ?');
    params.push(accountId);
  }
  if (view.startsWith('folder:')) {
    where.push('EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.folder_id = ?)');
    params.push(Number(view.slice(7)));
  } else if (view === 'pinned') {
    where.push("t.pinned = 1 AND (t.roles LIKE '%,inbox,%' OR t.roles LIKE '%,archive,%' OR t.roles LIKE '%,sent,%' OR t.roles LIKE '%,other,%' OR t.roles LIKE '%,drafts,%')");
  } else if (view === 'all') {
    where.push("(t.roles NOT LIKE '%,trash,%' AND t.roles NOT LIKE '%,junk,%' AND t.roles NOT LIKE '%,blocked,%') OR t.roles LIKE '%,inbox,%' OR t.roles LIKE '%,archive,%' OR t.roles LIKE '%,sent,%'");
  } else if (view === 'drafts') {
    where.push("(t.roles LIKE '%,drafts,%' OR EXISTS (SELECT 1 FROM drafts d WHERE d.thread_id = t.id))");
  } else if ((concreteRoles as string[]).includes(view)) {
    where.push('t.roles LIKE ?');
    params.push(`%,${view},%`);
  } else {
    where.push("t.roles LIKE '%,inbox,%'");
  }
  if (category && view === 'inbox') {
    const cats = category.split(',').filter((c) => ['person', 'notification', 'newsletter'].includes(c));
    if (cats.length) {
      where.push(`t.category IN (${cats.map(() => '?').join(',')})`);
      params.push(...cats);
    }
  }
  if (unread) where.push('t.unread_count > 0');
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function draftThreadIds(): Set<number> {
  return new Set((db.prepare('SELECT DISTINCT thread_id FROM drafts WHERE thread_id IS NOT NULL').all() as { thread_id: number }[]).map((r) => r.thread_id));
}

export function listThreads(q: ListQuery) {
  const view = q.view || 'inbox';
  const accountId = q.account ? Number(q.account) : null;
  const category = q.category && q.category.split(',').every((c) => ['person', 'notification', 'newsletter'].includes(c)) ? q.category : null;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const { where, params } = viewWhere(view, accountId, category, q.unread === '1');
  const cursorWhere: string[] = [];
  const cursorParams: unknown[] = [];
  if (q.before) {
    const [date, id] = q.before.split('|');
    if (date && id) {
      cursorWhere.push('(t.last_date < ? OR (t.last_date = ? AND t.id < ?))');
      cursorParams.push(date, date, Number(id));
    }
  }
  const fullWhere = where ? (cursorWhere.length ? `${where} AND ${cursorWhere.join(' AND ')}` : where) : cursorWhere.length ? 'WHERE ' + cursorWhere.join(' AND ') : '';
  const rows = db.prepare(`SELECT t.* FROM threads t ${fullWhere} ORDER BY t.last_date DESC, t.id DESC LIMIT ?`).all(...params, ...cursorParams, limit + 1) as ThreadRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN t.unread_count > 0 THEN 1 ELSE 0 END) AS unread FROM threads t ${where}`).get(...params) as { total: number; unread: number | null };
  const drafts = draftThreadIds();
  const last = page[page.length - 1];
  return {
    threads: page.map((t) => threadView(t, { draft: drafts.has(t.id) })),
    nextCursor: hasMore && last ? `${last.last_date}|${last.id}` : null,
    counts: { unread: counts.unread || 0, total: counts.total },
  };
}

export function threadDetail(threadId: number) {
  const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as ThreadRow | undefined;
  if (!t) return null;
  const rows = db
    .prepare(
      `SELECT m.*, f.role AS folder_role FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.thread_id = ?
       ORDER BY m.date ASC, m.id ASC`,
    )
    .all(threadId) as (MessageRow & { folder_role: FolderRole })[];
  // Hide duplicate copies (same Message-ID in several folders), preferring the inbox/archive copy.
  const pref: Record<string, number> = { inbox: 0, archive: 1, other: 2, sent: 3, drafts: 4, junk: 5, blocked: 6, trash: 7 };
  const byMsgId = new Map<string, MessageRow & { folder_role: FolderRole }>();
  const out: (MessageRow & { folder_role: FolderRole })[] = [];
  for (const r of rows) {
    if (!r.message_id) {
      out.push(r);
      continue;
    }
    const prev = byMsgId.get(r.message_id);
    if (!prev) {
      byMsgId.set(r.message_id, r);
      out.push(r);
    } else if ((pref[r.folder_role] ?? 9) < (pref[prev.folder_role] ?? 9)) {
      out[out.indexOf(prev)] = r;
      byMsgId.set(r.message_id, r);
    }
  }
  const bodyStmt = db.prepare('SELECT text, html, quoted, has_remote_images, calendar_json FROM bodies WHERE message_row = ?');
  const folderStmt = db.prepare('SELECT * FROM folders WHERE id = ?');
  const drafts = draftThreadIds();
  const messages = out.map((m) => messageView(m, folderStmt.get(m.folder_id) as FolderRow | undefined, bodyStmt.get(m.id) as never));
  // Kick body fetching for anything still missing.
  const missing = out.filter((m) => !m.body_fetched);
  if (missing.length) manager.get(t.account_id)?.kickBodyLoop();
  return { thread: threadView(t, { draft: drafts.has(t.id) }), messages };
}

type ActionBody = { threadIds?: string[]; messageIds?: string[]; action?: string; folderId?: string; scope?: 'view' | 'all'; view?: string };

/** Roles whose messages an action touches, given the view the user is in. */
function rolesForView(view: string | undefined, action: string): FolderRole[] | 'all' {
  if (view && (concreteRoles as string[]).includes(view)) return [view as FolderRole];
  if (view && view.startsWith('folder:')) return 'all';
  if (action === 'archive' || action === 'junk') return ['inbox'];
  return 'all';
}

export async function runAction(body: ActionBody): Promise<{ affected: number }> {
  const action = String(body.action || '');
  const scope = body.scope || 'view';
  let targets: (MessageRow & { role: FolderRole; path: string })[] = [];
  const sel = db.prepare('SELECT m.*, f.role, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.thread_id = ?');
  const selMsg = db.prepare('SELECT m.*, f.role, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?');
  if (body.messageIds?.length) {
    for (const id of body.messageIds) {
      const m = selMsg.get(Number(id)) as (MessageRow & { role: FolderRole; path: string }) | undefined;
      if (m) targets.push(m);
    }
  } else {
    const roles = scope === 'all' ? 'all' : rolesForView(body.view, action);
    for (const tid of body.threadIds || []) {
      let rows = sel.all(Number(tid)) as (MessageRow & { role: FolderRole; path: string })[];
      if (body.view?.startsWith('folder:')) rows = rows.filter((r) => r.folder_id === Number(body.view!.slice(7)));
      else if (roles !== 'all') rows = rows.filter((r) => roles.includes(r.role));
      targets.push(...rows);
    }
  }
  // Never act on trash copies unless the user is in trash (or deleting).
  if (!(body.view === 'trash' || action === 'delete' || action === 'inbox')) targets = targets.filter((t) => t.role !== 'trash');
  if (!targets.length) return { affected: 0 };

  const groups = new Map<number, (MessageRow & { role: FolderRole; path: string })[]>();
  for (const t of targets) {
    const g = groups.get(t.folder_id) || [];
    g.push(t);
    groups.set(t.folder_id, g);
  }
  const threads = new Set(targets.map((t) => t.thread_id));
  const flagOps: { add: string[]; remove: string[]; set: Partial<Record<'seen' | 'flagged', number>> } | null =
    action === 'read' ? { add: ['\\Seen'], remove: [], set: { seen: 1 } }
    : action === 'unread' ? { add: [], remove: ['\\Seen'], set: { seen: 0 } }
    : action === 'pin' ? { add: ['\\Flagged'], remove: [], set: { flagged: 1 } }
    : action === 'unpin' ? { add: [], remove: ['\\Flagged'], set: { flagged: 0 } }
    : null;

  if (flagOps) {
    // Optimistic locally, IMAP in the background.
    const col = Object.keys(flagOps.set)[0] as 'seen' | 'flagged';
    const val = flagOps.set[col] as number;
    const upd = db.prepare(`UPDATE messages SET ${col} = ? WHERE id = ?`);
    for (const t of targets) upd.run(val, t.id);
    for (const th of threads) recomputeThread(th);
    for (const [folderId, list] of groups) {
      refreshFolderCounts(folderId);
      const sync = manager.get(list[0].account_id);
      if (!sync) continue;
      sync.setFlags(folderId, list.map((m) => m.uid), flagOps.add, flagOps.remove).catch((err: Error) => {
        log.warn({ err: err.message }, 'flag update failed');
        bus.publish({ type: 'action.failed', message: `Could not update flags: ${err.message}` });
      });
    }
    for (const th of threads) bus.publish({ type: 'thread.updated', threadId: String(th), accountId: String(targets[0].account_id) });
    return { affected: targets.length };
  }

  let destRole: FolderRole | null = null;
  let destFolderId: number | null = null;
  switch (action) {
    case 'archive': destRole = 'archive'; break;
    case 'trash': destRole = 'trash'; break;
    case 'junk': destRole = 'junk'; break;
    case 'notjunk': destRole = 'inbox'; break;
    case 'inbox': destRole = 'inbox'; break;
    case 'move': destFolderId = Number(body.folderId); break;
    case 'delete': break;
    default:
      throw Object.assign(new Error(`Unknown action ${action}`), { statusCode: 400 });
  }
  let affected = 0;
  const errors: string[] = [];
  for (const [folderId, list] of groups) {
    const sync = manager.get(list[0].account_id);
    if (!sync) {
      errors.push(`${list[0].path}: account not connected`);
      continue;
    }
    const uids = list.map((m) => m.uid);
    try {
      if (action === 'delete') {
        if (!['trash', 'junk', 'blocked'].includes(list[0].role)) continue; // permanent delete only from those
        await sync.deleteMessages(folderId, uids);
      } else {
        if (destRole && list[0].role === destRole) continue;
        await sync.moveMessages(folderId, uids, destRole, destFolderId);
      }
      affected += list.length;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  for (const th of threads) {
    recomputeThread(th);
    bus.publish({ type: 'thread.updated', threadId: String(th), accountId: String(targets[0].account_id) });
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { statusCode: 502 });
  return { affected };
}

export function registerThreadRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ListQuery }>('/api/threads', async (req) => listThreads(req.query));

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (req, reply) => {
    const d = threadDetail(Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'not_found', message: 'This conversation is gone.' });
    return d;
  });

  app.get<{ Params: { id: string; messageId: string } }>('/api/threads/:id/messages/:messageId', async (req, reply) => {
    const m = db.prepare('SELECT * FROM messages WHERE id = ? AND thread_id = ?').get(Number(req.params.messageId), Number(req.params.id)) as MessageRow | undefined;
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const body = db.prepare('SELECT text, html, quoted, has_remote_images, calendar_json FROM bodies WHERE message_row = ?').get(m.id) as never;
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(m.folder_id) as FolderRow | undefined;
    if (!m.body_fetched) manager.get(m.account_id)?.kickBodyLoop();
    return messageView(m, folder, body);
  });

  app.post<{ Body: ActionBody }>('/api/threads/actions', async (req) => {
    const r = await runAction(req.body || {});
    return { ok: true, affected: r.affected };
  });

  app.post<{ Body: ActionBody }>('/api/messages/actions', async (req) => {
    const r = await runAction(req.body || {});
    return { ok: true, affected: r.affected };
  });
}
