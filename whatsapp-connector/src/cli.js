#!/usr/bin/env node
// WhatsApp connector for Claude.
//
//   node src/cli.js login [--phone 393331234567]   link this connector to your WhatsApp (QR or pairing code)
//   node src/cli.js serve                          MCP over stdio (Claude Desktop / Claude Code)
//   node src/cli.js serve --http [--port 8787]     MCP over HTTP (claude.ai web and mobile, via a public URL)

import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from './store.js';
import { WhatsApp } from './whatsapp.js';
import { createServer } from './tools.js';
import { startHttp } from './http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.error('[whatsapp]', ...a);

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phone: { type: 'string' },
    http: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT || '8787' },
    host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
    'data-dir': { type: 'string', default: process.env.WHATSAPP_DATA_DIR || join(ROOT, 'data') },
    help: { type: 'boolean', short: 'h' },
  },
});
const command = positionals[0] || 'serve';
const dataDir = resolve(opts['data-dir']);
const lockPath = join(dataDir, 'connector.lock');
const authFile = join(dataDir, 'auth', 'creds.json');

if (opts.help || !['login', 'serve', 'logout'].includes(command)) {
  console.error(`Usage:
  node src/cli.js login [--phone 393331234567]   link to your WhatsApp (QR code, or pairing code with --phone)
  node src/cli.js serve                          MCP server over stdio (Claude Desktop / Claude Code)
  node src/cli.js serve --http [--port 8787] [--host 0.0.0.0]
                                                 MCP server over HTTP; needs MCP_TOKEN in the environment
  node src/cli.js logout                         unlink this device and delete the session

Data (session keys, messages, media) is kept in ${dataDir} (--data-dir or WHATSAPP_DATA_DIR).`);
  process.exit(opts.help ? 0 : 1);
}

/** One process at a time may hold the WhatsApp connection; the others only read the stored messages. */
async function acquireLock() {
  try {
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false; // still running
      } catch { /* stale lock */ }
    }
  } catch { /* no lock */ }
  await writeFile(lockPath, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(lockPath, 'utf8') === String(process.pid)) unlinkSync(lockPath);
    } catch { /* ignore */ }
  };
  process.on('exit', release);
  return true;
}

/** True once a phone has accepted the link (creds.json exists before that, too). */
function isLinked() {
  try {
    return !!JSON.parse(readFileSync(authFile, 'utf8')).me;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  if (command === 'logout') {
    if (!(await acquireLock())) throw new Error('The connector is running; stop it first.');
    if (isLinked()) {
      const store = new Store(join(dataDir, 'store.db'));
      const wa = new WhatsApp({ dataDir, store });
      await wa.start();
      await new Promise(r => wa.once('open', r));
      await wa.sock.logout().catch(() => {});
    }
    await rm(join(dataDir, 'auth'), { recursive: true, force: true });
    log('Unlinked. Stored messages are still in', join(dataDir, 'store.db'), '- delete the data folder to remove them.');
    process.exit(0);
  }

  const owner = await acquireLock();

  if (command === 'login') {
    if (!owner) throw new Error('The connector is already running (e.g. inside Claude). Close it, then run login again.');
    await login();
    return;
  }

  // serve
  const store = new Store(join(dataDir, 'store.db'));
  let wa = null;
  if (owner) {
    wa = new WhatsApp({ dataDir, store });
    wa.on('qr', () => log('Not linked: run `npm run login` to link this connector.'));
    wa.on('open', me => log(`Connected as ${me.name || me.id}`));
    wa.on('logged-out', () => log('Logged out from the phone. Run `npm run login` again.'));
    wa.on('replaced', () => log('Another copy of the connector took over the session.'));
    if (isLinked()) await wa.start();
    else {
      wa.state = 'not_linked';
      log('Not linked yet: run `npm run login` first.');
    }
  } else {
    log('Another copy of the connector is running; this one is read-only.');
  }

  const shutdown = async () => {
    await wa?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (opts.http) {
    const token = process.env.MCP_TOKEN;
    if (!token || token.length < 24) {
      throw new Error('Set MCP_TOKEN to a long random secret (24+ characters), e.g. `openssl rand -hex 24`.');
    }
    await startHttp({ makeServer: () => createServer({ store, wa, dataDir }), token,
      port: Number(opts.port), host: opts.host, log });
  } else {
    const server = createServer({ store, wa, dataDir });
    await server.connect(new StdioServerTransport());
    process.stdin.on('close', shutdown);
  }
}

async function login() {
  const store = new Store(join(dataDir, 'store.db'));
  const already = isLinked();
  const wa = new WhatsApp({ dataDir, store, pairingPhone: opts.phone });
  const out = (...a) => console.log(...a);

  wa.on('qr', async qr => {
    const { default: qrcode } = await import('qrcode-terminal');
    out('\nOn your phone: WhatsApp > Settings > Linked devices > Link a device, then scan:\n');
    qrcode.generate(qr, { small: true }, code => out(code));
  });
  wa.on('pairing-code', code => {
    out('\nOn your phone: WhatsApp > Settings > Linked devices > Link a device >');
    out('"Link with phone number instead", and enter this code:\n');
    out(`    ${code}\n`);
  });

  let lastActivity = Date.now();
  let total = 0;
  wa.on('history', h => {
    lastActivity = Date.now();
    total += h.messages;
    out(`Syncing history... ${total} messages${h.progress != null ? ` (${h.progress}%)` : ''}`);
  });
  const done = new Promise((resolveDone, rejectDone) => {
    wa.on('history-complete', () => resolveDone('complete'));
    wa.on('logged-out', () => rejectDone(new Error('The phone refused or removed the link. Run login again.')));
    wa.on('replaced', () => rejectDone(new Error('Another copy of the connector is using this session.')));
  });

  await wa.start();
  await new Promise(r => wa.once('open', r));
  out(`\nLinked as ${wa.me.name || ''} ${wa.me.id}.`);
  if (already) {
    out('This connector was already linked; nothing else to do.');
    await wa.stop();
    process.exit(0);
  }
  out('Downloading your chat history from the phone (keep WhatsApp open on it). This can take a few minutes.');

  // Stop when WhatsApp says the sync is complete, or after 90 s without new history.
  const idle = new Promise(r => {
    const t = setInterval(() => {
      if (Date.now() - lastActivity > 90_000) {
        clearInterval(t);
        r('idle');
      }
    }, 5000);
  });
  await Promise.race([done, idle]);
  await new Promise(r => setTimeout(r, 3000)); // let the last chunks land
  const c = store.counts();
  out(`\nDone: ${c.chats} chats and ${c.messages} messages stored in ${join(dataDir, 'store.db')}.`);
  out('You can now add the connector to Claude (see README.md).');
  await wa.stop();
  process.exit(0);
}

main().catch(err => {
  log(err.message);
  process.exit(1);
});
