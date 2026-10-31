import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting } from './db.js';
import { uiSettings, updateUiSettings } from './settings.js';
import { isOwn, normalizePattern } from './routes/blocked.js';
import { driveConnected, saveBackupToDrive } from './google.js';
import { log } from './log.js';

/**
 * Backup of everything that lives only in Postino (mail itself stays on the mail servers):
 * settings, templates, signatures, blocked senders, sender categories, unsent drafts and the
 * mailbox setups. Never included: mailbox passwords, the Postino password, two-step and
 * passkeys, sessions. A few KB of JSON.
 */

const FORMAT = 'postino-backup';
const VERSION = 1;

type AccountOut = {
  email: string;
  name: string;
  color: string;
  sortOrder: number;
  username: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  aliases: string[];
  folderOverrides: Record<string, string>;
  notify: string;
};
type SignatureOut = { account: string; name: string; html: string; text: string; isDefault: boolean; sortOrder: number };
type DraftOut = { account: string; fromAddress: string; to: string; cc: string; bcc: string; subject: string; text: string; updatedAt: string };
export type Backup = {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  settings: unknown;
  accounts: AccountOut[];
  templates: { name: string; subject: string; text: string; sortOrder: number }[];
  signatures: SignatureOut[];
  blocked: { pattern: string; note: string }[];
  senderCategories: { email: string; category: string }[];
  drafts: DraftOut[];
};

const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function buildBackup(): Backup {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all() as Record<string, unknown>[];
  const emailOf = new Map(accounts.map((a) => [a.id as number, String(a.email)]));
  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    settings: uiSettings(),
    accounts: accounts.map((a) => ({
      email: String(a.email),
      name: String(a.name),
      color: String(a.color),
      sortOrder: Number(a.sort_order),
      username: String(a.username),
      imap: { host: String(a.imap_host), port: Number(a.imap_port), secure: Boolean(a.imap_secure) },
      smtp: { host: String(a.smtp_host), port: Number(a.smtp_port), secure: Boolean(a.smtp_secure) },
      aliases: parseJson<string[]>(a.aliases as string, []),
      folderOverrides: parseJson<Record<string, string>>(a.folder_overrides as string, {}),
      notify: String(a.notify ?? 'default'),
    })),
    templates: (db.prepare('SELECT name, subject, text, sort_order FROM templates ORDER BY sort_order, id').all() as { name: string; subject: string; text: string; sort_order: number }[]).map((t) => ({ name: t.name, subject: t.subject, text: t.text, sortOrder: t.sort_order })),
    signatures: (db.prepare('SELECT * FROM signatures ORDER BY account_id, sort_order, id').all() as Record<string, unknown>[])
      .filter((s) => emailOf.has(s.account_id as number))
      .map((s) => ({ account: emailOf.get(s.account_id as number)!, name: String(s.name), html: String(s.html), text: String(s.text), isDefault: Boolean(s.is_default), sortOrder: Number(s.sort_order) })),
    blocked: db.prepare('SELECT pattern, note FROM blocked_senders ORDER BY id').all() as { pattern: string; note: string }[],
    senderCategories: db.prepare('SELECT email, category FROM sender_overrides').all() as { email: string; category: string }[],
    drafts: (db.prepare('SELECT * FROM drafts ORDER BY id').all() as Record<string, unknown>[])
      .filter((d) => emailOf.has(d.account_id as number))
      .map((d) => ({ account: emailOf.get(d.account_id as number)!, fromAddress: String(d.from_address ?? ''), to: String(d.to_text), cc: String(d.cc_text), bcc: String(d.bcc_text), subject: String(d.subject), text: String(d.text), updatedAt: String(d.updated_at) })),
  };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 5000) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Check the shape and keep only the fields we know, with sane lengths. */
