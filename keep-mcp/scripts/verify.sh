#!/bin/bash
# Checks keep-mcp end to end and prints the connector URL ONCE, for claude.ai only.
#   bash ~/various/keep-mcp/scripts/verify.sh
set -uo pipefail
HOST="$(sudo awk -F= '/^KEEP_PUBLIC_HOST=/{print $2}' /etc/keep-mcp.env)"
ok() { printf '  \033[1;32mOK\033[0m %s\n' "$*"; }
ko() { printf '  \033[1;31mNO\033[0m %s\n' "$*"; FAIL=1; }
FAIL=0
systemctl is-active --quiet keep-mcp && ok "service running" || ko "service not running (sudo journalctl -u keep-mcp -n 30)"
[ "$(sudo stat -c '%a %U' /etc/keep-mcp.env)" = "600 keepmcp" ] && ok "/etc/keep-mcp.env is 600, owner keepmcp" || ko "/etc/keep-mcp.env permissions"
sudo ss -tlnH | grep -q ':8765 ' && ! sudo ss -tlnH | grep -qE '(0\.0\.0\.0|\*|\[::\]):8765 ' && ok "listens on the Docker bridge only" || ko "port 8765 binding"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/")"
[ "$CODE" = "404" ] && ok "https://$HOST/ answers 404 without the secret" || ko "https://$HOST/ answered $CODE (DNS or Caddy not ready?)"
SECRET="$(sudo awk -F= '/^KEEP_MCP_SECRET=/{print $2}' /etc/keep-mcp.env)"
# URL handed to curl on stdin (-K -), so the secret is never in a command line.
RESP="$(printf 'url = "https://%s/%s/mcp"\n' "$HOST" "$SECRET" | curl -s -K - -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"1"}}}')"
echo "$RESP" | grep -q '"serverInfo"' && ok "MCP endpoint answers initialize" || ko "MCP endpoint did not answer: $(echo "$RESP" | head -c 200)"
if sudo journalctl -u keep-mcp --no-pager 2>/dev/null | grep -qF "$SECRET"; then ko "the secret appears in the service log"; else ok "secret not in the service log"; fi
if sudo docker logs postino-caddy-1 2>&1 | grep -qF "$SECRET"; then ko "the secret appears in Caddy's log"; else ok "secret not in Caddy's log"; fi
echo
if [ "$FAIL" = 0 ]; then
  echo "Connector URL. Paste it ONLY into claude.ai > Settings > Connectors > Add custom connector, then clear the screen (clear):"
  printf '\n  https://%s/%s/mcp\n\n' "$HOST" "$SECRET"
else
  echo "Something is not ready. Paste the lines above to Claude (they contain no secret)."
fi
unset SECRET
