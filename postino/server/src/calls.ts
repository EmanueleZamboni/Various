import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { randomToken } from './crypto.js';
import { addSms, importSmsXml, smsCount, smsDir } from './sms.js';

/**
 * Phone call log. A web app cannot read the phone's call log, so calls come in two ways:
 * - history: the XML file exported by "SMS Backup & Restore" (Android), uploaded in Settings;
 * - live: an automation app (MacroDroid) calls a secret URL when each call ends.
 * Only who, when, which way and how long: never audio.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  num_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_started ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS calls_key ON calls(num_key, started_at);
`);

export type CallType = 'incoming' | 'outgoing' | 'missed' | 'rejected' | 'blocked' | 'voicemail';
const TYPES: CallType[] = ['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail'];

/** Numbers are matched on their last 9 digits, so +39 333…, 0039 333… and 333… are one person. */
export function numKey(number: string): string {
  const d = number.replace(/\D/g, '');
  return d.length > 9 ? d.slice(-9) : d;
}

export function cleanNumber(raw: string): string {
  let n = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  return n.slice(0, 32);
}

export function callType(raw: unknown): CallType | null {
  const t = String(raw ?? '').trim().toLowerCase();
  // SMS Backup & Restore codes, then words (English and Italian).
  const codes: Record<string, CallType> = { '1': 'incoming', '2': 'outgoing', '3': 'missed', '4': 'voicemail', '5': 'rejected', '6': 'blocked' };
  if (codes[t]) return codes[t];
  if (/^(in|incoming|received|entrata|in entrata|ricevuta)$/.test(t)) return 'incoming';
  if (/^(out|outgoing|dialed|uscita|in uscita|effettuata)$/.test(t)) return 'outgoing';
  if (/^(missed|persa|mancata)$/.test(t)) return 'missed';
  if (/^(rejected|declined|rifiutata)$/.test(t)) return 'rejected';
  return TYPES.includes(t as CallType) ? (t as CallType) : null;
}

/** Seconds from "75", "1:15" or "0:01:15". */
export function parseDuration(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Math.min(Number(s), 86_400);
  const parts = s.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return Math.min(parts.reduce((acc, p) => acc * 60 + p, 0), 86_400);
}

function parseTime(raw: unknown): Date | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s));
  if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Store one call unless it is already there (same person, same way, within 2 minutes). */
export function addCall(c: { number: string; name?: string; type: CallType; startedAt: Date; duration: number; source: string }): boolean {
  const number = cleanNumber(c.number);
  if (!number || number.length < 3) return false;
  const key = numKey(number);
  const at = c.startedAt.toISOString();
  // A call sent live from the phone may be stamped when it ended; the exported history has the
  // exact start and length. Same person and way, overlapping times: the same call.
  const lo = new Date(c.startedAt.getTime() - 120_000).toISOString();
  const hi = new Date(c.startedAt.getTime() + c.duration * 1000 + 120_000).toISOString();
  const dup = db.prepare('SELECT id, name, duration, source FROM calls WHERE num_key = ? AND type = ? AND started_at BETWEEN ? AND ?').get(key, c.type, lo, hi) as
    | { id: number; name: string; duration: number; source: string }
    | undefined;
  const name = String(c.name || '').trim().slice(0, 120);
  if (dup) {
    if (!dup.name && name) db.prepare('UPDATE calls SET name = ? WHERE id = ?').run(name, dup.id);
    // The history knows the real start and length: prefer it over the live estimate.
    if (c.source === 'import' && dup.source !== 'import') db.prepare("UPDATE calls SET started_at = ?, duration = ?, source = 'import' WHERE id = ?").run(at, c.duration, dup.id);
    return false;
  }
  db.prepare('INSERT INTO calls(number, num_key, name, type, started_at, duration, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(number, key, name, c.type, at, c.duration, c.source);
  return true;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? _m,
  );

/** Calls from an "SMS Backup & Restore" calls-*.xml export. */
export function importCallsXml(xml: string): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const m of xml.matchAll(/<call\s([^>]*?)\/?>/g)) {
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
      const type = callType(attrs.type);
      const at = parseTime(attrs.date);
      if (!type || !at || !attrs.number) {
        skipped++;
        continue;
      }
      const name = attrs.contact_name && attrs.contact_name !== '(Unknown)' && attrs.contact_name !== 'null' ? attrs.contact_name : '';
      if (addCall({ number: attrs.number, name, type, startedAt: at, duration: parseDuration(attrs.duration), source: 'import' })) added++;
      else skipped++;
    }
  })();
  return { added, skipped };
}

