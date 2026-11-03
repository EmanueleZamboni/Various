import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { db } from './db.js';
import { config } from './config.js';
import { log } from './log.js';

/**
 * WhatsApp, linked as one of the phone's "Linked devices" (like WhatsApp Web).
 *
 * Off until the owner links it from Settings > WhatsApp; nothing connects before that.
 * WhatsApp has no official API for personal accounts, so this uses Baileys (unofficial):
 * the owner is told about the small risk of the number being restricted before linking.
 * Only text is kept (media become "[photo]" etc.), in Postino's own database, and nothing is
 * ever sent on its own: sending happens only through the send tool, which Claude must confirm.
 */

const DIR = path.join(config.dataDir, 'whatsapp');
const AUTH = path.join(DIR, 'auth');

db.exec(`
CREATE TABLE IF NOT EXISTS wa_chats (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  is_group INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_messages (
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  sender TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS wa_messages_ts ON wa_messages(chat_jid, ts);
CREATE TABLE IF NOT EXISTS wa_contacts (jid TEXT PRIMARY KEY, name TEXT NOT NULL);
`);

type State = 'off' | 'connecting' | 'qr' | 'open' | 'logged_out';
let sock: WASocket | null = null;
let state: State = 'off';
let qrDataUrl: string | null = null;
let pairingCode: string | null = null;
let me: string | null = null;
let retry = 0;
let stopping = false;

// Baileys logs message contents at debug level: keep it quiet, only real problems reach the log.
const quiet = {
  level: 'silent',
  child() {
    return quiet;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(obj: unknown, msg?: string) {
    const e = obj as { err?: { message?: string } } | undefined;
    log.warn({ err: e?.err?.message ?? (typeof msg === 'string' ? msg : 'error') }, 'whatsapp');
  },
};

const tsOf = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = Number((v as { toNumber?: () => number }).toNumber ? (v as { toNumber: () => number }).toNumber() : v);
  return Number.isFinite(n) ? n : 0;
};

/** Plain text of a message; media and specials become a short tag. Null for things to skip. */
export function messageText(msg: WAMessage['message']): string | null {
  const m = normalizeMessageContent(msg);
  if (!m) return null;
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  const cap = (tag: string, c?: string | null) => (c ? `[${tag}] ${c}` : `[${tag}]`);
  if (m.imageMessage) return cap('photo', m.imageMessage.caption);
  if (m.videoMessage) return cap('video', m.videoMessage.caption);
  if (m.documentMessage) return cap('document', m.documentMessage.fileName || m.documentMessage.caption);
  if (m.documentWithCaptionMessage?.message?.documentMessage) return cap('document', m.documentWithCaptionMessage.message.documentMessage.fileName);
  if (m.audioMessage) return m.audioMessage.ptt ? '[voice message]' : '[audio]';
  if (m.stickerMessage) return '[sticker]';
  if (m.locationMessage || m.liveLocationMessage) return '[location]';
  if (m.contactMessage || m.contactsArrayMessage) return '[contact card]';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return cap('poll', (m.pollCreationMessage || m.pollCreationMessageV3)?.name);
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  return null;
}

const insMsg = db.prepare(
  `INSERT INTO wa_messages(chat_jid, id, from_me, sender, sender_name, ts, text) VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(chat_jid, id) DO UPDATE SET text = excluded.text`,
);
const upChat = db.prepare(
  `INSERT INTO wa_chats(jid, name, is_group, last_ts) VALUES (?, ?, ?, ?)
   ON CONFLICT(jid) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE wa_chats.name END,
     last_ts = MAX(wa_chats.last_ts, excluded.last_ts)`,
);
const upContact = db.prepare('INSERT INTO wa_contacts(jid, name) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name');

