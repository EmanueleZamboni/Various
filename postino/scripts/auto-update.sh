#!/bin/bash
# Keeps Postino up to date by itself: checks GitHub for a new version and, only when
# there is one, downloads it and rebuilds. Run by cron every 10 minutes (install.sh adds it):
#   */10 * * * * /home/ubuntu/various/postino/scripts/auto-update.sh >> /home/ubuntu/postino-update.log 2>&1
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
exec 9>/tmp/postino-update.lock
flock -n 9 || exit 0   # an update is already running

BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
git -C "$REPO" fetch -q origin "$BRANCH"
LOCAL="$(git -C "$REPO" rev-parse HEAD)"
REMOTE="$(git -C "$REPO" rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "$(date -u +%FT%TZ) updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
git -C "$REPO" merge -q --ff-only "origin/$BRANCH"
cd "$APP"
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose up -d --build
$DOCKER image prune -f >/dev/null 2>&1 || true
echo "$(date -u +%FT%TZ) now on ${REMOTE:0:7}"
