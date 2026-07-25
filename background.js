import { getActiveTabId, executePageTool, formatToolResultForMcp } from "./shared/browser-tools.js";
import { getNetworkLogSnapshot, syncNetworkAutoCapture } from "./shared/network-logs.js";
import {
  normalizeMcpBridgeSettings,
  DEFAULT_MCP_BRIDGE_PORT
} from "./shared/settings-schema.js";
import {
  cancelOpenAIDeviceAuthorization,
  getOpenAIOAuthStatus,
  getOpenAISubscriptionModels,
  handleOpenAIResponsePort,
  logoutOpenAI,
  openOpenAIDevicePage,
  pollOpenAIDeviceAuthorization,
  startOpenAIDeviceAuthorization
} from "./background/openai-service.js";
import { WEB_SEARCH_TOOL_NAMES, isWebSearchAvailable, executeWebSearchTool, normalizeWebSearchSettings } from "./shared/tavily.js";
import { MCP_PROXIED_TOOLS, toMcpToolSchema } from "./shared/tool-schemas.js";
import { buildJournalEntry, appendJournalEntry } from "./shared/journal.js";
import { BUILT_IN_TOOL_NAMES, DEFAULT_ENABLED_TOOLS } from "./sidepanel/settings/sections/tool-access.js";

const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;
const KEEPALIVE_ALARM = "margin-bridge-keepalive";
const SERVER_PROOF_PREFIX = "margin-bridge-server:";
const CLIENT_PROOF_PREFIX = "margin-bridge-client:";

// Keep extension secrets inaccessible to any future content script.
if (chrome.storage.local.setAccessLevel) {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) => console.warn("Could not restrict local storage access:", error));
}

let bridgeSocket = null;
let bridgeRegistered = false;
let bridgeReconnectTimer = null;
let bridgeReconnectDelayMs = RECONNECT_BASE_DELAY_MS;
let bridgeConfig = {
  enabled: false,
  port: DEFAULT_MCP_BRIDGE_PORT,
  token: ""
};

let bridgeStatus = {
  connected: false,
  lastError: ""
};

let toolAccessConfig = normalizeToolAccessConfig(null);
let toolAccessReady;

let webSearchConfig = normalizeWebSearchSettings(null);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting side panel behavior:", error));

chrome.runtime.onInstalled.addListener(async () => {
  await ensureMcpBridgeDefaults();
  await loadMcpBridgeConfig();
  await loadToolAccessConfig();
  await loadWebSearchConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadMcpBridgeConfig();
  await loadToolAccessConfig();
  await loadWebSearchConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.mcpBridge) {
    bridgeConfig = normalizeMcpBridgeSettings(changes.mcpBridge.newValue);
    scheduleMcpBridgeConnection(true);
  }
  if (changes.toolAccess) {
    toolAccessConfig = normalizeToolAccessConfig(changes.toolAccess.newValue);
    sendFeatureFlagsToBridge();
  }
  if (changes.webSearch) {
    webSearchConfig = normalizeWebSearchSettings(changes.webSearch.newValue);
    sendFeatureFlagsToBridge();
  }
  if (changes.networkCapture) {
    syncNetworkAutoCaptureFromStorage();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (bridgeConfig.enabled && !bridgeReconnectTimer && (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN)) {
    scheduleMcpBridgeConnection();
  }
  pollOpenAIDeviceAuthorization().catch(() => {});
});