/** Store messages (history or live). Returns how many were kept. */
export function storeMessages(list: WAMessage[], live = false): number {
  let n = 0;
  db.transaction(() => {
    for (const m of list) {
      const jid = m.key?.remoteJid ? jidNormalizedUser(m.key.remoteJid) : '';
      if (!jid || isJidStatusBroadcast(jid) || !m.key.id) continue;
      const text = messageText(m.message);
      if (text === null) continue;
      const ts = tsOf(m.messageTimestamp);
      const fromMe = m.key.fromMe ? 1 : 0;
      const sender = fromMe ? 'me' : jidNormalizedUser(m.key.participant || jid);
      if (!fromMe && m.pushName) upContact.run(sender, m.pushName);
      insMsg.run(jid, m.key.id, fromMe, sender, fromMe ? 'Me' : m.pushName || '', ts, text.slice(0, 20_000));
      upChat.run(jid, '', isJidGroup(jid) ? 1 : 0, ts);
      if (live && !fromMe) db.prepare('UPDATE wa_chats SET unread = unread + 1 WHERE jid = ?').run(jid);
      n++;
    }
  })();
  return n;
}

function storeChats(list: { id?: string | null; name?: string | null; conversationTimestamp?: unknown; unreadCount?: number | null }[]): void {
  db.transaction(() => {
    for (const c of list) {
      if (!c.id || isJidStatusBroadcast(c.id)) continue;
      const jid = jidNormalizedUser(c.id);
      upChat.run(jid, c.name || '', isJidGroup(jid) ? 1 : 0, tsOf(c.conversationTimestamp));
      if (typeof c.unreadCount === 'number') db.prepare('UPDATE wa_chats SET unread = ? WHERE jid = ?').run(Math.max(0, c.unreadCount), jid);
    }
  })();
}

function storeContacts(list: { id?: string; name?: string; notify?: string; verifiedName?: string }[]): void {
  db.transaction(() => {
    for (const c of list) {
      const name = c.name || c.notify || c.verifiedName;
      if (c.id && name) upContact.run(jidNormalizedUser(c.id), name);
    }
  })();
}

function linked(): boolean {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(AUTH, 'creds.json'), 'utf8')) as { registered?: boolean; me?: unknown };
    return Boolean(creds.me);
  } catch {
    return false;
  }
}

async function connect(phone?: string): Promise<void> {
  fs.mkdirSync(AUTH, { recursive: true, mode: 0o700 });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH);
  state = 'connecting';
  const s = makeWASocket({
    auth,
    logger: quiet as never,
    browser: Browsers.ubuntu('Postino'),
    markOnlineOnConnect: false, // the phone keeps getting notifications
    syncFullHistory: false,
    getMessage: async () => undefined,
  });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  let askedCode = false;
  s.ev.on('connection.update', (u) => {
    if (u.qr) {
      state = 'qr';
      void QRCode.toDataURL(u.qr, { margin: 1, width: 280 }).then((d) => (qrDataUrl = d));
      if (phone && !askedCode && !s.authState.creds.registered) {
        askedCode = true;
        s.requestPairingCode(phone).then(
          (c) => (pairingCode = c),
          (e: Error) => log.warn({ err: e.message }, 'whatsapp pairing code failed'),
        );
      }
    }
    if (u.connection === 'open') {
      state = 'open';
      qrDataUrl = null;
      pairingCode = null;
      retry = 0;
      me = s.user?.id ? jidNormalizedUser(s.user.id) : null;
      log.info('whatsapp connected');
    }
    if (u.connection === 'close') {
      if (sock === s) sock = null;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (stopping) return;
      if (code === DisconnectReason.loggedOut) {
        state = 'logged_out';
        fs.rmSync(AUTH, { recursive: true, force: true });
        log.warn('whatsapp unlinked from the phone');
        return;
      }
      // Right after the QR is scanned WhatsApp asks for a restart: always honour it,
      // even if the new credentials are still being written to disk.
      const restart = code === DisconnectReason.restartRequired;
      if (!restart && !linked() && (state === 'qr' || retry >= 4)) {
        // Never scanned (or no network before linking): stop instead of retrying forever.
        state = 'off';
        qrDataUrl = null;
        pairingCode = null;
        return;
      }
      state = 'connecting';
      const wait = restart ? 500 : Math.min(60_000, 2000 * 2 ** retry++);
      setTimeout(() => void connect().catch((e: Error) => log.warn({ err: e.message }, 'whatsapp reconnect failed')), wait);
    }
  });
  s.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
    storeContacts(contacts);
    storeChats(chats);
    storeMessages(messages);
  });
  s.ev.on('chats.upsert', storeChats);
  s.ev.on('chats.update', (list) => storeChats(list as never));
  s.ev.on('contacts.upsert', storeContacts);
  s.ev.on('contacts.update', (list) => storeContacts(list as never));
  s.ev.on('messages.upsert', ({ messages, type }) => storeMessages(messages, type === 'notify'));
}

