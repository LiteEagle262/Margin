#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import crypto from "crypto";
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

const port = Number(process.env.SCRAPEFLOW_MCP_PORT || DEFAULT_PORT);
const host = process.env.SCRAPEFLOW_MCP_HOST || DEFAULT_HOST;
const authToken = process.env.SCRAPEFLOW_MCP_TOKEN || "";

const pendingCalls = new Map();
let extensionSocket = null;
let extensionInfo = null;
let mcpServer = null;

function log(message) {
  console.error(`[scrapeflow-mcp] ${message}`);
}

function sendToExtension(message) {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    throw new Error("ScrapeFlow extension is not connected. Open Chrome with the extension loaded and enable MCP Server Mode in settings.");
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
    description: "Click a page element using a CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element to click." }
      },
      required: ["selector"]
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
    name: "type_text",
    description: "Type text into an input element on the page.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the input element." },
        text: { type: "string", description: "Text to enter." }
      },
      required: ["selector", "text"]
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
  ...TEMP_EMAIL_TOOLS
];

function visibleTools() {
  if (isTempEmailEnabled()) return TOOLS;
  return TOOLS.filter((tool) => !TEMP_EMAIL_TOOL_NAMES.has(tool.name));
}

function startBridgeServer() {
  const wss = new WebSocketServer({ host, port });

  wss.on("listening", () => {
    log(`Bridge listening on ws://${host}:${port}`);
    if (authToken) {
      log("Auth token required for extension connections.");
    } else {
      log("No auth token set — extension connections are open on localhost.");
    }
  });

  wss.on("connection", (socket, request) => {
    const remote = request.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      log(`Rejected connection from ${remote}`);
      socket.close(1008, "Only localhost connections are allowed");
      return;
    }

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message.type === "register") {
        if (authToken && message.token !== authToken) {
          socket.send(JSON.stringify({ type: "register/error", error: "Invalid auth token" }));
          socket.close(1008, "Invalid auth token");
          return;
        }

        extensionSocket = socket;
        extensionInfo = {
          client: message.client || "scrapeflow-extension",
          version: message.version || "unknown"
        };
        log(`Extension connected (${extensionInfo.client} ${extensionInfo.version})`);
        socket.send(JSON.stringify({ type: "register/ok", bridgePort: port }));
        return;
      }

      if (message.type === "pong") {
        return;
      }

      if (message.type === "feature-flags/set" && message.flags) {
        const tempEmail = message.flags.tempEmail || {};
        const { changed } = setTempEmailFlags({
          enabled: tempEmail.enabled === true,
          apiUrl: typeof tempEmail.apiUrl === "string" ? tempEmail.apiUrl : undefined,
          apiKey: typeof tempEmail.apiKey === "string" ? tempEmail.apiKey : undefined
        });
        log(`Feature flags updated (tempEmail.enabled=${isTempEmailEnabled()})`);
        if (changed && mcpServer) {
          mcpServer.notification({ method: "notifications/tools/list_changed" })
            .catch(() => { /* client may not support */ });
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
      if (extensionSocket === socket) {
        extensionSocket = null;
        extensionInfo = null;
        log("Extension disconnected");
      }
    });

    socket.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  });

  wss.on("error", (err) => {
    log(`Bridge server error: ${err.message}`);
    process.exit(1);
  });

  setInterval(() => {
    if (extensionSocket && extensionSocket.readyState === 1) {
      extensionSocket.send(JSON.stringify({ type: "ping" }));
    }
  }, 25000);

  return wss;
}

async function main() {
  startBridgeServer();

  const server = new Server(
    {
      name: "scrapeflow-browser",
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

    if (TEMP_EMAIL_TOOL_NAMES.has(name)) {
      if (!isTempEmailEnabled()) {
        return {
          content: [{ type: "text", text: "Tool is disabled. Enable Temp Email Backend in the ScrapeFlow extension settings." }],
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

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
