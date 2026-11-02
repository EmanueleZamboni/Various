"""One-time: swap the oauth_token cookie for a Keep master token.

1. In a private browser window open https://accounts.google.com/EmbeddedSetup
   and sign in. Ignore the endless spinner at the end.
2. DevTools > Application > Cookies: copy the value of `oauth_token`
   (starts with oauth2_4/). It expires within minutes.
3. Run: python get_token.py  and paste when asked.
"""
import getpass
import secrets

import gpsoauth

email = input("Google email: ").strip()
oauth_token = getpass.getpass("oauth_token cookie: ").strip()
android_id = secrets.token_hex(8)

res = gpsoauth.exchange_token(email, oauth_token, android_id)
token = res.get("Token")
if not token:
    raise SystemExit(f"Failed: {res.get('Error', res)}")
print("\nKEEP_MASTER_TOKEN=" + token)
print("Store it only in /etc/keep-mcp.env (chmod 600). It grants full account access.")
