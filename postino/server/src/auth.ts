import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { db } from './db.js';
import { config } from './config.js';
import { hashPassword, verifyPassword, randomToken, sha256, encrypt, decrypt } from './crypto.js';
import { vapidKeys } from './push.js';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, randomInt } from 'node:crypto';
import { log } from './log.js';
const timingSafeEqualStr = (a: string, b: string) => timingSafeEqual(Buffer.from(a), Buffer.from(b));

const COOKIE = 'postino_session';

type AuthRow = { id: number; password_hash: string; totp_secret: string | null; totp_pending: string | null };

export function needsSetup(): boolean {
  return !db.prepare('SELECT 1 FROM auth WHERE id = 1').get();
}

/**
 * A fresh install on the public internet must not be claimable by whoever finds it
 * first: creating the password needs a one-time code that only the server's owner
 * can read (printed in the log and kept in data/setup-code.txt).
 */
const setupCodeFile = path.join(config.dataDir, 'setup-code.txt');
export function setupCode(): string | null {
  if (!needsSetup()) return null;
  try {
    const existing = fs.readFileSync(setupCodeFile, 'utf8').trim();
    if (/^[0-9]{6}-[0-9]{6}$/.test(existing)) return existing;
  } catch {
    // not yet created
  }
  const digits = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
  const code = `${digits()}-${digits()}`;
  fs.writeFileSync(setupCodeFile, code + '\n', { mode: 0o600 });
  return code;
}
export function announceSetupCode(): void {
  const code = setupCode();
  if (!code) return;
  log.info({ code }, 'SETUP CODE: open the app and enter this code to create your password');
  // eslint-disable-next-line no-console
  console.log(`\n  Postino setup code: ${code}\n  Open the site and enter it together with your new password.\n`);
}

function authRow(): AuthRow | undefined {
  return db.prepare('SELECT * FROM auth WHERE id = 1').get() as AuthRow | undefined;
}

function cookieSecure(req: FastifyRequest): boolean {
  if (config.secureCookies === 'true') return true;
  if (config.secureCookies === 'false') return false;
  const proto = req.protocol; // Fastify applies trustProxy to X-Forwarded-Proto
  return proto === 'https';
}

export function issueSession(req: FastifyRequest, reply: FastifyReply): void {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  db.prepare('INSERT INTO sessions(token_hash, expires_at, user_agent) VALUES (?, ?, ?)').run(sha256(token), expires.toISOString(), String(req.headers['user-agent'] || '').slice(0, 200));
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), expires });
}

export function isAuthenticated(req: FastifyRequest): boolean {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT token_hash, expires_at, created_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as { token_hash: string; expires_at: string; created_at: string } | undefined;
  if (!row) return false;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return false;
  }
  const remaining = new Date(row.expires_at).getTime() - Date.now();
  // Sliding, but never beyond 90 days from sign-in.
  if (new Date(row.created_at).getTime() < Date.now() - 90 * 86400_000) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return false;
  }
  if (remaining < (config.sessionDays / 2) * 86400_000) {
    // Sliding expiry: a device in regular use never gets logged out by surprise.
    db.prepare("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), expires_at = ? WHERE token_hash = ?").run(new Date(Date.now() + config.sessionDays * 86400_000).toISOString(), row.token_hash);
  } else {
    db.prepare("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(row.token_hash);
  }
  return true;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/setup', async () => ({ needsSetup: needsSetup() }));

  app.post<{ Body: { password?: string; code?: string } }>('/api/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!needsSetup()) return reply.code(409).send({ error: 'already_setup', message: 'A password already exists. Sign in instead.' });
    const expected = setupCode();
    const given = String(req.body?.code || '').replace(/\s+/g, '');
    if (expected && (given.length !== expected.length || !timingSafeEqualStr(given, expected))) {
      return reply.code(403).send({ error: 'bad_setup_code', message: 'Wrong setup code. It is printed where Postino was started (docker compose logs postino) and in data/setup-code.txt.' });
    }
    const pw = String(req.body?.password || '');
    if (pw.length < 10) return reply.code(400).send({ error: 'weak_password', message: 'Use at least 10 characters.' });
    db.prepare('INSERT INTO auth(id, password_hash) VALUES (1, ?)').run(hashPassword(pw));
    try {
      fs.unlinkSync(setupCodeFile);
    } catch {
      // already gone
    }
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
        // A code is good for one sign-in only (RFC 6238 §5.2): no replay inside its 30 s window.
        const step = Math.floor(Date.now() / 30_000);
        const used = (db.prepare('SELECT totp_last_step FROM auth WHERE id = 1').get() as { totp_last_step: number }).totp_last_step;
        if (step <= used) return reply.code(401).send({ error: 'totp_required', message: 'That code was already used. Wait for the next one.' });
        db.prepare('UPDATE auth SET totp_last_step = ? WHERE id = 1').run(step);
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
    const passkeys = (db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number }).n;
    return { ok: true, totpEnabled: Boolean(row?.totp_secret), passkeys, vapidPublicKey: vapidKeys().publicKey };
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
