package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"cli-app/internal/config"
	"cli-app/internal/workspace"

	"github.com/gorilla/websocket"
)

const (
	toolTimeout         = 120 * time.Second
	registrationTimeout = 10 * time.Second
	connectionTimeout   = 90 * time.Second
	maxClientMessage    = 24 << 20
)

var upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	CheckOrigin: func(r *http.Request) bool {
		return isAllowedWebSocketOrigin(r)
	},
}

type Bridge struct {
	cfg      config.Config
	ws       *workspace.Workspace
	client   *websocket.Conn
	clientMu sync.Mutex
}

type toolResponse struct {
	content []contentBlock
	isError bool
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type inboundMessage struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Token     string          `json:"token"`
	Client    string          `json:"client"`
	Version   string          `json:"version"`
	Arguments json.RawMessage `json:"arguments"`
}

type outboundMessage struct {
	Type      string      `json:"type"`
	ID        string      `json:"id,omitempty"`
	Error     string      `json:"error,omitempty"`
	Workspace string      `json:"workspace,omitempty"`
	Port      int         `json:"port,omitempty"`
	Result    *toolResult `json:"result,omitempty"`
}

type toolResult struct {
	Content []contentBlock `json:"content"`
	IsError bool           `json:"isError"`
}

func New(cfg config.Config) (*Bridge, error) {
	cfg.AuthToken = strings.TrimSpace(cfg.AuthToken)
	if err := config.ValidateAuthToken(cfg.AuthToken); err != nil {
		return nil, fmt.Errorf("invalid auth token: %w; run `margin-cli init` or replace it with `margin-cli auth <token>`", err)
	}
	if !isLoopbackHost(cfg.Host) {
		return nil, fmt.Errorf("bridge host must resolve to a loopback address")
	}
	ws, err := workspace.New(cfg.WorkspaceRoot)
	if err != nil {
		return nil, err
	}
	return &Bridge{
		cfg: cfg,
		ws:  ws,
	}, nil
}

func (b *Bridge) ListenAndServe() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", b.handleWS)

	addr := fmt.Sprintf("%s:%d", b.cfg.Host, b.cfg.Port)
	log.Printf("[margin-cli] Bridge listening on ws://%s", addr)
	log.Printf("[margin-cli] Workspace: %s", b.cfg.WorkspaceRoot)
	log.Printf("[margin-cli] Auth token required for extension connections")

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return http.Serve(ln, mux)
}

func (b *Bridge) handleWS(w http.ResponseWriter, r *http.Request) {
	remote := r.RemoteAddr
	if idx := strings.LastIndex(remote, ":"); idx != -1 {
		remote = remote[:idx]
	}
	remote = strings.TrimPrefix(remote, "[")
	remote = strings.TrimSuffix(remote, "]")

	if !isLocalhost(remote) {
		log.Printf("[margin-cli] Rejected connection from %s", remote)
		http.Error(w, "Only localhost connections are allowed", http.StatusForbidden)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	defer b.onDisconnect(conn)

	conn.SetReadLimit(maxClientMessage)
	if err := conn.SetReadDeadline(time.Now().Add(registrationTimeout)); err != nil {
		return
	}
	authenticated := false

	conn.SetPongHandler(func(string) error {
		if !authenticated {
			return nil
		}
		return conn.SetReadDeadline(time.Now().Add(connectionTimeout))
	})

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg inboundMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			b.rejectConnection(conn, "A valid register message is required")
			return
		}

		if !authenticated {
			if msg.Type != "register" {
				b.rejectConnection(conn, "Register with a valid auth token before sending commands")
				return
			}
			if !b.handleRegister(conn, msg) {
				return
			}
			authenticated = true
			if err := conn.SetReadDeadline(time.Now().Add(connectionTimeout)); err != nil {
				return
			}
			go b.pingLoop(conn)
			continue
		}

		switch msg.Type {
		case "register":
			b.rejectConnection(conn, "Connection is already registered")
			return
		case "tool/call":
			go b.handleToolCall(conn, msg)
		case "pong":
		}
	}
}

func (b *Bridge) pingLoop(conn *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		b.clientMu.Lock()
		active := b.client == conn
		b.clientMu.Unlock()
		if !active {
			return
		}
		if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
			return
		}
	}
}

func (b *Bridge) handleRegister(conn *websocket.Conn, msg inboundMessage) bool {
	if subtle.ConstantTimeCompare([]byte(msg.Token), []byte(b.cfg.AuthToken)) != 1 {
		b.rejectConnection(conn, "Invalid auth token")
		return false
	}

	b.clientMu.Lock()
	previous := b.client
	b.client = conn
	b.clientMu.Unlock()
	if previous != nil && previous != conn {
		_ = previous.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Replaced by a new authenticated connection"),
			time.Now().Add(time.Second),
		)
		_ = previous.Close()
	}

	client := msg.Client
	if client == "" {
		client = "margin-extension"
	}
	version := msg.Version
	if version == "" {
		version = "unknown"
	}
	log.Printf("[margin-cli] Extension connected (%s %s)", client, version)

	b.send(conn, outboundMessage{
		Type:      "register/ok",
		Workspace: b.cfg.WorkspaceRoot,
		Port:      b.cfg.Port,
	})
	return true
}

