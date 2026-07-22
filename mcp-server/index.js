#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  TEMP_EMAIL_TOOLS,
  TEMP_EMAIL_TOOL_NAMES,
  callTempEmailTool,
  setTempEmailFlags,
  isTempEmailEnabled
} from "./temp-email.js";

const DEFAULT_PORT = 9229;
const DEFAULT_HOST = "127.0.0.1";
const TOOL_TIMEOUT_MS = 120000;
const AUTH_TIMEOUT_MS = 5000;
const MAX_BRIDGE_PAYLOAD_BYTES = 1024 * 1024;
const MIN_AUTH_TOKEN_BYTES = 32;
const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function readEnv(name, fallback = "") {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name] ?? fallback
    : fallback;
}

const port = Number(readEnv("MARGIN_MCP_PORT", String(DEFAULT_PORT)) || DEFAULT_PORT);
const host = readEnv("MARGIN_MCP_HOST", DEFAULT_HOST) || DEFAULT_HOST;
const configuredAuthToken = readEnv("MARGIN_MCP_TOKEN");

const pendingCalls = new Map();
let extensionSocket = null;
let extensionInfo = null;
let mcpServer = null;
// Expose no tools until the authenticated extension sends its allowlist.
let enabledToolNames = new Set();

function log(message) {
  console.error(`[margin-mcp] ${message}`);
}

export function requireBridgeAuthToken(value = configuredAuthToken) {
  const token = typeof value === "string" ? value.trim() : "";
  if (Buffer.byteLength(token, "utf8") < MIN_AUTH_TOKEN_BYTES) {
    throw new Error(
      "MARGIN_MCP_TOKEN is required and must be at least 32 bytes. Copy the generated token from Margin Settings → MCP Server Connector."
    );
  }
  return token;
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isAllowedBridgeOrigin(origin) {
  // Native clients may omit Origin; browsers must present a Chrome-extension origin.
  if (origin === undefined) return true;
  return typeof origin === "string" && CHROME_EXTENSION_ORIGIN.test(origin);
}

export function bridgeTokensMatch(expectedToken, providedToken) {
  if (typeof expectedToken !== "string" || typeof providedToken !== "string") return false;
  const expected = Buffer.from(expectedToken, "utf8");
  const provided = Buffer.from(providedToken, "utf8");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function safeSocketSend(socket, message) {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {}
}

function closeWithPolicyError(socket, reason) {
  safeSocketSend(socket, { type: "register/error", error: reason });
  socket.close(1008, reason);
}

function rejectPendingCalls(reason) {
  for (const pending of pendingCalls.values()) {
    pending.reject(new Error(reason));
  }
}

function clearExtensionControlledState() {
  const hadVisibleTools = visibleTools().length > 0;
  enabledToolNames = new Set();
  setTempEmailFlags({ enabled: false, apiUrl: "", apiKey: "" });
  if (hadVisibleTools && mcpServer) {
    mcpServer.notification({ method: "notifications/tools/list_changed" })
      .catch(() => {});
  }
}

function sendToExtension(message) {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    throw new Error("Margin extension is not connected. Open Chrome with the extension loaded and enable MCP Server Mode in settings.");
  }
  extensionSocket.send(JSON.stringify(message));
}

function waitForExtensionToolResult(id, timeoutMs = TOOL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Tool call timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    pendingCalls.set(id, {
      resolve: (payload) => {
        clearTimeout(timer);
        pendingCalls.delete(id);
        resolve(payload);
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingCalls.delete(id);
        reject(err);
      }
    });
  });
}

async function callExtensionTool(name, args = {}) {
  const id = crypto.randomUUID();
  sendToExtension({ type: "tool/call", id, name, arguments: args });
  return waitForExtensionToolResult(id);
}

