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
  WEB_SEARCH_TOOLS,
  WEB_SEARCH_TOOL_NAMES,
  setWebSearchEnabled,
  isWebSearchEnabled
} from "./web-search.js";

const DEFAULT_PORT = 9229;
const DEFAULT_HOST = "127.0.0.1";
const TOOL_TIMEOUT_MS = 120000;
const AUTH_TIMEOUT_MS = 5000;
// Some clients (Codex) ask for tools/list once at startup and ignore
// list_changed, so the first list waits out the extension's reconnect backoff.
// Stay under the 10s MCP startup timeout those clients allow.
const LIST_TOOLS_WAIT_MS = 8000;
// Codex runs several copies of this server at once, so another instance may
// hold the bridge port and may exit at any time; the losers keep retrying.
const BRIDGE_RETRY_MS = 2000;
const MAX_BRIDGE_PAYLOAD_BYTES = 1024 * 1024;
const MIN_AUTH_TOKEN_BYTES = 32;
const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const NONCE_PATTERN = /^[0-9a-f]{32,128}$/;
// Distinct prefixes stop a peer replaying one side's proof back at the other.
const SERVER_PROOF_PREFIX = "margin-bridge-server:";
const CLIENT_PROOF_PREFIX = "margin-bridge-client:";

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
let mcpServer = null;
// Expose no tools until the authenticated extension sends its allowlist and the
// matching definitions. Both arrive together on `feature-flags/set`.
let enabledToolNames = new Set();
let pushedTools = [];
let hasReceivedFeatureFlags = false;
let featureFlagsWaiters = [];

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

// The token itself is never sent over the bridge; each side proves it knows the
// token by signing the other side's nonce.
export function bridgeProof(token, payload) {
  return crypto.createHmac("sha256", token).update(payload).digest("hex");
}

export function bridgeProofsMatch(expectedProof, providedProof) {
  if (typeof expectedProof !== "string" || typeof providedProof !== "string") return false;
  const expected = Buffer.from(expectedProof, "utf8");
  const provided = Buffer.from(providedProof, "utf8");
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
  pushedTools = [];
  // A list issued after the extension drops waits for the reconnecting push.
  hasReceivedFeatureFlags = false;
  setWebSearchEnabled(false);
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

// Definitions for tools this process implements or gates on its own feature
// flags. Every tool the bridge proxies into the extension is pushed over
// `feature-flags/set` instead, so the extension stays the single source of truth.
const LOCAL_TOOLS = [...WEB_SEARCH_TOOLS];

const MAX_PUSHED_TOOLS = 100;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 4000;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// The peer is token- and origin-authenticated, but its payload still defines
// what MCP clients are told they can call, so it is validated rather than
// trusted. Anything malformed is dropped instead of failing the whole push.
export function sanitizeToolDefinitions(raw) {
  if (!Array.isArray(raw)) return [];
  const tools = [];
  const seen = new Set();

  for (const entry of raw) {
    if (tools.length >= MAX_PUSHED_TOOLS) break;
    if (!entry || typeof entry !== "object") continue;

    const name = typeof entry.name === "string" ? entry.name : "";
    if (name.length > MAX_TOOL_NAME_LENGTH || !TOOL_NAME_PATTERN.test(name)) continue;
    if (seen.has(name)) continue;
    // A pushed definition must never shadow a tool this process owns.
    if (WEB_SEARCH_TOOL_NAMES.has(name)) continue;

    const inputSchema = entry.inputSchema;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) continue;

    seen.add(name);
    tools.push({
      name,
      description: typeof entry.description === "string"
        ? entry.description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH)
        : "",
      inputSchema
    });
  }

  return tools;
}

export function visibleTools() {
  const local = LOCAL_TOOLS.filter((tool) => {
    if (!enabledToolNames.has(tool.name)) return false;
    if (WEB_SEARCH_TOOL_NAMES.has(tool.name)) return isWebSearchEnabled();
    return false;
  });
  // The extension only pushes tools it has already enabled; intersecting with
  // the separately pushed allowlist keeps one bug on either side from exposing
  // a tool the user switched off.
  const proxied = pushedTools.filter((tool) => enabledToolNames.has(tool.name));
  return [...proxied, ...local];
}

function resolveFeatureFlagsWaiters() {
  hasReceivedFeatureFlags = true;
  const waiters = featureFlagsWaiters;
  featureFlagsWaiters = [];
  for (const waiter of waiters) waiter();
}

// Waits for the first push only; an empty allowlist is still an answer.
// Times out rather than rejecting, so a client that lists with no extension
// running still gets a tool list.
function waitForFirstFeatureFlagsPush(timeoutMs) {
  if (hasReceivedFeatureFlags) return Promise.resolve();
  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      featureFlagsWaiters = featureFlagsWaiters.filter((entry) => entry !== waiter);
      resolve();
    }, timeoutMs);
    featureFlagsWaiters.push(waiter);
  });
}

export async function listTools(timeoutMs = LIST_TOOLS_WAIT_MS) {
  await waitForFirstFeatureFlagsPush(timeoutMs);
  return { tools: visibleTools() };
}

