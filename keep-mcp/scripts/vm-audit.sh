#!/bin/bash
# Read-only security check of the VM. Changes nothing and prints no secrets.
#   bash ~/various/keep-mcp/scripts/vm-audit.sh
set -u
h() { printf '\n===== %s\n' "$*"; }
h "System"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -r; uptime -p
[ -f /var/run/reboot-required ] && echo "REBOOT REQUIRED" || echo "no reboot pending"
h "SSH (effective settings)"
sudo sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication|pubkeyauthentication|permitemptypasswords|maxauthtries|x11forwarding|allowusers|authenticationmethods|usepam) '
echo "--- drop-ins:"; ls /etc/ssh/sshd_config.d/ 2>/dev/null
echo "--- users with a login shell:"; awk -F: '$7 !~ /(nologin|false|sync)$/ {print $1}' /etc/passwd | tr '\n' ' '; echo
echo "--- users with a usable password:"; sudo awk -F: '$2 ~ /^\$/ {print $1}' /etc/shadow | tr '\n' ' '; echo
echo "--- authorized keys (count per user):"
for d in /root /home/*; do f="$d/.ssh/authorized_keys"; [ -r "$f" ] || sudo test -r "$f" || continue; echo "$(basename "$d"): $(sudo grep -cE '^(ssh|ecdsa|sk-)' "$f")"; done
h "Automatic updates"
dpkg -l unattended-upgrades 2>/dev/null | awk '/^ii/{print $2, $3}' || echo "unattended-upgrades NOT installed"
cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null
systemctl is-enabled apt-daily-upgrade.timer 2>/dev/null | sed 's/^/apt-daily-upgrade.timer: /'
echo "--- last unattended run:"; sudo tail -n 3 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null
echo "--- pending updates:"; apt list --upgradable 2>/dev/null | grep -c upgradable || true
h "Firewall: iptables INPUT"
sudo iptables -S INPUT 2>/dev/null
echo "--- ufw:"; sudo ufw status 2>/dev/null | head -n 3 || echo "ufw not installed"
echo "--- nftables ruleset size:"; sudo nft list ruleset 2>/dev/null | wc -l
h "Listening ports"
sudo ss -tulpnH 2>/dev/null | awk '{print $1, $5, $7}' | sort -u
h "Docker"
sudo docker ps --format '{{.Names}}  {{.Ports}}' 2>/dev/null
ip -4 -o addr show docker0 2>/dev/null | awk '{print "docker0:", $4}'
h "Pending Caddy change for Keep (test only, Postino untouched)"
T="$(mktemp -d)"; mkdir -p "$T/extra"
if git -C "$HOME/various" fetch -q origin ccr-bc740e36-cemozc 2>/dev/null && git -C "$HOME/various" show FETCH_HEAD:postino/Caddyfile > "$T/Caddyfile" 2>/dev/null; then
  for case in "no extra sites" "with the Keep site"; do
    [ "$case" = "with the Keep site" ] && printf 'keep.example.com {\n\treverse_proxy host.docker.internal:8765\n}\n' > "$T/extra/keep.caddy"
    if sudo docker run --rm -e POSTINO_DOMAIN=postino.example.com -v "$T/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$T/extra:/etc/caddy/extra:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$T/out" 2>&1; then
      echo "valid ($case)"
    else
      echo "INVALID ($case):"; tail -n 3 "$T/out"
    fi
  done
else
  echo "could not fetch the pending change"
fi
rm -rf "$T"

h "Other"
systemctl is-active fail2ban 2>/dev/null | sed 's/^/fail2ban: /'
crontab -l 2>/dev/null | grep -v '^#'
echo; echo "Done. Paste everything above to Claude."