chrome.runtime.onConnect.addListener(handleOpenAIResponsePort);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const stored = await chrome.storage.session.get(["latchedTab"]);
    if (stored.latchedTab && stored.latchedTab.tabId === tabId) {
      await chrome.storage.session.remove("latchedTab");
    }
  } catch (e) {
    // Session storage may be unavailable early in the extension lifecycle.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url && !changeInfo.title) return;
  try {
    const stored = await chrome.storage.session.get(["latchedTab"]);
    if (stored.latchedTab && stored.latchedTab.tabId === tabId) {
      const updated = { ...stored.latchedTab };
      if (changeInfo.url) updated.url = changeInfo.url;
      if (changeInfo.title) updated.title = changeInfo.title;
      await chrome.storage.session.set({ latchedTab: updated });
    }
  } catch (e) {}
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "latch-tab/get") {
    (async () => {
      try {
        const stored = await chrome.storage.session.get(["latchedTab"]);
        const latched = stored.latchedTab || null;
        if (latched) {
          try {
            await chrome.tabs.get(latched.tabId);
          } catch {
            await chrome.storage.session.remove("latchedTab");
            sendResponse({ ok: true, tab: null });
            return;
          }
        }
        sendResponse({ ok: true, tab: latched });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "latch-tab/set") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab || typeof tab.id !== "number") {
          sendResponse({ ok: false, error: "No active tab" });
          return;
        }
        const info = {
          tabId: tab.id,
          url: tab.url || "",
          title: tab.title || "",
          windowId: tab.windowId
        };
        await chrome.storage.session.set({ latchedTab: info });
        await syncNetworkAutoCapture(info);
        sendResponse({ ok: true, tab: info });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "latch-tab/clear") {
    (async () => {
      try {
        await syncNetworkAutoCapture(null);
        await chrome.storage.session.remove("latchedTab");
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (message?.type === "network-capture/settings-changed") {
    syncNetworkAutoCaptureFromStorage().then((result) => {
      sendResponse({ ok: true, result });
    }).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message?.type === "mcp-bridge/get-status") {
    sendResponse({
      ok: true,
      config: {
        enabled: bridgeConfig.enabled,
        port: bridgeConfig.port,
        token: bridgeConfig.token
      },
      status: bridgeStatus
    });
    return false;
  }

  if (message?.type === "mcp-bridge/reconnect") {
    scheduleMcpBridgeConnection(true);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "mcp-bridge/regenerate-token") {
    ensureMcpBridgeDefaults(true).then((token) => {
      sendResponse({ ok: true, token });
    });
    return true;
  }

  if (message?.type === "mcp-bridge/feature-flags-changed") {
    (async () => {
      await loadToolAccessConfig();
      await loadWebSearchConfig();
      sendFeatureFlagsToBridge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (String(message?.type || "").startsWith("openai-oauth/")) {
    (async () => {
      try {
        let result;
        if (message.type === "openai-oauth/status") result = await getOpenAIOAuthStatus();
        else if (message.type === "openai-oauth/start") result = await startOpenAIDeviceAuthorization();
        else if (message.type === "openai-oauth/poll") result = await pollOpenAIDeviceAuthorization();
        else if (message.type === "openai-oauth/cancel") result = await cancelOpenAIDeviceAuthorization();
        else if (message.type === "openai-oauth/logout") result = await logoutOpenAI();
        else if (message.type === "openai-oauth/open-device") result = await openOpenAIDevicePage();
        else if (message.type === "openai-oauth/models") result = await getOpenAISubscriptionModels();
        else throw new Error("Unknown OpenAI OAuth request.");
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "network-logs/snapshot") {
    (async () => {
      try {
        const tabId = await getActiveTabId();
        const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
        const result = await getNetworkLogSnapshot(tabId, message.arguments || {});
        sendResponse({
          ok: true,
          result: {
            ...result,
            tab: tab ? {
              id: tab.id,
              title: tab.title || "",
              url: tab.url || "",
              windowId: tab.windowId
            } : null
          }
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "panel/opened") {
    bridgeBadgeCount = 0;
    updateBridgeBadge();
    return false;
  }

  if (message?.type === "page-tool" && message.name) {
    (async () => {
      const surface = message.surface === "bridge" ? "bridge" : "panel";
      const args = message.arguments || {};
      try {
        await toolAccessReady;
        if (!isStoredToolEnabled(message.name)) {
          recordToolJournalEntry({ surface, tool: message.name, args, outcome: "tool_disabled" });
          sendResponse({ ok: false, result: `Tool "${message.name}" is disabled in Margin settings.` });
          return;
        }
        const result = await executePageTool(message.name, args);
        recordToolJournalEntry({ surface, tool: message.name, args, outcome: journalOutcome(result) });
        sendResponse({ ok: true, result });
      } catch (err) {
        recordToolJournalEntry({ surface, tool: message.name, args, outcome: "error" });
        sendResponse({ ok: false, result: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});

// --- Tool journal -----------------------------------------------------------
// Fire-and-forget audit log in chrome.storage.local. Writes are chained so
// concurrent tool calls cannot lose entries; callers never await the chain, so
// tool latency is unchanged.

let toolJournalWriteChain = Promise.resolve();
let bridgeBadgeCount = 0;

function recordToolJournalEntry({ surface, tool, args, outcome }) {
  const ts = Date.now();
  toolJournalWriteChain = toolJournalWriteChain.then(async () => {
    const host = await resolveActiveTabHost();
    const entry = buildJournalEntry({ ts, surface, tool, host, args, outcome });
    const stored = await chrome.storage.local.get(["toolJournal"]);
    await chrome.storage.local.set({ toolJournal: appendJournalEntry(stored.toolJournal, entry) });
  }).catch(() => {});
  if (surface === "bridge") {
    bridgeBadgeCount += 1;
    updateBridgeBadge();
  }
}

async function resolveActiveTabHost() {
  try {
    const tabId = await getActiveTabId();
    if (!tabId) return "";
    const tab = await chrome.tabs.get(tabId);
    return tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    return "";
  }
}

function updateBridgeBadge() {
  const text = bridgeBadgeCount === 0 ? "" : bridgeBadgeCount > 99 ? "99+" : String(bridgeBadgeCount);
  chrome.action.setBadgeText({ text }).catch(() => {});
}

// Tool results are either plain strings, structured failure objects, or JSON
// strings of those objects; the journal only needs "ok" vs an error_code.
function journalOutcome(result) {
  let value = result;
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try {
      value = JSON.parse(value);
    } catch {
      return "ok";
    }
  }
  if (value && typeof value === "object" && value.ok === false) {
    return String(value.error_code || "error");
  }
  return "ok";
}

let mcpBridgeDefaultsPromise = null;

function ensureMcpBridgeDefaults(forceNewToken = false) {
  if (mcpBridgeDefaultsPromise && !forceNewToken) return mcpBridgeDefaultsPromise;

  mcpBridgeDefaultsPromise = (async () => {
    const stored = await chrome.storage.local.get(["mcpBridge"]);
    const current = stored.mcpBridge;
    if (current && current.token && !forceNewToken) {
      return current.token;
    }

    const token = randomHex(16);
    const next = {
      enabled: current?.enabled === true,
      port: Number(current?.port) || DEFAULT_MCP_BRIDGE_PORT,
      token
    };
    await chrome.storage.local.set({ mcpBridge: next });
    bridgeConfig = next;
    return token;
  })();

  return mcpBridgeDefaultsPromise;
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function bridgeProof(token, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bridgeProofsMatch(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

async function loadMcpBridgeConfig() {
  await ensureMcpBridgeDefaults(false);
  const stored = await chrome.storage.local.get(["mcpBridge"]);
  bridgeConfig = normalizeMcpBridgeSettings(stored.mcpBridge);
}

function normalizeToolAccessConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const stored = value.enabled && typeof value.enabled === "object" ? value.enabled : {};
  const enabled = {};
  BUILT_IN_TOOL_NAMES.forEach((toolName) => {
    enabled[toolName] = Object.hasOwn(stored, toolName)
      ? stored[toolName] === true
      : DEFAULT_ENABLED_TOOLS.has(toolName);
  });
  return { enabled };
}

function isStoredToolEnabled(toolName) {
  return toolAccessConfig.enabled?.[toolName] === true;
}

function loadToolAccessConfig() {
  toolAccessReady = (async () => {
    const stored = await chrome.storage.local.get(["toolAccess"]);
    toolAccessConfig = normalizeToolAccessConfig(stored.toolAccess);
  })();
  return toolAccessReady;
}

async function loadWebSearchConfig() {
  const stored = await chrome.storage.local.get(["webSearch"]);
  webSearchConfig = normalizeWebSearchSettings(stored.webSearch);
}

async function syncNetworkAutoCaptureFromStorage() {
  try {
    const stored = await chrome.storage.session.get(["latchedTab"]);
    const latched = stored.latchedTab || null;
    return await syncNetworkAutoCapture(latched);
  } catch (err) {
    return `Network auto-capture sync failed: ${err.message}`;
  }
}

// The bridge server keeps no tool definitions of its own, so the extension is
// the single source of truth for what MCP clients can see and call.
function buildBridgeToolSchemas() {
  return MCP_PROXIED_TOOLS
    .filter((tool) => isStoredToolEnabled(tool.function?.name))
    .map(toMcpToolSchema);
}

function sendFeatureFlagsToBridge() {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
  try {
    bridgeSocket.send(JSON.stringify({
      type: "feature-flags/set",
      flags: {
        tools: buildBridgeToolSchemas(),
        toolAccess: toolAccessConfig,
        // Only advertise availability. The Tavily key stays in the extension,
        // which runs the search when an MCP client calls the tool.
        webSearch: {
          enabled: isWebSearchAvailable(webSearchConfig)
        }
      }
    }));
  } catch (e) {}
}

// Side panels are per-window, so the broadcast has to name one panel or every
// open window would run the same tool call.
async function activePanelWindowId() {
  const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
  if (!panels.length) return null;
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  const active = panels.find((panel) => panel.windowId === focused?.id);
  return (active || panels[0]).windowId;
}

// Bridge web searches run entirely in the background, so this is the only
// place they can be journaled — they never reach executePageTool.
async function runBridgeWebSearch(message) {
  const args = message.arguments || {};
  try {
    const result = await executeWebSearchTool(message.name, args, webSearchConfig);
    recordToolJournalEntry({ surface: "bridge", tool: message.name, args, outcome: journalOutcome(result) });
    return result;
  } catch (err) {
    recordToolJournalEntry({ surface: "bridge", tool: message.name, args, outcome: "error" });
    throw err;
  }
}

async function requestMcpToolFromPanel(message) {
  const targetWindowId = await activePanelWindowId();
  if (targetWindowId === null) {
    return {
      content: [{ type: "text", text: "Open the Margin side panel to approve and run browser tools." }],
      isError: true,
    };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "mcp/tool-call",
      targetWindowId,
      name: message.name,
      arguments: message.arguments || {},
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          content: [{ type: "text", text: "Open the Margin side panel to approve and run browser tools." }],
          isError: true,
        });
        return;
      }
      resolve(response?.result || {
        content: [{ type: "text", text: "Margin returned no tool result." }],
        isError: true,
      });
    });
  });
}

function scheduleMcpBridgeConnection(force = false) {
  if (bridgeReconnectTimer) {
    clearTimeout(bridgeReconnectTimer);
    bridgeReconnectTimer = null;
  }

  if (force) {
    disconnectBridge();
  }

  if (!bridgeConfig.enabled) {
    disconnectBridge();
    bridgeStatus.connected = false;
    bridgeStatus.lastError = "";
    return;
  }

  connectBridge();
}

function disconnectBridge() {
  if (bridgeSocket) {
    bridgeSocket.onopen = null;
    bridgeSocket.onclose = null;
    bridgeSocket.onerror = null;
    bridgeSocket.onmessage = null;
    try {
      bridgeSocket.close();
    } catch {}
    bridgeSocket = null;
  }
  bridgeRegistered = false;
  bridgeStatus.connected = false;
}

function connectBridge() {
  if (!bridgeConfig.enabled) return;
  if (bridgeSocket && (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = `ws://127.0.0.1:${bridgeConfig.port}`;
  let socket;

  try {
    socket = new WebSocket(url);
  } catch (err) {
    bridgeStatus.lastError = err.message;
    queueReconnect();
    return;
  }

  bridgeSocket = socket;
  bridgeRegistered = false;
  const clientNonce = randomHex(32);

  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "hello",
      client: "margin-extension",
      version: chrome.runtime.getManifest().version,
      nonce: clientNonce
    }));
  };

  socket.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.type === "hello/proof") {
      const token = bridgeConfig.token || "";
      const [expectedServerProof, clientProof] = await Promise.all([
        bridgeProof(token, `${SERVER_PROOF_PREFIX}${clientNonce}`),
        bridgeProof(token, `${CLIENT_PROOF_PREFIX}${String(message.nonce || "")}`)
      ]);
      if (bridgeSocket !== socket) return;
      if (!bridgeProofsMatch(expectedServerProof, message.proof)) {
        bridgeStatus.lastError = "Bridge server failed authentication";
        disconnectBridge();
        queueReconnect();
        return;
      }
      socket.send(JSON.stringify({
        type: "register",
        proof: clientProof,
        client: "margin-extension",
        version: chrome.runtime.getManifest().version
      }));
      return;
    }

    if (message.type === "register/ok") {
      bridgeRegistered = true;
      bridgeStatus.connected = true;
      bridgeStatus.lastError = "";
      bridgeReconnectDelayMs = RECONNECT_BASE_DELAY_MS;
      sendFeatureFlagsToBridge();
      return;
    }

    if (message.type === "register/error") {
      bridgeStatus.connected = false;
      bridgeStatus.lastError = message.error || "Registration failed";
      disconnectBridge();
      queueReconnect();
      return;
    }

    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (message.type === "tool/call" && message.id && message.name) {
      if (!bridgeRegistered) return;
      await toolAccessReady;
      if (!isStoredToolEnabled(message.name)) {
        socket.send(JSON.stringify({
          type: "tool/result",
          id: message.id,
          result: {
            content: [{ type: "text", text: `Tool "${message.name}" is disabled in Margin settings.` }],
            isError: true
          }
        }));
        return;
      }
      try {
        const formatted = WEB_SEARCH_TOOL_NAMES.has(message.name)
          ? formatToolResultForMcp(await runBridgeWebSearch(message))
          : await requestMcpToolFromPanel(message);
        socket.send(JSON.stringify({
          type: "tool/result",
          id: message.id,
          result: formatted
        }));
      } catch (err) {
        socket.send(JSON.stringify({
          type: "tool/result",
          id: message.id,
          result: {
            content: [{ type: "text", text: err.message || String(err) }],
            isError: true
          }
        }));
      }
    }
  };

  socket.onclose = () => {
    if (bridgeSocket === socket) {
      bridgeSocket = null;
    }
    bridgeStatus.connected = false;
    if (bridgeConfig.enabled) {
      queueReconnect();
    }
  };

  socket.onerror = () => {
    bridgeStatus.lastError = "WebSocket connection failed";
  };
}

function queueReconnect() {
  if (!bridgeConfig.enabled || bridgeReconnectTimer) return;
  const delay = bridgeReconnectDelayMs;
  bridgeReconnectDelayMs = Math.min(bridgeReconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridge();
  }, delay);
}

loadMcpBridgeConfig().then(() => {
  scheduleMcpBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
});

loadToolAccessConfig();
loadWebSearchConfig();
syncNetworkAutoCaptureFromStorage();
