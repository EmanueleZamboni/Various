import { db } from './db.js';
import { cleanNumber, numKey } from './calls.js';

/**
 * Text messages (SMS) from the phone, next to the call log (his ask 2026-11-12). Same two ways in as calls:
 * - history: the sms-….xml file exported by "SMS Backup & Restore", uploaded with the same button as the calls file;
 * - live: MacroDroid calls the same secret link as for calls, with type=sms_in / sms_out and the text.
 * Only reading: Postino never sends SMS.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS sms (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  num_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  dir TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_at ON sms(at DESC);
CREATE INDEX IF NOT EXISTS sms_key ON sms(num_key, at);
`);

export type SmsDir = 'in' | 'out';

/** "1"/"in"/"received"/"sms_in" = received, "2"/"out"/"sent"/"sms_out" = sent (SMS Backup & Restore codes, then words). */
export function smsDir(raw: unknown): SmsDir | null {
  const t = String(raw ?? '').trim().toLowerCase();
  if (/^(1|in|incoming|received|sms_in|ricevuto|ricevuta|inbox)$/.test(t)) return 'in';
  if (/^(2|out|outgoing|sent|sms_out|inviato|inviata|sent_box)$/.test(t)) return 'out';
  return null;
}

/** Store one SMS unless it is already there (same person, same way, same text, within 2 minutes). */
export function addSms(s: { number: string; name?: string; dir: SmsDir; body: string; at: Date; source: string }): boolean {
  const number = cleanNumber(s.number);
  if (!number || number.length < 2) return false;
  const key = numKey(number) || number.toLowerCase();
  const body = String(s.body ?? '').slice(0, 5000);
  const lo = new Date(s.at.getTime() - 120_000).toISOString();
  const hi = new Date(s.at.getTime() + 120_000).toISOString();
  const dup = db.prepare('SELECT id, name, source FROM sms WHERE num_key = ? AND dir = ? AND body = ? AND at BETWEEN ? AND ?').get(key, s.dir, body, lo, hi) as
    | { id: number; name: string; source: string }
    | undefined;
  const name = String(s.name || '').trim().slice(0, 120);
  if (dup) {
    if (!dup.name && name) db.prepare('UPDATE sms SET name = ? WHERE id = ?').run(name, dup.id);
    if (s.source === 'import' && dup.source !== 'import') db.prepare("UPDATE sms SET at = ?, source = 'import' WHERE id = ?").run(s.at.toISOString(), dup.id);
    return false;
  }
  db.prepare('INSERT INTO sms(number, num_key, name, dir, body, at, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(number, key, name, s.dir, body, s.at.toISOString(), s.source);
  return true;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? _m,
  );

/** SMS from an "SMS Backup & Restore" sms-*.xml export (MMS are counted, not stored: they are pictures). */
export function importSmsXml(xml: string): { added: number; skipped: number; mms: number } {
  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const m of xml.matchAll(/<sms\s([^>]*?)\/?>/g)) {
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
      const dir = smsDir(attrs.type);
      const ms = Number(attrs.date);
      if (!dir || !Number.isFinite(ms) || !attrs.address) {
        skipped++;
        continue;
      }
      const name = attrs.contact_name && attrs.contact_name !== '(Unknown)' && attrs.contact_name !== 'null' ? attrs.contact_name : '';
      if (addSms({ number: attrs.address, name, dir, body: attrs.body ?? '', at: new Date(ms), source: 'import' })) added++;
      else skipped++;
    }
  })();
  return { added, skipped, mms: (xml.match(/<mms\s/g) || []).length };
}

/** Text messages, newest first: by person (name or number), words in the text, way and dates. */
export function listSms(o: { query?: string; text?: string; dir?: string; since?: string; until?: string; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const q = (o.query || '').trim();
  if (q) {
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 6) {
      where.push('num_key = ?');
      params.push(numKey(digits));
    } else {
      // a name: the SMS that carry it, plus calls and WhatsApp contacts with that name (their numbers)
      const keys = new Set<string>();
      for (const r of db.prepare('SELECT DISTINCT num_key FROM sms WHERE lower(name) LIKE ?').all(`%${q.toLowerCase()}%`) as { num_key: string }[]) keys.add(r.num_key);
      try {
        for (const r of db.prepare('SELECT DISTINCT num_key FROM calls WHERE lower(name) LIKE ?').all(`%${q.toLowerCase()}%`) as { num_key: string }[]) keys.add(r.num_key);
      } catch {
        /* no calls table */
      }
      try {
        for (const r of db.prepare('SELECT jid FROM wa_contacts WHERE lower(name) LIKE ?').all(`%${q.toLowerCase()}%`) as { jid: string }[]) keys.add(numKey(r.jid.split('@')[0]));
      } catch {
        /* no WhatsApp table */
      }
      // senders with letters (banks, couriers: "INTESA", "BRT") match on the number itself
      keys.add(q.toLowerCase());
      where.push(`num_key IN (${[...keys].map(() => '?').join(',')})`);
      params.push(...keys);
    }
  }
  for (const w of (o.text || '').trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    where.push('lower(body) LIKE ?');
    params.push(`%${w.toLowerCase()}%`);
  }
  if (o.dir === 'in' || o.dir === 'out') {
    where.push('dir = ?');
    params.push(o.dir);
  }
  const since = o.since ? new Date(o.since) : null;
  if (since && !Number.isNaN(since.getTime())) {
    where.push('at >= ?');
    params.push(since.toISOString());
  }
  const until = o.until ? new Date(o.until) : null;
  if (until && !Number.isNaN(until.getTime())) {
    where.push('at <= ?');
    params.push(until.toISOString());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sms ${w}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT number, name, dir, body, at FROM sms ${w} ORDER BY at DESC LIMIT ?`).all(...params, Math.min(Math.max(o.limit ?? 30, 1), 300)) as {
    number: string;
    name: string;
    dir: string;
    body: string;
    at: string;
  }[];
  return { total, sms: rows.map((r) => ({ name: r.name || undefined, number: r.number, dir: r.dir === 'in' ? 'received' : 'sent', at: r.at, text: r.body })) };
}

export function smsCount(): { count: number; last: string | null } {
  const n = db.prepare('SELECT COUNT(*) AS n, MAX(at) AS last FROM sms').get() as { n: number; last: string | null };
  return { count: n.n, last: n.last };
}
