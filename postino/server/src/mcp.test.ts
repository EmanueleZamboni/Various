import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { buildApp } from './index.js';
import { db } from './db.js';
import { randomToken, sha256 } from './crypto.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function csrfFor(app: Awaited<ReturnType<typeof buildApp>>, q: URLSearchParams, cookie: string): Promise<string> {
  const r = await app.inject({ url: `/oauth/authorize?${q}`, headers: { cookie } });
  return /name="csrf" value="([^"]+)"/.exec(r.body)![1];
}

function session(): string {
  const token = randomToken(32);
  db.prepare('INSERT INTO sessions(token_hash, expires_at, user_agent) VALUES (?, ?, ?)').run(sha256(token), new Date(Date.now() + 86400_000).toISOString(), 'test');
  return `postino_session=${token}`;
}

describe('Claude connector (MCP + OAuth)', () => {
  const appP = buildApp();
  afterAll(async () => (await appP).close());

  it('refuses /mcp without a token and points to the OAuth metadata', async () => {
    const app = await appP;
    const r = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401);
    expect(String(r.headers['www-authenticate'])).toContain('/.well-known/oauth-protected-resource');
    const m = await app.inject({ url: '/.well-known/oauth-authorization-server' });
    expect(m.json().code_challenge_methods_supported).toEqual(['S256']);
  });

  it('only lets Claude register', async () => {
    const app = await appP;
    const bad = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://evil.example/cb'] } });
    expect(bad.statusCode).toBe(400);
    const sneaky = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://claude.ai.evil.example/cb'] } });
    expect(sneaky.statusCode).toBe(400);
  });

  it('runs the whole sign-in and answers tool calls', async () => {
    const app = await appP;
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT] } });
    expect(reg.statusCode).toBe(201);
    const clientId = reg.json().client_id as string;
    const verifier = randomToken(40);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });

    // Signed out: off to the login page, which brings you back.
    const out = await app.inject({ url: `/oauth/authorize?${q}` });
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toMatch(/^\/login\?next=%2Foauth%2Fauthorize/);

    const cookie = session();
    const consent = await app.inject({ url: `/oauth/authorize?${q}`, headers: { cookie } });
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain('Allow');
    expect(String(consent.headers['content-security-policy'])).toContain('form-action \'self\' https://claude.ai');

    // A form posted from another site is refused.
    const csrf = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow` });
    expect(csrf.statusCode).toBe(403);
    const token = await csrfFor(app, q, cookie);
    const forged = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow&csrf=${token}` });
    expect(forged.statusCode).toBe(403);
    const otherSession = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie: session(), origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow&csrf=${token}` });
    expect(otherSession.statusCode).toBe(403);

    const allow = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, origin: 'null', 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow&csrf=${token}` });
    expect(allow.statusCode).toBe(302);
    const back = new URL(String(allow.headers.location));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    const wrong = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: randomToken(40) }).toString() });
    expect(wrong.statusCode).toBe(400); // and the code is now spent

    // A fresh code, the right verifier.
    const allow2 = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow&csrf=${token}` });
    const code2 = new URL(String(allow2.headers.location)).searchParams.get('code')!;
    const tok = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
    expect(tok.statusCode).toBe(200);
    const { access_token, refresh_token } = tok.json() as { access_token: string; refresh_token: string };
    const auth = { authorization: `Bearer ${access_token}` };

    const init = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } } });
    expect(init.json().result.protocolVersion).toBe('2025-06-18');
    const note = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    expect(note.statusCode).toBe(202);
    const list = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    const names = (list.json().result.tools as { name: string }[]).map((t) => t.name);
    for (const n of ['search_emails', 'read_thread', 'send_email', 'group_senders', 'suggest_groups']) expect(names).toContain(n);

    const g = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'group_senders', arguments: { group: 'Shops', senders: ['news@shop-mcp.test', 'not an address'] } } } });
    expect(g.json().result.structuredContent).toEqual({ added: 1, skipped: ['not an address'] });
    const gl = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_groups', arguments: {} } } });
    expect(JSON.stringify(gl.json().result.structuredContent)).toContain('news@shop-mcp.test');
    const un = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ungroup_sender', arguments: { email: 'news@shop-mcp.test' } } } });
    expect(un.json().result.structuredContent).toEqual({ removed: true });
    const bad = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_thread', arguments: { thread_id: '999999' } } } });
    expect(bad.json().result.isError).toBe(true);

    // Refresh rotates: the old refresh token stops working.
    const r1 = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token, client_id: clientId } });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', refresh_token, client_id: clientId } });
    expect(r2.statusCode).toBe(400);

    // Disconnect from Settings kills every token.
    const off = await app.inject({ method: 'DELETE', url: '/api/mcp/connections', headers: { cookie } });
    expect(off.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/mcp', headers: auth, payload: { jsonrpc: '2.0', id: 7, method: 'tools/list' } });
    expect(after.statusCode).toBe(401);
  });

  it('also accepts a client that asks for a secret', async () => {
    const app = await appP;
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' } });
    expect(reg.statusCode).toBe(201);
    const { client_id, client_secret } = reg.json() as { client_id: string; client_secret: string };
    expect(client_secret).toBeTruthy();
    const verifier = randomToken(40);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    const cookie = session();
    const token = await csrfFor(app, q, cookie);
    const allow = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow&csrf=${token}` });
    const code = new URL(String(allow.headers.location)).searchParams.get('code')!;
    const noSecret = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, client_id, code_verifier: verifier } });
    expect(noSecret.statusCode).toBe(401);
    const allow2 = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: `${q}&decision=allow&csrf=${token}` });
    const code2 = new URL(String(allow2.headers.location)).searchParams.get('code')!;
    const basic = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
    const ok = await app.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: `Basic ${basic}` }, payload: { grant_type: 'authorization_code', code: code2, code_verifier: verifier, redirect_uri: REDIRECT } });
    expect(ok.statusCode).toBe(200);
  });
});