function token(): string {
  let t = getSetting<string>('calls.token', '');
  if (!t) {
    t = randomToken(24);
    setSetting('calls.token', t);
  }
  return t;
}

/** Name for a number: from a call that had one, else from WhatsApp contacts. */
function nameFor(key: string): string {
  const fromCalls = db.prepare("SELECT name FROM calls WHERE num_key = ? AND name <> '' ORDER BY started_at DESC LIMIT 1").get(key) as { name: string } | undefined;
  if (fromCalls) return fromCalls.name;
  try {
    const wa = db.prepare("SELECT name FROM wa_contacts WHERE jid LIKE ? LIMIT 1").get(`%${key}@s.whatsapp.net`) as { name: string } | undefined;
    if (wa) return wa.name;
  } catch {
    /* no WhatsApp table */
  }
  return '';
}

const mmss = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

export function listCalls(o: { query?: string; type?: string; since?: string; until?: string; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const q = (o.query || '').trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    const keys = digits.length >= 6 ? [numKey(digits)] : [];
    if (!keys.length) {
      // A name: match calls that carry it, and every call with those numbers.
      const named = db.prepare("SELECT DISTINCT num_key FROM calls WHERE lower(name) LIKE ?").all(`%${q.toLowerCase()}%`) as { num_key: string }[];
      keys.push(...named.map((r) => r.num_key));
      try {
        const wa = db.prepare('SELECT jid FROM wa_contacts WHERE lower(name) LIKE ?').all(`%${q.toLowerCase()}%`) as { jid: string }[];
        keys.push(...wa.map((r) => numKey(r.jid.split('@')[0])));
      } catch {
        /* no WhatsApp table */
      }
    }
    if (!keys.length) return { calls: [], total: 0 };
    where.push(`num_key IN (${keys.map(() => '?').join(',')})`);
    params.push(...new Set(keys));
  }
  if (o.type && o.type !== 'all') {
    where.push('type = ?');
    params.push(o.type);
  }
  const since = parseTime(o.since);
  if (since) {
    where.push('started_at >= ?');
    params.push(since.toISOString());
  }
  const until = parseTime(o.until);
  if (until) {
    where.push('started_at <= ?');
    params.push(until.toISOString());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM calls ${w}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM calls ${w} ORDER BY started_at DESC LIMIT ?`).all(...params, Math.min(Math.max(o.limit ?? 50, 1), 500)) as { number: string; num_key: string; name: string; type: string; started_at: string; duration: number }[];
  const names = new Map<string, string>();
  const nm = (r: { num_key: string; name: string }) => r.name || names.get(r.num_key) || (names.set(r.num_key, nameFor(r.num_key)), names.get(r.num_key)!) || '';
  return { total, calls: rows.map((r) => ({ name: nm(r), number: r.number, type: r.type, at: r.started_at, duration: mmss(r.duration) })) };
}

/** Who you talk to most in a period: count and total time per person. */
export function callStats(o: { since?: string; until?: string; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const since = parseTime(o.since);
  if (since) {
    where.push('started_at >= ?');
    params.push(since.toISOString());
  }
  const until = parseTime(o.until);
  if (until) {
    where.push('started_at <= ?');
    params.push(until.toISOString());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT num_key, MAX(number) AS number, COUNT(*) AS calls, SUM(duration) AS secs, SUM(type = 'missed') AS missed, MAX(started_at) AS last
       FROM calls ${w} GROUP BY num_key ORDER BY secs DESC, calls DESC LIMIT ?`,
    )
    .all(...params, Math.min(Math.max(o.limit ?? 20, 1), 100)) as { num_key: string; number: string; calls: number; secs: number; missed: number; last: string }[];
  return { people: rows.map((r) => ({ name: nameFor(r.num_key), number: r.number, calls: r.calls, missed: r.missed, talk_time: mmss(r.secs || 0), last: r.last })) };
}