function clean(raw: unknown): Backup {
  const b = obj(raw);
  if (b.format !== FORMAT) throw Object.assign(new Error('This is not a Postino backup file.'), { statusCode: 400 });
  if (typeof b.version !== 'number' || b.version > VERSION) throw Object.assign(new Error('This backup was made by a newer Postino. Update this server first.'), { statusCode: 400 });
  const email = (v: unknown) => str(v, 320).trim().toLowerCase();
  const isEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const endpoint = (v: unknown) => {
    const e = obj(v);
    return { host: str(e.host, 255).trim(), port: Number.isInteger(e.port) ? (e.port as number) : 0, secure: e.secure === true };
  };
  return {
    format: FORMAT,
    version: b.version,
    createdAt: str(b.createdAt, 40),
    settings: obj(b.settings),
    accounts: arr(b.accounts)
      .map(obj)
      .map((a) => ({
        email: email(a.email),
        name: str(a.name, 200),
        color: /^#[0-9a-f]{6}$/i.test(str(a.color, 7)) ? str(a.color, 7) : '',
        sortOrder: Number.isInteger(a.sortOrder) ? (a.sortOrder as number) : 0,
        username: str(a.username, 320),
        imap: endpoint(a.imap),
        smtp: endpoint(a.smtp),
        aliases: arr(a.aliases).map(email).filter(isEmail).slice(0, 50),
        folderOverrides: Object.fromEntries(Object.entries(obj(a.folderOverrides)).filter(([k, v]) => typeof v === 'string' && k.length < 100 && (v as string).length < 500)) as Record<string, string>,
        notify: ['default', 'all', 'people', 'none'].includes(str(a.notify, 20)) ? str(a.notify, 20) : 'default',
      }))
      .filter((a) => isEmail(a.email)),
    templates: arr(b.templates).map(obj).map((t) => ({ name: str(t.name, 80), subject: str(t.subject, 300), text: str(t.text, 20000), sortOrder: Number.isInteger(t.sortOrder) ? (t.sortOrder as number) : 0 })).filter((t) => t.name),
    signatures: arr(b.signatures).map(obj).map((s) => ({ account: email(s.account), name: str(s.name, 80) || 'Signature', html: str(s.html, 2_000_000), text: str(s.text, 20000), isDefault: s.isDefault === true, sortOrder: Number.isInteger(s.sortOrder) ? (s.sortOrder as number) : 0 })).filter((s) => isEmail(s.account)),
    blocked: arr(b.blocked).map(obj).map((x) => ({ pattern: str(x.pattern, 320), note: str(x.note, 200) })),
    senderCategories: arr(b.senderCategories).map(obj).map((x) => ({ email: email(x.email), category: str(x.category, 20) })).filter((x) => isEmail(x.email) && ['person', 'notification', 'newsletter'].includes(x.category)),
    drafts: arr(b.drafts).map(obj).map((d) => ({ account: email(d.account), fromAddress: email(d.fromAddress), to: str(d.to, 5000), cc: str(d.cc, 5000), bcc: str(d.bcc, 5000), subject: str(d.subject, 998), text: str(d.text, 500_000), updatedAt: str(d.updatedAt, 40) })).filter((d) => isEmail(d.account)),
  };
}

type Pending = { accounts: AccountOut[]; signatures: SignatureOut[]; drafts: DraftOut[] };

/** Signatures, drafts, colour and aliases of one restored mailbox, once it exists here. */
export function applyPendingFor(accountId: number): void {
  const pending = getSetting<Pending | null>('restore.pending', null);
  if (!pending) return;
  const row = db.prepare('SELECT id, email FROM accounts WHERE id = ?').get(accountId) as { id: number; email: string } | undefined;
  if (!row) return;
  const e = row.email.toLowerCase();
  const acct = pending.accounts.find((a) => a.email === e);
  if (!acct) return;
  db.transaction(() => {
    db.prepare('UPDATE accounts SET name = ?, color = COALESCE(NULLIF(?, \'\'), color), aliases = ?, folder_overrides = ?, notify = ? WHERE id = ?').run(acct.name || row.email, acct.color, JSON.stringify(acct.aliases), JSON.stringify(acct.folderOverrides), acct.notify, row.id);
    const sigs = pending.signatures.filter((s) => s.account === e);
    if (sigs.length) {
      db.prepare('DELETE FROM signatures WHERE account_id = ?').run(row.id);
      const ins = db.prepare('INSERT INTO signatures(account_id, name, html, text, is_default, sort_order) VALUES (?,?,?,?,?,?)');
      for (const s of sigs) ins.run(row.id, s.name, s.html, s.text, s.isDefault ? 1 : 0, s.sortOrder);
    }
    const insD = db.prepare('INSERT INTO drafts(account_id, from_address, to_text, cc_text, bcc_text, subject, text) VALUES (?,?,?,?,?,?,?)');
    for (const d of pending.drafts.filter((x) => x.account === e)) insD.run(row.id, d.fromAddress, d.to, d.cc, d.bcc, d.subject, d.text);
    const left: Pending = { accounts: pending.accounts.filter((a) => a.email !== e), signatures: pending.signatures.filter((s) => s.account !== e), drafts: pending.drafts.filter((d) => d.account !== e) };
    if (left.accounts.length) setSetting('restore.pending', left);
    else db.prepare("DELETE FROM settings WHERE key = 'restore.pending'").run();
  })();
}

