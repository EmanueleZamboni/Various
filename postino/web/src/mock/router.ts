import samplePdf from './files/sample.pdf?url';
import sampleDocx from './files/sample.docx?url';
import sampleXlsx from './files/sample.xlsx?url';
import type { Address, Category, FolderRole, Message, ThreadSummary, ThreadAction } from '../api/types';
import {
  accounts,
  blocked,
  drafts,
  folderByRole,
  folders,
  loggedIn,
  ME,
  needsSetup,
  recount,
  setAuth,
  settings,
  threads,
  type MockThread,
} from './data';

type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: any; method: string }) => Promise<Response> | Response;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const empty = (status = 204) => new Response(null, { status });
const fail = (status: number, error: string, message: string) => json({ error, message }, status);

let seq = 1000;
const nid = (p: string) => `${p}${(++seq).toString(36)}`;

export const listeners = new Set<(ev: { type: string; data: unknown }) => void>();
export function emit(type: string, data: unknown) {
  for (const l of listeners) l({ type, data });
}

const VIEW_ROLES: Record<string, FolderRole[] | null> = {
  inbox: ['inbox'],
  pinned: null,
  sent: ['sent'],
  drafts: ['drafts'],
  archive: ['archive'],
  junk: ['junk'],
  trash: ['trash'],
  blocked: ['blocked'],
  all: null,
};

function newest(t: MockThread): Message {
  return [...t.messages].sort((a, b) => b.date.localeCompare(a.date))[0];
}

function summarize(t: MockThread): ThreadSummary {
  const sorted = [...t.messages].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted[sorted.length - 1];
  const incoming = [...sorted].reverse().find((m) => !m.mine) ?? last;
  const me = ME[t.accountId].email.toLowerCase();
  const seen = new Set<string>();
  const participants: Address[] = [];
  for (const m of [...sorted].reverse()) {
    for (const a of [m.from, ...m.to, ...m.cc]) {
      const k = a.email.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      participants.push(a);
    }
  }
  const others = participants.filter((p) => p.email.toLowerCase() !== me);
  return {
    id: t.id,
    accountId: t.accountId,
    subject: sorted[0].subject,
    snippet: last.snippet,
    participants: others.length ? others : participants,
    lastFrom: last.from,
    lastDate: last.date,
    firstDate: sorted[0].date,
    count: sorted.length,
    unread: sorted.some((m) => !m.seen),
    pinned: sorted.some((m) => m.flagged),
    answered: sorted.some((m) => m.answered),
    hasAttachments: sorted.some((m) => m.attachments.length > 0),
    draft: drafts.some((d) => d.threadId === t.id) || sorted.some((m) => m.draft),
    category: incoming.category,
    folderRoles: Array.from(new Set(sorted.map((m) => m.folderRole))),
  };
}

function threadsInView(view: string, accountId?: string | null, category?: string | null, unread?: boolean): MockThread[] {
  let list = threads.filter((t) => !accountId || t.accountId === accountId);
  if (view.startsWith('folder:')) {
    const fid = view.slice(7);
    list = list.filter((t) => t.messages.some((m) => m.folderId === fid));
  } else if (view === 'pinned') {
    list = list.filter((t) => t.messages.some((m) => m.flagged && m.folderRole !== 'trash' && m.folderRole !== 'junk'));
  } else if (view === 'all') {
    list = list.filter((t) => t.messages.some((m) => m.folderRole !== 'trash' && m.folderRole !== 'junk' && m.folderRole !== 'blocked'));
  } else {
    const roles = VIEW_ROLES[view] ?? ['inbox'];
    list = list.filter((t) => t.messages.some((m) => roles.includes(m.folderRole)));
  }
  let sums = list.map((t) => ({ t, s: summarize(t) }));
  if (category) sums = sums.filter((x) => x.s.category === category);
  if (unread) sums = sums.filter((x) => x.s.unread);
  sums.sort((a, b) => b.s.lastDate.localeCompare(a.s.lastDate));
  return sums.map((x) => x.t);
}

function paginate(list: MockThread[], query: URLSearchParams) {
  const limit = Math.min(Number(query.get('limit') ?? 50), 200);
  const before = query.get('before');
  let start = 0;
  if (before) {
    const i = list.findIndex((t) => t.id === before);
    start = i >= 0 ? i + 1 : 0;
  }
  const page = list.slice(start, start + limit);
  const sums = page.map(summarize);
  const all = list.map(summarize);
  return {
    threads: sums,
    nextCursor: start + limit < list.length ? page[page.length - 1].id : null,
    counts: { unread: all.filter((s) => s.unread).length, total: all.length },
  };
}

