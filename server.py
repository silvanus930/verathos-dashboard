#!/usr/bin/env python3
"""Static file server + same-origin proxy for /api/dashboard.

verathos.ai's API does not send Access-Control-Allow-Origin, so a browser
fetch() from this app's origin gets blocked by CORS. Proxying the request
through this local server keeps everything same-origin.

Usage: python3 server.py [port]
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

UPSTREAM = "https://verathos.ai/api/dashboard"
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
        else:
            super().do_GET()

    def proxy_dashboard(self):
        try:
            req = urllib.request.Request(UPSTREAM, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
            self.send_json(200, body)
        except Exception as exc:
            self.send_json(502, json.dumps({"error": f"proxy failed: {exc}"}).encode())

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
