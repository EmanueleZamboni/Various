# YouTube Analytics

Reads your channel's analytics through Google's official YouTube Analytics API:
views, watch time, subscribers, top videos, traffic sources, countries, devices,
audience age and gender, and revenue if your channel is monetized.
Plain Python 3, nothing to install.

| File | What it does | Where you run it |
|---|---|---|
| `get_refresh_token.py` | One-time Google sign-in; prints the three values below | Your computer (it needs a browser) |
| `yt_analytics.py` | Fetches the reports, prints a summary, saves CSV files | A Claude Code session, or anywhere |

Access is read-only: the scripts can't change anything on your channel.

## Setup (once, about 15 minutes)

### 1. Create a Google Cloud project and OAuth client

1. Go to <https://console.cloud.google.com/> and create a project (any name, e.g. `yt-analytics`).
2. In **APIs & Services → Library**, enable **YouTube Analytics API** and **YouTube Data API v3**.
3. Open **Google Auth Platform** (called **OAuth consent screen** in older consoles) and click
   **Get started**. Use app name `yt-analytics`, your email as support and contact email,
   and audience **External**.
4. Under **Audience**, click **Publish app** so the status is **In production**.
   In *Testing* mode Google cancels your sign-in every 7 days. You don't need to submit
   the app for verification.
5. Under **Clients**, click **Create client**, choose **Desktop app**, then **Create**.
   Click **Download JSON** right away (newer consoles show the secret only once) and save
   the file as `client_secret.json` next to `get_refresh_token.py`.

### 2. Sign in (on your computer)

```sh
python3 get_refresh_token.py client_secret.json
```

On Windows use `py` instead of `python3`. Add `--revenue` if your channel is monetized
and you want revenue numbers too.

Your browser opens:

- Choose the Google account that owns the channel. If you manage several channels,
  Google asks which one; pick the one you want.
- Google warns **"Google hasn't verified this app"**. That's expected for your own app:
  click **Advanced → Go to yt-analytics (unsafe)**, then allow access and tick every box.

The terminal then shows your channel name and three lines:

```
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=...
```

### 3. Give them to Claude Code

In Claude Code on the web, open the environment menu in the session's title bar, click
**Edit**, and add the three lines under API credentials (or as environment variables if
there's no such section). Then start a new session; it picks them up.

Keep these values private: never paste them into a chat or commit them.
`client_secret*.json` is git-ignored.

## Usage

```sh
python3 yt_analytics.py                               # last 28 days, ending yesterday
python3 yt_analytics.py --days 90
python3 yt_analytics.py --start 2026-01-01 --end 2026-06-30
python3 yt_analytics.py --currency EUR                # revenue currency (default USD)
```

It prints a summary and writes one CSV per report to `output/<start>_<end>/` (git-ignored):
`totals`, `daily`, `top_videos` (up to 200), `traffic_sources`, `countries`, `devices`,
`demographics`, and `revenue_daily` if you signed in with `--revenue`.

YouTube's numbers lag by 2–3 days, so the latest days may be missing or incomplete.

## No Python on your computer?

Replace step 2 with Google's OAuth Playground:

1. In **Google Auth Platform → Clients**, create a second client of type **Web application**
   and add `https://developers.google.com/oauthplayground` under **Authorized redirect URIs**.
2. Open <https://developers.google.com/oauthplayground>, click the gear icon, tick
   **Use your own OAuth credentials** and paste that client's ID and secret.
3. In **Input your own scopes** on the left, paste
   `https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly`
   (add `https://www.googleapis.com/auth/yt-analytics-monetary.readonly` for revenue),
   click **Authorize APIs** and sign in as described in step 2.
4. Click **Exchange authorization code for tokens** and copy the **Refresh token**.

In step 3, use the Web client's ID and secret with that refresh token.

## Troubleshooting

| You see | Fix |
|---|---|
| `invalid_grant`, "expired or revoked" | Redo step 2. If it happens every week, the app is still in *Testing*; publish it (step 1.4). |
| "Access blocked: ... has not completed the Google verification process" | The app is in *Testing*; publish it (step 1.4). |
| "... API has not been used in project ... or it is disabled" | Enable the API named in the message (step 1.2), wait a minute, try again. |
| `CERTIFICATE_VERIFY_FAILED` (macOS) | Run **Install Certificates.command** in your Python folder under Applications. |
| Revenue missing | Redo step 2 with `--revenue`. Revenue only exists for channels in the YouTube Partner Program. |
| Audience "no data" | YouTube hides age and gender data when the audience is too small. |
