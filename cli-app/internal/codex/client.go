package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

const requestTimeout = 30 * time.Second

type EventHandler func(map[string]any)

type Client struct {
	command  string
	cwd      string
	model    string
	sandbox  string
	approval string
	onEvent  EventHandler

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	nextID atomic.Int64

	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[int64]chan response
	threads map[string]string
	turns   map[string]string
	reverse map[string]string
	closed  chan struct{}
}

type response struct {
	Result json.RawMessage
	Error  *rpcError
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

func New(command, cwd, model, sandbox, approval string, onEvent EventHandler) *Client {
	return &Client{
		command:  command,
		cwd:      cwd,
		model:    model,
		sandbox:  sandbox,
		approval: approval,
		onEvent:  onEvent,
		pending:  make(map[int64]chan response),
		threads:  make(map[string]string),
		turns:    make(map[string]string),
		reverse:  make(map[string]string),
		closed:   make(chan struct{}),
	}
}

func (c *Client) Start(ctx context.Context) error {
	if c.command == "" {
		c.command = "codex"
	}
	c.cmd = exec.CommandContext(ctx, c.command, "app-server", "--listen", "stdio://")
	c.cmd.Dir = c.cwd

	stdout, err := c.cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := c.cmd.StderrPipe()
	if err != nil {
		return err
	}
	c.stdin, err = c.cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := c.cmd.Start(); err != nil {
		return fmt.Errorf("start codex app-server: %w", err)
	}

	go c.readLoop(stdout)
	go c.stderrLoop(stderr)
	go func() {
		_ = c.cmd.Wait()
		close(c.closed)
		c.failPending(errors.New("codex app-server stopped"))
	}()

	var initialized map[string]any
	if err := c.call("initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "scrapeflow-cli",
			"title":   "ScrapeFlow CLI",
			"version": "1.0.0",
		},
		"capabilities": map[string]any{
			"experimentalApi":    false,
			"requestAttestation": false,
		},
	}, &initialized); err != nil {
		_ = c.Close()
		return fmt.Errorf("initialize codex app-server: %w", err)
	}
	return c.notify("initialized", map[string]any{})
}

func (c *Client) Send(chatID, text string, images []string) error {
	if chatID == "" {
		return errors.New("chat id is required")
	}
	if text == "" && len(images) == 0 {
		return errors.New("message is empty")
	}

	threadID, err := c.threadForChat(chatID)
	if err != nil {
		return err
	}

	input := []map[string]any{}
	if text != "" {
		input = append(input, map[string]any{
			"type":          "text",
			"text":          text,
			"text_elements": []any{},
		})
	}
	for _, image := range images {
		if image != "" {
			input = append(input, map[string]any{"type": "image", "url": image})
		}
	}

	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.call("turn/start", map[string]any{
		"threadId": threadID,
		"input":    input,
	}, &result); err != nil {
		return err
	}

	c.mu.Lock()
	c.turns[chatID] = result.Turn.ID
	c.mu.Unlock()
	return nil
}

func (c *Client) Interrupt(chatID string) error {
	c.mu.Lock()
	threadID := c.threads[chatID]
	turnID := c.turns[chatID]
	c.mu.Unlock()
	if threadID == "" || turnID == "" {
		return errors.New("no active codex turn for chat")
	}
	var result map[string]any
	return c.call("turn/interrupt", map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	}, &result)
}

func (c *Client) Reset(chatID string) {
	c.mu.Lock()
	if threadID := c.threads[chatID]; threadID != "" {
		delete(c.reverse, threadID)
	}
	delete(c.threads, chatID)
	delete(c.turns, chatID)
	c.mu.Unlock()
}

func (c *Client) Close() error {
	c.writeMu.Lock()
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	c.writeMu.Unlock()
	if c.cmd != nil && c.cmd.Process != nil {
		return c.cmd.Process.Kill()
	}
	return nil
}

func (c *Client) threadForChat(chatID string) (string, error) {
	c.mu.Lock()
	threadID := c.threads[chatID]
	c.mu.Unlock()
	if threadID != "" {
		return threadID, nil
	}

	params := map[string]any{
		"cwd":            c.cwd,
		"approvalPolicy": c.approval,
		"sandbox":        c.sandbox,
		"serviceName":    "scrapeflow-cli",
	}
	if c.model != "" {
		params["model"] = c.model
	}
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := c.call("thread/start", params, &result); err != nil {
		return "", err
	}
	if result.Thread.ID == "" {
		return "", errors.New("codex returned an empty thread id")
	}

	c.mu.Lock()
	c.threads[chatID] = result.Thread.ID
	c.reverse[result.Thread.ID] = chatID
	c.mu.Unlock()
	return result.Thread.ID, nil
}

func (c *Client) call(method string, params any, out any) error {
	id := c.nextID.Add(1)
	ch := make(chan response, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}

	timer := time.NewTimer(requestTimeout)
	defer timer.Stop()
	select {
	case resp := <-ch:
		if resp.Error != nil {
			return fmt.Errorf("codex %s: %s", method, resp.Error.Message)
		}
		if out == nil || len(resp.Result) == 0 {
			return nil
		}
		return json.Unmarshal(resp.Result, out)
	case <-timer.C:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return fmt.Errorf("codex %s timed out", method)
	case <-c.closed:
		return errors.New("codex app-server stopped")
	}
}

func (c *Client) notify(method string, params any) error {
	return c.write(map[string]any{"method": method, "params": params})
}

func (c *Client) write(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.stdin == nil {
		return errors.New("codex app-server is not running")
	}
	_, err = c.stdin.Write(append(data, '\n'))
	return err
}

func (c *Client) readLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var msg envelope
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if len(msg.ID) > 0 && msg.Method == "" {
			var id int64
			if err := json.Unmarshal(msg.ID, &id); err != nil {
				continue
			}
			c.mu.Lock()
			ch := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if ch != nil {
				ch <- response{Result: msg.Result, Error: msg.Error}
			}
			continue
		}
		if len(msg.ID) > 0 && msg.Method != "" {
			// The bridge runs Codex with approvalPolicy=never by default. Decline
			// any unexpected server request so the agent cannot hang indefinitely.
			_ = c.write(map[string]any{
				"id":     msg.ID,
				"result": map[string]any{"decision": "decline"},
			})
			continue
		}
		c.forwardEvent(msg)
	}
}

func (c *Client) forwardEvent(msg envelope) {
	if c.onEvent == nil || msg.Method == "" {
		return
	}
	var params map[string]any
	_ = json.Unmarshal(msg.Params, &params)
	threadID, _ := params["threadId"].(string)

	c.mu.Lock()
	chatID := c.reverse[threadID]
	if msg.Method == "turn/completed" && chatID != "" {
		delete(c.turns, chatID)
	}
	c.mu.Unlock()

	c.onEvent(map[string]any{
		"method": msg.Method,
		"params": params,
		"chatId": chatID,
	})
}

func (c *Client) stderrLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		if c.onEvent != nil {
			c.onEvent(map[string]any{
				"method": "codex/stderr",
				"params": map[string]any{"message": scanner.Text()},
			})
		}
	}
}

func (c *Client) failPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, ch := range c.pending {
		ch <- response{Error: &rpcError{Message: err.Error()}}
		delete(c.pending, id)
	}
}
