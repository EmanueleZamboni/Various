import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './index.js';
import { htmlToText, stripBlocks } from './mail/sanitize.js';
import { normalizeSubject } from './mail/parse.js';

describe('auth gate', () => {
  const appP = buildApp();
  afterAll(async () => (await appP).close());
  it('refuses API calls without a session however the path is spelled', async () => {
    const app = await appP;
    for (const url of ['/api/accounts', '/%61pi/accounts', '//api/accounts', '/API/accounts', '/api/threads?view=inbox', '/api/attachments/1']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).not.toBe(200);
    }
    const w = await app.inject({ method: 'POST', url: '/%61pi/blocked', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: { pattern: 'x@y.z' } });
    expect(w.statusCode).not.toBe(201);
  });
  it('keeps the public routes public and the health route quiet', async () => {
    const app = await appP;
    const h = await app.inject({ method: 'GET', url: '/api/health' });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ ok: true });
    const s = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(s.statusCode).toBe(200);
  });
  it('sends a strict CSP without inline scripts', async () => {
    const app = await appP;
    const r = await app.inject({ method: 'GET', url: '/' });
    if (r.statusCode === 200) expect(String(r.headers['content-security-policy'])).toContain("script-src 'self';");
  });
});

describe('hostile mail text', () => {
  it('strips blocks and tags in linear time', () => {
    const t0 = Date.now();
    htmlToText('<style'.repeat(60000));
    htmlToText('<'.repeat(200000));
    normalizeSubject('Re' + ' '.repeat(60000));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(htmlToText('<style>a{}</style><p>Ciao</p><script>x</script> mondo<br>!')).toBe('Ciao\nmondo\n!');
    expect(stripBlocks('<stylesheet>keep</stylesheet><style>x</style>', 'style')).toBe('<stylesheet>keep</stylesheet> ');
  });
});
