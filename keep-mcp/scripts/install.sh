#!/bin/bash
# Installs keep-mcp next to Postino: system user keepmcp, venv in /opt/keep-mcp,
# systemd service keep-mcp, /etc/keep-mcp.env (600, owned by keepmcp).
# The service starts only after scripts/set-token.sh has stored the master token.
#   bash ~/various/keep-mcp/scripts/install.sh
set -euo pipefail
say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || die "run as your normal user (it uses sudo)"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${KEEP_HOST:-keep.emazamboni.com}"
ENVF=/etc/keep-mcp.env

say "Packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-venv >/dev/null

say "System user keepmcp"
id keepmcp >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin keepmcp

say "Code and venv in /opt/keep-mcp"
sudo install -d -o root -g root -m 755 /opt/keep-mcp
sudo install -o root -g root -m 644 "$SRC/server.py" "$SRC/requirements.txt" /opt/keep-mcp/
[ -x /opt/keep-mcp/venv/bin/python ] || sudo python3 -m venv /opt/keep-mcp/venv
sudo /opt/keep-mcp/venv/bin/pip install -q --upgrade pip
sudo /opt/keep-mcp/venv/bin/pip install -q -r /opt/keep-mcp/requirements.txt

# Caddy runs in Docker, so the service listens on the Docker bridge (not reachable from outside).
BIND="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
[ -n "$BIND" ] || die "docker0 not found: is Docker running?"

say "Settings in $ENVF"
if sudo test -f "$ENVF"; then
  echo "exists, kept (secret unchanged)"
else
  read -r -p "Google account for Keep (e.g. name@gmail.com): " EMAIL </dev/tty
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "not an email address"
  # Written straight into the file by root: the secret never reaches the screen, argv or logs.
  sudo env EMAIL="$EMAIL" HOST="$HOST" BIND="$BIND" ENVF="$ENVF" python3 - <<'PY'
import os, secrets
fd = os.open(os.environ["ENVF"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(f"""KEEP_EMAIL={os.environ['EMAIL']}
KEEP_MASTER_TOKEN=
KEEP_MCP_SECRET={secrets.token_urlsafe(32)}
KEEP_PUBLIC_HOST={os.environ['HOST']}
KEEP_BIND={os.environ['BIND']}
KEEP_PORT=8765
KEEP_STATE_FILE=/var/lib/keep-mcp/state.json
KEEP_BACKUP_DIR=/var/lib/keep-mcp/backups
KEEP_PROTECTED_LABELS=Finance,Finanze,Soldi,Money
""")
PY
fi
sudo chown keepmcp:keepmcp "$ENVF"
sudo chmod 600 "$ENVF"
ls -l "$ENVF" 2>/dev/null || sudo ls -l "$ENVF"

say "Firewall: Caddy's container may reach $BIND:8765, nothing else"
NET="$(sudo docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' postino-caddy-1 2>/dev/null || true)"
SUBNET="$( [ -n "$NET" ] && sudo docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET" 2>/dev/null || true)"
[ -n "$SUBNET" ] || die "could not find Caddy's Docker network (container postino-caddy-1)"
RULE=(-s "$SUBNET" -d "$BIND/32" -p tcp --dport 8765 -j ACCEPT)
if ! sudo iptables -C INPUT "${RULE[@]}" 2>/dev/null; then
  POS="$(sudo iptables -S INPUT | grep -n -m1 -E -- '-j (REJECT|DROP)' | cut -d: -f1 || true)"
  if [ -n "$POS" ] && [ "$POS" -gt 1 ]; then sudo iptables -I INPUT "$((POS - 1))" "${RULE[@]}"; else sudo iptables -A INPUT "${RULE[@]}"; fi
fi
command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save >/dev/null 2>&1 || true
echo "allowed $SUBNET -> $BIND:8765"

say "systemd service"
sudo install -o root -g root -m 644 "$SRC/keep-mcp.service" /etc/systemd/system/keep-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable keep-mcp >/dev/null 2>&1

say "Caddy: add $HOST next to Postino"
APP="$(cd "$SRC/../postino" && pwd)"
if grep -q 'caddy-extra' "$APP/docker-compose.yml" && grep -q 'host.docker.internal:host-gateway' "$APP/docker-compose.yml"; then
  # Only a new site file; Postino's own block is untouched. No access log: the secret is in the URL path.
  cat > "$APP/caddy-extra/keep.caddy" <<CADDY
$HOST {
	reverse_proxy host.docker.internal:8765 {
		flush_interval -1
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
}
CADDY
  (cd "$APP" && sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null) && echo "Caddy reloaded"
else
  echo "Postino's Caddy is not ready for extra sites yet (the approved compose change has not arrived). Run this script again later."
fi

say "Done"
echo "Next: the master token (Claude guides you), then: bash $SRC/scripts/set-token.sh"
