#!/bin/bash
# Server tasks for keep-mcp, run by postino/scripts/auto-update.sh (normal user, passwordless sudo)
# whenever ops/VERSION changes. Idempotent. Writes a report (no secrets) to postino/data/ops/report.txt,
# which Postino emails to its owner. Never prints or logs the Keep secret or token.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HERE="$(cd "$(dirname "$0")" && pwd)"; KM="$(cd "$HERE/.." && pwd)"; REPO="$(cd "$KM/.." && pwd)"; APP="$REPO/postino"
OPS="$APP/data/ops"; VERSION="$(cat "$HERE/VERSION")"; STAMP="$HOME/.keep-ops-version"
STAMP2="$OPS/.ops-version"
# Done already? Checked in two places, so one unwritable file can never make it run again and again.
[ "$(cat "$STAMP" 2>/dev/null)" = "$VERSION" ] && exit 0
[ "$(sudo -n cat "$STAMP2" 2>/dev/null)" = "$VERSION" ] && exit 0
S="sudo -n"
R="$(mktemp)"; log() { printf '%s\n' "$*" >> "$R"; }
publish() {
  $S install -d -o 1000 -g 1000 -m 700 "$OPS"
  $S install -o 1000 -g 1000 -m 600 "$R" "$OPS/report.txt"
  rm -f "$R"
}
status() { printf '{"stage":"%s","detail":"%s","at":"%s"}\n' "$1" "${2:-}" "$(date -u +%FT%TZ)" | $S tee "$OPS/keep-status" >/dev/null; $S chown 1000:1000 "$OPS/keep-status"; $S chmod 600 "$OPS/keep-status"; }
log "Postino server report, $(date -u '+%F %H:%M UTC'), tasks v$VERSION"
if ! $S true 2>/dev/null; then log "STOPPED: sudo needs a password for $(id -un); nothing changed."; publish 2>/dev/null; exit 0; fi
$S install -d -o 1000 -g 1000 -m 700 "$OPS"
# Mark this version done before doing anything: these tasks run once, never on every update.
echo "$VERSION" > "$STAMP" 2>/dev/null || log "note: could not write $STAMP"
echo "$VERSION" | $S tee "$STAMP2" >/dev/null
DOMAIN="$(grep -E '^POSTINO_DOMAIN=' "$APP/.env" | cut -d= -f2-)"
# Keys that let this user in. grep -c prints 0 AND fails when there are none, so never "|| echo".
KEYS="$(grep -cE '^(ssh|ecdsa|sk-)' "$HOME/.ssh/authorized_keys" 2>/dev/null)"; KEYS="${KEYS:-0}"

# ---------------- 1. What was there ----------------
log ""; log "== FOUND"
. /etc/os-release; log "System: $PRETTY_NAME, kernel $(uname -r), up $(uptime -p | sed 's/up //')"
SSHD="$($S sshd -T 2>/dev/null)"
for k in permitrootlogin passwordauthentication kbdinteractiveauthentication pubkeyauthentication; do log "ssh $k: $(echo "$SSHD" | awk -v k="$k" '$1==k{print $2}')"; done
log "users with a password: $($S awk -F: '$2 ~ /^\$/ {print $1}' /etc/shadow | tr '\n' ' ')"
log "SSH keys for $(id -un): $KEYS"
log "unattended-upgrades: $(dpkg -s unattended-upgrades >/dev/null 2>&1 && echo installed || echo MISSING); config: $(tr '\n' ' ' < /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null)"
log "pending updates: $(apt list --upgradable 2>/dev/null | grep -c upgradable)"; [ -f /var/run/reboot-required ] && log "a reboot is pending (kernel update)"
log "firewall INPUT:"; $S iptables -S INPUT | sed 's/^/  /' >> "$R"
log "listening on public interfaces:"; $S ss -tlnH | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|172\.)' | sort -u | sed 's/^/  /' >> "$R"
log "docker published: $($S docker ps --format '{{.Names}} {{.Ports}}' | tr '\n' ';')"

# ---------------- 2. SSH: keys only ----------------
log ""; log "== CHANGED"
CONF=/etc/ssh/sshd_config.d/00-hardening.conf
WANT='# Keys only. Added by keep-mcp/ops/run.sh
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no'
if ! [ "$KEYS" -ge 1 ] 2>/dev/null; then
  log "SSH: NOT changed, $(id -un) has no key (would lock you out)"
elif [ "$($S cat "$CONF" 2>/dev/null)" = "$WANT" ]; then
  log "SSH: already keys-only"
else
  printf '%s\n' "$WANT" | $S tee "$CONF" >/dev/null; $S chmod 644 "$CONF"
  if $S sshd -t 2>/dev/null; then
    $S systemctl reload ssh 2>/dev/null || $S systemctl reload sshd
    log "SSH: keys only, no root login, no passwords (now: $($S sshd -T | awk '$1=="passwordauthentication"||$1=="permitrootlogin"{printf "%s=%s ", $1, $2}'))"
  else
    $S rm -f "$CONF"; log "SSH: change rejected by sshd -t, undone"
  fi
