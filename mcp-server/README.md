# ScrapeFlow MCP Server

Expose ScrapeFlow browser automation tools to **Claude Code**, **Codex**, **Cursor**, and any other MCP client.

## How it works

```
MCP client (Claude Code / Cursor / Codex)
    │ stdio MCP
    ▼
scrapeflow-mcp-server (this package)
    │ WebSocket localhost:9229
    ▼
ScrapeFlow Chrome extension (background bridge)
    │ chrome.scripting / chrome.debugger
    ▼
Your active browser tab
```

## Setup

### 1. Install dependencies

```bash
cd mcp-server
npm install
```

### 2. Enable in the extension

1. Load the ScrapeFlow extension in Chrome.
2. Open **Settings → MCP Server Connector**.
3. Turn on **Enable MCP Server Mode**.
4. Copy the **Auth Token** (optional but recommended).

### 3. Configure your MCP client

#### Claude Code (`~/.claude/settings.json` or project `.mcp.json`)

```json
{
  "mcpServers": {
    "scrapeflow": {
      "command": "node",
      "args": ["C:/path/to/extension/mcp-server/index.js"],
      "env": {
        "SCRAPEFLOW_MCP_TOKEN": "your-token-from-extension-settings"
      }
    }
  }
}
```

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "scrapeflow": {
      "command": "node",
      "args": ["C:/path/to/extension/mcp-server/index.js"],
      "env": {
        "SCRAPEFLOW_MCP_TOKEN": "your-token-from-extension-settings"
      }
    }
  }
}
```

#### Codex / other stdio MCP clients

Use the same `command` + `args` pattern. Point `args` at `index.js` in this folder.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SCRAPEFLOW_MCP_PORT` | `9229` | WebSocket bridge port |
| `SCRAPEFLOW_MCP_HOST` | `127.0.0.1` | Bridge bind address |
| `SCRAPEFLOW_MCP_TOKEN` | _(empty)_ | Must match the token in extension settings |

## Available tools

| Tool | Description |
|---|---|
| `get_active_tab` | Active tab metadata |
| `list_tabs` | Tabs in current window |
| `navigate` | Go to URL in active tab |
| `get_dom` | Page text + truncated HTML |
| `take_screenshot` | Viewport screenshot (returns image) |
| `click_element` | Click by CSS selector |
| `scroll_page` | Scroll up/down |
| `type_text` | Fill an input |
| `run_js` | Evaluate JavaScript (uses CDP to bypass CSP) |

## Troubleshooting

- **"ScrapeFlow extension is not connected"** — Enable MCP Server Mode in extension settings and keep Chrome open.
- **Port in use** — Set `SCRAPEFLOW_MCP_PORT` to another port and match it in extension settings.
- **Auth errors** — Ensure `SCRAPEFLOW_MCP_TOKEN` matches the token shown in extension settings.
