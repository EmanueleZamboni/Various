# WhatsApp connector for Claude

Lets Claude read and search your personal WhatsApp. It is read-only: it can't send
anything, to anyone. It links to your
account as an extra device, exactly like WhatsApp Web, and speaks MCP, the protocol Claude
uses for connectors.

| Claude can | Tool |
|---|---|
| See connection state and how much history is stored | `whatsapp_status` |
| List chats, newest first, with unread counts | `list_chats` |
| Read a chat (by name, phone number or id, optionally a date range) | `read_messages` |
| Search all chats, or one chat or person, ignoring case and accents | `search_messages` |
| Look up a contact or group | `find_contact` |
| Download photos, videos, voice notes and documents (and look at photos) | `download_media` |

> **Unofficial.** WhatsApp has no API for personal accounts, so this uses
> [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source WhatsApp Web client.
> Using an unofficial client breaks WhatsApp's terms, and Meta can ban numbers it flags.
> Bans hit accounts that send bulk or automated messages; this connector only reads,
> which is low-risk, but the risk isn't zero.

## How it works

```
 WhatsApp on your phone ──(linked device)── connector ──(MCP)── Claude
                                               │
                                       data/ (session keys,
                                       messages, media)
```

The first time you link, your phone sends the connector your recent chat history; after
that the connector stores every new message while it runs. Claude reads that local copy,
so it only sees messages from while the connector was running (plus the initial history).
Nothing is sent anywhere except to WhatsApp and to the Claude app you connect it to.

Your phone keeps working normally and still gets notifications. If the phone is offline
for about 14 days, WhatsApp unlinks the connector; run the login step again.

## Choose where it runs

| You use Claude in… | Run the connector | Setup |
|---|---|---|
| Claude Desktop or Claude Code on your computer | On that computer, started by Claude | [A](#a-on-your-computer-claude-desktop--claude-code) |
| The Claude phone app, claude.ai, and the desktop app too | On an always-on machine: a free Oracle Cloud server ([guide](docs/oracle-cloud.md)), a home PC or a Raspberry Pi | [B](#b-always-on-for-the-phone-app-and-claudeai) |

The Claude phone app can't start programs, so for the phone the connector has to run
somewhere that is always on and reachable over HTTPS. Claude's servers call it from the
internet. Setup B does this with Docker and a free Cloudflare tunnel, so you don't need a
domain or to open ports on your router.

No machine that stays on? [docs/oracle-cloud.md](docs/oracle-cloud.md) walks you through a
server that's free forever on Oracle Cloud, with this exact setup.

Only one copy may be connected at a time. If you start a second one (say Claude Desktop and
Claude Code both start it), the extra copies can read stored messages but not download media.

## A. On your computer (Claude Desktop / Claude Code)

Needs [Node.js](https://nodejs.org) 22.16 or newer (`node --version`).

```sh
cd whatsapp-connector
npm install
npm run login
```

A QR code appears in the terminal. On your phone open **WhatsApp → Settings → Linked
devices → Link a device** and scan it. Then keep WhatsApp open on the phone while the
history downloads (a few minutes; the command exits by itself).

No second screen? Use a pairing code instead: `npm run login -- --phone 393331234567`
(your number with country code, digits only), then on the phone pick
**Link with phone number instead** and type the 8-character code.

**Claude Desktop:** Settings → Developer → Edit Config, and add (with your real path):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/full/path/to/whatsapp-connector/src/cli.js", "serve"]
    }
  }
}
```

On Windows write the path as `C:\\Users\\you\\whatsapp-connector\\src\\cli.js`. Restart
Claude Desktop; WhatsApp appears in the tools menu (the sliders icon) of a new chat.

**Claude Code:**

```sh
claude mcp add whatsapp --scope user -- node --disable-warning=ExperimentalWarning /full/path/to/whatsapp-connector/src/cli.js serve
```

## B. Always-on, for the phone app and claude.ai

Needs a machine that stays on with [Docker](https://docs.docker.com/get-docker/)
(Docker Desktop on a home computer works, as does any small Linux server or Raspberry Pi).
For a free Oracle Cloud server, follow [docs/oracle-cloud.md](docs/oracle-cloud.md) instead.

```sh
cd whatsapp-connector
cp .env.example .env
openssl rand -hex 24          # paste the result after MCP_TOKEN= in .env
docker compose build
docker compose run --rm whatsapp login      # scan the QR (or add: --phone 393331234567)
docker compose up -d
docker compose logs tunnel | grep trycloudflare.com
```

The last command prints your address, like `https://some-words.trycloudflare.com`. Your
connector URL is that address plus `/mcp/` plus your token:

```
https://some-words.trycloudflare.com/mcp/<your MCP_TOKEN>
```

Treat this URL like a password: anyone who has it can read your WhatsApp messages.

Add it to Claude once, on claude.ai in a browser: **Settings → Connectors → Add custom
connector**, name it `WhatsApp`, paste the URL, and click **Add**. It then shows up in the
Claude app on your phone and desktop with the same account: in a chat, tap the tools
(sliders) button and turn WhatsApp on.

The free quick tunnel gets a new address whenever the tunnel container restarts. Then run
the `logs` command again and edit the connector's URL in claude.ai. For an address that
never changes, you need a domain of your own (about €10 a year) on a free Cloudflare
account and a named tunnel; see the comment in `docker-compose.yml`.

Useful commands: `docker compose logs -f whatsapp` (connection log),
`docker compose restart whatsapp`, `docker compose down` (stop).

### Without Docker

```sh
npm install && npm run login
MCP_TOKEN=... npm run start:http -- --host 0.0.0.0 --port 8787
```

Then make `http://<machine>:8787` reachable over HTTPS (Cloudflare Tunnel, Tailscale
Funnel, Caddy, ...), and use `https://<public address>/mcp/<MCP_TOKEN>` as above.

## Using it

Ask Claude in plain language, for example:

- "What did I miss on WhatsApp today?"
- "Summarise the Calcetto group from this week."
- "Find the address Laura sent me last month."
- "Which messages did I leave unanswered this week?"
- "Show me the photo Giulia sent this morning."

Messages are written by other people, and a message could try to give Claude instructions
("ignore previous instructions and…"). Claude is told to treat message text as information
only. The connector has no way to send, so the worst case is limited to what Claude does
with your other connectors: keep confirming actions such as sending email.

## Your data

Everything lives in `data/` (setup A) or the `whatsapp-data` Docker volume (setup B):

| Path | What |
|---|---|
| `auth/` | The linked-device keys. Anyone with these can use your WhatsApp. |
| `store.db` | Chats, contacts and messages (SQLite) |
| `media/` | Files fetched with `download_media` |

`data/` and `.env` are git-ignored. To unlink: `npm run logout`
(or `docker compose run --rm whatsapp logout` after `docker compose stop whatsapp`),
or remove the device on the phone under **Linked devices**. Delete `data/`
(or `docker volume rm whatsapp-connector_whatsapp-data`) to erase the stored messages.

## Troubleshooting

| You see | Fix |
|---|---|
| "WhatsApp is not linked yet" | Run the login step. In setup B, then `docker compose restart whatsapp`. |
| "This device was logged out from the phone" | Someone removed it under Linked devices, or the phone was offline ~14 days. Log in again. |
| "Another copy of the connector…" | Close the other Claude app or terminal that started it, or stop the Docker container. |
| Few or no old messages | WhatsApp sends history only once, at login, and decides how much (usually months for active chats). Keep WhatsApp open on the phone during login. To redo it: logout, delete `store.db`, login. |
| Contacts shown as numbers | Names arrive with the history sync and from people's WhatsApp profile names; give it a few minutes after login. |
| QR expires before you scan it | Run login again, or use `--phone` for a pairing code. |
| Connector not showing in the phone app | Add it on claude.ai in a browser first; it syncs to the app. Check the URL ends in `/mcp/<token>`. |
| `Connection Failure` / 405 at login | Update Baileys: `npm install baileys@latest`. WhatsApp changes its protocol now and then. |
