import { ImapFlow, type FetchMessageObject, type ListResponse, type MessageStructureObject, type MailboxObject, type MessageEnvelopeObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { decrypt } from '../crypto.js';
import { bus } from '../events.js';
import { log } from '../log.js';
import type { AccountRow } from '../views.js';
import { accountView, folderView, syncProgress } from '../views.js';
import {
  upsertHeader, updateFlags, storeBody, markBodyError, storeAttachment, registerAttachmentMeta, attachmentPath,
  deleteMessagesByIds, deleteFolderMessages, refreshFolderCounts, isBlocked, folderByRole, type FolderRow, type FolderRole, type MessageRow,
} from './store.js';
import { bodyFromParsed, normalizeMsgId, parseReferences, pickUnsubscribe, splitQuoted, makeSnippet, parserOptions, defaultFilename, type ParsedHeaders, type Address } from './parse.js';
import { sanitizeEmailHtml, htmlToText, textToHtml } from './sanitize.js';

const EXTRA_HEADERS = ['references', 'list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'x-auto-response-suppress', 'feedback-id', 'x-mailgun-sid', 'x-campaign', 'x-mailchimp-id', 'x-sg-eid'];

type Listener = () => void;

const roleOrder: FolderRole[] = ['inbox', 'junk', 'blocked', 'sent', 'drafts', 'archive', 'trash', 'other'];

/** Folder role from the server's special-use flag or well-known names. */
export function detectRole(f: { path: string; name: string; specialUse?: string }): FolderRole {
  const su = (f.specialUse || '').toLowerCase();
  if (f.path.toUpperCase() === 'INBOX') return 'inbox';
  if (su === '\\sent') return 'sent';
  if (su === '\\drafts') return 'drafts';
  if (su === '\\junk') return 'junk';
  if (su === '\\trash') return 'trash';
  if (su === '\\archive' || su === '\\all') return 'archive'; // Gmail's "All Mail": moving there = archiving
  const n = f.name.toLowerCase();
  const p = f.path.toLowerCase();
  if (/^(blocked|bloccati|blocked senders)$/.test(n)) return 'blocked';
  if (/^(junk|spam|junk e-mail|bulk mail|posta indesiderata|indesiderata)$/.test(n) || /^inbox[./](spam|junk)$/.test(p)) return 'junk';
  if (/^(sent|sent items|sent messages|sent mail|posta inviata|inviati|inviata)$/.test(n)) return 'sent';
  if (/^(drafts|draft|bozze)$/.test(n)) return 'drafts';
  if (/^(trash|deleted|deleted items|deleted messages|cestino|eliminati)$/.test(n)) return 'trash';
  if (/^(archive|archives|archivio|all mail)$/.test(n)) return 'archive';
  return 'other';
}

function parseHeaderBlock(buf: Buffer | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!buf) return out;
  const text = buf.toString('utf8').replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out.set(k, out.has(k) ? `${out.get(k)} ${v}` : v);
  }
  return out;
}

function envAddr(list?: { name?: string; address?: string }[]): Address[] {
  return (list || []).filter((a) => a.address).map((a) => ({ name: a.name || '', email: (a.address || '').toLowerCase() }));
}

function headersFromEnvelope(env: MessageEnvelopeObject | undefined, extra: Map<string, string>): ParsedHeaders {
  const e = env || {};
  const date = e.date ? new Date(e.date) : null;
  return {
    messageId: normalizeMsgId(e.messageId),
    inReplyTo: normalizeMsgId(e.inReplyTo),
    references: parseReferences(extra.get('references')),
    subject: e.subject || '',
    from: envAddr(e.from)[0] || envAddr(e.sender)[0] || { name: '', email: '' },
    to: envAddr(e.to),
    cc: envAddr(e.cc),
    bcc: envAddr(e.bcc),
    replyTo: envAddr(e.replyTo),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    listUnsubscribe: pickUnsubscribe(extra.get('list-unsubscribe') || ''),
    isBulk: Boolean(extra.get('list-id') || /bulk|list|junk/i.test(extra.get('precedence') || '') || extra.get('feedback-id') || extra.get('x-mailgun-sid') || extra.get('x-campaign') || extra.get('x-mailchimp-id') || extra.get('x-sg-eid')),
    autoSubmitted: /^auto-/i.test(extra.get('auto-submitted') || '') || Boolean(extra.get('x-auto-response-suppress')),
  };
}

type PartInfo = { part: string; type: string; filename: string; size: number; contentId: string | null; disposition: string; inline: boolean; charset: string | null; encoding: string | null };

