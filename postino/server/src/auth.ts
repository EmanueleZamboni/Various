import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, randomToken, sha256, encrypt, decrypt } from './crypto.js';
import { vapidKeys } from './push.js';

const COOKIE = 'postino_session';

type AuthRow = { id: number; password_hash: string; totp_secret: string | null; totp_pending: string | null };

export function needsSetup(): boolean {
  return !db.prepare('SELECT 1 FROM auth WHERE id = 1').get();
}

function authRow(): AuthRow | undefined {
  return db.prepare('SELECT * FROM auth WHERE id = 1').get() as AuthRow | undefined;
}

function cookieSecure(req: FastifyRequest): boolean {
  if (config.secureCookies === 'true') return true;
  if (config.secureCookies === 'false') return false;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) || req.protocol;
  return proto === 'https';
}

function issueSession(req: FastifyRequest, reply: FastifyReply): void {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  db.prepare('INSERT INTO sessions(token_hash, expires_at, user_agent) VALUES (?, ?, ?)').run(sha256(token), expires.toISOString(), String(req.headers['user-agent'] || '').slice(0, 200));
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), expires });
}

export function isAuthenticated(req: FastifyRequest): boolean {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT token_hash, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as { token_hash: string; expires_at: string } | undefined;
  if (!row) return false;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return false;
  }
  db.prepare("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(row.token_hash);
  return true;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/setup', async () => ({ needsSetup: needsSetup() }));

  app.post<{ Body: { password?: string } }>('/api/setup', async (req, reply) => {
    if (!needsSetup()) return reply.code(409).send({ error: 'already_setup', message: 'A password already exists. Sign in instead.' });
    const pw = String(req.body?.password || '');
    if (pw.length < 10) return reply.code(400).send({ error: 'weak_password', message: 'Use at least 10 characters.' });
    db.prepare('INSERT INTO auth(id, password_hash) VALUES (1, ?)').run(hashPassword(pw));
    issueSession(req, reply);
    return reply.code(204).send();
  });

  app.post<{ Body: { password?: string; totp?: string } }>(
    '/api/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const row = authRow();
      if (!row) return reply.code(409).send({ error: 'needs_setup', message: 'Create a password first.' });
      const pw = String(req.body?.password || '');
      if (!verifyPassword(pw, row.password_hash)) {
        await new Promise((r) => setTimeout(r, 400));
        return reply.code(401).send({ error: 'bad_credentials', message: 'Wrong password.' });
      }
      if (row.totp_secret) {
        const code = String(req.body?.totp || '').replace(/\s+/g, '');
        if (!code) return reply.code(401).send({ error: 'totp_required', message: 'Enter the 6-digit code from your authenticator app.' });
        if (!authenticator.check(code, decrypt(row.totp_secret))) return reply.code(401).send({ error: 'totp_required', message: 'That code is not valid. Try the next one.' });
      }
      issueSession(req, reply);
      return reply.code(204).send();
    },
  );

  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', async (req, reply) => {
    if (!isAuthenticated(req)) return reply.code(401).send({ error: 'unauthorized' });
    const row = authRow();
    return { ok: true, totpEnabled: Boolean(row?.totp_secret), vapidPublicKey: vapidKeys().publicKey };
  });

  app.post<{ Body: { current?: string; next?: string } }>('/api/me/password', async (req, reply) => {
    const row = authRow();
    if (!row || !verifyPassword(String(req.body?.current || ''), row.password_hash)) return reply.code(401).send({ error: 'bad_credentials', message: 'Current password is wrong.' });
    const next = String(req.body?.next || '');
    if (next.length < 10) return reply.code(400).send({ error: 'weak_password', message: 'Use at least 10 characters.' });
    db.prepare('UPDATE auth SET password_hash = ? WHERE id = 1').run(hashPassword(next));
    db.prepare('DELETE FROM sessions').run();
    issueSession(req, reply);
    return reply.code(204).send();
  });

  app.post('/api/me/totp/start', async () => {
    const secret = authenticator.generateSecret();
    db.prepare('UPDATE auth SET totp_pending = ? WHERE id = 1').run(encrypt(secret));
    const otpauthUrl = authenticator.keyuri('postino', 'Postino', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
    return { secret, otpauthUrl, qrDataUrl };
  });

  app.post<{ Body: { code?: string } }>('/api/me/totp/enable', async (req, reply) => {
    const row = authRow();
    if (!row?.totp_pending) return reply.code(400).send({ error: 'no_pending', message: 'Start 2FA setup first.' });
    const secret = decrypt(row.totp_pending);
    if (!authenticator.check(String(req.body?.code || '').replace(/\s+/g, ''), secret)) return reply.code(400).send({ error: 'bad_code', message: 'That code is not valid.' });
    db.prepare('UPDATE auth SET totp_secret = totp_pending, totp_pending = NULL WHERE id = 1').run();
    return reply.code(204).send();
  });

  app.post<{ Body: { password?: string } }>('/api/me/totp/disable', async (req, reply) => {
    const row = authRow();
    if (!row || !verifyPassword(String(req.body?.password || ''), row.password_hash)) return reply.code(401).send({ error: 'bad_credentials', message: 'Wrong password.' });
    db.prepare('UPDATE auth SET totp_secret = NULL, totp_pending = NULL WHERE id = 1').run();
    return reply.code(204).send();
  });
}
