#!/bin/sh
# Prints the URL to paste into claude.ai > Settings > Connectors > Add custom connector.
# Run from the whatsapp-connector folder after `docker compose up -d`.
set -eu
cd "$(dirname "$0")/.."
token=$(grep '^MCP_TOKEN=' .env | cut -d= -f2)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  host=$(sudo docker compose logs tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
  [ -n "$host" ] && break
  sleep 3
done
if [ -z "$host" ]; then
  echo "No tunnel address yet. Check: sudo docker compose logs tunnel" >&2
  exit 1
fi
echo "$host/mcp/$token"
echo "Keep it secret: anyone with this URL can read your WhatsApp." >&2
