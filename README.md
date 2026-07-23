# Verathos Dashboard Plus

This project can run either as a local web dashboard or as a Chrome extension.
The extension redirects `https://verathos.ai/dashboard` to its packaged,
enhanced dashboard. The address bar changes to a `chrome-extension://` URL so
the original website's security policy cannot block the replacement UI.

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
