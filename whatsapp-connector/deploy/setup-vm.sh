#!/bin/sh
# Prepares a fresh Ubuntu server (e.g. Oracle Cloud Always Free) for the WhatsApp connector:
# installs Docker, downloads the code, creates .env with a random token and builds the image.
# Safe to run again.
#
#   curl -fsSL https://raw.githubusercontent.com/EmanueleZamboni/Various/main/whatsapp-connector/deploy/setup-vm.sh | sh
set -eu

REPO=${REPO:-https://github.com/EmanueleZamboni/Various.git}
BRANCH=${BRANCH:-main}
DIR=${DIR:-$HOME/Various}

echo "== Installing Docker and git"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git openssl >/dev/null
sudo systemctl enable --now docker >/dev/null

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