fi
if $S passwd -S root 2>/dev/null | grep -q ' P '; then $S passwd -l root >/dev/null && log "root password locked"; fi

# ---------------- 3. Automatic security updates ----------------
dpkg -s unattended-upgrades >/dev/null 2>&1 || { $S env DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades >/dev/null 2>&1 && log "installed unattended-upgrades"; }
AUTO='APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";'
if [ "$(cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null)" != "$AUTO" ]; then printf '%s\n' "$AUTO" | $S tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null; log "automatic security updates: turned on (daily)"; else log "automatic security updates: already on"; fi
$S systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1

# ---------------- 4. Firewall: only 22, 80, 443 ----------------
while IFS= read -r rule; do
  [ -n "$rule" ] || continue
  $S iptables ${rule/-A INPUT/-D INPUT} && log "firewall: closed  $rule"
done < <($S iptables -S INPUT | grep -- '-j ACCEPT' | grep -E -- '--dport ' | grep -vE -- '--dport (22|80|443)( |$)' | grep -v -- '--dport 8765')
$S iptables -S INPUT | grep -qE -- '-j (REJECT|DROP)' || log "firewall: WARNING, no final REJECT rule in INPUT"
# rpcbind (port 111) is only for NFS, which this server does not use.
if systemctl is-active --quiet rpcbind.socket rpcbind.service 2>/dev/null || systemctl is-enabled --quiet rpcbind.socket 2>/dev/null; then
  if grep -qE '\snfs4?\s' /proc/mounts; then
    log "rpcbind: kept, an NFS share is mounted"
  else
    $S systemctl disable --now rpcbind.socket rpcbind.service >/dev/null 2>&1 && log "rpcbind (port 111, unused NFS helper): stopped and disabled"
  fi
fi
# IPv6: only matters if the server has a public IPv6 address.
if ip -6 addr show scope global 2>/dev/null | grep -q inet6; then
  log "IPv6: public address present; ip6tables INPUT:"; $S ip6tables -S INPUT | sed 's/^/  /' >> "$R"
else
  log "IPv6: no public IPv6 address, nothing reachable over IPv6"
fi

# ---------------- 5. keep-mcp ----------------
$S env DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-venv >/dev/null 2>&1
id keepmcp >/dev/null 2>&1 || { $S useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin keepmcp && log "keep-mcp: user keepmcp created"; }
$S install -d -o root -g root -m 755 /opt/keep-mcp
$S install -o root -g root -m 644 "$KM/server.py" "$KM/requirements.txt" "$HERE/exchange.py" /opt/keep-mcp/
[ -x /opt/keep-mcp/venv/bin/python ] || $S python3 -m venv /opt/keep-mcp/venv
if $S /opt/keep-mcp/venv/bin/pip install -q --disable-pip-version-check -r /opt/keep-mcp/requirements.txt >/tmp/keep-pip.log 2>&1; then log "keep-mcp: code and venv in /opt/keep-mcp"; else log "keep-mcp: pip FAILED: $(tail -n 3 /tmp/keep-pip.log | tr '\n' ' ')"; fi
rm -f /tmp/keep-pip.log
BIND="$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)"
[ "$BIND" = "172.17.0.1" ] || log "keep-mcp: WARNING docker0 is ${BIND:-missing}, but the Caddyfile points /keep at 172.17.0.1"
ENVF=/etc/keep-mcp.env
if ! $S test -f "$ENVF"; then
  EMAIL="$($S python3 -c "import sqlite3;c=sqlite3.connect('file:$APP/data/postino.db?mode=ro',uri=True);r=c.execute(\"SELECT email FROM accounts WHERE auth_type='google' ORDER BY id LIMIT 1\").fetchone() or c.execute(\"SELECT email FROM accounts WHERE email LIKE '%@gmail.com' ORDER BY id LIMIT 1\").fetchone();print(r[0] if r else '')")"
  $S env EMAIL="$EMAIL" HOST="$DOMAIN" BIND="$BIND" ENVF="$ENVF" python3 - <<'PY'
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
  log "keep-mcp: /etc/keep-mcp.env created with a fresh secret, account ${EMAIL:-UNKNOWN}"
fi
$S chown keepmcp:keepmcp "$ENVF"; $S chmod 600 "$ENVF"
log "keep-mcp: $ENVF $($S stat -c '%a %U:%G' "$ENVF")"
NET="$($S docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' postino-caddy-1 2>/dev/null)"
SUBNET="$($S docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET" 2>/dev/null)"
if [ -n "$SUBNET" ] && [ -n "$BIND" ]; then
  RULE=(-s "$SUBNET" -d "$BIND/32" -p tcp --dport 8765 -j ACCEPT)
  if ! $S iptables -C INPUT "${RULE[@]}" 2>/dev/null; then
    POS="$($S iptables -S INPUT | grep -n -m1 -E -- '-j (REJECT|DROP)' | cut -d: -f1)"
    if [ -n "$POS" ] && [ "$POS" -gt 1 ]; then $S iptables -I INPUT "$((POS - 1))" "${RULE[@]}"; else $S iptables -A INPUT "${RULE[@]}"; fi
    log "firewall: only Caddy's container ($SUBNET) may reach $BIND:8765"
  fi
