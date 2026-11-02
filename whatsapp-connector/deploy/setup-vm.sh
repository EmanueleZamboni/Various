#!/bin/sh
# Prepares an Ubuntu server (e.g. Oracle Cloud Always Free) for the WhatsApp connector:
# installs Docker if missing, downloads the code, creates .env with a random token and builds
# the image. Safe to run again, and on a server that already runs other containers: it uses
# its own project name, volume and network, and publishes no ports.
#
#   curl -fsSL https://raw.githubusercontent.com/EmanueleZamboni/Various/main/whatsapp-connector/deploy/setup-vm.sh | sh
set -eu

REPO=${REPO:-https://github.com/EmanueleZamboni/Various.git}
BRANCH=${BRANCH:-main}
DIR=${DIR:-$HOME/Various}

# On a server that already runs other things (e.g. another connector), leave its Docker alone.
if command -v docker >/dev/null 2>&1; then
  echo "== Docker already installed, keeping it"
  if ! sudo docker compose version >/dev/null 2>&1; then
    echo "Docker is here but 'docker compose' isn't. Install the Compose plugin for your Docker, then run this again." >&2
    exit 1
  fi
  command -v git >/dev/null 2>&1 || { echo "Please install git, then run this again." >&2; exit 1; }
elif command -v apt-get >/dev/null 2>&1; then
  echo "== Installing Docker and git"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git openssl >/dev/null
  sudo systemctl enable --now docker >/dev/null
else
  echo "This script installs Docker only on Ubuntu/Debian. Install Docker with the Compose plugin and git, then run it again." >&2
  exit 1
fi

# Small servers (1 GB RAM) need swap to build the image.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && ! swapon --show | grep -q .; then
  echo "== Adding 2 GB of swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== Getting the code ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/whatsapp-connector"

if [ ! -f .env ]; then
  echo "== Creating .env with a new secret token"
  sed "s/^MCP_TOKEN=.*/MCP_TOKEN=$(openssl rand -hex 24)/" .env.example > .env
  chmod 600 .env
fi

echo "== Building (takes a few minutes the first time)"
sudo docker compose build -q

cat <<MSG

Done. Next:
  cd $DIR/whatsapp-connector
  sudo docker compose run --rm whatsapp login --phone 39XXXXXXXXXX   # your number, digits only
  sudo docker compose up -d
  sh deploy/connector-url.sh
MSG