func (b *Bridge) rejectConnection(conn *websocket.Conn, reason string) {
	b.send(conn, outboundMessage{Type: "register/error", Error: reason})
	_ = conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.ClosePolicyViolation, reason),
		time.Now().Add(time.Second),
	)
}

func (b *Bridge) onDisconnect(conn *websocket.Conn) {
	b.clientMu.Lock()
	if b.client == conn {
		b.client = nil
		log.Printf("[margin-cli] Extension disconnected")
	}
	b.clientMu.Unlock()
}

func (b *Bridge) handleToolCall(conn *websocket.Conn, msg inboundMessage) {
	result := b.dispatchTool(msg.Name, msg.Arguments)
	b.send(conn, outboundMessage{
		Type: "tool/result",
		ID:   msg.ID,
		Result: &toolResult{
			Content: result.content,
			IsError: result.isError,
		},
	})
}

func (b *Bridge) dispatchTool(name string, args json.RawMessage) toolResponse {
	switch name {
	case "read_file":
		return b.toolReadFile(args)
	case "write_file":
		return b.toolWriteFile(args)
	case "list_files":
		return b.toolListFiles(args)
	case "delete_file":
		return b.toolDeleteFile(args)
	case "rename_file":
		return b.toolRenameFile(args)
	case "search_files":
		return b.toolSearchFiles(args)
	case "get_file_info":
		return b.toolGetFileInfo(args)
	case "exec":
		return b.toolExec(args)
	case "get_workspace":
		return textResult(fmt.Sprintf("Workspace root: %s", b.cfg.WorkspaceRoot), false)
	default:
		return textResult(fmt.Sprintf("Unknown tool: %s", name), true)
	}
}

type renameFileArgs struct {
	OldPath string `json:"old_path"`
	NewPath string `json:"new_path"`
}

func (b *Bridge) toolRenameFile(args json.RawMessage) toolResponse {
	var a renameFileArgs
	if err := json.Unmarshal(args, &a); err != nil || a.OldPath == "" || a.NewPath == "" {
		return textResult("old_path and new_path are required", true)
	}
	if err := b.ws.RenameFile(a.OldPath, a.NewPath); err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(fmt.Sprintf("Renamed %s -> %s", a.OldPath, a.NewPath), false)
}

type searchFilesArgs struct {
	Query string `json:"query"`
	Limit int    `json:"limit"`
}