export function startBridgeServer(options = {}) {
  const {
    bridgeHost = host,
    bridgePort = port,
    bridgeAuthToken = configuredAuthToken,
    exitOnError = false,
    retryDelayMs = BRIDGE_RETRY_MS,
    // Lets a caller reach the instance a retry created, since the first return
    // value belongs to the server that lost the port.
    onListening = null
  } = options;
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
    onListening?.(wss);
  });

  wss.on("connection", (socket, request) => {
    const remote = request.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      log(`Rejected connection from ${remote}`);
      socket.close(1008, "Only localhost connections are allowed");
      return;
    }

    let authenticated = false;
    let serverNonce = "";
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
        if (message.type === "hello") {
          if (!NONCE_PATTERN.test(String(message.nonce || ""))) {
            closeWithPolicyError(socket, "Handshake nonce must be at least 16 random bytes as hex");
            return;
          }
          serverNonce = crypto.randomBytes(32).toString("hex");
          safeSocketSend(socket, {
            type: "hello/proof",
            proof: bridgeProof(requiredAuthToken, `${SERVER_PROOF_PREFIX}${message.nonce}`),
            nonce: serverNonce
          });
          return;
        }

        if (message.type !== "register" || !serverNonce) {
          closeWithPolicyError(socket, "Registration required");
          return;
        }

        if (!bridgeProofsMatch(bridgeProof(requiredAuthToken, `${CLIENT_PROOF_PREFIX}${serverNonce}`), message.proof)) {
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
        const client = typeof message.client === "string" ? message.client.slice(0, 80) : "margin-extension";
        const version = typeof message.version === "string" ? message.version.slice(0, 40) : "unknown";
        log(`Extension connected (${client} ${version})`);
        const address = wss.address();
        const listeningPort = typeof address === "object" && address ? address.port : bridgePort;
        safeSocketSend(socket, { type: "register/ok", bridgePort: listeningPort });
        return;
      }

      if (socket !== extensionSocket) {
        socket.close(1008, "Connection is no longer active");
        return;
      }

      if (message.type === "hello" || message.type === "register") {
        socket.close(1008, "Already registered");
        return;
      }

      if (message.type === "pong") {
        return;
      }

      if (message.type === "feature-flags/set" && message.flags) {
        // Compare whole definitions, not just names: a pushed schema or
        // description can now change while the tool list stays the same, and
        // clients still need to be told to refetch.
        const before = JSON.stringify(visibleTools());
        const access = message.flags.toolAccess;
        if (access?.enabled && typeof access.enabled === "object") {
          const entries = Object.entries(access.enabled);
          enabledToolNames = new Set(
            entries.filter(([, enabled]) => enabled === true).map(([name]) => name)
          );
        }
        if (Array.isArray(message.flags.tools)) {
          pushedTools = sanitizeToolDefinitions(message.flags.tools);
        }
        const webSearch = message.flags.webSearch || {};
        setWebSearchEnabled(webSearch.enabled === true);
        const after = JSON.stringify(visibleTools());
        resolveFeatureFlagsWaiters();
        log(`Feature flags updated (webSearch.enabled=${isWebSearchEnabled()}, tools=${visibleTools().length})`);
        if (before !== after && mcpServer) {
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
        rejectPendingCalls("Margin extension disconnected");
        clearExtensionControlledState();
        log("Extension disconnected");
      }
    });

    socket.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
    });
  });

  const keepAliveTimer = setInterval(() => {
    if (extensionSocket && extensionSocket.readyState === 1) {
      extensionSocket.send(JSON.stringify({ type: "ping" }));
    }
  }, 25000);

  wss.on("close", () => {
    clearInterval(keepAliveTimer);
  });

  wss.on("error", (err) => {
    log(`Bridge server error: ${err.message}`);
    if (err.code === "EADDRINUSE") {
      // Only the current wss schedules a retry, so retries never stack.
      log(`Bridge port ${bridgePort} in use; retrying in ${retryDelayMs}ms`);
      clearInterval(keepAliveTimer);
      wss.close();
      setTimeout(() => startBridgeServer(options), retryDelayMs);
      return;
    }
    if (exitOnError) process.exit(1);
  });

  return wss;
}

export async function main() {
  const requiredAuthToken = requireBridgeAuthToken();
  startBridgeServer({ bridgeAuthToken: requiredAuthToken, exitOnError: true });

  const server = new Server(
    {
      name: "margin-browser",
      version: "2.0.0"
    },
    {
      capabilities: {
        tools: { listChanged: true }
      }
    }
  );
  mcpServer = server;

  server.setRequestHandler(ListToolsRequestSchema, () => listTools());

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!visibleTools().some(tool => tool.name === name)) {
      return {
        content: [{ type: "text", text: `Tool unavailable: ${name}` }],
        isError: true
      };
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

  // Nothing else releases the event loop once the client is gone: the bridge
  // server and its keep-alive both keep it alive, so a dead client would leave
  // this process squatting the port. The SDK's stdio transport only listens for
  // `data`, so stdin EOF is what actually fires here.
  const exitOnClientGone = () => {
    log("stdio client disconnected, exiting");
    process.exit(0);
  };
  process.stdin.on("end", exitOnClientGone);
  process.stdin.on("close", exitOnClientGone);

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
