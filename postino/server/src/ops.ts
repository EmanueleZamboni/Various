import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { log } from './log.js';
import { buildSendJob } from './routes/compose.js';
import { executeSend } from './mail/outbox.js';

/**
 * Bridge to the server tasks in keep-mcp/ops (run on the host by auto-update.sh):
 * - they leave a report in data/ops/report.txt (no secrets): Postino emails it to its owner;
 * - the Google Keep sign-in cookie is dropped in data/ops/keep-cookie for the host to swap
 *   for the master token, and the connector URL comes back in data/ops/keep-url to be shown
 *   once in Settings > Claude.
 */
const OPS = path.join(config.dataDir, 'ops');
const COOKIE = /^oauth2_4\/[A-Za-z0-9._~+/=-]{20,4000}$/;

function ownerAccount(): { id: number; email: string } | undefined {
  return (db.prepare("SELECT id, email FROM accounts WHERE auth_type = 'google' ORDER BY id LIMIT 1").get() ??
    db.prepare("SELECT id, email FROM accounts WHERE email LIKE '%@gmail.com' ORDER BY id LIMIT 1").get() ??
    db.prepare('SELECT id, email FROM accounts ORDER BY id LIMIT 1').get()) as { id: number; email: string } | undefined;
}

function readStatus(): { stage: string; detail?: string; at?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(OPS, 'keep-status'), 'utf8')) as { stage: string; detail?: string; at?: string };
  } catch {
    return null;
  }
}

function writePrivate(name: string, text: string): void {
  const file = path.join(OPS, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function mailReport(): Promise<void> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(OPS, 'report.txt'), 'utf8');
  } catch {
    return;
  }
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (getSetting('ops.mailedReport', '') === hash) return;
  const acc = ownerAccount();
  if (!acc) return;
  try {
    await executeSend(buildSendJob({ accountId: String(acc.id), to: acc.email, subject: 'Postino server: rapporto sicurezza e Google Keep', text, signatureId: 'none' }));
    setSetting('ops.mailedReport', hash);
    log.info('ops report mailed');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'ops report mail failed');
  }
}

function sweep(): void {
  // The connector URL is shown once; it never stays on disk for long.
  const url = path.join(OPS, 'keep-url');
  try {
    if (Date.now() - fs.statSync(url).mtimeMs > 24 * 3600_000) fs.unlinkSync(url);
  } catch {
    /* none */
  }
}

export function startOps(): void {
  const tick = () => {
    sweep();
    void mailReport();
  };
  setTimeout(tick, 30_000);
  setInterval(tick, 60_000);
}

export function registerOpsRoutes(app: FastifyInstance): void {
  app.get('/api/ops/keep', async () => {
    const st = readStatus();
    return {
      installed: fs.existsSync(path.join(OPS, 'report.txt')) && st !== null,
      stage: st?.stage ?? null,
      detail: st?.detail ?? '',
      email: ownerAccount()?.email ?? '',
      urlReady: fs.existsSync(path.join(OPS, 'keep-url')),
    };
  });

  app.post<{ Body: { cookie?: string } }>('/api/ops/keep/cookie', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const cookie = String(req.body?.cookie || '').trim().replace(/^oauth_token=/, '');
    if (!COOKIE.test(cookie)) return reply.code(400).send({ error: 'bad_cookie', message: 'That is not the oauth_token value (it starts with oauth2_4/).' });
    if (!fs.existsSync(OPS) || !readStatus()) return reply.code(409).send({ error: 'not_installed', message: 'The Keep connector is still being installed on the server. Try again in a few minutes.' });
    const acc = ownerAccount();
    if (!acc) return reply.code(400).send({ error: 'no_account', message: 'Add your Gmail account first.' });
    writePrivate('keep-status', JSON.stringify({ stage: 'submitted', detail: '', at: new Date().toISOString() }));
    writePrivate('keep-cookie', JSON.stringify({ email: acc.email, cookie }));
    return { ok: true };
  });

  app.get('/api/ops/keep/url', async (_req, reply) => {
    try {
      return { url: fs.readFileSync(path.join(OPS, 'keep-url'), 'utf8').trim() };
    } catch {
      return reply.code(404).send({ error: 'gone', message: 'The link was already removed.' });
    }
  });

  app.delete('/api/ops/keep/url', async () => {
    try {
      fs.unlinkSync(path.join(OPS, 'keep-url'));
    } catch {
      /* already gone */
    }
    return { ok: true };
  });
}
