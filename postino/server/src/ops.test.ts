import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { config } from './config.js';
import { registerOpsRoutes } from './ops.js';

const OPS = path.join(config.dataDir, 'ops');

describe('keep sign-in bridge', () => {
  afterAll(() => fs.rmSync(OPS, { recursive: true, force: true }));
  it('accepts only an oauth_token value, only once installed, and writes it privately', async () => {
    const app = Fastify();
    registerOpsRoutes(app);
    const cookie = 'oauth2_4/' + 'a'.repeat(40);
    const early = await app.inject({ method: 'POST', url: '/api/ops/keep/cookie', payload: { cookie } });
    expect(early.statusCode).toBe(409);
    fs.mkdirSync(OPS, { recursive: true });
    fs.writeFileSync(path.join(OPS, 'report.txt'), 'r');
    fs.writeFileSync(path.join(OPS, 'keep-status'), JSON.stringify({ stage: 'installed' }));
    const bad = await app.inject({ method: 'POST', url: '/api/ops/keep/cookie', payload: { cookie: 'hello' } });
    expect(bad.statusCode).toBe(400);
    const st = await app.inject({ url: '/api/ops/keep' });
    expect(st.json()).toMatchObject({ installed: true, stage: 'installed', urlReady: false });
    const gone = await app.inject({ url: '/api/ops/keep/url' });
    expect(gone.statusCode).toBe(404);
    fs.writeFileSync(path.join(OPS, 'keep-url'), 'https://x/keep/s/mcp');
    expect((await app.inject({ url: '/api/ops/keep/url' })).json().url).toBe('https://x/keep/s/mcp');
    await app.inject({ method: 'DELETE', url: '/api/ops/keep/url' });
    expect(fs.existsSync(path.join(OPS, 'keep-url'))).toBe(false);
  });
});