const TOOLS = [
  {
    name: "take_snapshot",
    description: "Take a compact accessibility-style page snapshot with element uids for reliable interaction.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Include more non-interactive elements." },
        limit: { type: "number", description: "Maximum elements to return." }
      }
    }
  },
  {
    name: "get_active_tab",
    description: "Get metadata about the currently active browser tab (id, url, title).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_tabs",
    description: "List tabs in the current browser window.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "navigate",
    description: "Navigate the active tab to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Destination URL." }
      },
      required: ["url"]
    }
  },
  {
    name: "get_dom",
    description: "Retrieve text body content and truncated HTML DOM of the active webpage.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "take_screenshot",
    description: "Capture a screenshot of the visible viewport of the active tab.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "click_element",
    description: "Click a page element. Prefer uid from take_snapshot; selector is a fallback.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Element uid from take_snapshot." },
        selector: { type: "string", description: "CSS selector fallback." },
        dblClick: { type: "boolean", description: "Double click the target." },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      }
    }
  },
  {
    name: "fill_element",
    description: "Set the value of an input, textarea, select, checkbox, or radio element. Prefer uid from take_snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Element uid from take_snapshot." },
        selector: { type: "string", description: "CSS selector fallback." },
        value: { type: "string", description: "Value to enter. Use true/false for checkboxes and radios." },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      },
      required: ["value"]
    }
  },
  {
    name: "fill_form",
    description: "Fill multiple form fields in one call. Prefer this over multiple fill_element calls.",
    inputSchema: {
      type: "object",
      properties: {
        elements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              uid: { type: "string" },
              selector: { type: "string" },
              value: { type: "string" }
            },
            required: ["value"]
          }
        },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      },
      required: ["elements"]
    }
  },
  {
    name: "hover_element",
    description: "Hover over a page element. Prefer uid from take_snapshot; selector is a fallback.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Element uid from take_snapshot." },
        selector: { type: "string", description: "CSS selector fallback." },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      }
    }
  },
  {
    name: "press_key",
    description: "Press a key or key combination such as Enter, Tab, Escape, Control+A, or Control+Shift+R.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key or key combination to press." },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      },
      required: ["key"]
    }
  },
  {
    name: "wait_for",
    description: "Wait for page state after navigation or interaction.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text that should appear on the page." },
        selector: { type: "string", description: "CSS selector that should appear." },
        url_contains: { type: "string", description: "Substring expected in the current URL." },
        timeout: { type: "number", description: "Maximum wait time in milliseconds." },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      }
    }
  },
  {
    name: "evaluate_script",
    description: "Evaluate a JavaScript function in the page context and return a JSON-serializable result.",
    inputSchema: {
      type: "object",
      properties: {
        function: { type: "string", description: "JavaScript function declaration/expression to execute." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional string arguments passed to the function. For complex values, pass JSON strings and parse inside the function."
        }
      },
      required: ["function"]
    }
  },
  {
    name: "type_text",
    description: "Type text into an input element or the focused field. Prefer fill_element/fill_form for normal forms.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "Element uid from take_snapshot." },
        selector: { type: "string", description: "CSS selector fallback." },
        text: { type: "string", description: "Text to enter." },
        submitKey: { type: "string", description: "Optional key to press after typing." },
        include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result." }
      },
      required: ["text"]
    }
  },
  {
    name: "scroll_page",
    description: "Scroll the active page up or down.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
        amount: { type: "number", description: "Pixels to scroll. Defaults to 500." }
      },
      required: ["direction"]
    }
  },
  {
    name: "run_js",
    description: "Execute JavaScript in the active page context and return the result.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to evaluate." }
      },
      required: ["code"]
    }
  },
  {
    name: "start_network_capture",
    description: "Start recording HTTP/network requests on the active tab.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "stop_network_capture",
    description: "Stop recording network requests on the active tab.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_network_logs",
    description: "List captured network requests. Filter by URL, method, status, or type.",
    inputSchema: {
      type: "object",
      properties: {
        url_contains: { type: "string", description: "Filter logs to URLs containing this substring." },
        method: { type: "string", description: "Filter by HTTP method." },
        status: { type: "number", description: "Filter by HTTP status code." },
        type: { type: "string", description: "Filter by resource type, e.g. XHR or Fetch." },
        limit: { type: "number", description: "Max entries to return." },
        include_body: { type: "boolean", description: "Include request/response bodies." }
      }
    }
  },
  {
    name: "get_network_log_detail",
    description: "Get full details for a single network request including headers and response body.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Request id from get_network_logs." }
      },
      required: ["request_id"]
    }
  },
  {
    name: "clear_network_logs",
    description: "Clear all captured network logs for the active tab.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_authenticator_code",
    description: "Generate a current 6-digit TOTP authenticator code from a saved manual key for a domain. If domain is omitted, uses the active tab hostname.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Optional hostname or URL. Defaults to the current active tab hostname." }
      }
    }
  },
  {
    name: "list_authenticator_domains",
    description: "List domains that have saved authenticator manual keys. Does not reveal the keys.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "http_request",
    description: "Make an HTTP request from the active page's context so its cookies, session, and origin apply. Use to replay or modify an API call seen in network logs. Returns status, headers, and body. Cross-origin requests are subject to the page's CORS policy.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Request URL. Relative URLs resolve against the active page." },
        method: { type: "string", description: "HTTP method. Defaults to GET." },
        headers: { type: "object", description: "Optional request headers as a key/value object." },
        body: { type: "string", description: "Optional request body string. Omit for GET/HEAD." },
        credentials: { type: "string", enum: ["include", "omit", "same-origin"], description: "Whether to send cookies. Defaults to include." },
        max_response_chars: { type: "number", description: "Maximum response body characters to return. Defaults to 20000." }
      },
      required: ["url"]
    }
  },
  {
    name: "get_cookies",
    description: "Read cookies for the active tab's site (or a given domain), including httpOnly cookies that page scripts cannot access.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Optional domain or URL. Defaults to the active tab." },
        name: { type: "string", description: "Optional cookie name filter." }
      }
    }
  },
  {
    name: "get_storage",
    description: "Read localStorage and/or sessionStorage for the active page.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["local", "session", "all"], description: "Which storage to read. Defaults to all." },
        keys: { type: "array", items: { type: "string" }, description: "Optional list of keys to return. Omit for all keys." }
      }
    }
  },
  {
    name: "list_scripts",
    description: "List JavaScript files loaded by the active page (external, inline, and resource-timing entries).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "search_scripts",
    description: "Search the source of the page's loaded JavaScript bundles for a string or regex. Finds API endpoints, GraphQL operations, keys, or flags. Returns matching snippets, not whole bundles.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term or regex source." },
        regex: { type: "boolean", description: "Treat query as a case-insensitive regular expression. Defaults to false." },
        max_matches: { type: "number", description: "Maximum matches to return. Defaults to 30, capped at 200." }
      },
      required: ["query"]
    }
  },
  ...TEMP_EMAIL_TOOLS
];

