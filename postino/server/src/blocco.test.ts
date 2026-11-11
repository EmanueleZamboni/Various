import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './index.js';
import { setLockedForTest } from './blocco.js';

describe('Segretario kill switch', () => {
  afterEach(() => setLockedForTest(false));

  it('refuses everything but /api/health while switched off, and opens again', async () => {
    const app = await buildApp();
    setLockedForTest(true);
    for (const url of ['/api/accounts', '/mcp', '/oauth/token', '/.well-known/oauth-authorization-server', '/%61pi/accounts', '/']) {
      const r = await app.inject({ method: url === '/oauth/token' || url === '/mcp' ? 'POST' : 'GET', url });
      expect(r.statusCode, url).toBe(503);
    }
    const page = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(page.body).toContain('/riaccendi');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    setLockedForTest(false);
    expect((await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).statusCode).not.toBe(503);
    await app.close();
  });
});
