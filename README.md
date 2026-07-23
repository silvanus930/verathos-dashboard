# Verathos Dashboard Plus

This project can run either as a local web dashboard or as a Chrome extension.
The extension replaces the document at `https://verathos.ai/dashboard` with
its packaged, enhanced dashboard while keeping the original URL in the address
bar. Its scripts and styles run in Chrome's isolated extension environment so
the original website's security policy cannot block them.

When active, the extension toolbar badge shows **ON**. If injection fails, it
shows **ERR** and records the failure on the extension's service-worker console.

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
