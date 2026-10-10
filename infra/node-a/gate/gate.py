"""A shared-password gate in front of the whole staging site.

Caddy asks GET /verify (forward_auth) before every request. A browser that has
entered the password carries a signed cookie and passes; anything else is sent
to the password page (GET /__gate). A correct password sets the cookie for a
year, so a device is asked once. A wrong one is logged as

    gate: wrong password from <ip>

which fail2ban counts (infra/node-a/gate.nix): five within an hour block that
address from ports 80 and 443 for a day.

Files:
    /var/lib/mike-gate-secret/password  the shared password, written by the
                                        operator (root only, never committed),
                                        passed in as a systemd credential
    <state directory>/key               the cookie signing key, generated on
                                        first start
"""

from __future__ import annotations

import hashlib
import hmac
import html
import os
import secrets
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = os.environ.get("STATE_DIRECTORY", "/var/lib/mike-gate").split(":")[0]
COOKIE = "mike_gate"
MAX_AGE = 365 * 24 * 3600
TRUSTED = {ip.strip() for ip in os.environ.get("GATE_TRUSTED_IPS", "").split(",") if ip.strip()}
LISTEN = ("127.0.0.1", int(os.environ.get("GATE_PORT", "9180")))


def read_or_create_key() -> bytes:
    path = os.path.join(STATE, "key")
    if not os.path.exists(path):
        with open(path, "wb") as fh:
            os.fchmod(fh.fileno(), 0o600)
            fh.write(secrets.token_bytes(32))
    with open(path, "rb") as fh:
        return fh.read()


KEY = read_or_create_key()


def password() -> str | None:
    # systemd hands the operator's root-only file over as a credential.
    directory = os.environ.get("CREDENTIALS_DIRECTORY") or STATE
    try:
        with open(os.path.join(directory, "password"), encoding="utf-8") as fh:
            value = fh.read().strip()
        return value or None
    except OSError:
        return None


def sign(issued: str) -> str:
    return hmac.new(KEY, f"v1.{issued}".encode(), hashlib.sha256).hexdigest()


def new_cookie() -> str:
    issued = str(int(time.time()))
    return f"v1.{issued}.{sign(issued)}"


def cookie_ok(header: str | None) -> bool:
    if not header:
        return False
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name != COOKIE:
            continue
        version, _, rest = value.partition(".")
        issued, _, mac = rest.partition(".")
        if version != "v1" or not issued.isdigit() or not mac:
            continue
        if int(issued) + MAX_AGE < time.time():
            continue
        if hmac.compare_digest(mac, sign(issued)):
            return True
    return False


def safe_next(value: str | None) -> str:
    """Only same-site paths, never another host."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    return value


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private preview</title>
<style>
  :root {{ color-scheme: light dark; --bg: #f9fafb; --card: #fdfdfe; --text: #111827; --muted: #6b7280; --line: #e5e7eb; --accent: rgb(0, 136, 255); }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg: #0b0c0f; --card: #15171c; --text: #f3f4f6; --muted: #9ca3af; --line: #2a2d35; }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
         font: 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }}
  main {{ width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px; }}
  h1 {{ font: 500 26px/1.2 "EB Garamond", Georgia, serif; margin: 0 0 6px; }}
  p {{ margin: 0 0 18px; color: var(--muted); font-size: 14px; }}
  label {{ display: block; font-size: 13px; margin-bottom: 6px; }}
  input {{ width: 100%; font-size: 16px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: transparent; color: var(--text); }}
  input:focus-visible, button:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
  button {{ margin-top: 14px; width: 100%; font-size: 15px; padding: 10px 12px; border: 0; border-radius: 999px; background: var(--text); color: var(--bg); cursor: pointer; }}
  .error {{ color: #dc2626; font-size: 14px; margin: 12px 0 0; }}
</style>
</head>
<body>
<main>
  <h1>Private preview</h1>
  <p>Enter the access password to continue.</p>
  <form method="post" action="/__gate">
    <input type="hidden" name="next" value="{next}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Continue</button>
    {error}
  </form>
</main>
</body>
</html>
"""


class Gate(BaseHTTPRequestHandler):
    server_version = "gate"
    sys_version = ""

    def client_ip(self) -> str:
        # Caddy sets X-Forwarded-For to the connecting address; it trusts no
        # upstream proxy, so a client cannot choose this value.
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # only failures are logged, for fail2ban

    def send(self, status: int, body: str = "", headers: dict[str, str] | None = None) -> None:
        data = body.encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        if body:
            self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if data and self.command != "HEAD":
            self.wfile.write(data)

    def page(self, status: int, next_path: str, error: str = "") -> None:
        block = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
        self.send(status, PAGE.format(next=html.escape(next_path, quote=True), error=block))

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path)
        if path.path == "/verify":
            if self.client_ip() in TRUSTED or cookie_ok(self.headers.get("Cookie")):
                self.send(200)
                return
            uri = self.headers.get("X-Forwarded-Uri", "/")
            method = self.headers.get("X-Forwarded-Method", "GET")
            accept = self.headers.get("Accept", "")
            if method == "GET" and "text/html" in accept:
                target = "/__gate?" + urllib.parse.urlencode({"next": safe_next(uri)})
                self.send(302, headers={"Location": target})
            else:
                self.send(401)
            return
        if path.path == "/__gate":
            query = urllib.parse.parse_qs(path.query)
            next_path = safe_next((query.get("next") or ["/"])[0])
            if cookie_ok(self.headers.get("Cookie")):
                self.send(302, headers={"Location": next_path})
                return
            self.page(200, next_path)
            return
        self.send(404)

    do_HEAD = do_GET  # noqa: N815

    def do_POST(self) -> None:  # noqa: N802
        if urllib.parse.urlsplit(self.path).path != "/__gate":
            self.send(404)
            return
        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        form = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        given = (form.get("password") or [""])[0]
        next_path = safe_next((form.get("next") or ["/"])[0])
        expected = password()
        if expected and hmac.compare_digest(given.encode(), expected.encode()):
            cookie = f"{COOKIE}={new_cookie()}; Max-Age={MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=None"
            self.send(303, headers={"Location": next_path, "Set-Cookie": cookie})
            return
        print(f"gate: wrong password from {self.client_ip()}", flush=True)
        time.sleep(1)
        self.page(401, next_path, "That password is not right.")


if __name__ == "__main__":
    if password() is None:
        print("gate: no password file; every request will be refused", file=sys.stderr, flush=True)
    ThreadingHTTPServer(LISTEN, Gate).serve_forever()