function visibleTools() {
  return TOOLS.filter((tool) => {
    if (TEMP_EMAIL_TOOL_NAMES.has(tool.name) && !isTempEmailEnabled()) return false;
    if (!TEMP_EMAIL_TOOL_NAMES.has(tool.name) && !enabledToolNames.has(tool.name)) return false;
    return true;
  });
}

export function startBridgeServer({
  bridgeHost = host,
  bridgePort = port,
  bridgeAuthToken = configuredAuthToken,
  exitOnError = false
} = {}) {
  const requiredAuthToken = requireBridgeAuthToken(bridgeAuthToken);
  const wss = new WebSocketServer({
    host: bridgeHost,
    port: bridgePort,
    maxPayload: MAX_BRIDGE_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: (info, accept) => {
      const remote = info.req.socket.remoteAddress;
      if (!isLoopbackAddress(remote)) {
        log(`Rejected non-loopback bridge connection from ${remote || "unknown"}`);
        accept(false, 403, "Forbidden");
        return;
      }

      if (!isAllowedBridgeOrigin(info.origin)) {
        log("Rejected bridge connection from a non-extension browser origin");
        accept(false, 403, "Forbidden");
        return;
      }

      accept(true);
    }
  });

  wss.on("listening", () => {
    const address = wss.address();
    const listeningPort = typeof address === "object" && address ? address.port : bridgePort;
    log(`Bridge listening on ws://${bridgeHost}:${listeningPort}`);
    log("Auth token required for extension connections.");
  });

  wss.on("connection", (socket, request) => {
    const remote = request.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      log(`Rejected connection from ${remote}`);
      socket.close(1008, "Only localhost connections are allowed");
      return;
    }

    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        closeWithPolicyError(socket, "Registration timed out");
      }
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        socket.close(1003, "Messages must be valid JSON");
        return;
      }

      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.close(1003, "Messages must be JSON objects");
        return;
      }

      if (!authenticated) {
        if (message.type !== "register") {
          closeWithPolicyError(socket, "Registration required");
          return;
        }

        if (!bridgeTokensMatch(requiredAuthToken, message.token)) {
          closeWithPolicyError(socket, "Authentication failed");
          return;
        }

        authenticated = true;
        clearTimeout(authTimer);

        if (extensionSocket && extensionSocket !== socket) {
          rejectPendingCalls("Margin extension connection was replaced");
          extensionSocket.close(1012, "Replaced by a new authenticated connection");
        }

        clearExtensionControlledState();
        extensionSocket = socket;
        extensionInfo = {
          client: typeof message.client === "string" ? message.client.slice(0, 80) : "margin-extension",
          version: typeof message.version === "string" ? message.version.slice(0, 40) : "unknown"
        };
        log(`Extension connected (${extensionInfo.client} ${extensionInfo.version})`);
        const address = wss.address();
        const listeningPort = typeof address === "object" && address ? address.port : bridgePort;
        safeSocketSend(socket, { type: "register/ok", bridgePort: listeningPort });
        return;
      }

      if (socket !== extensionSocket) {
        socket.close(1008, "Connection is no longer active");
        return;
      }

      if (message.type === "register") {
        socket.close(1008, "Already registered");
        return;
      }

      if (message.type === "pong") {
        return;
      }

      if (message.type === "feature-flags/set" && message.flags) {
        const tempEmail = message.flags.tempEmail || {};
        const before = visibleTools().map((tool) => tool.name).join(",");
        const { changed } = setTempEmailFlags({
          enabled: tempEmail.enabled === true,
          apiUrl: typeof tempEmail.apiUrl === "string" ? tempEmail.apiUrl : undefined,
          apiKey: typeof tempEmail.apiKey === "string" ? tempEmail.apiKey : undefined
        });
        const access = message.flags.toolAccess;
        if (access?.enabled && typeof access.enabled === "object") {
          const entries = Object.entries(access.enabled);
          enabledToolNames = new Set(
            entries.filter(([, enabled]) => enabled === true).map(([name]) => name)
          );
        }
        const after = visibleTools().map((tool) => tool.name).join(",");
        log(`Feature flags updated (tempEmail.enabled=${isTempEmailEnabled()}, tools=${enabledToolNames.size})`);
        if ((changed || before !== after) && mcpServer) {
          mcpServer.notification({ method: "notifications/tools/list_changed" })
            .catch(() => {});
        }
        return;
      }

      if (message.type === "tool/result" && message.id) {
        const pending = pendingCalls.get(message.id);
        if (pending) {
          pending.resolve(message.result || { content: [{ type: "text", text: "Empty result" }], isError: false });
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (extensionSocket === socket) {
        extensionSocket = null;
        extensionInfo = null;
        rejectPendingCalls("Margin extension disconnected");
        clearExtensionControlledState();
        log("Extension disconnected");
      }
    });

    socket.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  });

  wss.on("error", (err) => {
    log(`Bridge server error: ${err.message}`);
    if (exitOnError) process.exit(1);
  });

  const keepAliveTimer = setInterval(() => {
    if (extensionSocket && extensionSocket.readyState === 1) {
      extensionSocket.send(JSON.stringify({ type: "ping" }));
    }
  }, 25000);

  wss.on("close", () => {
    clearInterval(keepAliveTimer);
  });

  return wss;
}