function viewRoles(view: string | undefined): FolderRole[] | null {
  if (!view) return ['inbox'];
  if (view.startsWith('folder:')) return null;
  return VIEW_ROLES[view] ?? ['inbox'];
}

function applyAction(msgs: Message[], action: ThreadAction, folderId?: string) {
  for (const m of msgs) {
    const t = threads.find((x) => x.id === m.threadId)!;
    const move = (role: FolderRole) => {
      const f = folderByRole(m.accountId, role);
      m.folderId = f.id;
      m.folderRole = f.role;
    };
    switch (action) {
      case 'read': m.seen = true; break;
      case 'unread': m.seen = false; break;
      case 'pin': m.flagged = true; break;
      case 'unpin': m.flagged = false; break;
      case 'archive': move('archive'); break;
      case 'trash': move('trash'); break;
      case 'junk': move('junk'); break;
      case 'notjunk': case 'inbox': move('inbox'); break;
      case 'delete': t.messages = t.messages.filter((x) => x.id !== m.id); break;
      case 'move': {
        const f = folders.find((x) => x.id === folderId);
        if (f) { m.folderId = f.id; m.folderRole = f.role; }
        break;
      }
    }
  }
  for (let i = threads.length - 1; i >= 0; i--) if (!threads[i].messages.length) threads.splice(i, 1);
  recount();
  const tids = Array.from(new Set(msgs.map((m) => m.threadId)));
  for (const tid of tids) {
    if (threads.find((t) => t.id === tid)) emit('thread.updated', { threadId: tid, accountId: msgs[0].accountId });
    else emit('thread.removed', { threadId: tid });
  }
  for (const a of accounts) emit('account.updated', a);
}

// ---------- search ----------
type Parsed = {
  terms: string[];
  phrases: string[];
  excluded: string[];
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  pinned?: boolean;
  in?: string;
  account?: string;
  before?: string;
  after?: string;
};

