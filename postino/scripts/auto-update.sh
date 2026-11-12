#!/bin/bash
# Keeps Postino up to date by itself: checks GitHub for a new version and, only when
# there is one, downloads it and rebuilds. Run by cron every 10 minutes (install.sh adds it):
#   */10 * * * * /home/ubuntu/various/postino/scripts/auto-update.sh >> /home/ubuntu/postino-update.log 2>&1
#
# Signed updates (.deploy/ at the repo root): the server only installs a commit signed by a key listed in
# .deploy/allowed_signers OF THE VERSION ALREADY INSTALLED, so a stolen GitHub account or token cannot put
# code on the server. .deploy/mode: "off" (old behaviour), "avviso" (install everything, only report whether it
# is signed), "obbligo" (install only the newest signed commit; unsigned ones wait for a signed one on top).
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP/.." && pwd)"
exec 9>/tmp/postino-update.lock
flock -n 9 || exit 0   # an update is already running

BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
git -C "$REPO" fetch -q origin "$BRANCH"
LOCAL="$(git -C "$REPO" rev-parse HEAD)"
REMOTE="$(git -C "$REPO" rev-parse "origin/$BRANCH")"

# ---- signatures (read from the installed, already trusted checkout) ----
SIGNERS="$REPO/.deploy/allowed_signers"
MODE="$(tr -d '[:space:]' 2>/dev/null < "$REPO/.deploy/mode" || true)"; MODE="${MODE:-off}"
[ -f "$SIGNERS" ] || MODE=off
signed() { git -C "$REPO" -c gpg.ssh.allowedSignersFile="$SIGNERS" verify-commit "$1" >/dev/null 2>&1; }
TARGET="$REMOTE"; NEWEST_SIGNED=""
if [ "$MODE" != off ] && [ "$LOCAL" != "$REMOTE" ]; then
  for c in $(git -C "$REPO" rev-list --first-parent "$LOCAL..$REMOTE"); do   # newest first
    if signed "$c"; then NEWEST_SIGNED="$c"; break; fi
  done
  if [ "$MODE" = obbligo ]; then TARGET="${NEWEST_SIGNED:-$LOCAL}"; fi
fi
report() {   # what the Segretario shows in stato(): no secrets, only commit ids and yes/no
  local dir="$HOME/segretario/deploy-stato" inst="$1" note="$2" hs=false rs=false srv=false
  [ -d "$dir" ] || return 0
  [ "$MODE" != off ] && signed "$inst" && hs=true
  [ "$MODE" != off ] && signed "$REMOTE" && rs=true
  # Waiting changes that touch what runs on the server (not e.g. power-meter): the Segretario tells Ema about these.
  [ "$inst" != "$REMOTE" ] && [ -n "$(git -C "$REPO" diff --name-only "$inst" "$REMOTE" -- postino keep-mcp .deploy 2>/dev/null | head -1)" ] && srv=true
  printf '{"repo":"various","modo":"%s","installato":"%s","installato_firmato":%s,"github":"%s","github_firmato":%s,"attesa_server":%s,"nota":"%s","quando":"%s"}\n' \
    "$MODE" "${inst:0:7}" "$hs" "${REMOTE:0:7}" "$rs" "$srv" "$note" "$(date -u +%FT%TZ)" > "$dir/various.json.tmp" \
    && mv -f "$dir/various.json.tmp" "$dir/various.json"
}

# One-time server tasks shipped with the code (keep-mcp/ops), run when their version changes.
# Approved by the server's owner. They report by email through Postino; a failure there never
# blocks Postino's own update.
run_ops() {
  local ops="$REPO/keep-mcp/ops/run.sh"
  [ -x "$ops" ] || return 0
  "$ops" || echo "$(date -u +%FT%TZ) ops tasks failed (exit $?)"
}

if [ "$TARGET" = "$LOCAL" ]; then
  if [ "$LOCAL" != "$REMOTE" ]; then report "$LOCAL" "in attesa di un commit firmato"; else report "$LOCAL" "aggiornato"; fi
  run_ops
  exit 0
fi

if [ "$MODE" = avviso ] && [ "$TARGET" != "$NEWEST_SIGNED" ]; then
  echo "$(date -u +%FT%TZ) WARNING: ${TARGET:0:7} is not signed (mode avviso: installing anyway)"
fi
echo "$(date -u +%FT%TZ) updating ${LOCAL:0:7} -> ${TARGET:0:7}"
git -C "$REPO" merge -q --ff-only "$TARGET"
cd "$APP"
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose up -d --build
$DOCKER image prune -f >/dev/null 2>&1 || true
echo "$(date -u +%FT%TZ) now on ${TARGET:0:7}"
report "$TARGET" "aggiornato"
run_ops
