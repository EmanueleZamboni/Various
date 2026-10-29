import { db } from './db.js';

export type ParsedQuery = {
  terms: string[]; // free text (positive)
  phrases: string[];
  excluded: string[];
  from: string[];
  to: string[];
  subject: string[];
  hasAttachment: boolean;
  unread: boolean | null;
  pinned: boolean | null;
  inRole: string | null;
  account: string | null;
  before: string | null; // ISO date
  after: string | null;
  newerThanDays: number | null;
  olderThanDays: number | null;
  larger: number | null; // bytes
  smaller: number | null;
};

const roleAliases: Record<string, string> = { inbox: 'inbox', sent: 'sent', drafts: 'drafts', archive: 'archive', archived: 'archive', junk: 'junk', spam: 'junk', trash: 'trash', bin: 'trash', blocked: 'blocked', all: 'all', anywhere: 'all' };

/** Parse a Gmail-like query string. */
export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], phrases: [], excluded: [], from: [], to: [], subject: [], hasAttachment: false, unread: null, pinned: null, inRole: null, account: null, before: null, after: null, newerThanDays: null, olderThanDays: null, larger: null, smaller: null };
  const tokens = q.match(/-?\w+:"[^"]*"|-?\w+:\S+|"[^"]*"|-\S+|\S+/g) || [];
  for (const raw of tokens) {
    let t = raw;
    const neg = t.startsWith('-');
    if (neg) t = t.slice(1);
    const m = t.match(/^(\w+):(.*)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].replace(/^"|"$/g, '');
      if (!val) continue;
      switch (key) {
        case 'from':
          out.from.push(val);
          continue;
        case 'to':
        case 'cc':
          out.to.push(val);
          continue;
        case 'subject':
          out.subject.push(val);
          continue;
        case 'has':
          if (/^attach/i.test(val)) out.hasAttachment = true;
          continue;
        case 'is':
          if (/^unread$/i.test(val)) out.unread = !neg;
          else if (/^read$/i.test(val)) out.unread = neg;
          else if (/^(pinned|starred|flagged)$/i.test(val)) out.pinned = !neg;
          continue;
        case 'in':
        case 'folder':
          out.inRole = roleAliases[val.toLowerCase()] || null;
          continue;
        case 'account':
          out.account = val.toLowerCase();
          continue;
        case 'before':
          out.before = toIso(val);
          continue;
        case 'after':
        case 'since':
          out.after = toIso(val);
          continue;
        case 'newer_than':
        case 'newer':
        case 'older_than':
        case 'older': {
          const mm = val.match(/^(\d+)([dwmy])?$/i);
          if (mm) {
            const n = Number(mm[1]);
            const unit = (mm[2] || 'd').toLowerCase();
            const days = unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : unit === 'y' ? n * 365 : n;
            if (key.startsWith('newer')) out.newerThanDays = days;
            else out.olderThanDays = days;
          }
          continue;
        }
        case 'larger':
        case 'smaller':
        case 'size': {
          const mm = val.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
          if (mm) {
            const mult = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 ** 3 }[mm[2].toLowerCase()] ?? 1;
            const bytes = Math.round(Number(mm[1]) * mult);
            if (key === 'smaller') out.smaller = bytes;
            else out.larger = bytes;
          }
          continue;
        }
        default:
          // unknown operator: treat as text
          break;
      }
    }
    if (t.startsWith('"') && t.endsWith('"') && t.length > 1) {
      const phrase = t.slice(1, -1).trim();
      if (phrase) (neg ? out.excluded : out.phrases).push(phrase);
      continue;
    }
    if (neg) out.excluded.push(t);
    else out.terms.push(t);
  }
  return out;
}

function toIso(v: string): string | null {
  const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) || v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString();
  const m2 = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/); // dd/mm/yyyy
  if (m2) return new Date(Date.UTC(Number(m2[3]), Number(m2[2]) - 1, Number(m2[1]))).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Escape one word for FTS5 MATCH: quote it, add prefix matching. */
