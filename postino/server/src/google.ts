import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { db, getSetting, setSetting } from './db.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import { manager } from './mail/manager.js';
import { attachmentPath } from './mail/store.js';
import type { AccountRow, AttachmentRow } from './views.js';
import { applyPendingFor } from './backup.js';
import { log } from './log.js';

/**
 * Google Drive: "Save to Drive" and "Open in Google Docs/Sheets/Slides" for
 * attachments. The user creates an OAuth client in Google Cloud once and pastes
 * its id/secret here; tokens are stored encrypted. Only the drive.file scope is
 * requested, so Postino can see the files it created and nothing else.
 */

// Overridable so the whole flow can be exercised against a local fake Google.
const AUTH_BASE = process.env.POSTINO_GOOGLE_AUTH_BASE || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.POSTINO_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.POSTINO_GOOGLE_API_BASE || 'https://www.googleapis.com';
const SCOPE = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
  'https://www.googleapis.com/auth/tasks',
  'openid',
  'email',
].join(' ');

type Creds = { clientId: string; clientSecret: string }; // secret stored encrypted
type Tokens = { access: string; refresh: string; expiresAt: number; email: string; scope?: string };

/** Postino registered once with Google (POSTINO_GOOGLE_CLIENT_ID/SECRET in .env): connecting is then one button. */
function managedCreds(): Creds | null {
  const id = (process.env.POSTINO_GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.POSTINO_GOOGLE_CLIENT_SECRET || '').trim();
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

function creds(): Creds | null {
  const managed = managedCreds();
  if (managed) return managed;
  const c = getSetting<{ clientId: string; secretEnc: string } | null>('google.creds', null);
  if (!c) return null;
  try {
    return { clientId: c.clientId, clientSecret: decrypt(c.secretEnc) };
  } catch {
    return null;
  }
}

function tokens(): Tokens | null {
  const t = getSetting<{ enc: string } | null>('google.tokens', null);
  if (!t) return null;
  try {
    return JSON.parse(decrypt(t.enc)) as Tokens;
  } catch {
    return null;
  }
}

function saveTokens(t: Tokens | null): void {
  if (!t) db.prepare("DELETE FROM settings WHERE key = 'google.tokens'").run();
  else setSetting('google.tokens', { enc: encrypt(JSON.stringify(t)) });
}

function redirectUri(req: FastifyRequest): string {
  const host = String(req.host || 'localhost').split(',')[0].trim(); // trustProxy decides whether X-Forwarded-Host counts
  const proto = String(req.protocol || 'http');
  return `${proto}://${host}/api/google/callback`;
}

const pendingStates = new Map<string, { redirect: string; expires: number; purpose?: 'drive' | 'gmail'; back?: string; accountId?: number }>();

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(body.error_description || body.error || `Google answered ${res.status}`));
  return body;
}

/** A valid access token, refreshed when it is about to expire. */
async function accessToken(): Promise<string> {
  const t = tokens();
  const c = creds();
  if (!t || !c) throw Object.assign(new Error('Google Drive is not connected. Connect it in Settings → Google.'), { statusCode: 409 });
  if (t.expiresAt - Date.now() > 60_000) return t.access;
  const body = await tokenRequest({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: t.refresh, grant_type: 'refresh_token' });
  const next: Tokens = { ...t, access: String(body.access_token), expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  saveTokens(next);
  return next.access;
}

const GOOGLE_MIME: Record<string, string> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
};

/** Upload a file to Drive (multipart), optionally converting it to a Google editor format. */
async function uploadToDrive(opts: { name: string; contentType: string; bytes: Buffer; convertTo?: string }): Promise<{ id: string; webViewLink: string }> {
  const token = await accessToken();
  const boundary = 'postino' + randomToken(8);
  const metadata: Record<string, unknown> = { name: opts.name };
  if (opts.convertTo && GOOGLE_MIME[opts.convertTo]) metadata.mimeType = GOOGLE_MIME[opts.convertTo];
  const head = Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${opts.contentType || 'application/octet-stream'}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, opts.bytes, tail]);
  const res = await fetch(`${API_BASE}/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name,mimeType`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': String(body.length) },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; webViewLink?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(json.error?.message || `Google Drive answered ${res.status}`);
  return { id: json.id, webViewLink: json.webViewLink || `https://drive.google.com/file/d/${json.id}/view` };
}

