import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import { applyPendingFor } from '../backup.js';
import { db } from '../db.js';
import { encrypt } from '../crypto.js';
import { manager } from '../mail/manager.js';
import { guessPreset } from '../mail/presets.js';
import { verifySmtp } from '../mail/send.js';
import { accountView, folderView, type AccountRow } from '../views.js';
import type { FolderRow } from '../mail/store.js';
import { bus } from '../events.js';
import { friendlyError } from '../mail/sync.js';

const palette = ['#2B3D90', '#3F6FB0', '#56657E', '#B4593C', '#A3821C', '#8C6A4A', '#2F7F78', '#5E7F45', '#3E8A6E', '#8A4F7D', '#5A4FA0', '#9A5A6B'];

type ServerIn = { host?: string; port?: number | string; secure?: boolean | string };
type AccountIn = { email?: string; name?: string; password?: string; username?: string; color?: string; signature?: string; order?: number; imap?: ServerIn; smtp?: ServerIn; aliases?: string[]; folders?: Record<string, string>; notify?: string };

function server(s: ServerIn | undefined, defPort: number): { host: string; port: number; secure: boolean } | null {
  if (!s || !s.host) return null;
  const host = String(s.host).trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host) && !/^[\d.]+$/.test(host)) {
    throw Object.assign(new Error('That server name does not look right.'), { statusCode: 400, code: 'invalid_host' });
  }
  const port = s.port === undefined || s.port === '' ? defPort : Number(s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('The port must be a number between 1 and 65535.'), { statusCode: 400, code: 'invalid_port' });
  const secure = s.secure === undefined ? port === 993 || port === 465 : s.secure === true || s.secure === 'true';
  return { host, port, secure };
}

async function testImap(opts: { host: string; port: number; secure: boolean; user: string; pass: string }): Promise<void> {
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
    logger: false,
    verifyOnly: true,
    connectionTimeout: 15_000, // a wrong host must fail in seconds, not hang the "Test connection" button
    doSTARTTLS: !opts.secure && process.env.POSTINO_TLS_INSECURE !== '1',
    tls: { rejectUnauthorized: process.env.POSTINO_TLS_INSECURE !== '1' },
  });
  await client.connect();
}

