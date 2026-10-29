import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { registerAuthRoutes, isAuthenticated } from './auth.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerThreadRoutes } from './routes/threads.js';
import { registerBlockedRoutes } from './routes/blocked.js';
import { registerComposeRoutes } from './routes/compose.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerSignatureRoutes } from './routes/signatures.js';
import { registerPasskeyRoutes } from './passkeys.js';
import { manager } from './mail/manager.js';
import { startPushBridge, vapidKeys } from './push.js';

export async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Cross-site requests never get to change anything, whatever the cookie says.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      if (origin && host && new URL(origin).host !== host.split(',')[0].trim()) {
        return reply.code(403).send({ error: 'forbidden', message: 'Cross-site request refused.' });
      }
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
        return reply.code(403).send({ error: 'forbidden', message: 'Cross-site request refused.' });
      }
    }
    const open = ['/api/setup', '/api/login', '/api/health', '/api/passkeys/login/options', '/api/passkeys/login/verify'];
    if (open.some((p) => req.url === p || req.url.startsWith(p + '?'))) return;
    if (!isAuthenticated(req)) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' });
  });

  // Security headers for everything we serve.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (!req.url.startsWith('/api/')) {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'", // the inline script is only the mail iframe's height reporter
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          'font-src https://fonts.gstatic.com data:',
          "img-src 'self' data: blob: https: http:", // remote images in mail, only after "Load images"
          "connect-src 'self'",
          "frame-src 'self' data: blob:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
          "worker-src 'self'",
          "manifest-src 'self'",
        ].join('; '),
      );
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string; validation?: unknown };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) log.error({ err: e.message, stack: e.stack }, 'request failed');
    reply.code(status).send({ error: typeof e.code === 'string' ? e.code.toLowerCase() : status >= 500 ? 'internal' : 'bad_request', message: e.message });
  });

  registerAuthRoutes(app);
  registerAccountRoutes(app);
  registerThreadRoutes(app);
  registerBlockedRoutes(app);
  registerComposeRoutes(app);
  registerMiscRoutes(app);
  registerSignatureRoutes(app);
  registerPasskeyRoutes(app);

  // Serve the built web app (SPA fallback to index.html).
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    // wildcard: true serves whatever is on disk now, so a rebuilt web/dist works without a restart.
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      wildcard: true,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        // Vite names bundles by content hash, so they can be cached for good; the entry files cannot.
        const set = (v: string) => {
          const r = res as unknown as { setHeader?: (n: string, v: string) => void; header?: (n: string, v: string) => void };
          if (typeof r.setHeader === 'function') r.setHeader('Cache-Control', v);
          else r.header?.('Cache-Control', v);
        };
        if (/[\\/]assets[\\/]/.test(filePath)) set('public, max-age=31536000, immutable');
        else if (/\.(html|webmanifest)$/.test(filePath) || /sw\.js$/.test(filePath)) set('no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', message: req.url.startsWith('/api/') ? 'No such endpoint.' : 'Web app not built. Run `npm run build` or use the Vite dev server.' }));
  }
  return app;
}

async function main(): Promise<void> {
  // A dropped IMAP connection or a bug in one background task must never take the whole server down.
  process.on('unhandledRejection', (reason) => {
    const e = reason as Error;
    log.error({ err: e?.message || String(reason), stack: e?.stack }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaught exception');
  });
  const app = await buildApp();
  vapidKeys();
  startPushBridge();
  manager.startAll();
  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, data: config.dataDir }, 'postino listening');
  const shutdown = async () => {
    log.info('shutting down');
    await manager.stopAll();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('/index.js');
if (isMain || process.env.POSTINO_RUN === '1') {
  main().catch((err) => {
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'fatal');
    process.exit(1);
  });
}
