"""Run as root by keep-mcp-token.service when Postino drops the Google sign-in cookie.

Swaps the one-time oauth_token cookie for the Keep master token (what get_token.py does),
stores it only in /etc/keep-mcp.env, deletes the cookie, restarts keep-mcp and checks it.
Writes a status file (never the token) and, on success, the connector URL for Postino to
show once. Nothing secret is printed, so nothing reaches the journal.
"""
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

OPS = sys.argv[1]
ENVF = "/etc/keep-mcp.env"
COOKIE = os.path.join(OPS, "keep-cookie")


def put(name: str, text: str) -> None:
    st = os.stat(OPS)
    path = os.path.join(OPS, name)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, path)


def status(stage: str, detail: str = "") -> None:
    put("keep-status", json.dumps({"stage": stage, "detail": detail, "at": datetime.now(timezone.utc).isoformat()}))


def read_env() -> dict:
    out = {}
    for line in open(ENVF).read().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.split("#", 1)[0].strip() if k.strip() == "KEEP_MCP_SECRET" else v.strip()
    return out


def write_env(updates: dict) -> None:
    st = os.stat(ENVF)
    lines = open(ENVF).read().splitlines()
    done = set()
    for i, line in enumerate(lines):
        k = line.split("=", 1)[0].strip()
        if k in updates:
            lines[i] = f"{k}={updates[k]}"
            done.add(k)
    lines += [f"{k}={v}" for k, v in updates.items() if k not in done]
    tmp = ENVF + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, ENVF)


def main() -> None:
    try:
        raw = open(COOKIE).read()
    except FileNotFoundError:
        return
    finally:
        try:
            os.unlink(COOKIE)  # one-time: never left lying around
        except FileNotFoundError:
            pass
    try:
        data = json.loads(raw)
        email, cookie = str(data["email"]).strip(), str(data["cookie"]).strip()
    except (ValueError, KeyError):
        status("error", "Bad request from Postino")
        return
    status("exchanging")
    import gpsoauth  # from the keep-mcp venv

    res = gpsoauth.exchange_token(email, cookie, secrets.token_hex(8))
    token = res.get("Token")
    del cookie
    if not token:
        err = str(res.get("Error", "unknown"))[:80]
        status("error", f"Google refused the sign-in ({err}). The cookie expires in minutes: sign in again and paste it right away.")
        return
    write_env({"KEEP_EMAIL": email, "KEEP_MASTER_TOKEN": token})
    del token
    subprocess.run(["systemctl", "restart", "keep-mcp"], check=False)
    env = read_env()
    url = f"http://{env['KEEP_BIND']}:{env.get('KEEP_PORT', '8765')}/{env['KEEP_MCP_SECRET']}/mcp"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "postino", "version": "1"}}}).encode()
    for _ in range(30):
        time.sleep(2)
        try:
            req = urllib.request.Request(url, data=body, method="POST", headers={"Host": env["KEEP_PUBLIC_HOST"], "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
            with urllib.request.urlopen(req, timeout=10) as r:
                if b"serverInfo" in r.read():
                    put("keep-url", f"https://{env['KEEP_PUBLIC_HOST']}/keep/{env['KEEP_MCP_SECRET']}/mcp")
                    status("connected")
                    return
        except Exception:
            continue
    active = subprocess.run(["systemctl", "is-active", "keep-mcp"], capture_output=True, text=True).stdout.strip()
    status("error", f"Signed in, but the Keep service did not answer (service {active}).")


main()
