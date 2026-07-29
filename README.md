# Verathos Dashboard Plus

This project can run either as a local web dashboard or as a Chrome extension.
The extension replaces the document at `https://verathos.ai/dashboard` with
its packaged, enhanced dashboard while keeping the original URL in the address
bar. Its scripts and styles run in Chrome's isolated extension environment so
the original website's security policy cannot block them.

When active, the extension toolbar badge shows **ON**. If injection fails, it
shows **ERR** and records the failure on the extension's service-worker console.

## Watched groups

Use **New watched group** to save a group or user name with a list of miner
UIDs. Select a group above the miner table, then use the stars to add or remove
miners from that group. **Delete group** removes the currently selected group
after confirmation. Groups are stored in the current browser, and an
existing single watchlist is migrated automatically. The miner search also
matches full or partial hotkeys.

## Quick model tests

Every model card has a **Quick test** button. Enter a Verathos API key and run
one or three normal inference requests to see success rate, average round-trip
latency, effective output tokens per second, and proof status when returned by
the gateway. The key is kept only for the current tab. The test dialog also
configures request count, maximum output tokens, timeout, temperature, delay
between requests, and prompt; those settings are reused by every model button
for the rest of the tab session.

The check is deliberately limited to three sequential requests and 64 output
tokens per request. It is gateway-routed and does not target or flood individual
miner endpoints. Requests can consume your Verathos balance.

The same bounded check is available from Python:

```powershell
python -m src.main --model "MODEL_ID" --api-key "vrt_sk_YOUR_KEY" --requests 3 --max-tokens 64 --timeout 90 --temperature 0 --delay-ms 0
```

## Owned endpoint resilience checks

Miner rows whose endpoint is listed in `owned-endpoints.json` show a **Test**
button. The settings modal offers health load, unsigned authentication
rejection, bounded request-body rejection, invalid-method rejection, or a full
combined HTTP suite. Every case ends with a recovery probe. Health-load results
include reachability, HTTP statuses, and average/p50/p95/max latency.

The extension and local Python server both enforce the same ownership
allowlist. Hard limits are 25 health requests, concurrency 5, a 64 KiB body
check, 10-second request timeout, and a 1-second delay between waves. These
checks measure the exposed Cloudflare/Runpod and application path; they are not
packet-flood or origin kernel tests.

## Telegram probation alerts

Open the gear button, enter a Telegram bot token and chat ID, then choose
**Connect & send test**. A successful connection sends an initial Telegram
message and enables alerts for newly detected probation transitions across all
watched groups. Detection runs whenever the open dashboard refreshes. Telegram
credentials are stored in Chrome extension storage when running as an
extension, or browser-local storage during local development. The last observed
probation state is also saved locally so unchanged statuses do not resend.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Visit `https://verathos.ai/dashboard`.

Clicking the extension icon also opens the dashboard. To temporarily see the
original website again, disable the extension on `chrome://extensions`.

## Local development

The Python server remains available for browser development outside the
extension:

```powershell
python server.py 8000
```

Then open `http://localhost:8000`.
