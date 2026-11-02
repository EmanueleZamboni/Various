import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { fetchRemoteImage } from './avatars.js';

/**
 * Images in emails go through your own server, like Gmail's image proxy: the sender
 * never sees your IP address or device, can't set cookies, and a tracking pixel only
 * learns that "the server" fetched it (cached, so opening the email again tells nothing).
 */

const dir = path.join(config.dataDir, 'imgcache');
fs.mkdirSync(dir, { recursive: true });
const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_MS = 7 * 86_400_000;
const inflight = new Map<string, Promise<{ bytes: Buffer; contentType: string } | null>>();
let writes = 0;

function prune(): void {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {
      // gone already
    }
  }
}

export function registerImageProxy(app: FastifyInstance): void {
  app.get<{ Querystring: { u?: string } }>('/api/img', async (req, reply) => {
    const u = String(req.query.u || '');
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      return reply.code(400).send({ error: 'bad_url' });
    }
    if (!/^https?:$/.test(url.protocol) || u.length > 4096) return reply.code(400).send({ error: 'bad_url' });
    const key = crypto.createHash('sha256').update(u).digest('hex');
    const file = path.join(dir, key);
    const send = (bytes: Buffer, contentType: string) =>
      reply
        .header('content-type', contentType)
        .header('cache-control', 'private, max-age=86400')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('x-content-type-options', 'nosniff')
        .send(bytes);
    try {
      const type = fs.readFileSync(`${file}.type`, 'utf8');
      return send(fs.readFileSync(file), type);
    } catch {
      // not cached yet
    }
    let p = inflight.get(key);
    if (!p) {
      p = fetchRemoteImage(url.toString(), MAX_BYTES);
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    const img = await p;
    if (!img) return reply.code(404).header('cache-control', 'private, max-age=600').send();
    try {
      fs.writeFileSync(file, img.bytes);
      fs.writeFileSync(`${file}.type`, img.contentType);
      if (++writes % 200 === 0) prune();
    } catch {
      // disk full or similar: still serve it
    }
    return send(img.bytes, img.contentType);
  });
}