function ftsWord(w: string, prefix = true): string {
  const clean = w.replace(/"/g, '""').replace(/[*^]/g, '');
  if (!clean) return '';
  return `"${clean}"${prefix ? '*' : ''}`;
}

function ftsPhrase(p: string): string {
  const words = p.split(/\s+/).filter(Boolean).map((w) => w.replace(/"/g, '""'));
  return words.length ? `"${words.join(' ')}"` : '';
}

/** Build the FTS5 MATCH expression (or null when the query has no text parts). */
export function buildMatch(p: ParsedQuery): string | null {
  const parts: string[] = [];
  for (const t of p.terms) {
    const w = ftsWord(t);
    if (w) parts.push(w);
  }
  for (const ph of p.phrases) {
    const w = ftsPhrase(ph);
    if (w) parts.push(w);
  }
  for (const f of p.from) {
    const w = f.split(/[\s]+/).map((x) => ftsWord(x)).filter(Boolean).join(' ');
    if (w) parts.push(`from_text : (${w})`);
  }
  for (const t of p.to) {
    const w = t.split(/[\s]+/).map((x) => ftsWord(x)).filter(Boolean).join(' ');
    if (w) parts.push(`to_text : (${w})`);
  }
  for (const s of p.subject) {
    const w = s.split(/[\s]+/).map((x) => ftsWord(x)).filter(Boolean).join(' ');
    if (w) parts.push(`subject : (${w})`);
  }
  let expr = parts.join(' AND ');
  const ex = p.excluded.map((x) => (x.includes(' ') ? ftsPhrase(x) : ftsWord(x, false))).filter(Boolean);
  if (ex.length) {
    if (!expr) return null; // FTS5 cannot do pure negation
    expr = `(${expr}) NOT (${ex.join(' OR ')})`;
  }
  return expr || null;
}

export type SearchResult = { threadId: number; rank: number; highlight: string | null; messageId: number };

/**
 * Search messages and return the best-ranked message per thread, newest-thread
 * first with rank as tiebreaker. Returns thread ids with snippets.
 */
export function searchThreads(q: string, opts: { accountId: number | null; limit: number; offset: number }): { results: SearchResult[]; total: number } {
  const p = parseQuery(q);
  const match = buildMatch(p);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.accountId) {
    where.push('m.account_id = ?');
    params.push(opts.accountId);
  } else if (p.account) {
    where.push('m.account_id IN (SELECT id FROM accounts WHERE lower(email) LIKE ? OR lower(name) LIKE ?)');
    params.push(`%${p.account}%`, `%${p.account}%`);
  }
  if (p.hasAttachment) where.push('m.has_attachments = 1');
  if (p.unread !== null) where.push(p.unread ? 'm.seen = 0' : 'm.seen = 1');
  if (p.pinned !== null) where.push(p.pinned ? 'm.flagged = 1' : 'm.flagged = 0');
  if (p.inRole && p.inRole !== 'all') {
    where.push('f.role = ?');
    params.push(p.inRole);
  } else if (!p.inRole) {
    where.push("f.role NOT IN ('trash', 'junk', 'blocked')");
  }
  if (p.before) {
    where.push('m.date < ?');
    params.push(p.before);
  }
  if (p.after) {
    where.push('m.date >= ?');
    params.push(p.after);
  }
  if (p.newerThanDays) {
    where.push('m.date >= ?');
    params.push(new Date(Date.now() - p.newerThanDays * 86400_000).toISOString());
  }
  if (p.olderThanDays) {
    where.push('m.date < ?');
    params.push(new Date(Date.now() - p.olderThanDays * 86400_000).toISOString());
  }
  if (p.larger) {
    where.push('m.size >= ?');
    params.push(p.larger);
  }
  if (p.smaller) {
    where.push('m.size <= ?');
    params.push(p.smaller);
  }
  // Operator-only searches without FTS text still work via plain SQL filters.
  if (!match && p.from.length) for (const f of p.from) { where.push("(lower(m.from_json) LIKE ?)"); params.push(`%${f.toLowerCase()}%`); }
  if (!match && p.to.length) for (const t of p.to) { where.push("(lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)"); params.push(`%${t.toLowerCase()}%`, `%${t.toLowerCase()}%`); }
  if (!match && p.subject.length) for (const s of p.subject) { where.push('lower(m.subject) LIKE ?'); params.push(`%${s.toLowerCase()}%`); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  let sql: string;
  let countSql: string;
  const base = `FROM messages m JOIN folders f ON f.id = m.folder_id`;
  if (match) {
    sql = `WITH hits AS (
             SELECT rowid AS id, bm25(fts, 6.0, 4.0, 2.0, 1.0) AS rank,
                    snippet(fts, 3, '\u0001', '\u0002', '…', 14) AS snip,
                    snippet(fts, 0, '\u0001', '\u0002', '', 20) AS subj
             FROM fts WHERE fts MATCH ?
           ),
           scored AS (
             SELECT m.thread_id, m.id AS message_id, h.rank, h.snip, h.subj, m.date,
                    ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY h.rank ASC, m.date DESC) AS rn
             ${base} JOIN hits h ON h.id = m.id ${whereSql}
           )
           SELECT thread_id, message_id, rank, snip, subj, date FROM scored WHERE rn = 1
           ORDER BY date DESC LIMIT ? OFFSET ?`;
    countSql = `WITH hits AS (SELECT rowid AS id FROM fts WHERE fts MATCH ?)
                SELECT COUNT(DISTINCT m.thread_id) AS n ${base} JOIN hits h ON h.id = m.id ${whereSql}`;
    const rows = db.prepare(sql).all(match, ...params, opts.limit, opts.offset) as { thread_id: number; message_id: number; rank: number; snip: string; subj: string; date: string }[];
    const total = (db.prepare(countSql).get(match, ...params) as { n: number }).n;
    return {
      total,
      results: rows.map((r) => ({ threadId: r.thread_id, messageId: r.message_id, rank: r.rank, highlight: toHighlight(r.snip.includes('\u0001') ? r.snip : r.subj) })),
    };
  }
  sql = `SELECT m.thread_id, m.id AS message_id, m.date FROM (
           SELECT m.thread_id, m.id, m.date, ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC) AS rn
           ${base} ${whereSql}
         ) m WHERE rn = 1 ORDER BY m.date DESC LIMIT ? OFFSET ?`;
  countSql = `SELECT COUNT(DISTINCT m.thread_id) AS n ${base} ${whereSql}`;
  const rows = db.prepare(sql).all(...params, opts.limit, opts.offset) as { thread_id: number; message_id: number; date: string }[];
  const total = (db.prepare(countSql).get(...params) as { n: number }).n;
  return { total, results: rows.map((r) => ({ threadId: r.thread_id, messageId: r.message_id, rank: 0, highlight: null })) };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function toHighlight(snip: string): string | null {
  if (!snip) return null;
  return esc(snip).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}

export function rememberSearch(q: string): void {
  const t = q.trim();
  if (!t) return;
  db.prepare('INSERT INTO recent_searches(query, used_at) VALUES (?, ?) ON CONFLICT(query) DO UPDATE SET used_at = excluded.used_at').run(t, new Date().toISOString());
  db.prepare('DELETE FROM recent_searches WHERE query NOT IN (SELECT query FROM recent_searches ORDER BY used_at DESC LIMIT 30)').run();
}
