#!/bin/bash
# Nightly backup of Postino's data: the SQLite database (consistent copy), the
# secret key and the settings. Attachments and avatars are a cache and are
# fetched again from the mail server, so they are not included.
#
# Install on the server (runs at 03:30 every night, keeps 14 days):
#   crontab -e
#   30 3 * * * /home/ubuntu/various/postino/scripts/backup.sh >> /home/ubuntu/postino-backup.log 2>&1
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${POSTINO_DATA_DIR:-$DIR/data}"
DEST="${POSTINO_BACKUP_DIR:-$HOME/postino-backups}"
mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d_%H%M)"
TMP="$(mktemp -d)"
# A hot copy that is safe while the app is running (sqlite3's online backup API).
if command -v sqlite3 >/dev/null; then
  sqlite3 "$DATA/postino.db" ".backup '$TMP/postino.db'"
else
  docker compose -f "$DIR/docker-compose.yml" exec -T postino node -e "const D=require('better-sqlite3');new D('/data/postino.db').backup('/data/.backup.db').then(()=>process.exit(0))"
  mv "$DATA/.backup.db" "$TMP/postino.db"
fi
[ -f "$DATA/secret.key" ] && cp "$DATA/secret.key" "$TMP/"
[ -f "$DIR/.env" ] && cp "$DIR/.env" "$TMP/env"
tar -czf "$DEST/postino-$STAMP.tar.gz" -C "$TMP" .
rm -rf "$TMP"
find "$DEST" -name 'postino-*.tar.gz' -mtime +14 -delete
echo "backup written: $DEST/postino-$STAMP.tar.gz"