func (b *Bridge) toolSearchFiles(args json.RawMessage) toolResponse {
	var a searchFilesArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Query == "" {
		return textResult("query is required", true)
	}
	entries, err := b.ws.SearchFiles(a.Query, a.Limit)
	if err != nil {
		return textResult(err.Error(), true)
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(string(data), false)
}

func (b *Bridge) toolGetFileInfo(args json.RawMessage) toolResponse {
	var a readFileArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Path == "" {
		return textResult("path is required", true)
	}
	abs, err := b.ws.Resolve(a.Path)
	if err != nil {
		return textResult(err.Error(), true)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return textResult(err.Error(), true)
	}
	data, err := json.MarshalIndent(map[string]any{
		"path":        a.Path,
		"is_dir":      info.IsDir(),
		"size":        info.Size(),
		"modified_at": info.ModTime(),
	}, "", "  ")
	if err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(string(data), false)
}

type readFileArgs struct {
	Path string `json:"path"`
}

func (b *Bridge) toolReadFile(args json.RawMessage) toolResponse {
	var a readFileArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Path == "" {
		return textResult("path is required", true)
	}
	content, err := b.ws.ReadFile(a.Path)
	if err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(content, false)
}

type writeFileArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (b *Bridge) toolWriteFile(args json.RawMessage) toolResponse {
	var a writeFileArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Path == "" {
		return textResult("path is required", true)
	}
	if err := b.ws.WriteFile(a.Path, a.Content); err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(fmt.Sprintf("Wrote %s", a.Path), false)
}

type listFilesArgs struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

func (b *Bridge) toolListFiles(args json.RawMessage) toolResponse {
	var a listFilesArgs
	if err := json.Unmarshal(args, &a); err != nil {
		return textResult("invalid arguments", true)
	}
	if a.Path == "" {
		a.Path = "."
	}
	entries, err := b.ws.ListFiles(a.Path, a.Recursive)
	if err != nil {
		return textResult(err.Error(), true)
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(string(data), false)
}

type deleteFileArgs struct {
	Path string `json:"path"`
}

func (b *Bridge) toolDeleteFile(args json.RawMessage) toolResponse {
	var a deleteFileArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Path == "" {
		return textResult("path is required", true)
	}
	if err := b.ws.DeleteFile(a.Path); err != nil {
		return textResult(err.Error(), true)
	}
	return textResult(fmt.Sprintf("Deleted %s", a.Path), false)
}

type execArgs struct {
	Command   string `json:"command"`
	Cwd       string `json:"cwd"`
	TimeoutMs int    `json:"timeout_ms"`
}

func (b *Bridge) toolExec(args json.RawMessage) toolResponse {
	var a execArgs
	if err := json.Unmarshal(args, &a); err != nil || a.Command == "" {
		return textResult("command is required", true)
	}
	if a.Cwd == "" {
		a.Cwd = "."
	}
	timeout := toolTimeout
	if a.TimeoutMs > 0 {
		timeout = time.Duration(a.TimeoutMs) * time.Millisecond
	}
	result, err := b.ws.RunCommand(a.Command, a.Cwd, timeout, nil)
	if err != nil {
		return textResult(err.Error(), true)
	}
	out := fmt.Sprintf("exit_code: %d\n\n--- stdout ---\n%s", result.ExitCode, result.Stdout)
	if result.Stderr != "" {
		out += fmt.Sprintf("\n\n--- stderr ---\n%s", result.Stderr)
	}
	return textResult(out, result.ExitCode != 0)
}

func textResult(text string, isError bool) toolResponse {
	return toolResponse{
		content: []contentBlock{{Type: "text", Text: text}},
		isError: isError,
	}
}

func (b *Bridge) send(conn *websocket.Conn, msg outboundMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	b.clientMu.Lock()
	defer b.clientMu.Unlock()
	if conn != nil {
		_ = conn.WriteMessage(websocket.TextMessage, data)
	}
}

func isLocalhost(addr string) bool {
	return addr == "127.0.0.1" || addr == "::1" || addr == "localhost"
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isAllowedWebSocketOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		// Native clients may omit Origin but still require bridge-token authentication.
		return true
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Scheme == "chrome-extension" &&
		parsed.Hostname() != "" &&
		parsed.Port() == "" &&
		parsed.User == nil &&
		parsed.Path == "" &&
		parsed.RawQuery == "" &&
		parsed.Fragment == ""
}

// Tools returns the tool definitions for extension/MCP integration.
func Tools() []map[string]any {
	return []map[string]any{
		{
			"name":        "read_file",
			"description": "Read a file within the CLI workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string", "description": "Relative path within the workspace."},
				},
				"required": []string{"path"},
			},
		},
		{
			"name":        "write_file",
			"description": "Create or overwrite a file within the CLI workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":    map[string]any{"type": "string", "description": "Relative path within the workspace."},
					"content": map[string]any{"type": "string", "description": "File contents."},
				},
				"required": []string{"path", "content"},
			},
		},
		{
			"name":        "list_files",
			"description": "List files and directories within the CLI workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path":      map[string]any{"type": "string", "description": "Relative directory path. Defaults to workspace root."},
					"recursive": map[string]any{"type": "boolean", "description": "List recursively."},
				},
			},
		},
		{
			"name":        "delete_file",
			"description": "Delete a file within the CLI workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string", "description": "Relative path within the workspace."},
				},
				"required": []string{"path"},
			},
		},
		{
			"name":        "rename_file",
			"description": "Rename or move a file within the CLI workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"old_path": map[string]any{"type": "string"},
					"new_path": map[string]any{"type": "string"},
				},
				"required": []string{"old_path", "new_path"},
			},
		},
		{
			"name":        "search_files",
			"description": "Search workspace files by path.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string"},
					"limit": map[string]any{"type": "number"},
				},
				"required": []string{"query"},
			},
		},
		{
			"name":        "get_file_info",
			"description": "Get metadata for a workspace file or directory.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"path": map[string]any{"type": "string"},
				},
				"required": []string{"path"},
			},
		},
		{
			"name":        "exec",
			"description": "Execute a shell command within the CLI workspace. cwd must be inside the workspace.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command":    map[string]any{"type": "string", "description": "Shell command to run."},
					"cwd":        map[string]any{"type": "string", "description": "Working directory relative to workspace root. Defaults to '.'"},
					"timeout_ms": map[string]any{"type": "number", "description": "Timeout in milliseconds. Defaults to 120000."},
				},
				"required": []string{"command"},
			},
		},
		{
			"name":        "get_workspace",
			"description": "Return the absolute path of the CLI workspace root.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
	}
}
