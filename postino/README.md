# Postino

A self-hosted email app for many accounts: one inbox, a Spark-style layout,
and a Block sender button that works on the server, so it works on your phone,
on your computer and in any browser. Your mail stays on your providers (IMAP);
Postino keeps a searchable copy on your own server.

- Unified inbox for all accounts, smart grouping (People / Notifications / Newsletters)
- Fast search with Gmail-like operators (`from:anna has:attachment after:2026-09-01 "colonna sonora"`)
- Block sender: mail from blocked addresses or domains goes to a `Blocked` folder on arrival, 24/7
- Spam folder (merges the provider's `Junk` and `INBOX.spam`), Archive, Trash, Pinned
- Reply, reply all, forward, attachments, drafts, signatures per account
- Push notifications on Android (and desktop browsers), installable as an app (PWA)
- Password login, **fingerprint / face sign-in** (passkeys) and optional 2FA (TOTP); mailbox passwords encrypted at rest
- Rich signatures (formatting, images) per account; reply from the address the mail was sent to (aliases)
- Undo send and Send later (an outbox that survives restarts)
- Sender pictures (Gravatar, company logos)
- Settings for inbox grouping, preview lines, mark-as-read, remote images, swipes, density, per-account notifications

## Layout

```
postino/
  server/   Node 22 + Fastify + SQLite (FTS5). IMAP sync engine (ImapFlow), SMTP (nodemailer).
  web/      React + Vite PWA.
  docs/     API contract, screenshots.
  mockup/   The original design mockup (static).
```

## Run it locally

```bash
npm install
npm run dev            # server on http://127.0.0.1:8025 (API + serves web/dist when built)
npm run dev:web        # Vite dev server on http://127.0.0.1:5173, proxies /api to 8025
```

The first visit asks you to create a password, then add your accounts
(Settings → Accounts). Entering an address fills in the server settings for
known providers, including the vhosting servers used by the emazamboni.com,
stostudio.it and emanuelezamboni.com domains.

Tests: `npm test`.

## Deploy for free on Oracle Cloud (Always Free)

You need: an Oracle Cloud account (a card is asked for identity verification
only), a domain or subdomain you control (for example `mail.emazamboni.com`),
and 30 minutes.

### 1. Create the server

1. Sign in at https://cloud.oracle.com → **Compute → Instances → Create instance**.
2. Image: **Canonical Ubuntu 24.04**. Shape: **Ampere (VM.Standard.A1.Flex)**, 2 OCPUs,
   12 GB RAM (within Always Free). If A1 capacity is "out of host capacity", retry
   later or use the AMD `VM.Standard.E2.1.Micro` (1 GB, also free).
3. Under **Add SSH keys**, generate or paste a key. Download the private key.
4. Create. Note the **public IP**.
5. Open the ports: **Networking → Virtual cloud networks → your VCN → Security lists →
   Default** → **Add ingress rules**: source `0.0.0.0/0`, TCP ports `80` and `443`.

### 2. Point your domain at it

At your DNS provider (vhosting's panel for your domains), add an **A record**:
`mail` → `<public IP>`. Wait until `ping mail.yourdomain.it` answers.

### 3. Install

SSH in (`ssh -i key.pem ubuntu@<public IP>`) and run:

```bash
# Oracle's Ubuntu image also has its own firewall: open 80/443 there too.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# Postino
git clone https://github.com/emanuelezamboni/various.git
cd various/postino
cp .env.example .env
nano .env     # set POSTINO_DOMAIN, POSTINO_BASE_URL and a random POSTINO_SECRET (openssl rand -base64 32)
docker compose up -d --build
```

Caddy gets a Let's Encrypt certificate automatically. Open
`https://mail.yourdomain.it`, create your password, add your accounts.

### 4. Phone

Open the site in Chrome on Android → menu → **Add to Home screen** (or
"Install app"). In Postino → Settings → Notifications → **Enable**. New mail
from people then shows up as a normal notification, even with the app closed.

### Updating

```bash
cd various/postino && git pull && docker compose up -d --build
```

### Backups

Everything lives in `postino/data/` (SQLite database, cached attachments, the
secret key). Copy that folder; `data/secret.key` (or `POSTINO_SECRET` in `.env`)
is needed to read the stored account passwords.

## If something goes wrong

- **Forgot the Postino password**: `docker compose exec postino node scripts/reset-password.mjs` (signs every device out and turns 2FA off; passkeys keep working).
- **An account shows "Login refused"**: open Settings → Accounts → Edit, re-enter the mailbox password. For Gmail/iCloud use an *app password*.
- **"Certificate problem"** on a provider with a bad TLS certificate: add `POSTINO_TLS_INSECURE=1` to `.env` (only if you trust the network) and `docker compose up -d`.
- **No notifications on the phone**: the site must be opened over HTTPS and added to the home screen; then Settings → Notifications → Enable, and allow notifications in Android's prompt. "Send test" shows whether the phone is registered.
- **Google Drive buttons missing**: Settings → Google Drive must show "Connected". If Google refuses the redirect, the URI in the Google Cloud console must match the one shown there exactly.
- **Mail is not arriving live**: Settings → Accounts shows a red dot when the IMAP connection dropped; Postino reconnects by itself (backoff up to 5 minutes). `docker compose logs -f postino` shows why.
- **Disk**: `data/attachments` is a cache capped at 2 GB (change with `POSTINO_ATTACHMENT_CACHE_MB` in `.env`); the least recently opened files are dropped and fetched again when needed. `data/avatars` can be deleted at any time.
- **Backups**: `scripts/backup.sh` (see the comment inside for the nightly cron line). Restore = stop the app, replace `data/postino.db` and `data/secret.key`, start it again.
- **Logs**: `docker compose logs --tail 200 postino`.

## Security notes

- All API calls need the session cookie; login is rate-limited; 2FA is optional.
- Account passwords are encrypted with AES-256-GCM using a key derived from `POSTINO_SECRET`.
- Email HTML is sanitized on the server (no scripts, no forms, no event handlers) and shown
  in a sandboxed iframe; remote images are blocked until you ask to load them.
- Put the app behind HTTPS (the compose file does) and use a long password.
