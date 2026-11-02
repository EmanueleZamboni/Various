// Local SQLite copy of chats, contacts and messages.
// WhatsApp only sends history once (when the device is linked) and then live
// messages, so everything Claude reads comes from here.

import { DatabaseSync } from 'node:sqlite';
import { fold, phoneFromJid } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT
);
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  chat TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender TEXT,
  sender_name TEXT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  search TEXT,
  mime TEXT,
  file_name TEXT,
  quoted_id TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  raw TEXT,
  PRIMARY KEY (chat, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat, ts);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_id ON messages (id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export class Store {
  constructor(path, { readOnly = false } = {}) {
    this.db = new DatabaseSync(path, { readOnly });
    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      this.db.exec(SCHEMA);
    }
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.q = {};
  }

  stmt(sql) {
    return (this.q[sql] ||= this.db.prepare(sql));
  }

  tx(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- identity -------------------------------------------------------------

  /** WhatsApp is moving 1:1 chats to anonymous "@lid" ids; use the phone-number id when we know it. */
  canonical(jid) {
    if (!jid) return jid;
    if (jid.endsWith('@lid')) {
      const lid = jid.replace(/:\d+@/, '@');
      return this.stmt('SELECT pn FROM lid_map WHERE lid = ?').get(lid)?.pn || lid;
    }
    return jid.replace(/:\d+@s\.whatsapp\.net$/, '@s.whatsapp.net');
  }

  /** Records lid <-> phone number and moves anything stored under the lid. */
  addLidMapping(lid, pn) {
    if (!lid || !pn) return;
    lid = lid.replace(/:\d+@/, '@');
    pn = pn.replace(/:\d+@/, '@');
    if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
    if (this.stmt('SELECT pn FROM lid_map WHERE lid = ?').get(lid)?.pn === pn) return;
    this.tx(() => {
      this.stmt('INSERT OR REPLACE INTO lid_map (lid, pn) VALUES (?, ?)').run(lid, pn);
      this.stmt('UPDATE OR IGNORE messages SET chat = ? WHERE chat = ?').run(pn, lid);
      this.stmt('DELETE FROM messages WHERE chat = ?').run(lid);
      this.stmt('UPDATE messages SET sender = ? WHERE sender = ?').run(pn, lid);
      const chat = this.stmt('SELECT * FROM chats WHERE jid = ?').get(lid);
      if (chat) {
        this.upsertChat({ jid: pn, name: chat.name, isGroup: false, lastTs: chat.last_ts, unread: chat.unread });
        this.stmt('DELETE FROM chats WHERE jid = ?').run(lid);
      }
      const contact = this.stmt('SELECT * FROM contacts WHERE jid = ?').get(lid);
      if (contact) {
        this.upsertContact({ jid: pn, name: contact.name, notify: contact.notify });
        this.stmt('DELETE FROM contacts WHERE jid = ?').run(lid);
      }
    });
  }

  // ---- writes ---------------------------------------------------------------

  upsertChat({ jid, name, isGroup, lastTs, unread, archived }) {
    jid = this.canonical(jid);
    if (!jid) return;
    this.stmt(`
      INSERT INTO chats (jid, name, is_group, last_ts, unread, archived) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (jid) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        is_group = MAX(is_group, excluded.is_group),
        last_ts = MAX(last_ts, excluded.last_ts),
        unread = COALESCE(?, unread),
        archived = COALESCE(?, archived)
    `).run(jid, name || null, isGroup ? 1 : 0, lastTs || 0, unread || 0, archived ? 1 : 0,
      unread ?? null, archived == null ? null : (archived ? 1 : 0));
  }

  upsertContact({ jid, name, notify }) {
    jid = this.canonical(jid);
    if (!jid || (!name && !notify)) return;
    this.stmt(`
      INSERT INTO contacts (jid, name, notify) VALUES (?, ?, ?)
      ON CONFLICT (jid) DO UPDATE SET name = COALESCE(excluded.name, name), notify = COALESCE(excluded.notify, notify)
    `).run(jid, name || null, notify || null);
  }

  /** m: { chat, id, fromMe, sender, senderName, ts, type, text, mime, fileName, quotedId, raw } */
  upsertMessage(m) {
    const chat = this.canonical(m.chat);
    const sender = m.fromMe ? null : this.canonical(m.sender || m.chat);
    this.stmt(`
      INSERT INTO messages (chat, id, from_me, sender, sender_name, ts, type, text, search, mime, file_name, quoted_id, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat, id) DO UPDATE SET
        sender_name = COALESCE(excluded.sender_name, sender_name),
        raw = COALESCE(excluded.raw, raw)
    `).run(chat, m.id, m.fromMe ? 1 : 0, sender, m.senderName || null, m.ts, m.type, m.text || '',
      fold(`${m.text || ''} ${m.fileName || ''}`), m.mime || null, m.fileName || null, m.quotedId || null, m.raw || null);
    const isGroup = chat.endsWith('@g.us');
    this.upsertChat({ jid: chat, isGroup, lastTs: m.ts });
    if (sender && m.senderName) this.upsertContact({ jid: sender, notify: m.senderName });
  }

  /** Baileys' chats.update: 0 = read, -1 = marked unread, n > 0 = n new messages. */
  applyUnread(jid, value) {
    jid = this.canonical(jid);
    this.upsertChat({ jid, isGroup: jid.endsWith('@g.us') });
    if (value === 0) this.stmt('UPDATE chats SET unread = 0 WHERE jid = ?').run(jid);
    else if (value < 0) this.stmt('UPDATE chats SET unread = MAX(unread, 1) WHERE jid = ?').run(jid);
    else this.stmt('UPDATE chats SET unread = unread + ? WHERE jid = ?').run(value, jid);
  }

  editMessage(chat, id, text) {
    this.stmt('UPDATE messages SET text = ?, search = ?, edited = 1 WHERE chat = ? AND id = ?')
      .run(text, fold(text), this.canonical(chat), id);
  }

  deleteMessage(chat, id) {
    this.stmt("UPDATE messages SET deleted = 1, text = '', search = '', raw = NULL WHERE chat = ? AND id = ?")
      .run(this.canonical(chat), id);
  }

  setMeta(key, value) {
    this.stmt('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
  }

  getMeta(key) {
    return this.stmt('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  }

  // ---- reads ----------------------------------------------------------------

  rawMessage(id) {
    return this.stmt('SELECT raw FROM messages WHERE id = ? AND raw IS NOT NULL LIMIT 1').get(id)?.raw;
  }

  displayName(jid) {
    if (!jid) return '?';
    const row = this.stmt(`
      SELECT COALESCE(NULLIF(ch.name, ''), ct.name, ct.notify,
                      (SELECT sender_name FROM messages WHERE sender = ?1 AND sender_name IS NOT NULL ORDER BY ts DESC LIMIT 1)) AS name
      FROM (SELECT ?1 AS jid) j
      LEFT JOIN chats ch ON ch.jid = j.jid
      LEFT JOIN contacts ct ON ct.jid = j.jid
    `).get(jid);
    return row?.name || phoneFromJid(jid) || jid.split('@')[0];
  }

  allChats() {
    return this.stmt(`
      SELECT ch.jid, ch.is_group, ch.last_ts, ch.unread, ch.archived,
             COALESCE(NULLIF(ch.name, ''), ct.name, ct.notify) AS name
      FROM chats ch LEFT JOIN contacts ct ON ct.jid = ch.jid
      WHERE ch.jid NOT LIKE '%@broadcast' AND ch.jid NOT LIKE '%@newsletter'
      ORDER BY ch.last_ts DESC
    `).all();
  }

  allContacts() {
    return this.stmt(`
      SELECT ct.jid, ct.name, ct.notify, ch.last_ts FROM contacts ct LEFT JOIN chats ch ON ch.jid = ct.jid
      WHERE ct.jid LIKE '%@s.whatsapp.net' OR ct.jid LIKE '%@lid'
    `).all();
  }

  lastMessage(chat) {
    return this.stmt('SELECT * FROM messages WHERE chat = ? AND deleted = 0 ORDER BY ts DESC LIMIT 1').get(chat);
  }

  messages(chat, { limit, before, after }) {
    const rows = this.stmt(`
      SELECT * FROM messages WHERE chat = ? AND ts < ? AND ts > ? ORDER BY ts DESC LIMIT ?
    `).all(chat, before ?? 2 ** 40, after ?? -1, limit);
    return rows.reverse();
  }

  message(chat, id) {
    return this.stmt('SELECT * FROM messages WHERE chat = ? AND id = ?').get(chat, id);
  }

  search({ words, chat, fromMe, sender, before, after, limit }) {
    const where = ['deleted = 0', 'ts < ?', 'ts > ?'];
    const args = [before ?? 2 ** 40, after ?? -1];
    for (const w of words) {
      where.push("search LIKE ? ESCAPE '\\'");
      args.push(`%${w.replace(/[\\%_]/g, c => `\\${c}`)}%`);
    }
    if (chat) { where.push('chat = ?'); args.push(chat); }
    if (fromMe) where.push('from_me = 1');
    if (sender) { where.push('sender = ?'); args.push(sender); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args);
  }

  counts() {
    return this.stmt(`
      SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages,
             (SELECT MIN(ts) FROM messages) AS oldest, (SELECT MAX(ts) FROM messages) AS newest
    `).get();
  }
}
