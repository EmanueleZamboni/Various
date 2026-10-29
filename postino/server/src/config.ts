import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

const dataDir = path.resolve(env('POSTINO_DATA_DIR', './data'));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

// The secret protects account passwords at rest. When it is not given, one is
// generated once and kept next to the database so restarts keep working.
function loadSecret(): string {
  const fromEnv = process.env.POSTINO_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  port: Number(env('PORT', '8025')),
  host: env('HOST', '0.0.0.0'),
  dataDir,
  dbPath: path.join(dataDir, 'postino.db'),
  attachmentsDir: path.join(dataDir, 'attachments'),
  uploadsDir: path.join(dataDir, 'uploads'),
  secret: loadSecret(),
  // Public URL of the app, used in push notification links.
  baseUrl: env('POSTINO_BASE_URL', ''),
  // Where the built web app lives (served as static files in production).
  webDist: path.resolve(env('POSTINO_WEB_DIST', path.join(process.cwd(), '..', 'web', 'dist'))),
  secureCookies: env('POSTINO_SECURE_COOKIES', 'auto'), // "auto" | "true" | "false"
  // Trust X-Forwarded-* only behind a reverse proxy (docker-compose sets it); otherwise a client
  // could spoof its address past the login rate limit.
  trustProxy: env('POSTINO_TRUST_PROXY', '') === '' ? env('POSTINO_SECURE_COOKIES', 'auto') === 'true' : /^(1|true|yes)$/i.test(env('POSTINO_TRUST_PROXY', '')),
  sessionDays: 30,
  // Messages larger than this are fetched part by part instead of as one blob.
  maxSourceFetchBytes: 1_500_000,
  // How often non-inbox folders are reconciled with the server.
  folderPollMs: 3 * 60_000,
  inboxPollMs: 60_000,
  logLevel: env('LOG_LEVEL', 'info'),
  // Cached attachments beyond this size are dropped (least recently used first)
  // and fetched again from the server when opened.
  attachmentCacheBytes: Math.max(64, Number(env('POSTINO_ATTACHMENT_CACHE_MB', '2048')) || 2048) * 1024 * 1024,
};
