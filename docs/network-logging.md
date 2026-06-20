# Network Logging

ScrapeFlow captures page network traffic through Chrome DevTools Protocol via
`chrome.debugger`. The implementation lives in `shared/network-logs.js` and is
routed through the background service worker.

## What Changed

- Logs now use a per-tab rolling buffer of the last 1500 requests.
- Captured logs can be restored across chats during the current browser session
  through `chrome.storage.session`.
- Settings include auto-capture for the latched tab, session persistence,
  response-body capture, and sensitive-data redaction.
- Auto-capture is scoped to the latched tab only. ScrapeFlow does not attach a
  debugger to every browser tab.
- Request IDs exposed to the AI are stable public IDs, so redirects no longer
  collide on raw CDP request IDs.
- Failed requests are recorded from `Network.loadingFailed` and can be filtered
  with `failed: true`.
- Extra header events are consumed when Chrome provides them.
- Cookies, authorization headers, API keys, tokens, passwords, and common secret
  fields are redacted by default before the AI sees them.
- Binary bodies are omitted instead of being decoded into corrupted text.

## How To Use

For hindsight capture, open settings and enable:

- `Automatically keep a hindsight buffer for the latched tab`
- `Keep captured logs across chats during this browser session`

Then latch ScrapeFlow to the target tab. The AI can call `get_network_logs`
later without needing to have called `start_network_capture` first.

Manual capture still works:

1. Call `start_network_capture`.
2. Reload or interact with the page.
3. Call `get_network_logs`.
4. Call `get_network_log_detail` with an ID from the list.

You can also open the sidepanel Network Logs viewer from the header button or
from Settings -> Network Capture. The viewer searches the current per-tab
buffer locally, and Download Current Logs exports the full current buffer as
redacted JSON for debugging.

## Caveats

The logger still depends on Chrome's debugger API, so it can conflict with
DevTools or another extension attached to the same tab. It captures only traffic
from the target tab after attachment starts. Session persistence is intentionally
not long-term storage; closing the browser can discard the buffer.

Response bodies are best-effort. Chrome may refuse body retrieval for some
requests, cached responses, streams, WebSockets, downloads, or large/binary
payloads.
