# margin-mcp-server

MCP server for the [Margin](https://github.com/LiteEagle262/extension-thhing) Chrome extension. It lets MCP clients — Claude Code, Codex, Cursor, and others — drive your real browser through Margin: take page snapshots, click and fill elements, navigate, inspect network traffic, and more.

## How it works

```
MCP client  ──stdio──▶  margin-mcp-server  ◀──ws://127.0.0.1──  Margin extension
```

The server speaks MCP over stdio to your client and accepts one mutually authenticated WebSocket connection from the Margin extension on loopback. Tool definitions are **pushed by the extension** at connect time, so the server never goes stale when Margin adds or changes tools — it exposes exactly what your extension version implements and what you have enabled in Margin's Tool Access settings. No tools are exposed until the extension connects and authenticates.

## Setup

1. Install the Margin extension and open **Settings → MCP Server Connector**.
2. Enable the bridge and copy the generated shared secret (32+ bytes, required).
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
| `MARGIN_MCP_TOKEN` | yes | — | Shared secret; must match the extension's generated token. It is never sent over the bridge |
| `MARGIN_MCP_PORT` | no | `9229` | Loopback port the extension connects to |
| `MARGIN_MCP_HOST` | no | `127.0.0.1` | Bind address (loopback only) |

## Security

- Binds to loopback only and rejects non-loopback peers, and browser connections must carry a `chrome-extension://` origin.
- The extension and the server authenticate each other with an HMAC-SHA256 challenge-response. The token is never transmitted: the extension sends a random nonce, the server answers with `HMAC(token, "margin-bridge-server:" + clientNonce)` and its own nonce, and the extension replies with `HMAC(token, "margin-bridge-client:" + serverNonce)`. Both proofs are compared in constant time, and the distinct prefixes stop either side's proof from being replayed at the other. A process that squats the port learns nothing and is dropped by the extension before any tool traffic.
- Tools disabled in Margin's Tool Access settings are neither listed nor callable — including web search — and pushed tool definitions are validated before being served.

## Compatibility

Requires Margin extension v1.6 or newer, which performs the mutual handshake above and pushes tool schemas over the bridge. Older extensions fail authentication and cannot connect.

## License

MIT
