#!/usr/bin/env python3
"""End-to-end check of the sandbox image: a stand-in for the API's device
endpoints drives the helper inside a container through a short script
(open an editor, type into it, read it back, press a menu by ref) and
fails on any wrong answer.

    python3 sandbox/smoke.py [--image computer-sandbox] [--out DIR]

Needs Docker. --out keeps the last screenshot and the helper's log.
"""

import argparse
import base64
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "smoke-" + uuid.uuid4().hex
TEXT = "An old silent pond\nA frog jumps into the pond"

commands: "queue.Queue[dict]" = queue.Queue()
results: "dict[str, queue.Queue]" = {}
heartbeats: list = []


class Api(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def authorized(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_response(401)
            self.end_headers()
            return False
        return True

    def reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.authorized():
            return
        if self.path.startswith("/computers/device/next"):
            try:
                self.reply(200, commands.get(timeout=5))
            except queue.Empty:
                self.reply(204)
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
        if self.path == "/computers/device/heartbeat":
            heartbeats.append(body)
            self.reply(200, {"ok": True})
        elif self.path.startswith("/computers/device/results/"):
            command_id = self.path.rsplit("/", 1)[1]
            results.setdefault(command_id, queue.Queue()).put(body)
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})


def send(command, timeout=60):
    command["id"] = str(uuid.uuid4())
    results[command["id"]] = queue.Queue()
    commands.put(command)
    result = results[command["id"]].get(timeout=timeout)
    if not result.get("ok"):
        raise AssertionError(f"{command['type']} failed: {result.get('error')}")
    return result.get("observation") or result.get("act")


def observe(screenshot=False):
    return send({"type": "observe", "screenshot": screenshot, "max_elements": 150})


def act(frame_id, *actions):
    result = send({"type": "act", "frame_id": frame_id, "actions": list(actions)})
    if result.get("stopped_reason"):
        raise AssertionError(f"act stopped: {result['stopped_reason']}")
    return result


def scenario(out):
    first = observe()
    act(first["frame_id"], {"type": "open_app", "name": "Mousepad"}, {"type": "wait", "ms": 1500})
    opened = observe()
    app = (opened.get("app") or {}).get("bundle_id") or ""
    assert "mousepad" in app.lower(), f"Mousepad is not in front: {opened.get('app')}"
    act(opened["frame_id"], {"type": "type", "text": TEXT}, {"type": "wait", "ms": 300})
    typed = observe(screenshot=True)
    if out:
        shot = typed.get("screenshot")
        if shot:
            with open(os.path.join(out, "screenshot.jpg"), "wb") as f:
                f.write(base64.b64decode(shot["data"]))
        with open(os.path.join(out, "observation.json"), "w") as f:
            typed = dict(typed)
            if typed.get("screenshot"):
                typed["screenshot"] = {**typed["screenshot"], "data": "…"}
            json.dump(typed, f, indent=2)
    shot = typed.get("screenshot")
    assert shot and shot["width"] == 1280 and shot["height"] == 800, typed.get("screenshot_note")
    areas = [e for e in typed["elements"] if e["role"] == "textarea"]
    assert any("silent pond" in (e.get("value") or "") for e in areas), (
        f"the typed text is not in the editor: {[e.get('value') for e in areas]}; "
        f"note: {typed.get('elements_note')}"
    )
    menus = [e for e in typed["elements"] if e["role"] in ("menu", "menuitem") and e.get("title")]
    assert menus, "no menus listed"
    act(typed["frame_id"], {"type": "click", "ref": menus[0]["ref"]}, {"type": "key", "combo": "escape"})
    refused = send({"type": "act", "frame_id": "stale", "actions": [{"type": "click", "ref": "e1"}]})
    assert refused.get("stopped_reason", "").startswith("stale frame"), refused
    assert heartbeats and heartbeats[0]["platform"] == "sandbox", heartbeats[:1]
    assert heartbeats[0]["capabilities"]["coordinates"] == "screen"
    return len(typed["elements"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="computer-sandbox")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.out:
        os.makedirs(args.out, exist_ok=True)

    server = ThreadingHTTPServer(("0.0.0.0", 0), Api)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    name = "computer-sandbox-smoke-" + uuid.uuid4().hex[:8]
    subprocess.run(
        [
            "docker", "run", "-d", "--rm", "--name", name,
            "--add-host=host.docker.internal:host-gateway",
            "-e", f"COMPUTER_SERVER_URL=http://host.docker.internal:{port}",
            "-e", f"COMPUTER_DEVICE_TOKEN={TOKEN}",
            args.image,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    ok = False
    try:
        started = time.monotonic()
        count = scenario(args.out)
        print(f"sandbox smoke: ok ({count} elements, {time.monotonic() - started:.1f} s)")
        ok = True
    except (AssertionError, queue.Empty) as e:
        print(f"sandbox smoke: FAILED: {e or 'timed out waiting for the helper'}", file=sys.stderr)
    finally:
        log = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
        if args.out:
            with open(os.path.join(args.out, "helper.log"), "w") as f:
                f.write(log.stdout + log.stderr)
        if not ok:
            print(log.stdout + log.stderr, file=sys.stderr)
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        server.shutdown()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
