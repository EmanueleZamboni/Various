// MCP over Streamable HTTP, for claude.ai (web, desktop and mobile apps) as a custom connector.
// claude.ai custom connectors can't send a fixed API key, so the secret travels in the URL:
//   https://your-host/mcp/<MCP_TOKEN>
// An "Authorization: Bearer <MCP_TOKEN>" header on /mcp works too (Claude Code, other clients).

import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MAX_BODY = 1024 * 1024;

const digest = s => createHash('sha256').update(s).digest();

export function startHttp({ makeServer, token, port, host, log }) {
  const expected = digest(token);
  const authorized = req => {
    const url = new URL(req.url, 'http://x');
    const fromPath = url.pathname.match(/^\/mcp\/([^/]+)\/?$/)?.[1];
    const fromHeader = /^\/mcp\/?$/.test(url.pathname) ? req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] : undefined;
    const given = fromPath ? decodeURIComponent(fromPath) : fromHeader;
    return given !== undefined && timingSafeEqual(digest(given), expected);
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/healthz') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      if (!req.url.startsWith('/mcp')) return void res.writeHead(404).end();
      if (!authorized(req)) {
        await new Promise(r => setTimeout(r, 300)); // slow down guessing
        return json(res, 401, { error: 'unauthorized' });
      }
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream and no sessions to delete.
        return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return json(res, 413, { error: 'request too large' });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
      const mcp = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log('request failed:', err.message);
      if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  return new Promise(resolveListen => {
    server.listen(port, host, () => {
      log(`MCP over HTTP on http://${host}:${port}/mcp/<MCP_TOKEN>`);
      resolveListen(server);
    });
  });
}
