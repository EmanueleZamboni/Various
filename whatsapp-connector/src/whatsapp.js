// The WhatsApp side: a linked device (like WhatsApp Web) built on Baileys.
// It keeps the store up to date and downloads media for the tools. It never sends messages.

import { EventEmitter } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion,
  isJidGroup, jidNormalizedUser, useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import { describeMessage, toSeconds } from './util.js';

const SKIP_CHATS = /@(broadcast|newsletter)$/;

export class WhatsApp extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir      where auth/ lives
   * @param {import('./store.js').Store} opts.store
   * @param {string} [opts.pairingPhone]  link with an 8-character code instead of a QR (digits, with country code)
   */
  constructor({ dataDir, store, pairingPhone, logLevel = 'warn' }) {
    super();
    this.dataDir = dataDir;
    this.authDir = join(dataDir, 'auth');
    this.store = store;
    this.pairingPhone = pairingPhone?.replace(/\D/g, '');
    this.logger = pino({ level: logLevel }, pino.destination(2)); // stderr: stdout belongs to MCP
    this.state = 'starting';
    this.lastError = undefined;
    this.me = undefined;
    this.retries = 0;
    this.stopped = false;
  }

  get connected() {
    return this.state === 'open';
  }

  async start() {
    await mkdir(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch { /* fall back to the version bundled with Baileys */ }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      browser: Browsers.macOS('Desktop'), // a "desktop" device gets the full history on first link
      syncFullHistory: true,
      markOnlineOnConnect: false, // stay "offline" so your phone keeps getting notifications
      getMessage: async key => {
        const raw = this.store.rawMessage(key.id);
        return raw ? JSON.parse(raw, BufferJSON.reviver).message : undefined;
      },
    });
    this.sock = sock;
    this.state = 'connecting';

    if (this.pairingPhone && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(this.pairingPhone);
          this.emit('pairing-code', code.match(/.{1,4}/g).join('-'));
        } catch (err) {
          this.logger.error({ err }, 'pairing code request failed');
        }
      }, 3000);
    }

    sock.ev.process(async events => {
      try {
        await this.handle(events, saveCreds);
      } catch (err) {
        this.logger.error({ err }, 'event handling failed');
      }
    });
  }

  async handle(events, saveCreds) {
    if (events['creds.update']) await saveCreds();

    const conn = events['connection.update'];
    if (conn) {
      if (conn.qr && !this.pairingPhone) {
        this.state = 'qr';
        this.emit('qr', conn.qr);
      }
      if (conn.connection === 'open') {
        this.state = 'open';
        this.retries = 0;
        this.lastError = undefined;
        this.me = { id: jidNormalizedUser(this.sock.user?.id), name: this.sock.user?.name };
        this.store.setMeta('me', JSON.stringify(this.me));
        this.emit('open', this.me);
        this.refreshGroups();
      }
      if (conn.connection === 'close') await this.onClose(conn.lastDisconnect?.error);
    }

    if (events['lid-mapping.update']) {
      const { lid, pn } = events['lid-mapping.update'];
      this.store.addLidMapping(lid, pn);
    }

    const history = events['messaging-history.set'];
    if (history) {
      this.store.tx(() => {
        for (const m of history.lidPnMappings || []) this.store.addLidMapping(m.lid, m.pn);
        for (const c of history.contacts || []) this.saveContact(c);
        for (const c of history.chats || []) {
          if (SKIP_CHATS.test(c.id)) continue;
          this.store.upsertChat({
            jid: c.id, name: c.name || undefined, isGroup: isJidGroup(c.id),
            lastTs: toSeconds(c.conversationTimestamp), unread: c.unreadCount ?? undefined, archived: c.archived ?? undefined,
          });
        }
        for (const msg of history.messages || []) this.saveMessage(msg);
      });
      this.store.setMeta('last_history_sync', Date.now());
      this.emit('history', { messages: history.messages?.length || 0, progress: history.progress, isLatest: history.isLatest });
    }
    if (events['messaging-history.status']?.status === 'complete') this.emit('history-complete');

    for (const c of [...(events['contacts.upsert'] || []), ...(events['contacts.update'] || [])]) this.saveContact(c);

    for (const c of [...(events['chats.upsert'] || []), ...(events['chats.update'] || [])]) {
      if (!c.id || SKIP_CHATS.test(c.id)) continue;
      if (c.name || c.conversationTimestamp || c.archived != null) {
        this.store.upsertChat({
          jid: c.id, name: c.name || undefined, isGroup: isJidGroup(c.id),
          lastTs: toSeconds(c.conversationTimestamp), archived: c.archived ?? undefined,
        });
      }
      if (typeof c.unreadCount === 'number') this.store.applyUnread(c.id, c.unreadCount);
    }

    for (const g of [...(events['groups.upsert'] || []), ...(events['groups.update'] || [])]) {
      if (g.id && g.subject) this.store.upsertChat({ jid: g.id, name: g.subject, isGroup: true });
    }

    const upsert = events['messages.upsert'];
    if (upsert) {
      for (const msg of upsert.messages) {
        const saved = this.saveMessage(msg);
        if (saved && upsert.type === 'notify') this.emit('message', saved);
      }
    }
  }

  async onClose(error) {
    const code = error?.output?.statusCode;
    this.lastError = error?.message;
    if (this.stopped) return;
    if (code === DisconnectReason.loggedOut) {
      this.state = 'logged_out';
      await rm(this.authDir, { recursive: true, force: true });
      this.emit('logged-out');
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      // Another copy of this connector is using the same session.
      this.state = 'replaced';
      this.emit('replaced');
      return;
    }
    this.state = 'reconnecting';
    const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2000 * 2 ** this.retries++);
    setTimeout(() => this.start().catch(err => this.onClose(err)), delay);
  }

  async refreshGroups() {
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      this.store.tx(() => {
        for (const g of Object.values(groups)) this.store.upsertChat({ jid: g.id, name: g.subject, isGroup: true });
      });
    } catch (err) {
      this.logger.warn({ err }, 'could not fetch groups');
    }
  }

  saveContact(c) {
    if (!c?.id) return;
    if (c.lid && c.phoneNumber) this.store.addLidMapping(c.lid, c.phoneNumber);
    else if (c.id.endsWith('@lid') && c.phoneNumber) this.store.addLidMapping(c.id, c.phoneNumber);
    else if (c.lid && c.id.endsWith('@s.whatsapp.net')) this.store.addLidMapping(c.lid, c.id);
    if (isJidGroup(c.id)) {
      if (c.name || c.subject) this.store.upsertChat({ jid: c.id, name: c.name || c.subject, isGroup: true });
      return;
    }
    this.store.upsertContact({ jid: c.id, name: c.name || undefined, notify: c.notify || c.verifiedName || undefined });
  }

  /** Stores one WAMessage; returns the stored fields, or undefined if it was skipped. */
  saveMessage(msg) {
    const key = msg?.key;
    const chat = key?.remoteJid;
    if (!chat || !key.id || SKIP_CHATS.test(chat)) return undefined;
    if (key.remoteJidAlt) this.store.addLidMapping(chat, key.remoteJidAlt);
    if (key.participant && key.participantAlt) this.store.addLidMapping(key.participant, key.participantAlt);

    const desc = describeMessage(msg.message);
    if (!desc) return undefined;
    if (desc.revoke) return void this.store.deleteMessage(chat, desc.revoke);
    if (desc.edit) return void this.store.editMessage(chat, desc.edit, desc.text);

    const fromMe = !!key.fromMe;
    const record = {
      chat,
      id: key.id,
      fromMe,
      sender: fromMe ? this.me?.id : (key.participant || chat),
      senderName: fromMe ? undefined : msg.pushName || undefined,
      ts: toSeconds(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      type: desc.type,
      text: desc.type === 'voice' && desc.seconds ? `${desc.seconds}s` : desc.text,
      mime: desc.mime,
      fileName: desc.fileName,
      quotedId: desc.quotedId,
      raw: desc.media
        ? JSON.stringify({ key, message: msg.message, messageTimestamp: msg.messageTimestamp }, BufferJSON.replacer)
        : undefined,
    };
    this.store.upsertMessage(record);
    return record;
  }

  requireConnection() {
    if (this.connected) return;
    const why = {
      qr: 'WhatsApp is not linked yet. Run `npm run login` and scan the QR code.',
      not_linked: 'WhatsApp is not linked yet. Run the login step on the machine where the connector runs (`npm run login`, or `docker compose run --rm whatsapp login`).',
      logged_out: 'This device was logged out from the phone. Run `npm run login` again.',
      replaced: 'Another copy of the connector took over this WhatsApp session. Close it, then restart this one.',
    }[this.state] || `WhatsApp is not connected right now (${this.state}${this.lastError ? `: ${this.lastError}` : ''}). Try again in a minute.`;
    throw new Error(why);
  }

  async download(raw) {
    this.requireConnection();
    const msg = JSON.parse(raw, BufferJSON.reviver);
    return downloadMediaMessage(msg, 'buffer', {}, { logger: this.logger, reuploadRequest: this.sock.updateMediaMessage });
  }

  async stop() {
    this.stopped = true;
    try { this.sock?.end(undefined); } catch { /* already closed */ }
  }
}