/** Bring a backup in: global things now, each mailbox's own things when it is added again. */
export function restoreBackup(raw: unknown): { mailboxes: AccountOut[] } {
  const b = clean(raw);
  db.transaction(() => {
    updateUiSettings(b.settings);
    if (b.templates.length) {
      db.prepare('DELETE FROM templates').run();
      const ins = db.prepare('INSERT INTO templates(name, subject, text, sort_order) VALUES (?, ?, ?, ?)');
      for (const t of b.templates) ins.run(t.name, t.subject, t.text, t.sortOrder);
      setSetting('templates.seeded', true);
    }
    const insB = db.prepare('INSERT OR IGNORE INTO blocked_senders(pattern, note) VALUES (?, ?)');
    for (const x of b.blocked) {
      const p = normalizePattern(x.pattern);
      if (p && !isOwn(p)) insB.run(p, x.note);
    }
    const insC = db.prepare('INSERT INTO sender_overrides(email, category) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET category = excluded.category');
    for (const c of b.senderCategories) insC.run(c.email, c.category);
    setSetting('restore.pending', { accounts: b.accounts, signatures: b.signatures, drafts: b.drafts } satisfies Pending);
  })();
  // Mailboxes that are already here get their things straight away.
  for (const a of b.accounts) {
    const row = db.prepare('SELECT id FROM accounts WHERE lower(email) = ?').get(a.email) as { id: number } | undefined;
    if (row) applyPendingFor(row.id);
  }
  return { mailboxes: pendingMailboxes() };
}

/** Mailboxes from a restored backup that still need their password typed in. */
export function pendingMailboxes(): AccountOut[] {
  return getSetting<Pending | null>('restore.pending', null)?.accounts ?? [];
}

const fileName = () => `postino-backup-${new Date().toISOString().slice(0, 10)}.json`;

async function backupToDrive(): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(buildBackup()));
  await saveBackupToDrive(fileName(), bytes, 30);
  setSetting('backup.drive', { at: new Date().toISOString(), error: null, bytes: bytes.length });
}

/** Once a day, if Drive is connected: a copy in Drive, older than 30 days removed. */
export function startDriveBackups(): void {
  const tick = async () => {
    if (!driveConnected()) return;
    const last = getSetting<{ at: string | null } | null>('backup.drive', null);
    if (last?.at && Date.now() - Date.parse(last.at) < 23 * 3_600_000) return;
    try {
      await backupToDrive();
    } catch (err) {
      log.warn({ err }, 'Drive backup failed');
      setSetting('backup.drive', { at: last?.at ?? null, error: (err as Error).message, bytes: 0 });
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), 3_600_000).unref();
}

export function registerBackupRoutes(app: FastifyInstance): void {
  app.get('/api/backup', async (_req, reply) => {
    reply.header('content-disposition', `attachment; filename="${fileName()}"`);
    reply.header('cache-control', 'no-store');
    reply.type('application/json');
    return JSON.stringify(buildBackup(), null, 1);
  });

  app.get('/api/backup/status', async () => {
    const d = getSetting<{ at: string | null; error: string | null; bytes: number } | null>('backup.drive', null);
    return { driveConnected: driveConnected(), lastDrive: d?.at ?? null, lastDriveError: d?.error ?? null, pendingMailboxes: pendingMailboxes() };
  });

  app.post('/api/backup/drive-now', async (_req, reply) => {
    if (!driveConnected()) return reply.code(409).send({ error: 'not_connected', message: 'Connect Google Drive first (Settings → Google Drive).' });
    try {
      await backupToDrive();
    } catch (err) {
      return reply.code(502).send({ error: 'drive_failed', message: (err as Error).message });
    }
    return { ok: true };
  });

  app.post('/api/backup/restore', { bodyLimit: 20 * 1024 * 1024 }, async (req) => restoreBackup(req.body));

  app.post('/api/backup/forget-pending', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'restore.pending'").run();
    return { ok: true };
  });
}
