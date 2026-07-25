# margin-mcp-server

MCP server for the [Margin](https://github.com/LiteEagle262/extension-thhing) Chrome extension. It lets MCP clients — Claude Code, Codex, Cursor, and others — drive your real browser through Margin: take page snapshots, click and fill elements, navigate, inspect network traffic, and more.

## How it works

```
MCP client  ──stdio──▶  margin-mcp-server  ◀──ws://127.0.0.1──  Margin extension
```

The server speaks MCP over stdio to your client and accepts one authenticated WebSocket connection from the Margin extension on loopback. Tool definitions are **pushed by the extension** at connect time, so the server never goes stale when Margin adds or changes tools — it exposes exactly what your extension version implements and what you have enabled in Margin's Tool Access settings. No tools are exposed until the extension connects and authenticates.

## Setup

1. Install the Margin extension and open **Settings → MCP Server Connector**.
2. Enable the bridge and copy the generated auth token (32+ bytes, required).
3. Add the server to your MCP client:

```json
{
  "mcpServers": {
    "margin": {
      "command": "npx",
      "args": ["-y", "margin-mcp-server@latest"],
      "env": {
        "MARGIN_MCP_PORT": "9229",
        "MARGIN_MCP_TOKEN": "paste-token-from-extension-settings"
      }
    }
  }
}
```

For Claude Code: `claude mcp add margin -e MARGIN_MCP_TOKEN=<token> -- npx -y margin-mcp-server@latest`

Keep the Margin side panel open while tools run — the extension executes browser tools in the panel.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MARGIN_MCP_TOKEN` | yes | — | Shared auth token; must match the extension's generated token |
| `MARGIN_MCP_PORT` | no | `9229` | Loopback port the extension connects to |
| `MARGIN_MCP_HOST` | no | `127.0.0.1` | Bind address (loopback only) |
| `MARGIN_MAIL_API_URL` | no | — | Temp-email backend URL (optional feature) |
| `MARGIN_MAIL_API_KEY` | no | — | Temp-email backend key |

## Security

- Binds to loopback only and rejects non-loopback peers.
- Extension connections must present the shared token (constant-time comparison) and a `chrome-extension://` origin.
- Tools disabled in Margin's Tool Access settings are neither listed nor callable, and pushed tool definitions are validated before being served.

## Compatibility

Requires a Margin extension version that pushes tool schemas over the bridge (v1.5+). Older extensions will connect but no browser tools will be listed.

## License

MIT
