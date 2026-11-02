# Free always-on server on Oracle Cloud

Oracle Cloud's **Always Free** tier includes a small Linux server that never expires. The
connector runs there around the clock, and a free Cloudflare tunnel gives it the HTTPS
address that claude.ai and the Claude phone app need. Total cost: €0. Time: about 30 minutes.

Why not Cloudflare alone? Cloudflare Workers can't keep a WhatsApp session open around the
clock or keep a message database on disk. Here Cloudflare only provides the tunnel.

## 1. Create the Oracle account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Oracle asks for a credit or debit card to check you're a real person. Always Free
   resources aren't charged. Prepaid and virtual cards are often refused.
3. Pick a **home region** close to you (e.g. *Italy Northwest (Milan)*). You can't change it
   later, and free servers can only be created there.

## 2. Create the server

In the Oracle console: **☰ → Compute → Instances → Create instance**.

| Setting | Choose |
|---|---|
| Name | `whatsapp` |
| Image | **Change image → Ubuntu → Canonical Ubuntu 24.04** |
| Shape | **Change shape → Ampere → VM.Standard.A1.Flex**, 1 OCPU, 6 GB memory (labelled *Always Free-eligible*) |
| Networking | Leave the defaults (new network, public IPv4 address) |
| SSH keys | **Generate a key pair for me → Save private key** (keep this file) |

Click **Create** and wait until the state is *Running*. Copy the **Public IP address**.

If you get **"Out of capacity"** for the Ampere shape, try another *availability domain* in
the Placement section, try again in a few hours, or pick **VM.Standard.E2.1.Micro** (AMD,
1 GB RAM, also Always Free). The setup script adds swap so the small one works too.

You don't need to open any ports: the tunnel connects outwards.

### Keep Oracle from reclaiming it

Oracle may stop Always Free servers that look idle for 7 days (CPU, network and memory use
all under 20%). This connector is light, so it can look idle. To avoid that, upgrade the
account to **Pay As You Go** (☰ → Billing → Upgrade and manage payment). Always Free
resources stay free after the upgrade. Add a budget alert of €1 (☰ → Billing → Budgets) so
you get an email if anything ever would cost money.

## 3. Connect to the server

On your computer, in a terminal (on Windows: PowerShell):

```sh
chmod 600 ~/Downloads/ssh-key-*.key          # macOS/Linux only
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<public IP>
```

Type `yes` the first time. You're now on the server.

## 4. Install the connector

On the server:

```sh
curl -fsSL https://raw.githubusercontent.com/EmanueleZamboni/Various/main/whatsapp-connector/deploy/setup-vm.sh | sh
```

(Until this is merged into `main`, use the development branch:
`curl -fsSL https://raw.githubusercontent.com/EmanueleZamboni/Various/claude/whatsapp-connector-1e6dja/whatsapp-connector/deploy/setup-vm.sh | BRANCH=claude/whatsapp-connector-1e6dja sh`)

It installs Docker, downloads the code to `~/Various`, creates `.env` with a random secret
token, and builds the connector. Optional: `nano ~/Various/whatsapp-connector/.env` to change
the time zone (default `Europe/Rome`).

## 5. Link WhatsApp

```sh
cd ~/Various/whatsapp-connector
sudo docker compose run --rm whatsapp login --phone 393331234567
```

Use your own number, country code first, digits only. An 8-character code appears. On your
phone: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number
instead**, and type the code. (Without `--phone` you get a QR code to scan instead, if your
terminal shows it properly.)

Keep WhatsApp open on the phone while the history downloads. The command exits on its own
when it's done (a few minutes).

## 6. Start it and get the URL

```sh
sudo docker compose up -d
sh deploy/connector-url.sh
```

The last command prints something like
`https://some-words.trycloudflare.com/mcp/3f9c…`. That's your connector URL. Treat it like a
password.

## 7. Add it to Claude

On claude.ai in a browser: **Settings → Connectors → Add custom connector**. Name it
`WhatsApp`, paste the URL, and click **Add**. It appears in the Claude app on your phone and
your computer too. In a chat, open the tools menu and make sure WhatsApp is on. Then ask:
*"What did I miss on WhatsApp today?"*

## Day to day

| Task | Command (in `~/Various/whatsapp-connector`) |
|---|---|
| Is it connected? | `sudo docker compose logs --tail 20 whatsapp` |
| URL changed? (after a restart of the tunnel or server) | `sh deploy/connector-url.sh`, then edit the connector URL in claude.ai |
| Update to the latest code | `git pull && sudo docker compose up -d --build` |
| Re-link after "logged out" | `sudo docker compose stop whatsapp`, the login command from step 5, `sudo docker compose up -d` |
| Stop everything | `sudo docker compose down` |

The free quick tunnel keeps the same address as long as it runs, and it only changes when
the tunnel or the server restarts (rare). For an address that never changes you need your own
domain (about €10 a year) on a free Cloudflare account; see `docker-compose.yml`.

Your messages are stored on this server, in the `whatsapp-data` Docker volume. Only you can
log in to it (with your SSH key), and the connector only answers requests that carry your
token.
