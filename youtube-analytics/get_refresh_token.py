#!/usr/bin/env python3
"""Sign in to Google once and print the refresh token yt_analytics.py needs.

Run it on your own computer, because it opens your browser:

    python3 get_refresh_token.py client_secret.json [--revenue]

client_secret.json is the "Desktop app" OAuth client downloaded from Google
Cloud (see README.md). Uses only the Python standard library.
"""

import argparse
import base64
import hashlib
import http.server
import json
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"

SCOPES = [
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.readonly",
]
REVENUE_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"


class GoogleError(Exception):
    pass


def request_json(url, data=None, token=None):
    """GET url (POST if data is given) and return the decoded JSON response."""
    req = urllib.request.Request(url, data=data)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        raise GoogleError(describe(err)) from None


def describe(err):
    """Google's error message from the body of an HTTPError."""
    try:
        body = json.load(err)
    except ValueError:
        return f"HTTP {err.code}"
    error = body.get("error")
    if isinstance(error, dict):  # API error
        return error.get("message", f"HTTP {err.code}")
    if error:  # OAuth error
        return f"{error}: {body.get('error_description', '')}".rstrip(": ")
    return f"HTTP {err.code}"


class RedirectHandler(http.server.BaseHTTPRequestHandler):
    """Receives Google's redirect back to http://127.0.0.1:<port>/?code=..."""

    def do_GET(self):
        params = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
        if "code" not in params and "error" not in params:
            self.send_error(404)  # e.g. the browser asking for /favicon.ico
            return
        self.server.params = params
        message = ("Signed in. You can close this tab and go back to the terminal."
                   if "code" in params else "Sign-in didn't complete. Check the terminal.")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"<!doctype html><title>YouTube sign-in</title><p>{message}</p>".encode())

    def log_message(self, format, *args):
        pass  # keep the terminal quiet


def load_client(path):
    try:
        with open(path, encoding="utf-8") as f:
            client = json.load(f).get("installed")
    except (OSError, ValueError) as err:
        sys.exit(f"Couldn't read {path}: {err}")
    if not client:
        sys.exit(f"{path} isn't a 'Desktop app' OAuth client. Create one in Google Cloud "
                 "(Clients > Create client > Desktop app) and download its JSON.")
    return client["client_id"], client["client_secret"]


def sign_in(client_id, client_secret, scopes, open_browser):
    """Run Google's loopback sign-in flow and return the token response."""
    server = http.server.HTTPServer(("127.0.0.1", 0), RedirectHandler)
    server.params = None
    server.timeout = 1  # wake up every second so Ctrl+C also works on Windows
    redirect_uri = f"http://127.0.0.1:{server.server_address[1]}/"
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(scopes),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })

    print("Sign in with the Google account that owns your YouTube channel:\n\n" + url + "\n", flush=True)
    if open_browser:
        webbrowser.open(url)
    print("Waiting for the browser... (Ctrl+C to cancel)", flush=True)
    try:
        while server.params is None:
            server.handle_request()
    finally:
        server.server_close()

    params = server.params
    if params.get("state") != state:
        sys.exit("Sign-in failed: unexpected response. Please run the script again.")
    if "code" not in params:
        sys.exit(f"Sign-in failed: {params.get('error')}")
    return request_json(TOKEN_URL, data=urllib.parse.urlencode({
        "code": params["code"],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": verifier,
    }).encode())


def main():
    parser = argparse.ArgumentParser(description="Sign in to Google once and print a refresh token for yt_analytics.py.")
    parser.add_argument("client_secret", help="the 'Desktop app' OAuth client JSON downloaded from Google Cloud")
    parser.add_argument("--revenue", action="store_true", help="also allow reading revenue (monetized channels only)")
    parser.add_argument("--no-browser", action="store_true", help="only print the sign-in link, don't open a browser")
    args = parser.parse_args()

    client_id, client_secret = load_client(args.client_secret)
    scopes = SCOPES + ([REVENUE_SCOPE] if args.revenue else [])
    tokens = sign_in(client_id, client_secret, scopes, not args.no_browser)

    granted = tokens.get("scope")
    missing = set(scopes) - set(granted.split()) if granted else set()
    if missing:
        sys.exit("You didn't allow every permission (" + ", ".join(sorted(missing)) + ").\n"
                 "Run the script again and tick every box on Google's permission screen.")
    if "refresh_token" not in tokens:
        sys.exit("Google didn't return a refresh token. Please run the script again.")

    try:
        channels = request_json(CHANNELS_URL, token=tokens["access_token"]).get("items", [])
    except GoogleError as err:
        print(f"\nSigned in, but couldn't look up your channel: {err}")
    else:
        if not channels:
            sys.exit("This Google account has no YouTube channel. Run the script again and pick "
                     "the account (or brand account) that owns your channel.")
        print(f"\nSigned in to YouTube channel: {channels[0]['snippet']['title']}")

    print("\nAdd these three lines to your Claude Code cloud environment (environment menu in the\n"
          "session title bar > Edit > API credentials, or environment variables).\n"
          "Keep them private: don't paste them into a chat or commit them.\n")
    print(f"YOUTUBE_CLIENT_ID={client_id}")
    print(f"YOUTUBE_CLIENT_SECRET={client_secret}")
    print(f"YOUTUBE_REFRESH_TOKEN={tokens['refresh_token']}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
    except GoogleError as err:
        sys.exit(f"Google returned an error: {err}")
    except urllib.error.URLError as err:
        hint = ""
        if isinstance(err.reason, ssl.SSLCertVerificationError):
            hint = ("\nOn macOS, run 'Install Certificates.command' from your Python folder "
                    "in Applications, then try again.")
        sys.exit(f"Network error: {err.reason}{hint}")
