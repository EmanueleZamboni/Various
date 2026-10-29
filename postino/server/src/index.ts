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
import { manager } from './mail/manager.js';
import { startPushBridge, vapidKeys } from './push.js';

export async function buildApp() {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const open = ['/api/setup', '/api/login', '/api/health'];
    if (open.some((p) => req.url === p || req.url.startsWith(p + '?'))) return;
    if (!isAuthenticated(req)) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' });
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

  // Serve the built web app (SPA fallback to index.html).
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    // wildcard: true serves whatever is on disk now, so a rebuilt web/dist works without a restart.
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: true, maxAge: '1h', immutable: false });
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
