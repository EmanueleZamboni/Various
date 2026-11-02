#!/bin/bash
# Stores the Keep master token in /etc/keep-mcp.env without it ever being shown,
# saved in shell history or passed on a command line, then starts the service.
#   bash ~/various/keep-mcp/scripts/set-token.sh
set -euo pipefail
read -r -s -p "Paste the master token (aas_et/..., nothing will show): " TOKEN </dev/tty; echo
[[ "$TOKEN" =~ ^aas_et/[A-Za-z0-9._~+/=-]+$ ]] || { unset TOKEN; echo "That does not look like a master token (it starts with aas_et/)."; exit 1; }
# Passed on stdin, never in argv: other processes cannot see it.
printf '%s' "$TOKEN" | sudo python3 -c '
import os, sys
tok = sys.stdin.read().strip()
path = "/etc/keep-mcp.env"
lines = open(path).read().splitlines()
out = [("KEEP_MASTER_TOKEN=" + tok) if l.startswith("KEEP_MASTER_TOKEN=") else l for l in lines]
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(out) + "\n")
st = os.stat(path)
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, path)
'
unset TOKEN
sudo systemctl restart keep-mcp
sleep 4
if systemctl is-active --quiet keep-mcp; then
  echo "keep-mcp is running."
else
  echo "keep-mcp did not start. Last lines of its log:"
  sudo journalctl -u keep-mcp -n 15 --no-pager | grep -v 'aas_et/' || true
fi
