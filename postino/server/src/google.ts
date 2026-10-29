import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { db, getSetting, setSetting } from './db.js';
import { encrypt, decrypt, randomToken } from './crypto.js';
import { manager } from './mail/manager.js';
import { attachmentPath } from './mail/store.js';
import type { AttachmentRow } from './views.js';
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
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

type Creds = { clientId: string; clientSecret: string }; // secret stored encrypted
type Tokens = { access: string; refresh: string; expiresAt: number; email: string };

function creds(): Creds | null {
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
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${host}/api/google/callback`;
}

const pendingStates = new Map<string, { redirect: string; expires: number }>();

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

export function registerGoogleRoutes(app: FastifyInstance): void {
  app.get('/api/google/status', async () => {
    const c = creds();
    const t = tokens();
    return { configured: Boolean(c), connected: Boolean(c && t), email: t?.email || null, clientId: c?.clientId || null };
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
  app.post('/api/google/connect', async (req, reply) => {
    const c = creds();
    if (!c) return reply.code(409).send({ error: 'not_configured', message: 'Add the Google client ID and secret first.' });
    const state = randomToken(16);
    pendingStates.set(state, { redirect: redirectUri(req), expires: Date.now() + 10 * 60_000 });
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

  // Step 3: Google sends the user back here.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/google/callback', async (req, reply) => {
    const pending = req.query.state ? pendingStates.get(req.query.state) : undefined;
    if (req.query.state) pendingStates.delete(req.query.state);
    const back = (msg: string) => reply.redirect(`/settings/google?${new URLSearchParams({ result: msg }).toString()}`);
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
      saveTokens({ access: String(body.access_token), refresh: String(body.refresh_token), expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000, email });
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
