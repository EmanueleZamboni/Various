import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerImageProxy } from './imageProxy.js';

describe('image proxy', () => {
  it('refuses anything that is not an http(s) address', async () => {
    const app = Fastify();
    registerImageProxy(app);
    for (const u of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y.png']) {
      const r = await app.inject({ url: `/api/img?u=${encodeURIComponent(u)}` });
      expect(r.statusCode).toBe(400);
    }
  });
  it('never fetches private addresses', async () => {
    const app = Fastify();
    registerImageProxy(app);
    const r = await app.inject({ url: `/api/img?u=${encodeURIComponent('http://127.0.0.1:8025/api/me')}` });
    expect(r.statusCode).toBe(404);
  });
});