export function startWhatsApp(): void {
  if (!linked()) return; // off until the owner links it
  void connect().catch((e: Error) => log.warn({ err: e.message }, 'whatsapp start failed'));
}

export function waStatus() {
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM wa_chats) AS chats, (SELECT COUNT(*) FROM wa_messages) AS messages').get() as { chats: number; messages: number };
  return { state, qr: state === 'qr' ? qrDataUrl : null, code: state === 'qr' ? pairingCode : null, me, ...counts };
}

// ---------------------------------------------------------------- queries (used by the Claude connector)

const nameOf = (jid: string, stored: string) => stored || (db.prepare('SELECT name FROM wa_contacts WHERE jid = ?').get(jid) as { name: string } | undefined)?.name || '+' + jid.split('@')[0];

export function waChats(query: string, limit: number) {
  const q = query.trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT c.jid, c.name, c.is_group, c.last_ts, c.unread, COALESCE(k.name, '') AS contact FROM wa_chats c LEFT JOIN wa_contacts k ON k.jid = c.jid
       WHERE c.last_ts > 0 ${q ? "AND (lower(c.name) LIKE ? OR lower(COALESCE(k.name, '')) LIKE ? OR c.jid LIKE ?)" : ''}
       ORDER BY c.last_ts DESC LIMIT ?`,
    )
    .all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []), limit) as { jid: string; name: string; is_group: number; last_ts: number; unread: number; contact: string }[];
  const last = db.prepare('SELECT text, from_me FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 1');
  return rows.map((r) => {
    const l = last.get(r.jid) as { text: string; from_me: number } | undefined;
    return {
      chat_id: r.jid,
      name: r.name || r.contact || '+' + r.jid.split('@')[0],
      group: Boolean(r.is_group),
      last: new Date(r.last_ts * 1000).toISOString(),
      unread: r.unread,
      preview: l ? `${l.from_me ? 'Me: ' : ''}${l.text.slice(0, 120)}` : '',
    };
  });
}

/** A chat by id, or by (part of) its name when exactly one matches. */
export function resolveChat(chat: string): { jid: string; name: string } | { error: string } {
  const c = chat.trim();
  if (/@(s\.whatsapp\.net|g\.us|lid)$/.test(c)) {
    const r = db.prepare('SELECT jid, name FROM wa_chats WHERE jid = ?').get(c) as { jid: string; name: string } | undefined;
    return r ? { jid: r.jid, name: nameOf(r.jid, r.name) } : { jid: c, name: nameOf(c, '') };
  }
  if (/^\+?\d{6,15}$/.test(c.replace(/[\s-]/g, ''))) {
    const jid = c.replace(/[^\d]/g, '') + '@s.whatsapp.net';
    return { jid, name: nameOf(jid, '') };
  }
  const found = waChats(c, 5);
  const exact = found.filter((f) => f.name.toLowerCase() === c.toLowerCase());
  const pick = exact.length === 1 ? exact : found;
  if (pick.length === 1) return { jid: pick[0].chat_id, name: pick[0].name };
  if (!pick.length) return { error: `No chat matches "${c}".` };
  return { error: `Several chats match "${c}": ${pick.map((p) => `${p.name} (${p.chat_id})`).join(', ')}. Use the chat_id.` };
}

export function waMessages(jid: string, limit: number, before?: number) {
  const rows = db
    .prepare(`SELECT id, from_me, sender, sender_name, ts, text FROM wa_messages WHERE chat_jid = ? ${before ? 'AND ts < ?' : ''} ORDER BY ts DESC LIMIT ?`)
    .all(...(before ? [jid, before, limit] : [jid, limit])) as { id: string; from_me: number; sender: string; sender_name: string; ts: number; text: string }[];
  db.prepare('UPDATE wa_chats SET unread = 0 WHERE jid = ?').run(jid);
  return rows.reverse().map((r) => ({
    from: r.from_me ? 'Me' : r.sender_name || nameOf(r.sender, '') ,
    at: new Date(r.ts * 1000).toISOString(),
    text: r.text,
  }));
}

export function waSearch(query: string, limit: number) {
  const q = `%${query.trim().toLowerCase()}%`;
  const rows = db
    .prepare(`SELECT m.chat_jid, m.from_me, m.sender, m.sender_name, m.ts, m.text, c.name FROM wa_messages m LEFT JOIN wa_chats c ON c.jid = m.chat_jid WHERE lower(m.text) LIKE ? ORDER BY m.ts DESC LIMIT ?`)
    .all(q, limit) as { chat_jid: string; from_me: number; sender: string; sender_name: string; ts: number; text: string; name: string | null }[];
  return rows.map((r) => ({
    chat_id: r.chat_jid,
    chat: nameOf(r.chat_jid, r.name || ''),
    from: r.from_me ? 'Me' : r.sender_name || nameOf(r.sender, ''),
    at: new Date(r.ts * 1000).toISOString(),
    text: r.text.slice(0, 500),
  }));
}

let sentAt: number[] = [];
export async function waSend(jid: string, text: string): Promise<{ ok: true }> {
  if (state !== 'open' || !sock) throw new Error('WhatsApp is not connected. Link it in Postino > Settings > WhatsApp.');
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 60_000);
  if (sentAt.length >= 5) throw new Error('Slow down: at most 5 WhatsApp messages a minute.');
  sentAt.push(now);
  const sent = await sock.sendMessage(jid, { text });
  if (sent) storeMessages([sent]);
  return { ok: true };
}

// ---------------------------------------------------------------- routes (Settings > WhatsApp)

export function registerWhatsAppRoutes(app: FastifyInstance): void {
  app.get('/api/whatsapp/status', async () => waStatus());

  app.post<{ Body: { phone?: string } }>('/api/whatsapp/link', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (state === 'open') return { ok: true };
    const phone = req.body?.phone ? String(req.body.phone).replace(/[^\d]/g, '') : undefined;
    if (phone !== undefined && (phone.length < 8 || phone.length > 15)) return reply.code(400).send({ error: 'bad_phone', message: 'Write the number with the country code, e.g. 393331234567.' });
    stopping = true;
    sock?.end(undefined);
    sock = null;
    stopping = false;
    if (!linked()) fs.rmSync(AUTH, { recursive: true, force: true });
    qrDataUrl = null;
    pairingCode = null;
    retry = 0;
    await connect(phone);
    return { ok: true };
  });

  app.post<{ Body: { forget?: boolean } }>('/api/whatsapp/unlink', async (req) => {
    stopping = true;
    try {
      if (sock && state === 'open') await sock.logout();
    } catch {
      /* already gone */
    }
    sock?.end(undefined);
    sock = null;
    stopping = false;
    state = 'off';
    me = null;
    fs.rmSync(AUTH, { recursive: true, force: true });
    if (req.body?.forget) db.exec('DELETE FROM wa_messages; DELETE FROM wa_chats; DELETE FROM wa_contacts;');
    return { ok: true };
  });
}
