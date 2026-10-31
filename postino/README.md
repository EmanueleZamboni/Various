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
- Works offline: the last synced mail opens even without a connection (changes wait until it is back)
- Built for a free VM: a 100,000-message mailbox lists in ~10 ms and searches in under 200 ms (SQLite FTS5)

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

SSH in (`ssh -i key.pem ubuntu@<public IP>`) and run the installer. It asks for
the domain, installs Docker, opens the firewall, writes `.env` with a random
secret, schedules nightly backups and automatic security updates, and starts
everything behind Caddy (automatic HTTPS):

```bash
curl -fsSL https://raw.githubusercontent.com/emanuelezamboni/various/main/postino/scripts/install.sh | bash
```

It ends by printing a **setup code**. Open `https://mail.yourdomain.it`, enter the
code together with your new password (so nobody who stumbles on the address can
claim the server before you), and the wizard takes it from there: mailboxes,
phone, notifications, fingerprint sign-in.

<details>
<summary>What the installer does, step by step (if you prefer to do it by hand)</summary>

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

Caddy gets a Let's Encrypt certificate automatically. The setup code is in
`docker compose logs postino`. Open `https://mail.yourdomain.it`, create your
password, add your accounts.

</details>

### Giving it to a colleague

Postino is one person's mail: one password, their mailboxes. A colleague gets
their own copy, not an account on yours. Send them this page: with a free
Oracle VM (or any small Linux server) and a subdomain, the installer above plus
the in-app wizard take about 20 minutes and no technical knowledge beyond
copying two commands.

### 4. Phone

Open the site in Chrome on Android → menu → **Add to Home screen** (or
"Install app"). In Postino → Settings → Notifications → **Enable**. New mail
from people then shows up as a normal notification, even with the app closed.

### 5. Google Drive (optional, once)

"Save to Drive" and "Open in Google Docs / Sheets / Slides" need your own
Google OAuth client (free, about 5 minutes). Settings → Google Drive in
Postino shows the same steps with the exact redirect URI to paste:

1. Open [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) in any project.
2. APIs & Services → Library → enable **Google Drive API**, **Google Calendar API**, **People API** and **Google Tasks API** (Drive, invitations, contacts and tasks).
3. Create credentials → **OAuth client ID** → type **Web application**; under
   "Authorized redirect URIs" add `https://mail.yourdomain.it/api/google/callback`.
4. If the consent screen is in "Testing", add your Google address as a test user.
5. Either paste the client ID and secret into Settings → Google Drive, or,
   to make it a single **Connect Google Drive** button for you and your
   colleagues, put them in `.env` as `POSTINO_GOOGLE_CLIENT_ID` and
   `POSTINO_GOOGLE_CLIENT_SECRET` and run `docker compose up -d`. For a
   colleague's server, add their `https://<their address>/api/google/callback`
   to the same client's redirect URIs and give them the two values.
   On the consent screen, set the app to **In production** so connections
   don't expire after 7 days (`drive.file` needs no Google review). Postino only asks for access to files it creates
   (`drive.file`), never to your whole Drive.

### Updating

```bash
cd various/postino && git pull && docker compose up -d --build
```

### Backups

Everything lives in `postino/data/` (SQLite database, cached attachments, the
secret key). Copy that folder; `data/secret.key` (or `POSTINO_SECRET` in `.env`)
is needed to read the stored account passwords.

## If something goes wrong

- **Lost the setup code** (first start only): `docker compose logs postino | grep -i "setup code"`, or `cat data/setup-code.txt`.
- **Forgot the Postino password**: `docker compose exec postino node scripts/reset-password.mjs` (signs every device out, turns 2FA off and removes fingerprint sign-ins).
- **An account shows "Login refused"**: open Settings → Accounts → Edit, re-enter the mailbox password. For Gmail/iCloud use an *app password*.
- **"Certificate problem"** on a provider with a bad TLS certificate: add `POSTINO_TLS_INSECURE=1` to `.env` (only if you trust the network) and `docker compose up -d`.
- **No notifications on the phone**: the site must be opened over HTTPS and added to the home screen; then Settings → Notifications → Enable, and allow notifications in Android's prompt. "Send test" shows whether the phone is registered.
- **Google Drive buttons missing**: Settings → Google Drive must show "Connected". If Google refuses the redirect, the URI in the Google Cloud console must match the one shown there exactly.
- **Mail is not arriving live**: Settings → Accounts shows a red dot when the IMAP connection dropped; Postino reconnects by itself (retrying up to once a minute). `docker compose logs -f postino` shows why.
- **Disk**: `data/attachments` is a cache capped at 2 GB (change with `POSTINO_ATTACHMENT_CACHE_MB` in `.env`); the least recently opened files are dropped and fetched again when needed. `data/avatars` can be deleted at any time.
- **Backups**: your mail stays on the mail servers, so a lost server loses no email. What lives only in Postino (settings, templates, signatures, blocked senders, unsent drafts, the list of mailboxes) is covered by **Settings → Backup**: download the file, or connect Google Drive and a copy is saved every night in a "Postino backups" folder (copies older than 30 days are deleted). On a new server, the setup's first step has **Restore from a backup**: pick the file, then type each mailbox password (passwords are never in the backup).
- **Full server copy**: `scripts/backup.sh` also runs nightly on the server itself (the whole database plus the key). Restore = stop the app, replace `data/postino.db` and `data/secret.key`, start it again.
- **Logs**: `docker compose logs --tail 200 postino`.

## Security notes

- All API calls need the session cookie; login is rate-limited; 2FA is optional.
- A fresh install needs a one-time setup code (printed by the installer and in the log) before a password can be created.
- Account passwords are encrypted with AES-256-GCM using a key derived from `POSTINO_SECRET`. A placeholder or weak secret refuses to start.
- Email HTML is sanitized on the server (no scripts, no forms, no event handlers) and shown
  in a sandboxed iframe; remote images are blocked until you ask to load them.
- Put the app behind HTTPS (the compose file does) and use a long password.
