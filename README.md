# Margin

[![CI](https://github.com/LiteEagle262/extension-thhing/actions/workflows/ci.yml/badge.svg)](https://github.com/LiteEagle262/extension-thhing/actions/workflows/ci.yml)

**[margindev.com](https://margindev.com)**

Margin is an open-source Chrome extension that puts an AI agent in the browser side panel. The agent reads
the page you are on, clicks and types, captures network traffic, keeps files in a per-chat workspace, and can
expose the same tools to other MCP clients such as Claude Code, Codex, or Cursor.

The extension is plain ES modules — there is no build step and no runtime dependency.

## Install

A packed Chrome extension is coming soon. Until then, load it from source:

1. Clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the repository
   root (the folder containing `manifest.json`). Chrome 120 or newer is required.
3. Click the Margin toolbar icon to open the side panel.

## Connect a provider

Open **Settings → AI Provider** in the side panel and pick one:

- **OpenRouter** — paste an API key from [openrouter.ai/keys](https://openrouter.ai/keys) and choose any model
  OpenRouter offers.
- **ChatGPT account** — link an eligible ChatGPT plan through OpenAI's device-code OAuth flow. No OpenAI API
  key and no companion app is needed.

Keys and OAuth tokens are stored in Chrome extension storage on your device and are sent only to the provider
you selected.

## Tool surface

Every tool can be turned on or off individually under **Settings → Tool Access**.

- **Page** — snapshots, `get_dom`, screenshots, clicks, form fills, hover, key presses, scrolling, typing,
  waiting, navigation, tab listing, and `run_js`. `browser_batch` runs a whole sequence in one call.
  `set_file_input` attaches files to an upload field without the native picker, and `list_downloads`
  reports where downloaded files were saved (asks for the optional `downloads` permission).
- **Network** — start and stop request capture, then list, search, inspect, or clear the captured log.
- **Recon** — `http_request`, `get_storage`, page script listing and source search, `get_cookies` (asks for the
  optional `cookies` permission), and TOTP codes for domains whose manual key you saved.
- **Workspace files** — `write_file`, `read_file`, `list_files`, `search_files`, rename, and delete. Files show
  up as clickable cards instead of walls of code in chat.
- **Web search** — optional. Add a Tavily key under **Settings → Web Search Provider** to enable `search_web`
  and `fetch_search_result`.
- **External MCP servers** — connect streamable-HTTP MCP servers under **Settings → MCP Client Servers** to give
  the agent tools beyond the built-ins.

## Security model — read this before enabling risky tools

Margin drives your real, logged-in browser session. Tool access is consented once, in **Settings → Tool
Access** — there is no runtime approval gate and no content-based defense. If a page you visit contains
instructions aimed at the agent, the agent may follow them, and the tools you have enabled are the tools it
will use. Enabling `run_js` or `evaluate_script` grants the agent — and anything that can influence it —
arbitrary JavaScript on every page you visit, including logged-in ones. The activity log
(**Settings → Network Capture → Download activity log**) records what ran, from which surface, and against
which host; it is a record, not a barrier. Risky tools ship disabled for this reason. Enable what you will
actually use, and treat the MCP bridge token like a password.

## MCP bridge

The bridge points the other way: it lets an external MCP client drive your real browser through Margin.

1. In **Settings → MCP Server Connector**, enable MCP Server Mode and copy the generated auth token (the
   default bridge port is 9229).
2. Register the server with your client, for example:

   ```
   claude mcp add margin -e MARGIN_MCP_TOKEN=<token> -- npx -y margin-mcp-server@latest
   ```

   The settings panel also renders a ready-to-paste JSON config for clients that use one.
3. Keep Chrome and the Margin side panel open while tools run.

The extension and the server authenticate each other with an HMAC challenge-response over loopback, and the
extension pushes its tool definitions at connect time, so the server exposes exactly the tools your extension
version implements and you have enabled. See [`mcp-server/README.md`](mcp-server/README.md) for details.

## Development

```
npm ci
npm run check              # release validation (manifest, icons, source scan) + syntax check
npm test                   # check + the tests/ suite
npm run package:extension  # deterministic Web Store zip in dist/
npm run qa:visual          # serve the side panel with mocked Chrome APIs on 127.0.0.1:4173
```

The MCP server has its own suite:

```
cd mcp-server && npm ci && npm test
```

## License

MIT — see [LICENSE](LICENSE).