export function registerCallRoutes(app: FastifyInstance): void {
  // Live calls from the phone's automation app. Public path, secret token; GET or POST, query or body.
  const ingest = async (req: { params: { token: string }; query: Record<string, string>; body?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const want = Buffer.from(token());
    const got = Buffer.from(String(req.params.token || ''));
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return reply.code(404).send({ error: 'not_found' });
    const b = { ...(req.query || {}), ...((req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string>) };
    // Text messages use the same link: type=sms_in / sms_out, the text in text (or message/body). The text is not
    // kept in the "last received" note.
    if (/^sms/i.test(String(b.type ?? ''))) {
      const dir = smsDir(b.type);
      const num = String(b.number ?? b.phone ?? '');
      setSetting('sms.lastHook', { at: new Date().toISOString(), fields: { type: String(b.type).slice(0, 20), number: num.slice(0, 40) } });
      if (!dir || !num || /[[\]%{}]/.test(num)) return reply.code(400).send({ error: 'bad_sms', message: 'Need number and type (sms_in or sms_out).' });
      const text = String(b.text ?? b.message ?? b.body ?? '');
      const name = /[[\]%{}]/.test(String(b.name ?? '')) ? '' : String(b.name ?? '');
      addSms({ number: num, name, dir, body: /^\[[\w_]+\]$/.test(text) ? '' : text, at: parseTime(b.time) ?? new Date(), source: 'phone' });
      return { ok: true };
    }
    setSetting('calls.lastHook', { at: new Date().toISOString(), fields: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v).slice(0, 60)])) });
    const number = String(b.number ?? b.phone ?? '');
    const type = callType(b.type ?? b.direction);
    // Placeholders the automation app did not fill in (e.g. "[call_number]") mean a setup mistake.
    if (!number || /[[\]%{}]/.test(number) || !type) return reply.code(400).send({ error: 'bad_call', message: 'Need number and type (in, out or missed).' });
    const duration = parseDuration(b.duration);
    const ended = parseTime(b.time) ?? new Date();
    const startedAt = b.time ? ended : new Date(ended.getTime() - duration * 1000);
    const name = /[[\]%{}]/.test(String(b.name ?? '')) ? '' : String(b.name ?? '');
    addCall({ number, name, type, startedAt, duration, source: 'phone' });
    return { ok: true };
  };
  app.get<{ Params: { token: string }; Querystring: Record<string, string> }>('/hooks/calls/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, ingest as never);
  app.post<{ Params: { token: string }; Querystring: Record<string, string> }>('/hooks/calls/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, ingest as never);

  app.get('/api/calls/setup', async (req) => {
    const base = `${req.protocol}://${req.host}`;
    const n = db.prepare('SELECT COUNT(*) AS n, MAX(started_at) AS last FROM calls').get() as { n: number; last: string | null };
    return { hookUrl: `${base}/hooks/calls/${token()}`, count: n.n, last: n.last, lastHook: getSetting('calls.lastHook', null), sms: smsCount(), smsLastHook: getSetting('sms.lastHook', null) };
  });
  app.post('/api/calls/token', async () => {
    setSetting('calls.token', randomToken(24));
    return { ok: true };
  });
  app.post('/api/calls/import', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'no_file', message: 'Choose the calls file.' });
    const xml = (await file.toBuffer()).toString('utf8');
    // The same button takes the calls file and the messages file (sms-….xml) of SMS Backup & Restore.
    if (xml.includes('<sms') || xml.includes('<smses')) {
      const r = importSmsXml(xml);
      return { added: r.added, skipped: r.skipped, kind: 'sms', mms: r.mms };
    }
    if (!xml.includes('<call')) return reply.code(400).send({ error: 'bad_file', message: 'That is not a backup from SMS Backup & Restore (calls-….xml or sms-….xml).' });
    return importCallsXml(xml);
  });
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/calls', async (req) => listCalls({ query: req.query.q, limit: Number(req.query.limit) || 30 }));
  app.delete('/api/calls', async () => {
    db.exec('DELETE FROM calls');
    return { ok: true };
  });
}
