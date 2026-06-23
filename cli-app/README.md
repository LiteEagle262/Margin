# scrapeflow-cli

Local Go bridge that links the ScrapeFlow extension to a real workspace. It can either expose workspace tools to the extension's configured AI or run Codex as the extension's chat backend.

## Quick start

```bash
cd /path/to/your/project   # e.g. /api
go run . init              # locks workspace to this directory
go run . auth <token>      # paste token from web app (optional until integrated)
go run . serve --mode workspace

# Or use the extension as a Codex UI:
go run . serve --mode codex
```

Build a binary:

```bash
go build -o scrapeflow-cli .
```

## Commands

| Command | Description |
|---------|-------------|
| `init [path]` | Initialize workspace. Config is stored in `.scrapeflow-cli/`. Defaults to current directory. |
| `auth <token>` | Save auth token for extension handshake. |
| `serve --mode workspace` | Link the workspace to the extension's existing AI. |
| `serve --mode codex` | Link the workspace and proxy extension chat through the local Codex login. |
| `status` | Show workspace root, port, and auth state. |
| `tools` | List tools exposed to the extension. |

## Workspace sandbox

All file paths and command working directories are resolved relative to the workspace root set at `init` time. Paths outside that root (including `..` traversal) are rejected.

If you run `init` inside `/api`, the CLI can only access `/api` and its subfolders.

## Extension protocol

The bridge mirrors the existing MCP server pattern (`mcp-server/index.js`):

1. Extension connects to `ws://127.0.0.1:9230` (localhost only).
2. Sends `{ "type": "register", "token": "...", "client": "scrapeflow-extension", "version": "1.0.0" }`.
3. Server replies `{ "type": "register/ok", "workspace": "/abs/path", "port": 9230 }`.
4. Tool calls: `{ "type": "tool/call", "id": "<uuid>", "name": "read_file", "arguments": { ... } }`.
5. Results: `{ "type": "tool/result", "id": "<uuid>", "result": { "content": [{ "type": "text", "text": "..." }], "isError": false } }`.

### Tools

- `read_file` — read a file by relative path
- `write_file` — create or overwrite a file
- `list_files` — list directory contents (`recursive` optional)
- `delete_file` — delete a file
- `exec` — run a shell command (`command`, optional `cwd`, `timeout_ms`)
- `get_workspace` — return the workspace root path
- `rename_file` — rename or move a file
- `search_files` — search file paths
- `get_file_info` — return file metadata

## Codex proxy mode

`serve --mode codex` starts `codex app-server` over stdio, using the workspace root as Codex's working directory. Each extension chat gets its own persistent Codex thread. Messages, command/file activity, completion events, errors, and interrupts are relayed over the local WebSocket.

Requirements:

- `codex` must be installed and available on `PATH`
- the local Codex CLI must already be logged in

The default Codex policy is `workspace-write` with approvals set to `never`, so Codex can edit the linked workspace without leaving requests waiting in a hidden terminal prompt. These values can be changed in `.scrapeflow-cli/config.json`.

## Auth (web app integration)

Token flow (to be wired to the website):

1. User generates a CLI token in the ScrapeFlow web app.
2. User runs `scrapeflow-cli auth <token>` in their project.
3. Extension includes the same token in the `register` message.

Without a token, localhost connections are accepted (development mode).

## Config

Stored at `.scrapeflow-cli/config.json` (mode `600`, directory mode `700`):

```json
{
  "workspace_root": "/absolute/path/to/project",
  "auth_token": "optional-token",
  "port": 9230,
  "host": "127.0.0.1",
  "mode": "workspace",
  "codex_command": "codex",
  "codex_model": "",
  "codex_sandbox": "workspace-write",
  "codex_approval": "never"
}
```
