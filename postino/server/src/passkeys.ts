import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { db } from './db.js';
import { issueSession, recentlyAuthenticated } from './auth.js';
import { log } from './log.js';

/**
 * Passkeys (WebAuthn): sign in with the phone's fingerprint/face or the
 * computer's Touch ID / Windows Hello. The private key never leaves the device;
 * the server keeps only the public key.
 */

type PasskeyRow = { id: string; public_key: Buffer; counter: number; transports: string; name: string; created_at: string; last_used_at: string | null; backed_up: number };

// Challenges live a few minutes in memory; one per registration (keyed by session) or login (keyed by challenge).
const regChallenges = new Map<string, { challenge: string; expires: number }>();
const loginChallenges = new Map<string, number>();
const CHALLENGE_TTL = 5 * 60_000;

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of regChallenges) if (v.expires < now) regChallenges.delete(k);
  for (const [k, v] of loginChallenges) if (v < now) loginChallenges.delete(k);
}

/** The relying party is whatever host the app is served from (e.g. mail.example.com). */
export function relyingParty(req: FastifyRequest): { rpID: string; origin: string } {
  const host = String(req.host || 'localhost').split(',')[0].trim(); // trustProxy decides whether X-Forwarded-Host counts
  const proto = String(req.protocol || 'http');
  const rpID = host.replace(/:\d+$/, '');
  return { rpID, origin: `${proto}://${host}` };
}

export function listPasskeys() {
  return (db.prepare('SELECT id, name, created_at, last_used_at, backed_up FROM passkeys ORDER BY created_at').all() as Omit<PasskeyRow, 'public_key' | 'counter' | 'transports'>[]).map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
    syncedToCloud: Boolean(p.backed_up),
  }));
}

export function registerPasskeyRoutes(app: FastifyInstance): void {
  app.get('/api/passkeys', async () => ({ passkeys: listPasskeys() }));

  app.post<{ Body: { password?: string } }>('/api/passkeys/register/options', async (req, reply) => {
    // Adding a device that can unlock the mailbox needs a fresh sign-in or the password.
    if (!recentlyAuthenticated(req, req.body?.password)) return reply.code(403).send({ error: 'reauth_required', message: 'Enter your Postino password to add a device.' });
    sweep();
    const { rpID } = relyingParty(req);
    const existing = db.prepare('SELECT id, transports FROM passkeys').all() as { id: string; transports: string }[];
    const options = await generateRegistrationOptions({
      rpName: 'Postino',
      rpID,
      userName: 'postino',
      userDisplayName: 'Postino',
      userID: new TextEncoder().encode('postino-owner'),
      attestationType: 'none',
      excludeCredentials: existing.map((e) => ({ id: e.id, transports: safeTransports(e.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const sessionKey = String(req.cookies?.postino_session || '');
    regChallenges.set(sessionKey, { challenge: options.challenge, expires: Date.now() + CHALLENGE_TTL });
    return options;
  });

  app.post<{ Body: { response?: RegistrationResponseJSON; name?: string } }>('/api/passkeys/register/verify', async (req, reply) => {
    const sessionKey = String(req.cookies?.postino_session || '');
    const pending = regChallenges.get(sessionKey);
    regChallenges.delete(sessionKey);
    if (!pending || pending.expires < Date.now()) return reply.code(400).send({ error: 'expired', message: 'The registration took too long. Try again.' });
    const { rpID, origin } = relyingParty(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body?.response as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'passkey registration failed');
      return reply.code(400).send({ error: 'verification_failed', message: 'This device could not be verified.' });
    }
    if (!verification.verified) return reply.code(400).send({ error: 'verification_failed', message: 'This device could not be verified.' });
    const { credential, credentialBackedUp } = verification.registrationInfo;
    db.prepare('INSERT INTO passkeys(id, public_key, counter, transports, name, backed_up) VALUES (?, ?, ?, ?, ?, ?)').run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports || []),
      String(req.body?.name || 'This device').slice(0, 60),
      credentialBackedUp ? 1 : 0,
    );
    return reply.code(201).send({ ok: true, passkeys: listPasskeys() });
  });

  app.delete<{ Params: { id: string } }>('/api/passkeys/:id', async (req, reply) => {
    db.prepare('DELETE FROM passkeys WHERE id = ?').run(req.params.id);
    return reply.code(204).send();
  });

  // Login: discoverable credentials, so the phone offers the passkey without typing anything.
  app.post('/api/passkeys/login/options', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    sweep();
    const count = (db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number }).n;
    if (!count) return reply.code(404).send({ error: 'no_passkeys', message: 'No passkey is set up yet. Sign in with your password, then add one in Settings → Security.' });
    const { rpID } = relyingParty(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    loginChallenges.set(options.challenge, Date.now() + CHALLENGE_TTL);
    return options;
  });

  app.post<{ Body: { response?: AuthenticationResponseJSON } }>('/api/passkeys/login/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const response = req.body?.response;
    if (!response?.id) return reply.code(400).send({ error: 'invalid', message: 'Missing passkey response.' });
    const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as PasskeyRow | undefined;
    if (!row) return reply.code(401).send({ error: 'unknown_passkey', message: 'This passkey is not registered here.' });
    const { rpID, origin } = relyingParty(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => {
          const exp = loginChallenges.get(c);
          if (!exp || exp < Date.now()) return false;
          loginChallenges.delete(c);
          return true;
        },
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: safeTransports(row.transports) },
        requireUserVerification: true,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'passkey login failed');
      return reply.code(401).send({ error: 'verification_failed', message: 'The passkey could not be verified.' });
    }
    if (!verification.verified) return reply.code(401).send({ error: 'verification_failed', message: 'The passkey could not be verified.' });
    db.prepare("UPDATE passkeys SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(verification.authenticationInfo.newCounter, row.id);
    issueSession(req, reply);
    return reply.code(204).send();
  });
}

function safeTransports(json: string): ('ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb')[] | undefined {
  try {
    const v = JSON.parse(json) as string[];
    return v.length ? (v as never) : undefined;
  } catch {
    return undefined;
  }
}
