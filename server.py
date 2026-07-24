#!/usr/bin/env python3
"""Static file server + same-origin proxy for /api/dashboard.

verathos.ai's API does not send Access-Control-Allow-Origin, so a browser
fetch() from this app's origin gets blocked by CORS. Proxying the request
through this local server keeps everything same-origin.

Usage: python3 server.py [port]
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

UPSTREAM = "https://verathos.ai/api/dashboard"
MINER_DEBUG_UPSTREAM_BASE = "https://api.verathos.ai/v1/miner-debug"
MINER_DEBUG_PATH_RE = re.compile(r'^/api/miner-debug/(\d+)(?:/entries/(\d+))?$')
TELEGRAM_SEND_PATH = "/api/telegram/send-message"
TELEGRAM_TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]+$")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


def free_port(port):
    """Kill whatever is already listening on `port` so a restart never hits
    'Address already in use' — this script is meant to be re-run freely."""
    try:
        out = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5,
        ).stdout.split()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return
    pids = {int(p) for p in out if int(p) != os.getpid()}
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if pids:
        time.sleep(0.5)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.3)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/dashboard"):
            self.proxy_dashboard()
        elif self.path.startswith("/api/miner-debug/"):
            self.proxy_miner_debug()
        else:
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path == TELEGRAM_SEND_PATH:
            self.send_telegram_message()
        else:
            self.send_json(404, json.dumps({"error": "not found"}).encode())

    def proxy_dashboard(self):
        try:
            req = urllib.request.Request(UPSTREAM, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
            self.send_json(200, body)
        except Exception as exc:
            self.send_json(502, json.dumps({"error": f"proxy failed: {exc}"}).encode())

    def proxy_miner_debug(self):
        """Proxies the public miner-debug API (also lacks CORS headers)."""
        split = urlsplit(self.path)
        m = MINER_DEBUG_PATH_RE.match(split.path)
        if not m:
            self.send_json(400, json.dumps({"error": "invalid miner-debug path"}).encode())
            return
        uid, model_index = m.groups()
        upstream_path = f"/{uid}" + (f"/entries/{model_index}" if model_index else "")
        upstream_url = MINER_DEBUG_UPSTREAM_BASE + upstream_path
        if split.query:
            upstream_url += f"?{split.query}"
        try:
            req = urllib.request.Request(upstream_url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                self.send_json(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            self.send_json(exc.code, exc.read())
        except Exception as exc:
            self.send_json(502, json.dumps({"error": f"proxy failed: {exc}"}).encode())

    def send_telegram_message(self):
        """Sends Telegram messages without exposing the bot API to browser CORS."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > 65536:
            self.send_json(400, json.dumps({"error": "invalid request size"}).encode())
            return

        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, json.dumps({"error": "invalid JSON body"}).encode())
            return

        token = str(payload.get("bot_token", "")).strip()
        chat_id = str(payload.get("chat_id", "")).strip()
        text = str(payload.get("text", ""))
        if not TELEGRAM_TOKEN_RE.fullmatch(token):
            self.send_json(400, json.dumps({"error": "invalid Telegram bot token"}).encode())
            return
        if not chat_id or any(char.isspace() for char in chat_id):
            self.send_json(400, json.dumps({"error": "invalid Telegram chat ID"}).encode())
            return
        if not text or len(text) > 4096:
            self.send_json(400, json.dumps({"error": "message must contain 1-4096 characters"}).encode())
            return

        upstream_url = f"https://api.telegram.org/bot{quote(token, safe=':')}/sendMessage"
        upstream_body = json.dumps({"chat_id": chat_id, "text": text}).encode()
        request = urllib.request.Request(
            upstream_url,
            data=upstream_body,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                self.send_json(response.status, response.read())
        except urllib.error.HTTPError as exc:
            self.send_json(exc.code, exc.read())
        except Exception as exc:
            self.send_json(502, json.dumps({"error": f"Telegram request failed: {exc}"}).encode())

    def send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    free_port(PORT)
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"✔ Verathos dashboard running successfully at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