export async function main() {
  const requiredAuthToken = requireBridgeAuthToken();
  startBridgeServer({ bridgeAuthToken: requiredAuthToken, exitOnError: true });

  const server = new Server(
    {
      name: "margin-browser",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: { listChanged: true }
      }
    }
  );
  mcpServer = server;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!TOOLS.some(tool => tool.name === name)) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true
      };
    }

    if (!visibleTools().some(tool => tool.name === name)) {
      return {
        content: [{ type: "text", text: `Tool disabled: ${name}` }],
        isError: true
      };
    }

    if (TEMP_EMAIL_TOOL_NAMES.has(name)) {
      if (!isTempEmailEnabled()) {
        return {
          content: [{ type: "text", text: "Tool is disabled. Enable Temp Email Backend in the Margin extension settings." }],
          isError: true
        };
      }
      return await callTempEmailTool(name, args || {});
    }

    try {
      const result = await callExtensionTool(name, args || {});
      return {
        content: result.content || [{ type: "text", text: "Tool completed with no content." }],
        isError: result.isError === true
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message || String(err) }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server ready on stdio");
}

const isEntrypoint = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
);

if (isEntrypoint) {
  main().catch((err) => {
    log(`Fatal error: ${err.message}`);
    process.exitCode = 1;
  });
}
