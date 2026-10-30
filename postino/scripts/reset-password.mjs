#!/usr/bin/env node
// Forgot the Postino password? Run this on the server:
//   docker compose exec postino node scripts/reset-password.mjs
// (or `node scripts/reset-password.mjs` from postino/ with POSTINO_DATA_DIR set).
// It asks for a new password, replaces the old one, signs out every device,
// and turns off two-step verification so you can get back in.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dataDir = path.resolve(process.env.POSTINO_DATA_DIR || '/data');
const db = new Database(path.join(dataDir, 'postino.db'));

const rl = readline.createInterface({ input: stdin, output: stdout });
const pw = await rl.question('New password (at least 10 characters): ');
rl.close();
if (pw.normalize('NFKC').length < 10) {
  console.error('Too short.');
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw.normalize('NFKC'), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const stored = `scrypt.${salt.toString('base64url')}.${hash.toString('base64url')}`;
const tx = db.transaction(() => {
  const row = db.prepare('SELECT id FROM auth WHERE id = 1').get();
  if (row) db.prepare('UPDATE auth SET password_hash = ?, totp_secret = NULL, totp_pending = NULL WHERE id = 1').run(stored);
  else db.prepare('INSERT INTO auth(id, password_hash) VALUES (1, ?)').run(stored);
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM passkeys').run();
});
tx();
console.log('Password replaced. Every device was signed out, two-step verification is off and fingerprint sign-ins were removed (add them again in Settings).');
