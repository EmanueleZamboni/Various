import Database from 'better-sqlite3';
import { config } from './config.js';

export type DB = Database.Database;

export const db: DB = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -64000');

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_pending TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT,
  initial_sync_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '.',
  role TEXT NOT NULL DEFAULT 'other',
  uidvalidity INTEGER,
  uidnext INTEGER NOT NULL DEFAULT 1,
  highestmodseq INTEGER,
  total INTEGER NOT NULL DEFAULT 0,
  unseen INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, path)
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  subject_norm TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',
  last_from TEXT NOT NULL DEFAULT '{}',
  last_date TEXT NOT NULL DEFAULT '',
  first_date TEXT NOT NULL DEFAULT '',
  msg_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'person',
  roles TEXT NOT NULL DEFAULT '',          -- comma separated folder roles, e.g. ",inbox,sent,"
  inbox_date TEXT NOT NULL DEFAULT '',     -- newest date among messages in inbox (for sorting the inbox)
  role_dates TEXT NOT NULL DEFAULT '{}'    -- json role -> newest date
);
CREATE INDEX IF NOT EXISTS threads_account_last ON threads(account_id, last_date DESC);
CREATE INDEX IF NOT EXISTS threads_last ON threads(last_date DESC);
CREATE INDEX IF NOT EXISTS threads_subject ON threads(account_id, subject_norm);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL DEFAULT '',
  in_reply_to TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  subject_norm TEXT NOT NULL DEFAULT '',
  from_json TEXT NOT NULL DEFAULT '{}',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  from_email TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  internal_date TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  draft INTEGER NOT NULL DEFAULT 0,
  mine INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'person',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  list_unsubscribe TEXT,
  body_fetched INTEGER NOT NULL DEFAULT 0,
  body_error TEXT,
  structure_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (folder_id, uid)
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS messages_msgid ON messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS messages_from ON messages(from_email);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS messages_unfetched ON messages(body_fetched, date DESC);

CREATE TABLE IF NOT EXISTS message_refs (
  message_row INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_refs_ref ON message_refs(account_id, ref);
CREATE INDEX IF NOT EXISTS message_refs_row ON message_refs(message_row);

CREATE TABLE IF NOT EXISTS bodies (
  message_row INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  text TEXT,
  html TEXT,
  quoted TEXT,
  has_remote_images INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_row INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_row);

CREATE TABLE IF NOT EXISTS blocked_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sender_overrides (
  email TEXT PRIMARY KEY,
  category TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id INTEGER,
  in_reply_to INTEGER,
  forward_of INTEGER,
  to_text TEXT NOT NULL DEFAULT '',
  cc_text TEXT NOT NULL DEFAULT '',
  bcc_text TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Signature',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS signatures_account ON signatures(account_id);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT 'This device',
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, send_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS recent_searches (
  query TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  subject, from_text, to_text, body,
  tokenize = "unicode61 remove_diacritics 2",
  prefix = '2 3'
);
`;

db.exec(schema);

// Small migrations for columns added after the first release.
function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}
if (!hasColumn('accounts', 'initial_sync_done')) {
  db.exec(`ALTER TABLE accounts ADD COLUMN initial_sync_done INTEGER NOT NULL DEFAULT 0`);
}
if (!hasColumn('accounts', 'aliases')) db.exec(`ALTER TABLE accounts ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`);
if (!hasColumn('accounts', 'folder_overrides')) db.exec(`ALTER TABLE accounts ADD COLUMN folder_overrides TEXT NOT NULL DEFAULT '{}'`);
if (!hasColumn('bodies', 'calendar_json')) db.exec(`ALTER TABLE bodies ADD COLUMN calendar_json TEXT`);
if (!hasColumn('accounts', 'notify')) db.exec(`ALTER TABLE accounts ADD COLUMN notify TEXT NOT NULL DEFAULT 'default'`);

// Plain-text signatures from the first release become rich signatures.
{
  const legacy = db.prepare("SELECT id, signature FROM accounts WHERE signature <> '' AND id NOT IN (SELECT account_id FROM signatures)").all() as { id: number; signature: string }[];
  const ins = db.prepare('INSERT INTO signatures(account_id, name, html, text, is_default) VALUES (?, ?, ?, ?, 1)');
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string)).replace(/\n/g, '<br>');
  for (const a of legacy) ins.run(a.id, 'Default', `<div>${esc(a.signature)}</div>`, a.signature);
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export const nowIso = (): string => new Date().toISOString();