export function parseQuery(q: string): Parsed {
  const p: Parsed = { terms: [], phrases: [], excluded: [] };
  const re = /(-)?(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const neg = !!m[1];
    const op = m[2]?.toLowerCase();
    const val = (m[3] ?? m[4] ?? '').trim();
    if (!val && !op) continue;
    if (!op) {
      if (neg) p.excluded.push(val.toLowerCase());
      else if (m[3] !== undefined) p.phrases.push(val.toLowerCase());
      else p.terms.push(val.toLowerCase());
      continue;
    }
    switch (op) {
      case 'from': p.from = val.toLowerCase(); break;
      case 'to': p.to = val.toLowerCase(); break;
      case 'subject': p.subject = val.toLowerCase(); break;
      case 'has': if (val === 'attachment') p.hasAttachment = true; break;
      case 'is':
        if (val === 'unread') p.unread = true;
        if (val === 'pinned' || val === 'flagged' || val === 'starred') p.pinned = true;
        break;
      case 'in': p.in = val.toLowerCase(); break;
      case 'account': p.account = val.toLowerCase(); break;
      case 'before': p.before = val; break;
      case 'after': p.after = val; break;
      case 'newer_than': {
        const mm = val.match(/^(\d+)([dwm])$/);
        if (mm) {
          const n = Number(mm[1]);
          const days = mm[2] === 'd' ? n : mm[2] === 'w' ? n * 7 : n * 30;
          const d = new Date();
          d.setDate(d.getDate() - days);
          p.after = d.toISOString().slice(0, 10);
        }
        break;
      }
      default:
        p.terms.push(`${op}:${val}`.toLowerCase());
    }
  }
  return p;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function search(q: string, accountId?: string | null) {
  const p = parseQuery(q);
  const hits: { t: MockThread; score: number; snippet: string }[] = [];
  for (const t of threads) {
    if (accountId && t.accountId !== accountId) continue;
    if (p.account) {
      const a = accounts.find((x) => x.id === t.accountId)!;
      if (!a.email.toLowerCase().includes(p.account) && !a.name.toLowerCase().includes(p.account)) continue;
    }
    const s = summarize(t);
    if (p.in && !s.folderRoles.includes(p.in as FolderRole)) continue;
    if (p.unread && !s.unread) continue;
    if (p.pinned && !s.pinned) continue;
    if (p.hasAttachment && !s.hasAttachments) continue;
    if (p.before && s.lastDate.slice(0, 10) >= p.before) continue;
    if (p.after && s.lastDate.slice(0, 10) < p.after) continue;
    const froms = t.messages.map((m) => fold(`${m.from.name} ${m.from.email}`));
    const tos = t.messages.map((m) => fold([...m.to, ...m.cc].map((a) => `${a.name} ${a.email}`).join(' ')));
    if (p.from && !froms.some((f) => f.includes(fold(p.from!)))) continue;
    if (p.to && !tos.some((f) => f.includes(fold(p.to!)))) continue;
    if (p.subject && !fold(s.subject).includes(fold(p.subject))) continue;
    const subj = fold(s.subject);
    const body = fold(t.messages.map((m) => m.body.text ?? '').join('\n'));
    const fromAll = froms.join(' ');
    let score = 0;
    let ok = true;
    let firstHit = -1;
    for (const term of [...p.terms, ...p.phrases]) {
      const tt = fold(term);
      if (subj.includes(tt)) score += 5;
      else if (fromAll.includes(tt)) score += 4;
      else if (tos.join(' ').includes(tt)) score += 2;
      else if (body.includes(tt)) {
        score += 1;
        if (firstHit < 0) firstHit = body.indexOf(tt);
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (p.excluded.some((x) => subj.includes(x) || body.includes(x))) continue;
    if (!p.terms.length && !p.phrases.length) score = 1;
    const src = t.messages.map((m) => m.body.text ?? '').join(' ');
    let snippet = s.snippet;
    if (firstHit >= 0) snippet = src.slice(Math.max(0, firstHit - 60), firstHit + 120).replace(/\s+/g, ' ');
    const escd = snippet.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    let marked = escd;
    for (const term of [...p.terms, ...p.phrases]) {
      if (!term) continue;
      marked = marked.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`);
    }
    hits.push({ t, score, snippet: marked });
  }
  hits.sort((a, b) => b.score - a.score || summarize(b.t).lastDate.localeCompare(summarize(a.t).lastDate));
  return hits;
}

function allContacts(): { a: Address; n: number }[] {
  const map = new Map<string, { a: Address; n: number }>();
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  for (const t of threads)
    for (const m of t.messages)
      for (const a of [m.from, ...m.to, ...m.cc]) {
        const k = a.email.toLowerCase();
        if (mine.has(k)) continue;
        const e = map.get(k);
        if (e) e.n++;
        else map.set(k, { a, n: 1 });
      }
  return [...map.values()].sort((x, y) => y.n - x.n);
}

const sortedMessages = (t: MockThread) => [...t.messages].sort((a, b) => a.date.localeCompare(b.date));

const routes: [string, string, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => routes.push([method, pattern, h]);

// ----- auth
on('GET', '/api/health', () => json({ ok: true, accounts: accounts.length, uptime: 1234 }));
on('GET', '/api/setup', () => json({ needsSetup }));
on('POST', '/api/setup', ({ body }) => {
  if (!needsSetup) return fail(400, 'already_setup', 'Setup already done.');
  if (!body?.password || body.password.length < 8) return fail(400, 'weak_password', 'Use at least 8 characters.');
  setAuth(false, true);
  return empty();
});
on('POST', '/api/login', ({ body }) => {
  if (body?.password !== 'password') return fail(401, 'bad_credentials', 'Wrong password.');
  setAuth(false, true);
  return empty();
});
on('POST', '/api/logout', () => { setAuth(false, false); return empty(); });
on('GET', '/api/me', () => json({ ok: true, totpEnabled: false, passkeys: 0, vapidPublicKey: 'BMockVapidKey' }));
on('GET', '/api/passkeys', () => json({ passkeys: [] }));
on('GET', '/api/blocked/import', () => json({ candidates: [{ email: 'iscreenofficial@gmail.com', count: 3 }, { email: 'talent@ahacreatorsgrowth.digital', count: 1 }] }));
on('POST', '/api/blocked/import', () => json({ added: 2 }));
on('GET', '/api/backup/status', () => json({ driveConnected: true, lastDrive: new Date(Date.now() - 5 * 3600_000).toISOString(), lastDriveError: null, pendingMailboxes: [] }));
on('POST', '/api/backup/drive-now', () => json({ ok: true }));
on('POST', '/api/backup/restore', () => json({ mailboxes: [] }));
on('POST', '/api/backup/forget-pending', () => json({ ok: true }));
on('GET', '/api/google/status', () => json({ configured: false, connected: false, email: null, clientId: null }));
on('GET', '/api/google/redirect-uri', () => json({ redirectUri: 'https://mail.example.com/api/google/callback' }));
on('POST', '/api/google/credentials', () => fail(400, 'demo', 'Google Drive connects on the real server, not in the demo.'));
on('POST', '/api/google/connect', () => fail(409, 'demo', 'Google Drive connects on the real server, not in the demo.'));
on('POST', '/api/passkeys/register/options', () => fail(400, 'demo', 'Fingerprint sign-in works on the real server, not in the demo.'));
on('POST', '/api/passkeys/login/options', () => fail(404, 'no_passkeys', 'No passkey in the demo. Password: password'));
on('POST', '/api/me/password', ({ body }) => (body?.current === 'password' ? empty() : fail(400, 'bad_credentials', 'Current password is wrong.')));
on('POST', '/api/me/totp/start', () => json({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Postino?secret=JBSWY3DPEHPK3PXP', qrDataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#fff"/><rect x="20" y="20" width="40" height="40"/><rect x="100" y="20" width="40" height="40"/><rect x="20" y="100" width="40" height="40"/><rect x="70" y="70" width="20" height="20"/></svg>') }));
on('POST', '/api/me/totp/enable', ({ body }) => (/^\d{6}$/.test(body?.code ?? '') ? empty() : fail(400, 'bad_code', 'That code is not valid.')));
on('POST', '/api/me/totp/disable', () => empty());

// ----- accounts
on('GET', '/api/accounts', () => json([...accounts].sort((a, b) => a.order - b.order)));
on('GET', '/api/presets', ({ query }) => {
  const email = query.get('email') ?? '';
  const domain = email.split('@')[1] ?? '';
  if (!domain) return json(null);
  if (domain === 'emazamboni.com') return json({ imap: { host: 'mx1.vhostingcloud.com', port: 993, secure: true }, smtp: { host: 'mx1.vhostingcloud.com', port: 465, secure: true }, username: email });
  if (domain === 'stostudio.it') return json({ imap: { host: 'mailserver11.vhosting-it.com', port: 993, secure: true }, smtp: { host: 'mailserver11.vhosting-it.com', port: 465, secure: true }, username: email });
  if (domain === 'gmail.com') return json({ imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, username: email });
  return json({ imap: { host: `mail.${domain}`, port: 993, secure: true }, smtp: { host: `mail.${domain}`, port: 465, secure: true }, username: email });
});
on('POST', '/api/accounts/test', ({ body }) => (body?.password === 'wrong' ? fail(400, 'imap_login_failed', 'The mail server rejected the password.') : json({ ok: true })));
on('POST', '/api/accounts', ({ body }) => {
  if (body?.password === 'wrong') return fail(400, 'imap_login_failed', 'The mail server rejected the password.');
  const a = { id: nid('a'), email: body.email, name: body.name || body.email, color: body.color || '#5B6B9E', order: accounts.length, signature: '', status: 'syncing' as const, error: null, unread: 0, initialSync: { done: false, fetched: 0, total: 100 } };
  accounts.push(a);
  for (const [path, role] of [['INBOX', 'inbox'], ['Sent', 'sent'], ['Drafts', 'drafts'], ['Junk', 'junk'], ['Trash', 'trash']] as [string, FolderRole][])
    folders.push({ id: `${a.id}:${path}`, accountId: a.id, path, name: path === 'INBOX' ? 'Inbox' : path, role, unread: 0, total: 0 });
  ME[a.id] = { name: a.name, email: a.email };
  return json(a);
});
on('PATCH', '/api/accounts/:id', ({ params, body }) => {
  const a = accounts.find((x) => x.id === params.id);
  if (!a) return fail(404, 'not_found', 'No such account.');
  for (const k of ['name', 'color', 'signature', 'order', 'aliases', 'folders', 'notify'] as const) if (body[k] !== undefined) (a as any)[k] = body[k];
  if (body.password && a.status === 'error') { a.status = 'connected'; a.error = null; }
  emit('account.updated', a);
  return json(a);
});
on('DELETE', '/api/accounts/:id', ({ params }) => {
  const i = accounts.findIndex((x) => x.id === params.id);
  if (i >= 0) accounts.splice(i, 1);
  for (let k = threads.length - 1; k >= 0; k--) if (threads[k].accountId === params.id) threads.splice(k, 1);
  return empty();
});
on('POST', '/api/accounts/:id/resync', ({ params }) => {
  const a = accounts.find((x) => x.id === params.id);
  if (a) { a.status = 'syncing'; a.initialSync = { done: false, fetched: 0, total: 300 }; emit('account.updated', a); setTimeout(() => { a.status = 'connected'; a.initialSync = { done: true, fetched: 300, total: 300 }; emit('account.updated', a); }, 4000); }
  return empty(202);
});
on('GET', '/api/folders', () => json(folders));

// ----- threads
on('GET', '/api/threads', ({ query }) => {
  const view = query.get('view') ?? 'inbox';
  const list = threadsInView(view, query.get('account'), query.get('category'), query.get('unread') === '1');
  return json(paginate(list, query));
});
on('GET', '/api/threads/:id', ({ params }) => {
  const t = threads.find((x) => x.id === params.id);
  if (!t) return fail(404, 'not_found', 'This conversation no longer exists.');
  return json({ thread: summarize(t), messages: sortedMessages(t) });
});
on('GET', '/api/threads/:id/messages/:mid', ({ params }) => {
  const t = threads.find((x) => x.id === params.id);
  const m = t?.messages.find((x) => x.id === params.mid);
  return m ? json(m) : fail(404, 'not_found', 'Message not found.');
});
on('POST', '/api/threads/actions', ({ body }) => {
  const roles = body.scope === 'all' ? null : viewRoles(body.view);
  const msgs: Message[] = [];
  for (const tid of body.threadIds as string[]) {
    const t = threads.find((x) => x.id === tid);
    if (!t) continue;
    for (const m of t.messages) {
      if (body.action === 'read' || body.action === 'unread' || body.action === 'pin' || body.action === 'unpin' || !roles || roles.includes(m.folderRole)) msgs.push(m);
    }
  }
  applyAction(msgs, body.action, body.folderId);
  return json({ ok: true, affected: msgs.length });
});
on('POST', '/api/messages/actions', ({ body }) => {
  const msgs = threads.flatMap((t) => t.messages).filter((m) => body.messageIds.includes(m.id));
  applyAction(msgs, body.action, body.folderId);
  return json({ ok: true, affected: msgs.length });
});

// ----- blocked
on('GET', '/api/blocked', () => json({ senders: blocked }));
on('POST', '/api/blocked', ({ body }) => {
  const pattern = String(body.pattern ?? '').trim().toLowerCase();
  if (!pattern) return fail(400, 'bad_pattern', 'Enter an email or a domain like @example.com.');
  const entry = { id: nid('b'), pattern, note: body.note ?? '', createdAt: new Date().toISOString(), count: 0 };
  blocked.unshift(entry);
  const msgs = threads.flatMap((t) => t.messages).filter((m) => m.folderRole === 'inbox' && matchesPattern(m.from.email, pattern));
  entry.count = msgs.length;
  for (const m of msgs) { const f = folderByRole(m.accountId, 'blocked'); m.folderId = f.id; m.folderRole = f.role; m.seen = true; }
  recount();
  for (const tid of new Set(msgs.map((m) => m.threadId))) emit('thread.updated', { threadId: tid, accountId: msgs[0]?.accountId });
  for (const a of accounts) emit('account.updated', a);
  return json(entry);
});
on('DELETE', '/api/blocked/:id', ({ params }) => { const i = blocked.findIndex((b) => b.id === params.id); if (i >= 0) blocked.splice(i, 1); return empty(); });
on('POST', '/api/blocked/:id/restore', ({ params }) => {
  const b = blocked.find((x) => x.id === params.id);
  if (!b) return fail(404, 'not_found', 'Not found.');
  const msgs = threads.flatMap((t) => t.messages).filter((m) => m.folderRole === 'blocked' && matchesPattern(m.from.email, b.pattern));
  for (const m of msgs) { const f = folderByRole(m.accountId, 'inbox'); m.folderId = f.id; m.folderRole = f.role; }
  recount();
  for (const tid of new Set(msgs.map((m) => m.threadId))) emit('thread.updated', { threadId: tid, accountId: msgs[0]?.accountId });
  return json({ moved: msgs.length });
});
function matchesPattern(email: string, pattern: string) {
  const e = email.toLowerCase();
  return pattern.startsWith('@') ? e.endsWith(pattern) : e === pattern;
}

// ----- search
on('GET', '/api/search', ({ query }) => {
  const q = query.get('q') ?? '';
  const hits = search(q, query.get('account'));
  const page = paginate(hits.map((h) => h.t), query);
  const highlights: Record<string, string> = {};
  for (const h of hits) highlights[h.t.id] = h.snippet;
  return json({ ...page, highlights });
});
on('GET', '/api/search/suggest', ({ query }) => {
  const q = fold(query.get('q') ?? '');
  const contacts = allContacts().filter((c) => !q || fold(`${c.a.name} ${c.a.email}`).includes(q)).slice(0, 6).map((c) => c.a);
  return json({ contacts, recent: ['from:anna', 'has:attachment fattura', 'is:unread'] });
});
on('GET', '/api/contacts', ({ query }) => {
  const q = fold(query.get('q') ?? '');
  const limit = Number(query.get('limit') ?? 8);
  return json(allContacts().filter((c) => !q || fold(`${c.a.name} ${c.a.email}`).includes(q)).slice(0, limit).map((c) => c.a));
});

// ----- compose
on('GET', '/api/messages/:id/reply', ({ params, query }) => {
  const m = threads.flatMap((t) => t.messages).find((x) => x.id === params.id);
  if (!m) return fail(404, 'not_found', 'Message not found.');
  const mode = query.get('mode') ?? 'reply';
  const me = ME[m.accountId].email.toLowerCase();
  const fmt = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email);
  const quotedText = `On ${new Date(m.date).toLocaleString()}, ${fmt(m.from)} wrote:\n` + (m.body.text ?? '').split('\n').map((l) => `> ${l}`).join('\n');
  const quotedHtml = `<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${m.body.html ?? ''}</blockquote>`;
  if (mode === 'forward') return json({ to: '', cc: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, quotedText: `---------- Forwarded message ----------\nFrom: ${fmt(m.from)}\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\n\n${m.body.text ?? ''}`, quotedHtml: m.body.html ?? '', accountId: m.accountId });
  const replyTo = m.replyTo.length ? m.replyTo : [m.from];
  const to = (m.mine ? m.to : replyTo).map(fmt).join(', ');
  const cc = mode === 'replyAll' ? [...m.to, ...m.cc].filter((a) => a.email.toLowerCase() !== me && !replyTo.some((r) => r.email === a.email)).map(fmt).join(', ') : '';
  return json({ to, cc, subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, quotedText, quotedHtml, accountId: m.accountId });
});
on('POST', '/api/send', async ({ body }) => {
  const f0 = body instanceof FormData ? Object.fromEntries([...body.entries()].filter(([, v]) => typeof v === 'string')) as Record<string, string> : (body as Record<string, string>);
  const delay = f0.sendAt ? new Date(f0.sendAt).getTime() - Date.now() : f0.now === '1' ? 0 : settings.compose.undoSendSec * 1000;
  if (delay > 0) { const o = { id: nid('ob'), accountId: f0.accountId, to: f0.to || '', cc: f0.cc || '', subject: f0.subject || '', text: f0.text || '', sendAt: new Date(Date.now() + delay).toISOString(), status: 'queued', error: null, threadId: null, createdAt: new Date().toISOString() }; outbox.push(o); return json({ ok: true, queued: true, outboxId: o.id, sendAt: o.sendAt, threadId: null }); }
  const f: Record<string, string> = {};
  const files: string[] = [];
  if (body instanceof FormData) {
    for (const [k, v] of body.entries()) {
      if (v instanceof File) files.push(v.name);
      else f[k] = String(v);
    }
  } else Object.assign(f, body);
  if (!f.to?.trim()) return fail(400, 'missing_to', 'Add at least one recipient.');
  const accountId = f.accountId;
  const me = ME[accountId];
  const tos = f.to.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const mm = s.match(/^(.*?)\s*<([^>]+)>$/); return mm ? { name: mm[1].replace(/"/g, ''), email: mm[2] } : { name: '', email: s }; });
  let threadId = f.inReplyTo ? threads.flatMap((t) => t.messages).find((m) => m.id === f.inReplyTo)?.threadId ?? null : null;
  const id = nid('m');
  const sent = folderByRole(accountId, 'sent');
  const msg: Message = {
    id, threadId: threadId ?? nid('t'), accountId, folderId: sent.id, folderRole: 'sent', messageId: `<${id}@mock.postino>`,
    from: me, to: tos, cc: [], bcc: [], replyTo: [], subject: f.subject || '(no subject)', date: new Date().toISOString(),
    seen: true, flagged: false, answered: false, draft: false, mine: true, category: 'person', snippet: (f.text ?? '').slice(0, 160),
    attachments: files.map((n) => ({ id: nid('att'), filename: n, contentType: 'application/octet-stream', size: 1024, inline: false, url: '/api/attachments/x' })),
    listUnsubscribe: null,
    body: { html: `<div>${(f.text ?? '').split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`, text: f.text ?? '', hasRemoteImages: false, quoted: null, fetched: true },
  };
  if (threadId) {
    const t = threads.find((x) => x.id === threadId)!;
    t.messages.push(msg);
    const orig = t.messages.find((m) => m.id === f.inReplyTo);
    if (orig) orig.answered = true;
  } else {
    threadId = msg.threadId;
    threads.push({ id: threadId, accountId, messages: [msg] });
  }
  if (f.draftId) { const i = drafts.findIndex((d) => d.id === f.draftId); if (i >= 0) drafts.splice(i, 1); }
  recount();
  emit('thread.updated', { threadId, accountId });
  return json({ ok: true, messageId: id, threadId });
});
on('GET', '/api/drafts', () => json(drafts));
on('POST', '/api/drafts', ({ body }) => { const d = { id: nid('d'), accountId: body.accountId, to: body.to ?? '', cc: body.cc ?? '', bcc: body.bcc ?? '', subject: body.subject ?? '', text: body.text ?? '', inReplyTo: body.inReplyTo ?? null, threadId: body.threadId ?? null, updatedAt: new Date().toISOString() }; drafts.unshift(d); return json(d); });
on('PUT', '/api/drafts/:id', ({ params, body }) => { const d = drafts.find((x) => x.id === params.id); if (!d) return fail(404, 'not_found', 'Draft not found.'); Object.assign(d, body, { updatedAt: new Date().toISOString() }); return json(d); });
on('DELETE', '/api/drafts/:id', ({ params }) => { const i = drafts.findIndex((x) => x.id === params.id); if (i >= 0) drafts.splice(i, 1); return empty(); });
on('POST', '/api/messages/:id/unsubscribe', () => json({ ok: true, method: 'http', url: 'https://example.com/unsubscribe' }));

// ----- attachments
// Real sample files so the demo can show PDF, Word and Excel previews.
const SAMPLES: Record<string, string> = { pdf: samplePdf, docx: sampleDocx, xlsx: sampleXlsx };
on('GET', '/api/attachments/:id', async ({ params, query }) => {
  const a = threads.flatMap((t) => t.messages).flatMap((m) => m.attachments).find((x) => x.id === params.id);
  const name = a?.filename ?? 'file.bin';
  const inline = query.get('inline') === '1';
  const sample = SAMPLES[(name.split('.').pop() ?? '').toLowerCase()];
  const realFetch = (window as unknown as { __realFetch?: typeof fetch }).__realFetch;
  if (sample && realFetch) {
    const r = await realFetch(sample);
    return new Response(await r.arrayBuffer(), { headers: { 'Content-Type': a?.contentType ?? 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"` } });
  }
  const content = `Mock content of ${name}`;
  return new Response(content, { headers: { 'Content-Type': a?.contentType ?? 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"` } });
});

// ----- signatures
const signatures: { id: string; accountId: string; name: string; html: string; text: string; isDefault: boolean; updatedAt: string }[] = [
  { id: 'sig1', accountId: accounts[0].id, name: 'Collab', html: '<div><b>Ema Zamboni</b><br>Creator · Retro tech<br><a href="https://youtube.com/@emazamboni">youtube.com/@emazamboni</a></div>', text: 'Ema Zamboni\nCreator · Retro tech\nyoutube.com/@emazamboni', isDefault: true, updatedAt: new Date().toISOString() },
  { id: 'sig2', accountId: accounts[3].id, name: 'STOSTUDIO', html: '<div><b>Emanuele Zamboni</b> | STOSTUDIO<br><span style="color:#666">Video production · Modena</span></div>', text: 'Emanuele Zamboni | STOSTUDIO\nVideo production · Modena', isDefault: true, updatedAt: new Date().toISOString() },
];
on('GET', '/api/signatures', () => json(signatures));
on('POST', '/api/signatures', ({ body }) => {
  const mine = signatures.filter((x) => x.accountId === body.accountId);
  const isDefault = !!body.isDefault || mine.length === 0;
  if (isDefault) for (const x of mine) x.isDefault = false;
  const sg = { id: nid('sig'), accountId: body.accountId, name: body.name || 'Signature', html: body.html || '', text: String(body.html || '').replace(/<[^>]+>/g, ' ').trim(), isDefault, updatedAt: new Date().toISOString() };
  signatures.push(sg);
  return json(sg, 201);
});
on('PUT', '/api/signatures/:id', ({ params, body }) => {
  const sg = signatures.find((x) => x.id === params.id);
  if (!sg) return fail(404, 'not_found', 'Signature not found.');
  if (body.isDefault) for (const x of signatures) if (x.accountId === sg.accountId) x.isDefault = false;
  if (body.name !== undefined) sg.name = body.name;
  if (body.html !== undefined) { sg.html = body.html; sg.text = String(body.html).replace(/<[^>]+>/g, ' ').trim(); }
  if (body.isDefault !== undefined) sg.isDefault = !!body.isDefault;
  sg.updatedAt = new Date().toISOString();
  return json(sg);
});
on('DELETE', '/api/signatures/:id', ({ params }) => { const i = signatures.findIndex((x) => x.id === params.id); if (i >= 0) signatures.splice(i, 1); return empty(); });

// ----- settings / push
on('GET', '/api/settings', () => json(settings));
const deepMerge = (base: any, patch: any) => { for (const [k, v] of Object.entries(patch || {})) { if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') deepMerge(base[k], v); else base[k] = v; } return base; };
on('PUT', '/api/settings', ({ body }) => { deepMerge(settings, body); if (typeof body.smartInbox === 'boolean') settings.inbox.smart = body.smartInbox; settings.smartInbox = settings.inbox.smart; return json(settings); });
const outbox: { id: string; accountId: string; to: string; cc: string; subject: string; text: string; sendAt: string; status: string; error: null; threadId: string | null; createdAt: string }[] = [];
on('GET', '/api/outbox', () => json({ items: outbox.filter((o) => o.status === 'queued' && new Date(o.sendAt).getTime() > Date.now()) }));
on('DELETE', '/api/outbox/:id', ({ params }) => { const i = outbox.findIndex((o) => o.id === params.id); if (i < 0) return fail(404, 'gone', 'Already sent.'); const o = outbox.splice(i, 1)[0]; const d = { id: nid('d'), accountId: o.accountId, to: o.to, cc: o.cc, bcc: '', subject: o.subject, text: o.text, inReplyTo: null, threadId: o.threadId, updatedAt: new Date().toISOString() }; drafts.unshift(d); return json({ ok: true, draft: d }); });
on('POST', '/api/push/subscribe', () => empty());
on('DELETE', '/api/push/subscribe', () => empty());
on('POST', '/api/push/test', () => empty());

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, location.origin);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body: any = undefined;
  const raw = init?.body;
  if (raw instanceof FormData) body = raw;
  else if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch { body = raw; } }
  const path = url.pathname;
  const open = path === '/api/setup' || path === '/api/login' || path === '/api/health';
  if (!open && !loggedIn && path !== '/api/me') return fail(401, 'unauthorized', 'Please sign in.');
  if (path === '/api/me' && !loggedIn) return fail(401, 'unauthorized', 'Please sign in.');
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
  for (const [m, pattern, h] of routes) {
    if (m !== method) continue;
    const params = match(pattern, path);
    if (!params) continue;
    return h({ params, query: url.searchParams, body, method });
  }
  return fail(404, 'not_found', `No mock for ${method} ${path}`);
}

// Simulate a new message arriving every so often so the live UI can be seen.
export function startLiveMail() {
  const pitches = [
    { from: { name: 'Mia from Anker', email: 'creator@anker.com' }, subject: 'Anker Nano × Ema Zamboni: paid review', category: 'newsletter' as Category, text: 'Hi Ema, we would love to send you the new Nano charger for a paid review.' },
    { from: { name: 'Anna Vialetto', email: 'anna.v@netstrategy.it' }, subject: 'Re: ISUZU Shooting // organizzazione giornate di riprese', category: 'person' as Category, text: 'Invito inviato per giovedì alle 11. Ci sentiamo!' },
  ];
  let i = 0;
  setInterval(() => {
    const p = pitches[i++ % pitches.length];
    const existing = threads.find((t) => t.accountId === (p.category === 'person' ? 'a4' : 'a1') && t.messages[0].subject.replace(/^re:\s*/i, '') === p.subject.replace(/^re:\s*/i, ''));
    const accountId = p.category === 'person' ? 'a4' : 'a1';
    const tid = existing?.id ?? nid('t');
    const id = nid('m');
    const inbox = folderByRole(accountId, 'inbox');
    const msg: Message = { id, threadId: tid, accountId, folderId: inbox.id, folderRole: 'inbox', messageId: `<${id}@mock>`, from: p.from, to: [ME[accountId]], cc: [], bcc: [], replyTo: [], subject: p.subject, date: new Date().toISOString(), seen: false, flagged: false, answered: false, draft: false, mine: false, category: p.category, snippet: p.text, attachments: [], listUnsubscribe: null, body: { html: `<p>${p.text}</p>`, text: p.text, hasRemoteImages: false, quoted: null, fetched: true } };
    if (existing) existing.messages.push(msg);
    else threads.push({ id: tid, accountId, messages: [msg] });
    recount();
    emit('new.mail', { threadId: tid, accountId, from: p.from, subject: p.subject, category: p.category });
    emit('thread.updated', { threadId: tid, accountId });
    for (const a of accounts) emit('account.updated', a);
  }, 90_000);
}