const GMAIL_SCOPE = 'https://mail.google.com/ openid email profile';
const gmailTokens = new Map<number, { access: string; expiresAt: number }>();

/**
 * An access token for a Gmail mailbox that was connected with "Sign in with Google"
 * (IMAP and SMTP then log in with XOAUTH2; the stored secret is the refresh token).
 */
export async function gmailAccessToken(account: { id: number; password_enc: string }): Promise<string> {
  const cached = gmailTokens.get(account.id);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.access;
  const c = creds();
  if (!c) throw new Error('Google sign-in is not set up on this server any more (Settings → Google).');
  let body: Record<string, unknown>;
  try {
    body = await tokenRequest({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: decrypt(account.password_enc), grant_type: 'refresh_token' });
  } catch (err) {
    throw new Error(`Google sign-in expired or was revoked: sign in with Google again for this mailbox (${(err as Error).message})`);
  }
  const access = String(body.access_token);
  gmailTokens.set(account.id, { access, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 });
  return access;
}

/** Which Google features the current connection allows (an older connection may only have Drive). */
export function googleFeatures(): { drive: boolean; calendar: boolean; contacts: boolean; tasks: boolean } {
  const t = tokens();
  if (!t || !creds()) return { drive: false, calendar: false, contacts: false, tasks: false };
  const s = t.scope ?? 'https://www.googleapis.com/auth/drive.file';
  return { drive: s.includes('/auth/drive.file'), calendar: s.includes('/auth/calendar'), contacts: s.includes('/auth/contacts'), tasks: s.includes('/auth/tasks') };
}

/** A JSON call to a Google API with the connected account's token. */
export async function googleApi<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...((init.headers as Record<string, string>) || {}) };
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(url, { ...init, headers });
  if (res.status === 204) return {} as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw Object.assign(new Error((json as { error?: { message?: string } }).error?.message || `Google answered ${res.status}`), { statusCode: res.status === 401 || res.status === 403 ? 409 : 502 });
  return json;
}

let connectedHook: () => Promise<void> = async () => undefined;
/** Runs after Google is (re)connected, e.g. to pull Google Contacts straight away. */
export function setGoogleConnectedHook(fn: () => Promise<void>): void {
  connectedHook = fn;
}
function onGoogleConnected(): Promise<void> {
  return connectedHook().catch((err) => log.warn({ err }, 'after-connect task failed'));
}

/** True when Drive is connected (so the nightly backup can go there). */
export function driveConnected(): boolean {
  return Boolean(creds() && tokens());
}

async function driveJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const token = await accessToken();
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (res.status === 204) return {};
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message || `Google Drive answered ${res.status}`);
  return json;
}

/**
 * Save a backup file into a "Postino backups" folder in Drive and delete copies older than
 * keepDays. With the drive.file permission Postino only ever sees the files it made itself.
 */