export function registerAccountRoutes(app: FastifyInstance): void {
  app.get('/api/accounts', async () => {
    const rows = db.prepare('SELECT * FROM accounts ORDER BY sort_order, id').all() as AccountRow[];
    return rows.map(accountView);
  });

  app.get<{ Querystring: { email?: string } }>('/api/presets', async (req) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email.includes('@')) return null;
    return guessPreset(email);
  });

  const validate = (body: AccountIn, requirePassword: boolean) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { statusCode: 400, code: 'invalid_email' });
    const imap = server(body.imap, 993);
    const smtp = server(body.smtp, 465);
    if (!imap) throw Object.assign(new Error('IMAP host is missing.'), { statusCode: 400, code: 'invalid_imap' });
    if (!smtp) throw Object.assign(new Error('SMTP host is missing.'), { statusCode: 400, code: 'invalid_smtp' });
    const password = String(body.password || '');
    if (requirePassword && !password) throw Object.assign(new Error('Password is missing.'), { statusCode: 400, code: 'invalid_password' });
    return { email, imap, smtp, password, username: String(body.username || email).trim() || email, name: String(body.name || email.split('@')[0]).trim() };
  };

  app.post<{ Body: AccountIn }>('/api/accounts/test', async (req, reply) => {
    const v = validate(req.body || {}, true);
    try {
      await testImap({ ...v.imap, user: v.username, pass: v.password });
    } catch (err) {
      return reply.code(400).send({ error: 'imap_login_failed', message: `Incoming mail (IMAP): ${friendlyError((err as Error).message)}` });
    }
    try {
      await verifySmtp({ smtp_host: v.smtp.host, smtp_port: v.smtp.port, smtp_secure: v.smtp.secure ? 1 : 0, username: v.username, password_enc: encrypt(v.password) } as AccountRow);
    } catch (err) {
      return reply.code(400).send({ error: 'smtp_login_failed', message: `Outgoing mail (SMTP): ${friendlyError((err as Error).message)}` });
    }
    return { ok: true };
  });

  app.post<{ Body: AccountIn }>('/api/accounts', async (req, reply) => {
    const v = validate(req.body || {}, true);
    if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(v.email)) return reply.code(409).send({ error: 'exists', message: 'This address is already added.' });
    try {
      await testImap({ ...v.imap, user: v.username, pass: v.password });
    } catch (err) {
      return reply.code(400).send({ error: 'imap_login_failed', message: `Incoming mail (IMAP): ${friendlyError((err as Error).message)}` });
    }
    try {
      await verifySmtp({ smtp_host: v.smtp.host, smtp_port: v.smtp.port, smtp_secure: v.smtp.secure ? 1 : 0, username: v.username, password_enc: encrypt(v.password) } as AccountRow);
    } catch (err) {
      return reply.code(400).send({ error: 'smtp_login_failed', message: `Outgoing mail (SMTP): ${friendlyError((err as Error).message)}` });
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
    const color = req.body.color && /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : palette[count % palette.length];
    const info = db
      .prepare(
        `INSERT INTO accounts(email, name, color, sort_order, username, password_enc, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(v.email, v.name, color, count, v.username, encrypt(v.password), v.imap.host, v.imap.port, v.imap.secure ? 1 : 0, v.smtp.host, v.smtp.port, v.smtp.secure ? 1 : 0);
    // A restored backup brings back this mailbox's colour, signatures and drafts.
    applyPendingFor(Number(info.lastInsertRowid));
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid) as AccountRow;
    manager.start(row);
    return reply.code(201).send(accountView(row));
  });

  app.patch<{ Params: { id: string }; Body: AccountIn }>('/api/accounts/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const b = req.body || {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof b.name === 'string') { sets.push('name = ?'); params.push(b.name.trim()); }
    if (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) { sets.push('color = ?'); params.push(b.color); }
    if (typeof b.signature === 'string') { sets.push('signature = ?'); params.push(b.signature); }
    if (typeof b.order === 'number') { sets.push('sort_order = ?'); params.push(b.order); }
    if (typeof b.username === 'string' && b.username.trim()) { sets.push('username = ?'); params.push(b.username.trim()); }
    if (Array.isArray(b.aliases)) {
      const clean = [...new Set(b.aliases.map((a) => String(a).trim().toLowerCase()).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a) && a !== row.email.toLowerCase()))];
      sets.push('aliases = ?'); params.push(JSON.stringify(clean));
    }
    if (typeof b.notify === 'string' && ['default', 'all', 'people', 'none'].includes(b.notify)) { sets.push('notify = ?'); params.push(b.notify); }
    let refolder = false;
    if (b.folders && typeof b.folders === 'object') {
      const allowed = ['archive', 'sent', 'drafts', 'junk', 'trash', 'blocked'];
      const clean: Record<string, string> = {};
      for (const [role, pth] of Object.entries(b.folders)) if (allowed.includes(role) && typeof pth === 'string' && pth) clean[role] = pth;
      sets.push('folder_overrides = ?'); params.push(JSON.stringify(clean));
      refolder = true;
    }
    let reconnect = false;
    if (typeof b.password === 'string' && b.password) { sets.push('password_enc = ?', "auth_type = 'password'"); params.push(encrypt(b.password)); reconnect = true; }
    const imap = server(b.imap, 993);
    if (imap) { sets.push('imap_host = ?, imap_port = ?, imap_secure = ?'); params.push(imap.host, imap.port, imap.secure ? 1 : 0); reconnect = true; }
    const smtp = server(b.smtp, 465);
    if (smtp) { sets.push('smtp_host = ?, smtp_port = ?, smtp_secure = ?'); params.push(smtp.host, smtp.port, smtp.secure ? 1 : 0); }
    if (sets.length) db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    if (reconnect) await manager.restart(id);
    else {
      const sync = manager.get(id);
      sync?.refreshAccount();
      if (refolder && sync) await sync.listFolders().catch(() => undefined);
    }
    const updated = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow;
    bus.publish({ type: 'account.updated', account: accountView(updated) });
    return accountView(updated);
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    const id = Number(req.params.id);
    await manager.stop(id);
    const ids = (db.prepare('SELECT id FROM messages WHERE account_id = ?').all(id) as { id: number }[]).map((r) => r.id);
    const tx = db.transaction(() => {
      for (const m of ids) db.prepare('DELETE FROM fts WHERE rowid = ?').run(m);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
    tx();
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/resync', async (req, reply) => {
    const id = Number(req.params.id);
    const s = manager.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    void s.resync().catch((err) => bus.publish({ type: 'action.failed', message: `Resync failed: ${(err as Error).message}` }));
    return reply.code(202).send();
  });

  app.get('/api/folders', async () => {
    const rows = db.prepare('SELECT * FROM folders WHERE present = 1 ORDER BY account_id, path').all() as FolderRow[];
    return rows.map(folderView);
  });
}
