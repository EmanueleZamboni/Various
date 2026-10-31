import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerLegalRoutes } from './legal.js';

describe('privacy and terms pages', () => {
  it('are public HTML with the required statements', async () => {
    const app = Fastify();
    registerLegalRoutes(app);
    const p = await app.inject({ url: '/privacy' });
    expect(p.statusCode).toBe(200);
    expect(p.headers['content-type']).toContain('text/html');
    for (const s of ['Limited Use', 'myaccount.google.com/permissions', 'ezamboni96@gmail.com', 'Oracle Cloud', 'not sold']) expect(p.body).toContain(s);
    const t = await app.inject({ url: '/terms' });
    expect(t.statusCode).toBe(200);
  });
});
