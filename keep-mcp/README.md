# keep-mcp

Self-hosted Google Keep connector for Claude, running next to Postino on the same VM.

Tools:

- Read: list_notes (by text or label), get_note, list_labels
- Add: create_note, create_list, add_list_items, append_to_note, set_item_checked
- Organize: rewrite_note, edit_list_item, set_labels, set_pinned_archived
- Undo: list_backups, restore_note

No delete or trash on purpose. Every rewrite, item edit and label change first saves the note to KEEP_BACKUP_DIR, so any change can be undone with restore_note.

Notes labeled with anything in KEEP_PROTECTED_LABELS (default Finance, Finanze, Soldi, Money) are read-only for Claude apart from adding new lines or items: no rewrites, item edits, ticking, label changes, archiving or restores.

## How it runs

- systemd service `keep-mcp`, user `keepmcp`, code and venv in `/opt/keep-mcp`, sandboxed (see keep-mcp.service).
- Postino's Caddy runs in Docker, so keep-mcp listens on the Docker bridge (`KEEP_BIND`, e.g. 172.17.0.1), never on a public address; one iptables rule lets only Caddy's container reach port 8765.
- Caddy serves `keep.<domain>` from `postino/caddy-extra/keep.caddy` (created on the server, not in git), with no access log and no request lines in the error log, because the secret is in the URL path.
- `/etc/keep-mcp.env`: mode 600, owner keepmcp. Never commit it or paste it anywhere.

## Install (on the VM, as the normal user)

    bash ~/various/keep-mcp/scripts/vm-audit.sh     # read-only check, paste the output to Claude
    bash ~/various/keep-mcp/scripts/vm-harden.sh    # keys-only SSH, auto security updates, firewall (asks first)
    bash ~/various/keep-mcp/scripts/install.sh      # user, venv, service, env file with a fresh secret, Caddy site
    # master token: run get_token.py on your laptop, never on the server
    bash ~/various/keep-mcp/scripts/set-token.sh    # hidden prompt, starts the service
    bash ~/various/keep-mcp/scripts/verify.sh       # checks everything, prints the connector URL once

DNS: an A record `keep` pointing at the VM (Cloudflare: DNS only, grey cloud).

## Notes

- gkeepapi is unofficial. Google can break it, and the master token gives broad access to the Google account. If it leaks, revoke it by changing the Google password.
- The URL is the password. Paste it only into claude.ai; rotate the secret if it leaks (edit KEEP_MCP_SECRET, restart, re-add the connector).
