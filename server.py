#!/usr/bin/env python3
"""Static dashboard server and restricted same-origin API proxies.

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
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlsplit
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

UPSTREAM = "https://verathos.ai/api/dashboard"
CHAIN_RPC_UPSTREAM = "https://api.metagraph.sh/rpc/v1/finney"
CHAIN_HEAD_PATH = "/api/chain-head"
TIMESTAMP_NOW_STORAGE_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb"
SUBNET_TEMPO_STORAGE_KEY = "0x658faa385070e074c85bf6b568cf05557641384bb339f3758acddfd7053d33176000"
BLOCKS_SINCE_LAST_STEP_STORAGE_KEY = "0x658faa385070e074c85bf6b568cf055563f934e48e59bf9413de427605faa0246000"
MINER_DEBUG_UPSTREAM_BASE = "https://api.verathos.ai/v1/miner-debug"
MINER_DEBUG_PATH_RE = re.compile(r'^/api/miner-debug/(\d+)(?:/entries/(\d+))?$')
TELEGRAM_SEND_PATH = "/api/telegram/send-message"
TELEGRAM_TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]+$")
MODEL_TEST_PATH = "/api/model-test"
MODEL_TEST_UPSTREAM = "https://api.verathos.ai/v1/chat/completions"
VERATHOS_API_KEY_RE = re.compile(r"^vrt_sk_[A-Za-z0-9_-]{8,}$")
ENDPOINT_TEST_PATH = "/api/endpoint-test"
with open(os.path.join(os.path.dirname(__file__), "owned-endpoints.json"), encoding="utf-8") as allowlist_file:
    OWNED_ENDPOINTS = {urlsplit(endpoint).scheme + "://" + urlsplit(endpoint).netloc for endpoint in json.load(allowlist_file)}
PORT = int(sys.argv[1]) if __name__ == "__main__" and len(sys.argv) > 1 else 8000


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
        elif urlsplit(self.path).path == CHAIN_HEAD_PATH:
            self.proxy_chain_head()
        elif self.path.startswith("/api/miner-debug/"):
            self.proxy_miner_debug()
        else:
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path == TELEGRAM_SEND_PATH:
            self.send_telegram_message()
        elif urlsplit(self.path).path == MODEL_TEST_PATH:
            self.run_model_test()
        elif urlsplit(self.path).path == ENDPOINT_TEST_PATH:
            self.run_endpoint_test()
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

    def chain_rpc(self, method, params=None):
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params or [],
        }).encode()
        request = urllib.request.Request(
            CHAIN_RPC_UPSTREAM,
            data=body,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Verathos-Dashboard/1.9",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read())
        if payload.get("error"):
            raise RuntimeError(payload["error"].get("message", "chain RPC failed"))
        return payload["result"]

    def proxy_chain_head(self):
        """Returns one internally consistent chain block number and timestamp."""
        try:
            block_hash = self.chain_rpc("chain_getFinalizedHead")
            header = self.chain_rpc("chain_getHeader", [block_hash])
            block_number = int(header["number"], 16)
            timestamp_hex = self.chain_rpc(
                "state_getStorage",
                [TIMESTAMP_NOW_STORAGE_KEY, block_hash],
            )
            tempo_hex = self.chain_rpc(
                "state_getStorage",
                [SUBNET_TEMPO_STORAGE_KEY, block_hash],
            )
            blocks_since_last_step_hex = self.chain_rpc(
                "state_getStorage",
                [BLOCKS_SINCE_LAST_STEP_STORAGE_KEY, block_hash],
            )
            timestamp_bytes = bytes.fromhex(timestamp_hex.removeprefix("0x"))
            block_timestamp_ms = int.from_bytes(timestamp_bytes, byteorder="little")
            tempo = int.from_bytes(bytes.fromhex(tempo_hex.removeprefix("0x")), byteorder="little")
            blocks_since_last_step = int.from_bytes(
                bytes.fromhex(blocks_since_last_step_hex.removeprefix("0x")),
                byteorder="little",
            )
            self.send_json(200, json.dumps({
                "block_number": block_number,
                "block_timestamp_ms": block_timestamp_ms,
                "tempo": tempo,
                "blocks_since_last_step": blocks_since_last_step,
            }).encode())
        except Exception as exc:
            self.send_json(502, json.dumps({"error": f"chain proxy failed: {exc}"}).encode())

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

    def run_model_test(self):
        """Runs one bounded OpenAI-compatible inference request via Verathos."""
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

        api_key = str(payload.get("api_key", "")).strip()
        model = str(payload.get("model", "")).strip()
        messages = payload.get("messages")
        if not VERATHOS_API_KEY_RE.fullmatch(api_key):
            self.send_json(400, json.dumps({"error": "invalid Verathos API key"}).encode())
            return
        if not model or len(model) > 200:
            self.send_json(400, json.dumps({"error": "invalid model ID"}).encode())
            return
        if (
            not isinstance(messages, list)
            or len(messages) != 1
            or not isinstance(messages[0], dict)
            or messages[0].get("role") != "user"
        ):
            self.send_json(400, json.dumps({"error": "exactly one user message is required"}).encode())
            return
        prompt = str(messages[0].get("content", "")).strip()
        if not prompt or len(prompt) > 500:
            self.send_json(400, json.dumps({"error": "prompt must contain 1-500 characters"}).encode())
            return
        try:
            max_tokens = min(64, max(1, int(payload.get("max_tokens", 64))))
        except (TypeError, ValueError):
            self.send_json(400, json.dumps({"error": "max_tokens must be an integer"}).encode())
            return
        try:
            temperature = float(payload.get("temperature", 0))
        except (TypeError, ValueError):
            self.send_json(400, json.dumps({"error": "temperature must be numeric"}).encode())
            return
        if not 0 <= temperature <= 2:
            self.send_json(400, json.dumps({"error": "temperature must be between 0 and 2"}).encode())
            return
        try:
            timeout_seconds = int(payload.get("timeout_seconds", 90))
        except (TypeError, ValueError):
            self.send_json(400, json.dumps({"error": "timeout_seconds must be an integer"}).encode())
            return
        if not 5 <= timeout_seconds <= 90:
            self.send_json(400, json.dumps({"error": "timeout_seconds must be between 5 and 90"}).encode())
            return

        upstream_body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }).encode()
        request = urllib.request.Request(
            MODEL_TEST_UPSTREAM,
            data=upstream_body,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                self.send_json(response.status, response.read())
        except urllib.error.HTTPError as exc:
            self.send_json(exc.code, exc.read())
        except Exception as exc:
            self.send_json(502, json.dumps({"error": f"model test request failed: {exc}"}).encode())

    @staticmethod
    def probe_endpoint(endpoint, path, timeout_seconds, method="GET", body=None, headers=None):
        started_at = time.perf_counter()
        request_headers = {
            "Accept": "application/json",
            "User-Agent": "Verathos-Dashboard-Resilience-Check/1.0",
        }
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            endpoint + path,
            data=body,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                status = response.status
            return {
                "reached": True,
                "healthy": 200 <= status < 300,
                "status": status,
                "latencyMs": round((time.perf_counter() - started_at) * 1000),
            }
        except urllib.error.HTTPError as error:
            return {
                "reached": True,
                "healthy": False,
                "status": error.code,
                "latencyMs": round((time.perf_counter() - started_at) * 1000),
            }
        except Exception as error:
            return {
                "reached": False,
                "healthy": False,
                "status": None,
                "latencyMs": round((time.perf_counter() - started_at) * 1000),
                "error": "timeout" if isinstance(error, TimeoutError) else str(error),
            }

    def run_endpoint_test(self):
        """Runs a capped GET-only health burst against an explicitly owned endpoint."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > 16384:
            self.send_json(400, json.dumps({"error": "invalid request size"}).encode())
            return
        try:
            payload = json.loads(self.rfile.read(content_length))
            endpoint_split = urlsplit(str(payload.get("endpoint", "")).strip())
            endpoint = endpoint_split.scheme + "://" + endpoint_split.netloc
            settings = payload.get("settings") or {}
            path = "/" if settings.get("path") == "/" else "/health"
            requests = int(settings.get("requests"))
            concurrency = int(settings.get("concurrency"))
            timeout_ms = int(settings.get("timeoutMs"))
            delay_ms = int(settings.get("delayMs"))
            payload_bytes = int(settings.get("payloadBytes"))
            test_case = str(settings.get("testCase", "health_load"))
        except (json.JSONDecodeError, TypeError, ValueError):
            self.send_json(400, json.dumps({"error": "invalid endpoint test settings"}).encode())
            return

        if endpoint not in OWNED_ENDPOINTS:
            self.send_json(403, json.dumps({"error": "endpoint is not in the owner allowlist"}).encode())
            return
        if not 1 <= requests <= 25 or not 1 <= concurrency <= 5:
            self.send_json(400, json.dumps({"error": "requests/concurrency exceed safe limits"}).encode())
            return
        if not 2000 <= timeout_ms <= 10000 or not 0 <= delay_ms <= 1000:
            self.send_json(400, json.dumps({"error": "timeout/delay exceed safe limits"}).encode())
            return
        if not 1024 <= payload_bytes <= 65536:
            self.send_json(400, json.dumps({"error": "body test size exceeds safe limits"}).encode())
            return
        allowed_test_cases = {"health_load", "auth_gate", "body_limit", "method_rejection", "full_suite"}
        if test_case not in allowed_test_cases:
            self.send_json(400, json.dumps({"error": "unknown endpoint test case"}).encode())
            return

        timeout_seconds = timeout_ms / 1000

        def scheduled_probe(index):
            wave = index // concurrency
            if delay_ms and wave:
                time.sleep(wave * delay_ms / 1000)
            return self.probe_endpoint(endpoint, path, timeout_seconds)

        results = []
        if test_case in {"health_load", "full_suite"}:
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                results = list(executor.map(scheduled_probe, range(requests)))

        checks = []

        def add_check(kind, label, check_path, expected_statuses, method="GET", body=None, headers=None):
            result = self.probe_endpoint(
                endpoint, check_path, timeout_seconds, method=method, body=body, headers=headers
            )
            checks.append({
                "kind": kind,
                "label": label,
                "result": result,
                "passed": result["reached"] and result["status"] in expected_statuses,
            })

        if test_case in {"auth_gate", "full_suite"}:
            auth_body = json.dumps({
                "messages": [{"role": "user", "content": "authorization check"}],
                "max_tokens": 1,
            }).encode()
            add_check(
                "auth_gate",
                "Unsigned /chat authentication gate",
                "/chat",
                {401, 403},
                method="POST",
                body=auth_body,
                headers={"Content-Type": "application/json"},
            )
        if test_case in {"body_limit", "full_suite"}:
            large_body = json.dumps({
                "messages": [{"role": "user", "content": "A" * payload_bytes}],
                "max_tokens": 1,
            }).encode()
            add_check(
                "body_limit",
                f"{payload_bytes}-byte /chat body limit",
                "/chat",
                {400, 401, 403, 413, 422, 429},
                method="POST",
                body=large_body,
                headers={"Content-Type": "application/json"},
            )
        if test_case in {"method_rejection", "full_suite"}:
            add_check(
                "method_rejection",
                "Invalid PUT method",
                path,
                {400, 405, 501},
                method="PUT",
            )

        time.sleep(0.5)
        recovery = self.probe_endpoint(endpoint, path, timeout_seconds)
        latencies = sorted(result["latencyMs"] for result in results if result["reached"])
        statuses = {}
        for result in results:
            key = str(result["status"]) if result["status"] is not None else result.get("error", "network_error")
            statuses[key] = statuses.get(key, 0) + 1

        def percentile(values, fraction):
            if not values:
                return None
            index = min(len(values) - 1, max(0, int(len(values) * fraction + 0.999999) - 1))
            return values[index]

        response = {
            "endpoint": endpoint,
            "path": path,
            "requests": requests,
            "concurrency": concurrency,
            "reached": sum(1 for result in results if result["reached"]),
            "healthy": sum(1 for result in results if result["healthy"]),
            "statuses": statuses,
            "latency": {
                "averageMs": round(sum(latencies) / len(latencies)) if latencies else None,
                "p50Ms": percentile(latencies, 0.5),
                "p95Ms": percentile(latencies, 0.95),
                "maxMs": max(latencies) if latencies else None,
            },
            "testCase": test_case,
            "checks": checks,
            "recovery": recovery,
        }
        self.send_json(200, json.dumps(response).encode())

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