else
  log "firewall: could not find Caddy's network, Keep rule NOT added"
fi
command -v netfilter-persistent >/dev/null && $S netfilter-persistent save >/dev/null 2>&1
$S install -o root -g root -m 644 "$KM/keep-mcp.service" /etc/systemd/system/keep-mcp.service
printf '[Unit]\nDescription=Turn the Keep sign-in cookie from Postino into the master token\n\n[Path]\nPathExists=%s/keep-cookie\nUnit=keep-mcp-token.service\n\n[Install]\nWantedBy=multi-user.target\n' "$OPS" | $S tee /etc/systemd/system/keep-mcp-token.path >/dev/null
printf '[Unit]\nDescription=Keep master token exchange\n\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/opt/keep-mcp/venv/bin/python /opt/keep-mcp/exchange.py %s\n' "$OPS" | $S tee /etc/systemd/system/keep-mcp-token.service >/dev/null
$S systemctl daemon-reload
$S systemctl enable keep-mcp >/dev/null 2>&1
$S systemctl enable --now keep-mcp-token.path >/dev/null 2>&1
if $S grep -qE '^KEEP_MASTER_TOKEN=.+' "$ENVF"; then
  $S systemctl restart keep-mcp; sleep 5
  log "keep-mcp: service $(systemctl is-active keep-mcp)"
else
  log "keep-mcp: installed, waiting for the Google sign-in in Postino > Settings > Claude"
  $S test -f "$OPS/keep-status" || status installed
fi

# ---------------- 6. Caddy: /keep on Postino's address ----------------
T="$(mktemp -d)"
if $S docker run --rm -e POSTINO_DOMAIN="$DOMAIN" -v "$APP/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$T/out" 2>&1; then
  if ! $S docker exec postino-caddy-1 cat /etc/caddy/Caddyfile 2>/dev/null | cmp -s - "$APP/Caddyfile"; then
    $S docker exec postino-caddy-1 cat /etc/caddy/Caddyfile > "$T/old" 2>/dev/null
    (cd "$APP" && $S docker compose up -d --force-recreate --no-deps caddy >/dev/null 2>&1)
    UP=0
    for _ in 1 2 3 4 5 6 7 8; do
      sleep 5
      curl -sk --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" | grep -q '"ok":true' && { UP=1; break; }
    done
    if [ "$UP" = 1 ]; then
      log "caddy: new config live (adds /keep, no request lines in error log); Postino answers OK"
    else
      $S docker cp "$T/old" postino-caddy-1:/config/Caddyfile.rollback && $S docker exec postino-caddy-1 caddy reload --config /config/Caddyfile.rollback --adapter caddyfile >/dev/null 2>&1
      log "caddy: Postino did not answer after the change, ROLLED BACK to the old config"
    fi
  else
    log "caddy: config already live"
  fi
else
  log "caddy: new config INVALID, not applied: $(tail -n 2 "$T/out" | tr '\n' ' ')"
fi
$S rm -rf "$T"

# ---------------- 7. Segretario (repo separato, container sulla rete di Caddy) ----------------
# Clona https://github.com/EmanueleZamboni/segretario in ~/segretario, installa il suo aggiornamento
# automatico (cron) e lo avvia. Nessun sudo: tutto come l'utente normale. Idempotente.
SEG="$HOME/segretario"
if [ ! -d "$SEG/.git" ]; then
  if git clone -q https://github.com/EmanueleZamboni/segretario.git "$SEG" 2>/dev/null; then log "segretario: cloned into $SEG"; else log "segretario: clone FAILED"; fi
else
  git -C "$SEG" fetch -q origin 2>/dev/null && git -C "$SEG" merge -q --ff-only origin/main 2>/dev/null && log "segretario: updated to $(git -C "$SEG" log -1 --format=%h)"
fi
chmod +x "$SEG"/scripts/*.sh 2>/dev/null
if [ -x "$SEG/scripts/install.sh" ]; then
  "$SEG/scripts/install.sh" >> "$R" 2>&1 || log "segretario: install.sh failed (exit $?)"
elif [ -f "$SEG/scripts/install.sh" ]; then
  bash "$SEG/scripts/install.sh" >> "$R" 2>&1 || log "segretario: install.sh failed (exit $?)"
fi

log ""; log "== Next: Postino > Settings > Claude > Google Keep (sign in once)."
publish
echo "$VERSION" > "$STAMP"
echo "$(date -u +%FT%TZ) ops v$VERSION done"