export async function saveBackupToDrive(name: string, bytes: Buffer, keepDays = 30): Promise<void> {
  let folderId = getSetting<string | null>('backup.driveFolder', null);
  if (folderId) {
    const f = await driveJson(`${API_BASE}/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed`).catch(() => null);
    if (!f || f.trashed) folderId = null;
  }
  if (!folderId) {
    const f = await driveJson(`${API_BASE}/drive/v3/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Postino backups', mimeType: 'application/vnd.google-apps.folder' }),
    });
    folderId = String(f.id);
    setSetting('backup.driveFolder', folderId);
  }
  const token = await accessToken();
  const boundary = 'postino' + randomToken(8);
  const head = Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\ncontent-type: application/json\r\n\r\n`);
  const body = Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--`)]);
  const res = await fetch(`${API_BASE}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': String(body.length) },
    body,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(json.error?.message || `Google Drive answered ${res.status}`);
  }
  // Old copies go: anything in the folder made more than keepDays ago.
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const q = encodeURIComponent(`'${folderId}' in parents and createdTime < '${cutoff}' and trashed = false`);
  const list = await driveJson(`${API_BASE}/drive/v3/files?q=${q}&fields=files(id)&pageSize=100`);
  for (const f of (list.files as { id: string }[] | undefined) ?? []) {
    await driveJson(`${API_BASE}/drive/v3/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' }).catch((err) => log.warn({ err }, 'could not delete an old backup'));
  }
}

/** Create (or switch to Google sign-in) the Gmail mailbox; returns where to send the browser. */
function connectGmail(email: string, refresh: string, access: string, expiresIn: number, back: string): string {
  const e = email.trim().toLowerCase();
  const done = (msg: string) => `${back}?${new URLSearchParams({ result: msg }).toString()}`;
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) return done('Google did not say which address you signed in with. Try again.');
  const existing = db.prepare('SELECT id FROM accounts WHERE lower(email) = ?').get(e) as { id: number } | undefined;
  let id: number;
  if (existing) {
    db.prepare("UPDATE accounts SET auth_type = 'google', password_enc = ?, username = ?, imap_host = 'imap.gmail.com', imap_port = 993, imap_secure = 1, smtp_host = 'smtp.gmail.com', smtp_port = 465, smtp_secure = 1, last_error = NULL WHERE id = ?").run(encrypt(refresh), e, existing.id);
    id = existing.id;
  } else {
    const count = (db.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n;
    const info = db
      .prepare("INSERT INTO accounts(email, name, color, sort_order, username, password_enc, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, auth_type) VALUES (?, ?, '#C5221F', ?, ?, ?, 'imap.gmail.com', 993, 1, 'smtp.gmail.com', 465, 1, 'google')")
      .run(e, e.split('@')[0], count, e, encrypt(refresh));
    id = Number(info.lastInsertRowid);
    applyPendingFor(id);
  }
  gmailTokens.set(id, { access, expiresAt: Date.now() + expiresIn * 1000 });
  if (existing) void manager.restart(id);
  else manager.start(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow);
  return done('gmail-connected');
}

export function registerGoogleRoutes(app: FastifyInstance): void {
  app.get('/api/google/status', async () => {
    const c = creds();
    const t = tokens();
    return { configured: Boolean(c), managed: Boolean(managedCreds()), connected: Boolean(c && t), email: t?.email || null, clientId: c?.clientId || null, features: googleFeatures() };
  });

  // Step 1: the OAuth client the user created in Google Cloud.
  app.post<{ Body: { clientId?: string; clientSecret?: string } }>('/api/google/credentials', async (req, reply) => {
    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) return reply.code(400).send({ error: 'bad_client_id', message: 'The client ID should end with .apps.googleusercontent.com.' });
    if (clientSecret.length < 10) return reply.code(400).send({ error: 'bad_secret', message: 'The client secret looks too short.' });
    setSetting('google.creds', { clientId, secretEnc: encrypt(clientSecret) });
    saveTokens(null);
    return { ok: true, redirectUri: redirectUri(req) };
  });

  app.get('/api/google/redirect-uri', async (req) => ({ redirectUri: redirectUri(req) }));

  // Step 2: send the user to Google.
  app.post<{ Body: { back?: string } }>('/api/google/connect', async (req, reply) => {
    const c = creds();
    if (!c) return reply.code(409).send({ error: 'not_configured', message: 'Add the Google client ID and secret first.' });
    const state = randomToken(16);
    const back = req.body?.back === '/welcome?step=google' ? '/welcome?step=google' : '/settings/google';
    pendingStates.set(state, { redirect: redirectUri(req), expires: Date.now() + 10 * 60_000, purpose: 'drive', back });
    const url = new URL(AUTH_BASE);
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', redirectUri(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return { url: url.toString() };
  });

  // "Sign in with Google" for a Gmail mailbox (instead of an app password).
  app.post<{ Body: { back?: string; email?: string } }>('/api/google/gmail', async (req, reply) => {
    const c = creds();
    if (!c) return reply.code(409).send({ error: 'not_configured', message: 'Google sign-in is not set up on this server yet. Use an app password, or set up Google in Settings → Google first.' });
    const back = req.body?.back === '/welcome' ? '/welcome' : '/settings/accounts';
    const state = randomToken(16);
    pendingStates.set(state, { redirect: redirectUri(req), expires: Date.now() + 10 * 60_000, purpose: 'gmail', back });
    const url = new URL(AUTH_BASE);
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', redirectUri(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GMAIL_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent select_account');
    url.searchParams.set('state', state);
    const hint = String(req.body?.email || '').trim();
    if (/^[^@\s]+@[^@\s]+$/.test(hint)) url.searchParams.set('login_hint', hint);
    return { url: url.toString() };
  });

  // Step 3: Google sends the user back here.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/google/callback', async (req, reply) => {
    const pending = req.query.state ? pendingStates.get(req.query.state) : undefined;
    if (req.query.state) pendingStates.delete(req.query.state);
    const target = pending?.back || (pending?.purpose === 'gmail' ? '/settings/accounts' : '/settings/google');
    const back = (msg: string) => reply.redirect(`${target}${target.includes('?') ? '&' : '?'}${new URLSearchParams({ result: msg }).toString()}`);
    if (req.query.error) return back(`Google said: ${req.query.error}`);
    if (!pending || pending.expires < Date.now() || !req.query.code) return back('The sign-in took too long. Try again.');
    const c = creds();
    if (!c) return back('Google is not configured.');
    try {
      const body = await tokenRequest({ code: req.query.code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: pending.redirect, grant_type: 'authorization_code' });
      let email = '';
      const idToken = typeof body.id_token === 'string' ? body.id_token : '';
      if (idToken) {
        try {
          email = String(JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).email || '');
        } catch {
          email = '';
        }
      }
      if (!body.refresh_token) return back('Google did not give a refresh token. Remove Postino from your Google account permissions and connect again.');
      if (pending.purpose === 'gmail') return reply.redirect(connectGmail(email, String(body.refresh_token), String(body.access_token), Number(body.expires_in || 3600), pending.back || '/settings/accounts'));
      saveTokens({ access: String(body.access_token), refresh: String(body.refresh_token), expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000, email, scope: String(body.scope || '') });
      void onGoogleConnected();
      return back('connected');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'google oauth failed');
      return back(`Could not connect: ${(err as Error).message}`);
    }
  });

  app.post('/api/google/disconnect', async (_req, reply) => {
    const t = tokens();
    if (t) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh)}`, { method: 'POST' }).catch(() => undefined);
      saveTokens(null);
    }
    return reply.code(204).send();
  });

  // Save an attachment to Drive, optionally as a Google Doc/Sheet/Slides.
  app.post<{ Body: { attachmentId?: string; convertTo?: string } }>('/api/google/save', async (req, reply) => {
    const id = Number(req.body?.attachmentId);
    const a = db.prepare('SELECT a.*, m.account_id FROM attachments a JOIN messages m ON m.id = a.message_row WHERE a.id = ?').get(id) as (AttachmentRow & { account_id: number }) | undefined;
    if (!a) return reply.code(404).send({ error: 'not_found', message: 'Attachment not found.' });
    let file = attachmentPath(a.id);
    if (!a.cached || !fs.existsSync(file)) {
      const sync = manager.get(a.account_id);
      if (!sync) return reply.code(503).send({ error: 'offline', message: 'The account is not connected right now.' });
      file = await sync.cacheAttachment(a.id);
    }
    const bytes = await fs.promises.readFile(file);
    if (bytes.length > 100 * 1024 * 1024) return reply.code(413).send({ error: 'too_big', message: 'Files over 100 MB are not uploaded.' });
    const convertTo = req.body?.convertTo && GOOGLE_MIME[req.body.convertTo] ? req.body.convertTo : undefined;
    try {
      const r = await uploadToDrive({ name: a.filename, contentType: a.content_type, bytes, convertTo });
      return { ok: true, id: r.id, webViewLink: r.webViewLink, converted: Boolean(convertTo) };
    } catch (err) {
      const msg = (err as Error).message;
      const status = (err as { statusCode?: number }).statusCode || 502;
      return reply.code(status).send({ error: 'drive_failed', message: msg });
    }
  });
}