/** Flatten a BODYSTRUCTURE into leaf parts. */
export function flattenStructure(node: MessageStructureObject | undefined, acc: PartInfo[] = []): PartInfo[] {
  if (!node) return acc;
  const type = (node.type || '').toLowerCase();
  if (node.childNodes && node.childNodes.length) {
    for (const c of node.childNodes) flattenStructure(c, acc);
    return acc;
  }
  const filename = node.dispositionParameters?.filename || node.parameters?.name || '';
  const disposition = (node.disposition || '').toLowerCase();
  acc.push({
    part: node.part || '1',
    type,
    filename,
    size: node.size || 0,
    contentId: node.id ? normalizeMsgId(node.id) : null,
    disposition,
    inline: disposition === 'inline' && Boolean(node.id),
    charset: node.parameters?.charset || null,
    encoding: node.encoding || null,
  });
  return acc;
}

export function structureHasAttachments(node: MessageStructureObject | undefined): boolean {
  return flattenStructure(node).some((p) => isAttachmentPart(p));
}

function isAttachmentPart(p: PartInfo): boolean {
  if (p.disposition === 'attachment') return true;
  if (p.type.startsWith('text/') && !p.filename) return false;
  if (p.type.startsWith('multipart/')) return false;
  if (p.inline) return false; // inline image referenced by cid
  return true;
}

export class AccountSync {
  readonly id: number;
  private account: AccountRow;
  private client: ImapFlow | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private backoffMs = 2000;
  private pendingOps = 0;
  private bodyLoopRunning = false;
  private bodyLoopWanted = false;
  private inboxSyncTimer: NodeJS.Timeout | null = null;
  private folderSyncQueued = new Set<string>();
  private syncingAll = false;
  private connectPromise: Promise<void> | null = null;
  private lastFullReconcile = new Map<number, number>();

  constructor(account: AccountRow) {
    this.id = account.id;
    this.account = account;
  }

  get email(): string {
    return this.account.email;
  }

  refreshAccount(): void {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(this.id) as AccountRow | undefined;
    if (a) this.account = a;
  }

