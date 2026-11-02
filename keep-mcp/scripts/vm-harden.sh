#!/bin/bash
# Hardens the VM. Asks before every change. Never touches Postino.
#   bash ~/various/keep-mcp/scripts/vm-harden.sh
set -euo pipefail
say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
ask() { local a; read -r -p "$1 [y/N] " a </dev/tty; [[ "$a" =~ ^[yYsS] ]]; }
[ "$(id -u)" -ne 0 ] || { echo "Run as your normal user (it uses sudo)."; exit 1; }

# ---- SSH: keys only, no root, no passwords -------------------------------------
say "SSH"
ME="$(id -un)"
KEYS="$(grep -cE '^(ssh|ecdsa|sk-)' "$HOME/.ssh/authorized_keys" 2>/dev/null || true)"
if [ "${KEYS:-0}" -lt 1 ]; then
  echo "STOP: $ME has no SSH key in ~/.ssh/authorized_keys. Turning passwords off now would lock you out."
else
  CONF=/etc/ssh/sshd_config.d/00-hardening.conf
  WANT='# Keys only. Added by keep-mcp/scripts/vm-harden.sh
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no'
  if [ "$(sudo cat "$CONF" 2>/dev/null)" = "$WANT" ]; then
    echo "already hardened"
  elif ask "Allow SSH with keys only (no passwords, no root login)? $ME keeps access with its $KEYS key(s)."; then
    printf '%s\n' "$WANT" | sudo tee "$CONF" >/dev/null
    sudo chmod 644 "$CONF"
    if sudo sshd -t; then
      sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd
      echo "done. Effective now:"; sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '
      echo "Keep this window open and check that a NEW Cloud Shell/SSH session still logs in."
    else
      sudo rm -f "$CONF"; echo "sshd rejected the config: change undone."
    fi
  fi
  if sudo passwd -S root 2>/dev/null | grep -qE ' P '; then
    ask "root has a password set. Lock it?" && sudo passwd -l root
  fi
fi

# ---- Automatic security updates ---------------------------------------------------
say "Automatic security updates"
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  ask "unattended-upgrades is missing. Install it?" && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades
fi
AUTO='APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";'
if [ "$(cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null)" != "$AUTO" ]; then
  ask "Turn on daily automatic security updates?" && printf '%s\n' "$AUTO" | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
else
  echo "already on"
fi
sudo systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
REBOOT=/etc/apt/apt.conf.d/52keep-mcp-reboot
if [ ! -f "$REBOOT" ] && ask "Kernel fixes need a reboot. Reboot automatically at 04:30 when one is needed (Postino is offline ~1 minute)?"; then
  printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "04:30";\n' | sudo tee "$REBOOT" >/dev/null
fi

# ---- Firewall: only SSH, HTTP, HTTPS from outside -----------------------------------
say "Firewall (iptables INPUT)"
# Docker-published ports (Caddy 80/443) go through FORWARD, not INPUT; INPUT guards the host itself.
UNEXPECTED="$(sudo iptables -S INPUT | grep -- '-j ACCEPT' | grep -E -- '--dport ' | grep -vE -- '--dport (22|80|443)( |$)' | grep -v -- '-d 172\.17\.0\.1/32 .*--dport 8765' || true)"
if [ -z "$UNEXPECTED" ]; then
  echo "only 22, 80 and 443 are open (plus the Keep rule for Docker, if installed)"
else
  while IFS= read -r rule; do
    echo "open: $rule"
    if ask "Close it?"; then sudo iptables ${rule/-A INPUT/-D INPUT}; fi
  done <<< "$UNEXPECTED"
fi
if ! sudo iptables -S INPUT | grep -qE -- '-j (REJECT|DROP)$|-P INPUT DROP'; then
  echo "WARNING: INPUT has no final REJECT/DROP: everything not listed is allowed. Tell Claude before changing this."
fi
command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save >/dev/null 2>&1 && echo "rules saved for reboots"
echo; echo "Done. Paste the output to Claude."
