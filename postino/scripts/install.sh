#!/bin/bash
# One-command install of Postino on a fresh Ubuntu/Debian server (Oracle Always
# Free, Hetzner, a home box...). Run it as the normal user, not root:
#
#   curl -fsSL https://raw.githubusercontent.com/emanuelezamboni/various/main/postino/scripts/install.sh | bash
#
# It asks for the domain name, installs Docker, clones the code, writes .env
# with a random secret, opens ports 80/443 and starts Postino behind Caddy
# (automatic HTTPS). Safe to run again: existing data and .env are kept.
set -euo pipefail

main() {

REPO="${POSTINO_REPO:-https://github.com/emanuelezamboni/various.git}"
BRANCH="${POSTINO_BRANCH:-main}"
DIR="${POSTINO_DIR:-$HOME/various}"
APP="$DIR/postino"

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "run this as your normal user (it uses sudo where needed), not as root"
command -v sudo >/dev/null || die "sudo is required"

# ---- 1. Questions -------------------------------------------------------------
if [ -f "$APP/.env" ]; then
  DOMAIN="$(grep -E '^POSTINO_DOMAIN=' "$APP/.env" | cut -d= -f2- || true)"
fi
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN="${POSTINO_DOMAIN:-}"
  # Under `curl | bash` stdin is the pipe, so ask on the terminal itself.
  if [ -z "$DOMAIN" ] && [ -r /dev/tty ] && [ -c /dev/tty ]; then
    read -r -p "Domain that points at this server (e.g. mail.example.com): " DOMAIN </dev/tty || true
  fi
fi
[ -n "${DOMAIN:-}" ] || die "a domain name is needed (set POSTINO_DOMAIN=... when running non-interactively)"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%/}"

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [ -n "$PUBLIC_IP" ] && [ -n "$RESOLVED" ] && [ "$PUBLIC_IP" != "$RESOLVED" ]; then
  echo "Warning: $DOMAIN resolves to $RESOLVED but this server's address is $PUBLIC_IP."
  echo "         Caddy cannot get a certificate until the DNS A record points here."
elif [ -z "$RESOLVED" ]; then
  echo "Warning: $DOMAIN does not resolve yet. Add an A record -> ${PUBLIC_IP:-the IP of this server} and HTTPS will start working within minutes."
fi

# ---- 2. Firewall (Oracle's Ubuntu image blocks everything but SSH) -----------------
if command -v iptables >/dev/null && sudo iptables -S INPUT 2>/dev/null | grep -q -- '--dport 22'; then
  say "Opening ports 80 and 443 in the local firewall"
  # Insert just before the first REJECT/DROP rule (Oracle's image has one at the end), else append.
  POS="$(sudo iptables -S INPUT | grep -n -m1 -E -- '-j (REJECT|DROP)' | cut -d: -f1 || true)"
  for p in 80 443; do
    if ! sudo iptables -C INPUT -m state --state NEW -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
      if [ -n "$POS" ] && [ "$POS" -gt 1 ]; then
        sudo iptables -I INPUT "$((POS - 1))" -m state --state NEW -p tcp --dport "$p" -j ACCEPT
      else
        sudo iptables -A INPUT -m state --state NEW -p tcp --dport "$p" -j ACCEPT
      fi
    fi
  done
  command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save >/dev/null 2>&1 || true
fi
if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
  sudo ufw allow 80/tcp >/dev/null; sudo ufw allow 443/tcp >/dev/null
fi

# ---- 3. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
if ! $DOCKER compose version >/dev/null 2>&1; then
  say "Installing the Docker Compose plugin"
  sudo apt-get install -y -q docker-compose-plugin >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sudo sh
fi

# ---- 4. Code ----------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Updating the code in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Downloading Postino into $DIR"
  command -v git >/dev/null || sudo apt-get install -y git
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
[ -d "$APP" ] || die "$APP not found after cloning"

# ---- 5. Configuration -------------------------------------------------------------
if [ ! -f "$APP/.env" ]; then
  say "Writing $APP/.env"
  SECRET="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  cat > "$APP/.env" <<EOF
# Created by scripts/install.sh on $(date -u +%Y-%m-%d)
POSTINO_DOMAIN=$DOMAIN
POSTINO_BASE_URL=https://$DOMAIN
# Encrypts the mailbox passwords at rest. Keep it with your backups.
POSTINO_SECRET=$SECRET
EOF
  chmod 600 "$APP/.env"
fi
mkdir -p "$APP/data"
sudo chown 1000:1000 "$APP/data" 2>/dev/null || true   # the container runs as uid 1000

# ---- 6. Keep the server patched and backed up automatically -------------------------------
if command -v apt-get >/dev/null; then
  say "Enabling automatic security updates"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q unattended-upgrades >/dev/null 2>&1 || true
  echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null
fi
if command -v crontab >/dev/null && ! crontab -l 2>/dev/null | grep -q "postino/scripts/backup.sh"; then
  say "Scheduling a nightly backup (03:30, kept 14 days, in ~/postino-backups)"
  (crontab -l 2>/dev/null; echo "30 3 * * * $APP/scripts/backup.sh >> $HOME/postino-backup.log 2>&1") | crontab -
fi
chmod +x "$APP/scripts/"*.sh

# ---- 7. Start -----------------------------------------------------------------------
say "Building and starting Postino (first build takes a few minutes)"
cd "$APP"
$DOCKER compose up -d --build

say "Done"
CODE=""
for _ in $(seq 1 60); do
  [ -f "$APP/data/setup-code.txt" ] && CODE="$(cat "$APP/data/setup-code.txt" 2>/dev/null || sudo cat "$APP/data/setup-code.txt" 2>/dev/null || true)"
  [ -n "$CODE" ] && break
  sleep 2
done
cat <<EOF

Open  https://$DOMAIN  and follow the setup: choose a password, add your
mailboxes, put it on your phone.

EOF
if [ -n "$CODE" ]; then
  printf '  Your setup code (the first screen asks for it):  \033[1m%s\033[0m\n\n' "$CODE"
else
  echo "  The setup code appears in:  docker compose logs postino | grep -i 'setup code'"
fi
cat <<EOF

Useful later (from $APP):
  docker compose logs -f postino      live log
  git pull && docker compose up -d --build   update
  scripts/backup.sh                   backup (see the comment inside for nightly cron)
EOF
}

# Wrapped in a function so a half-downloaded script (curl | bash) runs nothing.
main "$@"