  // ---- lifecycle -------------------------------------------------------

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.inboxSyncTimer) clearTimeout(this.inboxSyncTimer);
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        await c.logout();
      } catch {
        c.close();
      }
    }
  }

  private setStatus(status: string, error: string | null = null): void {
    db.prepare('UPDATE accounts SET status = ?, last_error = ? WHERE id = ?').run(status, error, this.id);
    this.refreshAccount();
    bus.publish({ type: 'account.updated', account: accountView(this.account) });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.client) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      this.refreshAccount();
      if (!this.account.enabled) return;
      const client = new ImapFlow({
        host: this.account.imap_host,
        port: this.account.imap_port,
        secure: Boolean(this.account.imap_secure),
        auth: { user: this.account.username, pass: decrypt(this.account.password_enc) },
        logger: false,
        clientInfo: { name: 'Postino', version: '0.1' },
        socketTimeout: 5 * 60_000,
        tls: { rejectUnauthorized: process.env.POSTINO_TLS_INSECURE !== '1' },
      } as ConstructorParameters<typeof ImapFlow>[0]);
      client.on('error', (err) => {
        log.warn({ account: this.email, err: err.message }, 'imap error');
      });
      client.on('close', () => {
        if (this.client === client) this.client = null;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (!this.stopped) {
          this.setStatus('error', 'Connection closed, reconnecting…');
          this.scheduleReconnect();
        }
      });
      client.on('exists', (ev) => this.onExists(ev.path));
      client.on('expunge', (ev) => this.queueFolderSync(ev.path));
      client.on('flags', (ev) => this.onFlags(ev.path, ev.uid, ev.flags));
      try {
        this.setStatus('syncing');
        await client.connect();
        this.client = client;
        this.backoffMs = 2000;
        log.info({ account: this.email }, 'imap connected');
        await this.listFolders();
        await this.syncAll();
        this.setStatus('connected');
        this.pollTimer = setInterval(() => void this.poll(), config.inboxPollMs);
        await this.ensureInboxSelected();
        this.kickBodyLoop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ account: this.email, err: msg }, 'imap connect failed');
        this.setStatus('error', friendlyError(msg));
        try {
          client.close();
        } catch {
          // ignore
        }
        if (this.client === client) this.client = null;
        this.scheduleReconnect();
      }
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  private async requireClient(): Promise<ImapFlow> {
    if (!this.client) {
      await this.connect();
      if (!this.client) throw new Error(`Not connected to ${this.email}`);
    }
    return this.client;
  }

  /** Run `fn` with a mailbox selected and locked; re-select INBOX afterwards so IDLE resumes there. */
  private async withMailbox<T>(path: string, fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>): Promise<T> {
    const client = await this.requireClient();
    this.pendingOps++;
    const lock = await client.getMailboxLock(path);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw new Error(`Mailbox ${path} did not open`);
      return await fn(client, mailbox);
    } finally {
      lock.release();
      this.pendingOps--;
      if (this.pendingOps === 0) void this.ensureInboxSelected();
    }
  }

  private async ensureInboxSelected(): Promise<void> {
    const client = this.client;
    if (!client || this.pendingOps > 0) return;
    const inbox = folderByRole(this.id, 'inbox');
    if (!inbox) return;
    try {
      if (client.mailbox && client.mailbox.path === inbox.path) return;
      const lock = await client.getMailboxLock(inbox.path);
      lock.release();
    } catch (err) {
      log.debug({ account: this.email, err: (err as Error).message }, 'ensureInboxSelected');
    }
  }

  // ---- folders ---------------------------------------------------------

  async listFolders(): Promise<FolderRow[]> {
    const client = await this.requireClient();
    const list = await client.list();
    const seen = new Set<string>();
    const upsert = db.prepare(
      `INSERT INTO folders(account_id, path, name, delimiter, role, present) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter, role = excluded.role, present = 1`,
    );
    // The user can pin a folder to a role (e.g. use "INBOX.Archivio" as Archive).
    let overrides: Record<string, string> = {};
    try {
      overrides = JSON.parse(this.account.folder_overrides || '{}') as Record<string, string>;
    } catch {
      overrides = {};
    }
    const byPath = new Map<string, FolderRole>();
    for (const [role, pth] of Object.entries(overrides)) if (pth) byPath.set(pth, role as FolderRole);
    const tx = db.transaction((rows: ListResponse[]) => {
      for (const f of rows) {
        if (f.flags.has('\\Noselect') || f.flags.has('\\NonExistent')) continue;
        // Gmail's "Starred" and "Important" are views over mail that already lives in the
        // inbox / All Mail: syncing them would only download every message a second time.
        const su = (f.specialUse || '').toLowerCase();
        if (su === '\\flagged' || su === '\\important') continue;
        seen.add(f.path);
        let role = detectRole(f);
        const forced = byPath.get(f.path);
        if (forced) role = forced;
        else if ([...byPath.values()].includes(role) && role !== 'inbox') role = 'other'; // another folder holds this role now
        upsert.run(this.id, f.path, f.name, f.delimiter || '.', role);
      }
      const present = db.prepare('SELECT id, path FROM folders WHERE account_id = ?').all(this.id) as { id: number; path: string }[];
      for (const p of present) {
        if (!seen.has(p.path)) {
          deleteFolderMessages(p.id);
          db.prepare('UPDATE folders SET present = 0 WHERE id = ?').run(p.id);
        }
      }
    });
    tx(list);
    return this.folders();
  }

  folders(): FolderRow[] {
    const rows = db.prepare('SELECT * FROM folders WHERE account_id = ? AND present = 1').all(this.id) as FolderRow[];
    return rows.sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || a.path.localeCompare(b.path));
  }

  /** Prefix new folders need on this server ("" on most, "INBOX." on cPanel-style setups). */
  private namespacePrefix(client: ImapFlow): string {
    const ns = client.namespace as { prefix?: string; delimiter?: string | null } | undefined;
    if (ns?.prefix) return ns.delimiter && !ns.prefix.endsWith(ns.delimiter) ? ns.prefix + ns.delimiter : ns.prefix;
    // No NAMESPACE info: infer it when every folder but INBOX lives under INBOX.
    const rows = db.prepare("SELECT path, delimiter FROM folders WHERE account_id = ? AND present = 1 AND upper(path) <> 'INBOX'").all(this.id) as { path: string; delimiter: string }[];
    if (rows.length && rows.every((r) => r.path.toUpperCase().startsWith('INBOX' + (r.delimiter || '.')))) return 'INBOX' + (rows[0].delimiter || '.');
    return '';
  }

  /** Find a folder with the role, creating a standard one on the server when missing. */
  async ensureFolder(role: FolderRole): Promise<FolderRow> {
    const existing = folderByRole(this.id, role);
    if (existing) return existing;
    const names: Partial<Record<FolderRole, string>> = { archive: 'Archive', blocked: 'Blocked', junk: 'Junk', trash: 'Trash', sent: 'Sent', drafts: 'Drafts' };
    const base = names[role];
    if (!base) throw new Error(`No default folder for role ${role}`);
    const client = await this.requireClient();
    // Many hosting providers keep every folder under "INBOX." (the personal namespace
    // prefix); a root-level folder would be refused or hidden there.
    const name = this.namespacePrefix(client) + base;
    try {
      await client.mailboxCreate(name);
    } catch (err) {
      log.warn({ account: this.email, err: (err as Error).message }, 'mailboxCreate');
    }
    try {
      await client.mailboxSubscribe(name);
    } catch {
      // some servers reject SUBSCRIBE; harmless
    }
    await this.listFolders();
    const created = folderByRole(this.id, role) || (db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(this.id, name) as FolderRow | undefined);
    if (!created) throw new Error(`Could not create the ${name} folder`);
    if (created.role !== role) db.prepare('UPDATE folders SET role = ? WHERE id = ?').run(role, created.id);
    return { ...created, role };
  }

  // ---- sync ------------------------------------------------------------

  private async syncAll(): Promise<void> {
    if (this.syncingAll) return;
    this.syncingAll = true;
    try {
      for (const f of this.folders()) {
        if (this.stopped) return;
        await this.syncFolder(f.id, { reconcile: true });
      }
      if (!this.account.initial_sync_done) {
        const total = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(this.id) as { n: number }).n;
        const fetched = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND body_fetched = 1').get(this.id) as { n: number }).n;
        syncProgress.set(this.id, { fetched, total, done: false });
        bus.publish({ type: 'sync.progress', accountId: String(this.id), fetched, total, done: false });
      }
    } finally {
      this.syncingAll = false;
    }
  }

  private async poll(): Promise<void> {
    if (!this.client || this.stopped) return;
    log.debug({ account: this.email, idling: this.client.idling, mailbox: this.client.mailbox ? this.client.mailbox.path : null }, 'poll');
    const now = Date.now();
    for (const f of this.folders()) {
      const last = this.lastFullReconcile.get(f.id) || 0;
      const interval = f.role === 'inbox' ? config.inboxPollMs : config.folderPollMs;
      if (now - last >= interval - 1000) {
        try {
          await this.syncFolder(f.id, { reconcile: true });
        } catch (err) {
          log.warn({ account: this.email, folder: f.path, err: (err as Error).message }, 'poll sync failed');
        }
      }
    }
    this.kickBodyLoop();
  }

  private onExists(path: string): void {
    log.debug({ account: this.email, path }, 'exists event');
    this.queueFolderSync(path);
  }

  private onFlags(path: string, uid: number | undefined, flags: Set<string>): void {
    if (!uid) {
      this.queueFolderSync(path);
      return;
    }
    const folder = db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(this.id, path) as FolderRow | undefined;
    if (!folder) return;
    const r = updateFlags(folder.id, uid, flags);
    if (r.changed) {
      refreshFolderCounts(folder.id);
      this.emitFolder(folder.id);
      if (r.threadId) bus.publish({ type: 'thread.updated', threadId: String(r.threadId), accountId: String(this.id) });
    }
  }

  queueFolderSync(path: string): void {
    this.folderSyncQueued.add(path);
    if (this.inboxSyncTimer) return;
    this.inboxSyncTimer = setTimeout(() => {
      this.inboxSyncTimer = null;
      const paths = [...this.folderSyncQueued];
      this.folderSyncQueued.clear();
      void (async () => {
        for (const p of paths) {
          const f = db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(this.id, p) as FolderRow | undefined;
          if (!f) continue;
          try {
            await this.syncFolder(f.id, { reconcile: true });
          } catch (err) {
            log.warn({ account: this.email, folder: p, err: (err as Error).message }, 'folder sync failed');
          }
        }
        this.kickBodyLoop();
      })();
    }, 400);
  }

  async syncFolderByRole(role: FolderRole): Promise<void> {
    const f = folderByRole(this.id, role);
    if (f) await this.syncFolder(f.id, { reconcile: true });
  }

  /** Pull new messages for a folder and reconcile flags and deletions with the server. */
  async syncFolder(folderId: number, opts: { reconcile: boolean }): Promise<void> {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
    if (!folder || !folder.present) return;
    const changedThreads = new Set<number>();
    const newInbox: { id: number; threadId: number; from: Address; subject: string; category: string; uid: number; blocked: boolean }[] = [];

    await this.withMailbox(folder.path, async (client, mailbox) => {
      const uidValidity = Number(mailbox.uidValidity);
      let uidNextLocal = folder.uidnext;
      if (folder.uidvalidity !== null && folder.uidvalidity !== uidValidity) {
        log.info({ account: this.email, folder: folder.path }, 'uidvalidity changed, resetting folder');
        deleteFolderMessages(folder.id);
        uidNextLocal = 1;
      }
      // `mailbox.uidNext` is only refreshed on SELECT, so after an EXISTS notification it is
      // stale. Always ask for `${uidNextLocal}:*`: when nothing is new the server answers with
      // at most the highest existing message, which the uid check below skips.
      log.debug({ account: this.email, folder: folder.path, exists: mailbox.exists, uidNextLocal }, 'syncFolder');
      // 1. New messages
      if (mailbox.exists > 0) {
        let maxUid = uidNextLocal - 1;
        const range = `${uidNextLocal}:*`;
        for await (const msg of client.fetch(range, { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: EXTRA_HEADERS }, { uid: true })) {
          if (msg.uid < uidNextLocal) continue;
          maxUid = Math.max(maxUid, msg.uid);
          const r = this.ingestHeader(folder, msg);
          if (r) {
            changedThreads.add(r.threadId);
            if (r.isNew && folder.role === 'inbox') newInbox.push({ ...r, uid: msg.uid });
          }
        }
        uidNextLocal = Math.max(uidNextLocal, maxUid + 1);
      }
      // 2. Reconcile flags + deletions
      if (opts.reconcile) {
        const serverFlags = new Map<number, Set<string>>();
        if (mailbox.exists > 0) {
          for await (const msg of client.fetch('1:*', { uid: true, flags: true }, { uid: true })) serverFlags.set(msg.uid, msg.flags || new Set());
        }
        const local = db.prepare('SELECT id, uid, thread_id FROM messages WHERE folder_id = ?').all(folder.id) as { id: number; uid: number; thread_id: number }[];
        const gone: number[] = [];
        for (const m of local) {
          const flags = serverFlags.get(m.uid);
          if (!flags) {
            gone.push(m.id);
            changedThreads.add(m.thread_id);
            continue;
          }
          const r = updateFlags(folder.id, m.uid, flags);
          if (r.changed && r.threadId) changedThreads.add(r.threadId);
        }
        if (gone.length) deleteMessagesByIds(gone);
        this.lastFullReconcile.set(folder.id, Date.now());
      }
      db.prepare('UPDATE folders SET uidvalidity = ?, uidnext = ?, highestmodseq = ? WHERE id = ?').run(
        uidValidity,
        uidNextLocal,
        mailbox.highestModseq ? Number(mailbox.highestModseq) : null,
        folder.id,
      );
      // 3. Blocked senders arriving in the inbox go straight to the Blocked folder.
      const blocked = newInbox.filter((m) => m.blocked);
      if (blocked.length) {
        try {
          const dest = await this.ensureFolder('blocked');
          await client.messageFlagsAdd(blocked.map((m) => m.uid), ['\\Seen'], { uid: true });
          const res = await client.messageMove(blocked.map((m) => m.uid), dest.path, { uid: true });
          this.applyMoveResult(folder, dest, blocked.map((m) => m.uid), res && res.uidMap ? res.uidMap : null);
          log.info({ account: this.email, n: blocked.length }, 'moved blocked senders');
        } catch (err) {
          log.warn({ account: this.email, err: (err as Error).message }, 'blocked move failed');
        }
      }
    });

    refreshFolderCounts(folder.id);
    this.emitFolder(folder.id);
    for (const t of changedThreads) bus.publish({ type: 'thread.updated', threadId: String(t), accountId: String(this.id) });
    if (this.account.initial_sync_done) {
      for (const m of newInbox) {
        if (m.blocked) continue;
        bus.publish({ type: 'new.mail', threadId: String(m.threadId), accountId: String(this.id), from: m.from, subject: m.subject, category: m.category });
      }
    }
    if (newInbox.length) this.kickBodyLoop();
  }

  private ingestHeader(folder: FolderRow, msg: FetchMessageObject): { id: number; isNew: boolean; threadId: number; from: Address; subject: string; category: string; blocked: boolean } | null {
    try {
      const extra = parseHeaderBlock(msg.headers);
      const headers = headersFromEnvelope(msg.envelope, extra);
      const flags = msg.flags || new Set<string>();
      const r = upsertHeader({
        accountId: this.id,
        folder,
        uid: msg.uid,
        headers,
        flags,
        internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
        size: msg.size || 0,
        hasAttachments: structureHasAttachments(msg.bodyStructure),
        structureJson: msg.bodyStructure ? JSON.stringify(msg.bodyStructure) : null,
      });
      const row = db.prepare('SELECT category FROM messages WHERE id = ?').get(r.id) as { category: string } | undefined;
      const blocked = r.isNew && folder.role === 'inbox' && isBlocked(headers.from.email);
      return { id: r.id, isNew: r.isNew, threadId: r.threadId, from: headers.from, subject: headers.subject, category: row?.category || 'person', blocked };
    } catch (err) {
      log.warn({ account: this.email, uid: msg.uid, err: (err as Error).message }, 'ingest header failed');
      return null;
    }
  }

  private emitFolder(folderId: number): void {
    const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
    if (f) bus.publish({ type: 'folder.updated', folder: folderView(f) });
    this.refreshAccount();
    bus.publish({ type: 'account.updated', account: accountView(this.account) });
  }

  // ---- bodies ----------------------------------------------------------

  kickBodyLoop(): void {
    this.bodyLoopWanted = true;
    if (this.bodyLoopRunning) return;
    void this.bodyLoop();
  }

  /** Download bodies for messages that only have headers, newest and inbox first. */
  private async bodyLoop(): Promise<void> {
    this.bodyLoopRunning = true;
    try {
      while (this.bodyLoopWanted && !this.stopped && this.client) {
        this.bodyLoopWanted = false;
        // Each pass takes one batch from the highest-priority folder; loop until nothing is left.
        for (;;) {
          if (this.stopped || !this.client) break;
          const batch = db
            .prepare(
              `SELECT m.id, m.uid, m.folder_id, m.size, m.thread_id, m.structure_json FROM messages m JOIN folders f ON f.id = m.folder_id
               WHERE m.account_id = ? AND m.body_fetched = 0 AND m.body_error IS NULL AND f.present = 1
               ORDER BY CASE f.role WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'archive' THEN 2 WHEN 'drafts' THEN 3 WHEN 'other' THEN 4 WHEN 'junk' THEN 5 WHEN 'blocked' THEN 6 ELSE 7 END, m.date DESC
               LIMIT 12`,
            )
            .all(this.id) as { id: number; uid: number; folder_id: number; size: number; thread_id: number; structure_json: string | null }[];
          if (!batch.length) break;
          const folderId = batch[0].folder_id;
          const group = batch.filter((b) => b.folder_id === folderId);
          const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow;
          try {
            await this.fetchBodies(folder, group);
          } catch (err) {
            log.warn({ account: this.email, folder: folder.path, err: (err as Error).message }, 'body fetch batch failed');
            // Mark the batch so a persistent failure does not loop forever; they are retried on resync.
            for (const b of group) markBodyError(b.id, (err as Error).message);
          }
          for (const b of group) bus.publish({ type: 'message.updated', messageId: String(b.id), threadId: String(b.thread_id) });
          this.publishProgress();
        }
        if (!this.account.initial_sync_done) {
          db.prepare('UPDATE accounts SET initial_sync_done = 1 WHERE id = ?').run(this.id);
          this.refreshAccount();
          syncProgress.delete(this.id);
          bus.publish({ type: 'sync.progress', accountId: String(this.id), fetched: 0, total: 0, done: true });
          bus.publish({ type: 'account.updated', account: accountView(this.account) });
        }
      }
    } finally {
      this.bodyLoopRunning = false;
    }
  }

  private publishProgress(): void {
    if (this.account.initial_sync_done) return;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(this.id) as { n: number }).n;
    const fetched = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND body_fetched = 1').get(this.id) as { n: number }).n;
    syncProgress.set(this.id, { fetched, total, done: false });
    bus.publish({ type: 'sync.progress', accountId: String(this.id), fetched, total, done: false });
  }

  private async fetchBodies(folder: FolderRow, group: { id: number; uid: number; size: number; structure_json: string | null }[]): Promise<void> {
    const small = group.filter((g) => g.size <= config.maxSourceFetchBytes);
    const large = group.filter((g) => g.size > config.maxSourceFetchBytes);
    await this.withMailbox(folder.path, async (client) => {
      if (small.length) {
        const byUid = new Map(small.map((s) => [s.uid, s]));
        const found = new Set<number>();
        for await (const msg of client.fetch(small.map((s) => s.uid), { uid: true, source: true }, { uid: true })) {
          const target = byUid.get(msg.uid);
          if (!target) continue;
          found.add(msg.uid);
          if (!msg.source) {
            markBodyError(target.id, 'no source');
            continue;
          }
          try {
            await this.storeFromSource(target.id, msg.source);
          } catch (err) {
            markBodyError(target.id, (err as Error).message);
          }
        }
        for (const s of small) if (!found.has(s.uid)) markBodyError(s.id, 'not on server');
      }
      for (const l of large) {
        try {
          await this.storeFromParts(client, l.id, l.uid, l.structure_json);
        } catch (err) {
          markBodyError(l.id, (err as Error).message);
        }
      }
    });
  }

  private async storeFromSource(messageRow: number, source: Buffer): Promise<void> {
    const mail = await simpleParser(source, parserOptions);
    // Attachments are stored first so cid: images can point at their ids.
    const pending = (mail.attachments || []).map((a) => ({
      filename: a.filename || `attachment.${(a.contentType || 'bin').split('/')[1] || 'bin'}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || a.content?.length || 0,
      contentId: a.contentId ? normalizeMsgId(a.contentId) : null,
      inline: a.contentDisposition === 'inline' && Boolean(a.contentId),
      content: a.content as Buffer,
    }));
    db.prepare('DELETE FROM attachments WHERE message_row = ?').run(messageRow);
    const ids = new Map<string, string>();
    for (const a of pending) {
      const id = storeAttachment(messageRow, a);
      if (a.contentId) ids.set(a.contentId, `/api/attachments/${id}?inline=1`);
    }
    const body = bodyFromParsed(mail, (cid) => ids.get(cid));
    storeBody(messageRow, body);
  }

  private async storeFromParts(client: ImapFlow, messageRow: number, uid: number, structureJson: string | null): Promise<void> {
    const structure = structureJson ? (JSON.parse(structureJson) as MessageStructureObject) : undefined;
    const parts = flattenStructure(structure);
    const textParts = parts.filter((p) => p.type === 'text/plain' && !p.filename);
    const htmlParts = parts.filter((p) => p.type === 'text/html' && !p.filename);
    const want = [...textParts, ...htmlParts].map((p) => p.part);
    db.prepare('DELETE FROM attachments WHERE message_row = ?').run(messageRow);
    const ids = new Map<string, string>();
    for (const p of parts) {
      if (!isAttachmentPart(p) && !p.inline) continue;
      const id = registerAttachmentMeta(messageRow, { part: p.part, filename: p.filename || `attachment.${p.type.split('/')[1] || 'bin'}`, contentType: p.type, size: p.size, contentId: p.contentId, inline: p.inline });
      if (p.contentId) ids.set(p.contentId, `/api/attachments/${id}?inline=1`);
    }
    let text: string | null = null;
    let html: string | null = null;
    if (want.length) {
      const res = await client.downloadMany(String(uid), want, { uid: true, maxBytes: 4_000_000 });
      const first = (list: PartInfo[]): string | null => {
        for (const p of list) {
          const r = res[p.part];
          if (r && r.content) return r.content.toString('utf8');
        }
        return null;
      };
      text = first(textParts);
      html = first(htmlParts);
    }
    if (!text && html) text = htmlToText(html);
    let outHtml: string | null = null;
    let hasRemote = false;
    if (html) {
      const s = sanitizeEmailHtml(html, ids);
      outHtml = s.html;
      hasRemote = s.hasRemoteImages;
    }
    const split = text ? splitQuoted(text) : { visible: '', quoted: null };
    if (!html && text) outHtml = textToHtml(split.quoted ? split.visible : text);
    storeBody(messageRow, {
      text,
      html: outHtml,
      quoted: split.quoted,
      hasRemoteImages: hasRemote,
      snippet: makeSnippet(split.visible),
      attachments: parts.filter((p) => isAttachmentPart(p)).map((p) => ({ filename: p.filename, contentType: p.type, size: p.size, contentId: p.contentId, inline: p.inline, content: Buffer.alloc(0) })),
    });
  }

  /** Download one attachment part from the server into the cache. */
  async cacheAttachment(attachmentId: number): Promise<string> {
    const a = db
      .prepare('SELECT a.id, a.part, a.cached, m.uid, m.folder_id FROM attachments a JOIN messages m ON m.id = a.message_row WHERE a.id = ?')
      .get(attachmentId) as { id: number; part: string; cached: number; uid: number; folder_id: number } | undefined;
    if (!a) throw new Error('Attachment not found');
    const file = attachmentPath(a.id);
    if (a.cached && fs.existsSync(file)) return file;
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(a.folder_id) as FolderRow;
    if (!a.part) {
      // Attachments parsed from the whole message have no IMAP part number: download the
      // message again and restore every attachment of it from the parsed result.
      await this.withMailbox(folder.path, async (client) => {
        const msg = await client.fetchOne(String(a.uid), { uid: true, source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error('Message not found on the server');
        const mail = await simpleParser(msg.source, parserOptions);
        const rows = db.prepare('SELECT id, filename, content_id, size FROM attachments WHERE message_row = (SELECT message_row FROM attachments WHERE id = ?) ORDER BY id').all(a.id) as { id: number; filename: string; content_id: string | null; size: number }[];
        // Same naming as bodyFromParsed so rows stored at sync time match the re-parsed parts.
        const parsed = (mail.attachments || []).map((x) => ({ filename: x.filename || defaultFilename(x.contentType), contentId: x.contentId ? normalizeMsgId(x.contentId) : null, size: x.size || x.content?.length || 0, content: x.content as Buffer }));
        const used = new Set<number>();
        rows.forEach((row, i) => {
          const pick = (pred: (x: (typeof parsed)[number], idx: number) => boolean) => {
            const idx = parsed.findIndex((x, j) => !used.has(j) && pred(x, j));
            return idx;
          };
          let idx = pick((x) => Boolean(row.content_id) && x.contentId === row.content_id);
          if (idx < 0) idx = pick((x) => x.filename === row.filename && x.size === row.size);
          if (idx < 0) idx = pick((x) => x.filename === row.filename);
          if (idx < 0 && rows.length === parsed.length) idx = pick((_x, j) => j === i); // same order as when first stored
          const match = idx >= 0 ? parsed[idx] : null;
          if (match) used.add(idx);
          if (match) {
            fs.writeFileSync(attachmentPath(row.id), match.content);
            db.prepare('UPDATE attachments SET cached = 1 WHERE id = ?').run(row.id);
          }
        });
      });
      if (!fs.existsSync(file)) throw new Error('Attachment not found in the message');
      return file;
    }
    await this.withMailbox(folder.path, async (client) => {
      const dl = await client.download(String(a.uid), a.part, { uid: true });
      if (!dl.content) throw new Error('Attachment not found on the server');
      await pipeline(dl.content, fs.createWriteStream(file));
    });
    db.prepare('UPDATE attachments SET cached = 1 WHERE id = ?').run(a.id);
    return file;
  }

  // ---- actions ---------------------------------------------------------

  private applyMoveResult(src: FolderRow, dest: FolderRow, uids: number[], uidMap: Map<number, number> | null): void {
    const tx = db.transaction(() => {
      for (const uid of uids) {
        const row = db.prepare('SELECT id, thread_id FROM messages WHERE folder_id = ? AND uid = ?').get(src.id, uid) as { id: number; thread_id: number } | undefined;
        if (!row) continue;
        const newUid = uidMap?.get(uid);
        if (newUid && !db.prepare('SELECT 1 FROM messages WHERE folder_id = ? AND uid = ?').get(dest.id, newUid)) {
          db.prepare('UPDATE messages SET folder_id = ?, uid = ? WHERE id = ?').run(dest.id, newUid, row.id);
        } else {
          deleteMessagesByIds([row.id]);
        }
      }
    });
    tx();
    refreshFolderCounts(src.id);
    refreshFolderCounts(dest.id);
    this.emitFolder(src.id);
    this.emitFolder(dest.id);
    if (!uidMap) this.queueFolderSync(dest.path);
  }

  async moveMessages(srcFolderId: number, uids: number[], destRole: FolderRole | null, destFolderId: number | null): Promise<void> {
    if (!uids.length) return;
    const src = db.prepare('SELECT * FROM folders WHERE id = ?').get(srcFolderId) as FolderRow;
    const dest = destFolderId ? (db.prepare('SELECT * FROM folders WHERE id = ?').get(destFolderId) as FolderRow) : await this.ensureFolder(destRole as FolderRole);
    if (!dest) throw new Error('Destination folder not found');
    if (dest.id === src.id) return;
    await this.withMailbox(src.path, async (client) => {
      const res = await client.messageMove(uids, dest.path, { uid: true });
      if (!res) throw new Error('Move failed');
      this.applyMoveResult(src, dest, uids, res.uidMap || null);
    });
  }

  async setFlags(folderId: number, uids: number[], add: string[], remove: string[]): Promise<void> {
    if (!uids.length) return;
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow;
    await this.withMailbox(folder.path, async (client) => {
      if (add.length) await client.messageFlagsAdd(uids, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true });
    });
  }

  async deleteMessages(folderId: number, uids: number[]): Promise<void> {
    if (!uids.length) return;
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow;
    await this.withMailbox(folder.path, async (client) => {
      await client.messageDelete(uids, { uid: true });
    });
    const ids = (db.prepare(`SELECT id FROM messages WHERE folder_id = ? AND uid IN (${uids.map(() => '?').join(',')})`).all(folderId, ...uids) as { id: number }[]).map((r) => r.id);
    deleteMessagesByIds(ids);
    refreshFolderCounts(folderId);
    this.emitFolder(folderId);
  }

  async appendMessage(role: FolderRole, raw: Buffer, flags: string[]): Promise<void> {
    const folder = await this.ensureFolder(role);
    const client = await this.requireClient();
    this.pendingOps++;
    try {
      await client.append(folder.path, raw, flags, new Date());
    } finally {
      this.pendingOps--;
    }
    await this.syncFolder(folder.id, { reconcile: false });
    this.kickBodyLoop();
  }

  async markAnswered(messageRow: number): Promise<void> {
    const m = db.prepare('SELECT uid, folder_id FROM messages WHERE id = ?').get(messageRow) as { uid: number; folder_id: number } | undefined;
    if (!m) return;
    db.prepare('UPDATE messages SET answered = 1 WHERE id = ?').run(messageRow);
    await this.setFlags(m.folder_id, [m.uid], ['\\Answered'], []);
  }

  /** Re-download everything for this account. */
  async resync(): Promise<void> {
    const tx = db.transaction(() => {
      for (const f of this.folders()) deleteFolderMessages(f.id);
      db.prepare('UPDATE folders SET uidvalidity = NULL, uidnext = 1, highestmodseq = NULL, total = 0, unseen = 0 WHERE account_id = ?').run(this.id);
      db.prepare('UPDATE accounts SET initial_sync_done = 0 WHERE id = ?').run(this.id);
    });
    tx();
    this.refreshAccount();
    await this.listFolders();
    await this.syncAll();
    this.kickBodyLoop();
  }

  onChange(_l: Listener): void {
    // reserved for future per-account listeners
  }
}

export function friendlyError(msg: string): string {
  if (/auth|login|credentials|password|command failed|invalid credentials/i.test(msg)) return 'Login refused: check the user name and password.';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'Server not found: check the IMAP host name.';
  if (/ECONNREFUSED/i.test(msg)) return 'Connection refused: check the port and whether SSL is on.';
  if (/certificate|self signed|CERT_/i.test(msg)) return 'Certificate problem: the server\'s SSL certificate is not trusted.';
  if (/timeout/i.test(msg)) return 'Connection timed out.';
  return msg;
}

export { nowIso };
export type { MessageRow };
