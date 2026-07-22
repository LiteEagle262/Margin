package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cli-app/internal/config"

	"github.com/gorilla/websocket"
)

const (
	testExtensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
	testAuthToken       = "0123456789abcdef0123456789abcdef"
)

func newTestBridge(t *testing.T) (*Bridge, *httptest.Server) {
	t.Helper()
	root := t.TempDir()
	bridge, err := New(config.Config{
		WorkspaceRoot: root,
		AuthToken:     testAuthToken,
		Host:          "127.0.0.1",
		Port:          9230,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(bridge.handleWS))
	t.Cleanup(server.Close)
	return bridge, server
}

func dialTestBridge(t *testing.T, server *httptest.Server, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	conn, response, err := websocket.DefaultDialer.Dial(wsURL, header)
	return conn, response, err
}

func readOutbound(t *testing.T, conn *websocket.Conn) outboundMessage {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var message outboundMessage
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	return message
}

func TestOriginPolicy(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		allowed bool
	}{
		{name: "native client without origin", allowed: true},
		{name: "Chrome extension", origin: testExtensionOrigin, allowed: true},
		{name: "web page", origin: "https://attacker.example", allowed: false},
		{name: "localhost web page", origin: "http://localhost:3000", allowed: false},
		{name: "opaque browser origin", origin: "null", allowed: false},
		{name: "extension URL with path", origin: testExtensionOrigin + "/page.html", allowed: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := &http.Request{Header: http.Header{}}
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if got := isAllowedWebSocketOrigin(request); got != test.allowed {
				t.Fatalf("isAllowedWebSocketOrigin() = %v, want %v", got, test.allowed)
			}
		})
	}
}

func TestHTTPOriginCannotUpgrade(t *testing.T) {
	_, server := newTestBridge(t)
	conn, response, err := dialTestBridge(t, server, "https://attacker.example")
	if conn != nil {
		conn.Close()
	}
	if err == nil {
		t.Fatal("expected browser web origin to be rejected")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected HTTP 403, got %#v", response)
	}
}

func TestPrivilegedMessageBeforeRegistrationIsRejected(t *testing.T) {
	bridge, server := newTestBridge(t)
	conn, _, err := dialTestBridge(t, server, testExtensionOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	args, err := json.Marshal(map[string]string{"path": "owned.txt", "content": "should not exist"})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(inboundMessage{Type: "tool/call", ID: "1", Name: "write_file", Arguments: args}); err != nil {
		t.Fatal(err)
	}
	message := readOutbound(t, conn)
	if message.Type != "register/error" {
		t.Fatalf("expected register/error, got %q", message.Type)
	}
	if _, err := os.Stat(filepath.Join(bridge.cfg.WorkspaceRoot, "owned.txt")); !os.IsNotExist(err) {
		t.Fatalf("unauthenticated tool call wrote a file: %v", err)
	}
}

func TestInvalidRegistrationTokenIsRejected(t *testing.T) {
	_, server := newTestBridge(t)
	conn, _, err := dialTestBridge(t, server, testExtensionOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(inboundMessage{Type: "register", Token: "wrong-token"}); err != nil {
		t.Fatal(err)
	}
	message := readOutbound(t, conn)
	if message.Type != "register/error" || message.Error != "Invalid auth token" {
		t.Fatalf("unexpected registration response: %#v", message)
	}
}

func TestAuthenticatedConnectionCanCallTools(t *testing.T) {
	bridge, server := newTestBridge(t)
	conn, _, err := dialTestBridge(t, server, testExtensionOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(inboundMessage{
		Type:    "register",
		Token:   bridge.cfg.AuthToken,
		Client:  "margin-extension",
		Version: "test",
	}); err != nil {
		t.Fatal(err)
	}
	registered := readOutbound(t, conn)
	if registered.Type != "register/ok" {
		t.Fatalf("expected register/ok, got %#v", registered)
	}

	if err := conn.WriteJSON(inboundMessage{Type: "tool/call", ID: "1", Name: "get_workspace"}); err != nil {
		t.Fatal(err)
	}
	result := readOutbound(t, conn)
	if result.Type != "tool/result" || result.Result == nil || result.Result.IsError {
		t.Fatalf("unexpected tool response: %#v", result)
	}
	if len(result.Result.Content) != 1 || !strings.Contains(result.Result.Content[0].Text, bridge.cfg.WorkspaceRoot) {
		t.Fatalf("tool response did not contain workspace: %#v", result.Result)
	}
}

func TestNewRejectsBlankAuthToken(t *testing.T) {
	_, err := New(config.Config{WorkspaceRoot: t.TempDir(), AuthToken: "  ", Host: "127.0.0.1"})
	if err == nil {
		t.Fatal("expected blank auth token to be rejected")
	}
}

func TestNewRejectsShortAuthToken(t *testing.T) {
	_, err := New(config.Config{WorkspaceRoot: t.TempDir(), AuthToken: "short-token", Host: "127.0.0.1"})
	if err == nil {
		t.Fatal("expected short auth token to be rejected")
	}
}

func TestNewRejectsNonLoopbackBindHost(t *testing.T) {
	_, err := New(config.Config{WorkspaceRoot: t.TempDir(), AuthToken: testAuthToken, Host: "0.0.0.0"})
	if err == nil {
		t.Fatal("expected non-loopback bind host to be rejected")
	}
}

func TestAllowedOriginRejectsPort(t *testing.T) {
	requestURL, err := url.Parse(testExtensionOrigin + ":1234")
	if err != nil {
		t.Fatal(err)
	}
	request := &http.Request{Header: http.Header{"Origin": []string{requestURL.String()}}}
	if isAllowedWebSocketOrigin(request) {
		t.Fatal("expected extension origin with port to be rejected")
	}
}
