// background.js - ScrapeFlow background service worker

import { getActiveTabId, executePageTool, formatToolResultForMcp } from "./shared/browser-tools.js";
import { executeNetworkTool, getNetworkLogSnapshot, syncNetworkAutoCapture } from "./shared/network-logs.js";
import { normalizeMcpBridgeSettings, normalizeTempEmailSettings, DEFAULT_MCP_BRIDGE_PORT } from "./shared/settings-schema.js";
import { WEB_SEARCH_TOOL_NAMES, isWebSearchAvailable, executeWebSearchTool, normalizeWebSearchSettings } from "./shared/tavily.js";

const RECONNECT_DELAY_MS = 3000;
const KEEPALIVE_ALARM = "scrapeflow-mcp-keepalive";

let bridgeSocket = null;
let bridgeReconnectTimer = null;
let bridgeConfig = {
  enabled: false,
  port: DEFAULT_MCP_BRIDGE_PORT,
  token: ""
};

let bridgeStatus = {
  connected: false,
  lastError: "",
  lastConnectedAt: null
};

let tempEmailConfig = {
  enabled: false,
  apiUrl: "",
  apiKey: ""
};

let toolAccessConfig = {
  enabled: {}
};

let webSearchConfig = normalizeWebSearchSettings(null);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting side panel behavior:", error));

chrome.runtime.onInstalled.addListener(async () => {
  await ensureMcpBridgeDefaults();
  await loadMcpBridgeConfig();
  await loadTempEmailConfig();
  await loadToolAccessConfig();
  await loadWebSearchConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadMcpBridgeConfig();
  await loadTempEmailConfig();
  await loadToolAccessConfig();
  await loadWebSearchConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.mcpBridge) {
    bridgeConfig = normalizeMcpBridgeSettings(changes.mcpBridge.newValue);
    scheduleMcpBridgeConnection();
  }
  if (changes.tempEmail) {
    tempEmailConfig = normalizeTempEmailSettings(changes.tempEmail.newValue);
    sendFeatureFlagsToBridge();
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
  if (!bridgeConfig.enabled) return;
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    scheduleMcpBridgeConnection();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const stored = await chrome.storage.session.get(["latchedTab"]);
    if (stored.latchedTab && stored.latchedTab.tabId === tabId) {
      await chrome.storage.session.remove("latchedTab");
    }
  } catch (e) {
    // ignore — session storage may not be available very early in lifecycle
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
  } catch (e) {
    // ignore
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "latch-tab/get") {
    (async () => {
      try {
        const stored = await chrome.storage.session.get(["latchedTab"]);
        const latched = stored.latchedTab || null;
        if (latched) {
          // Verify the tab still exists. If not, clear and report no latch.
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
      await loadTempEmailConfig();
      await loadToolAccessConfig();
      await loadWebSearchConfig();
      sendFeatureFlagsToBridge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "network-tool" && message.name) {
    (async () => {
      try {
        const tabId = await getActiveTabId();
        const result = await executeNetworkTool(message.name, message.arguments || {}, tabId);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, result: err.message || String(err) });
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

  if (message?.type === "page-tool" && message.name) {
    (async () => {
      try {
        const result = await executePageTool(message.name, message.arguments || {});
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, result: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});

async function ensureMcpBridgeDefaults(forceNewToken = false) {
  const stored = await chrome.storage.local.get(["mcpBridge"]);
  const current = stored.mcpBridge;
  if (current && current.token && !forceNewToken) {
    return current.token;
  }

  const token = generateBridgeToken();
  const next = {
    enabled: current?.enabled === true,
    port: Number(current?.port) || DEFAULT_MCP_BRIDGE_PORT,
    token
  };
  await chrome.storage.local.set({ mcpBridge: next });
  bridgeConfig = next;
  return token;
}

function generateBridgeToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadMcpBridgeConfig() {
  await ensureMcpBridgeDefaults(false);
  const stored = await chrome.storage.local.get(["mcpBridge"]);
  bridgeConfig = normalizeMcpBridgeSettings(stored.mcpBridge);
}

async function loadTempEmailConfig() {
  const stored = await chrome.storage.local.get(["tempEmail"]);
  tempEmailConfig = normalizeTempEmailSettings(stored.tempEmail);
}

function normalizeToolAccessConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const enabled = value.enabled && typeof value.enabled === "object" ? value.enabled : {};
  return { enabled };
}

async function loadToolAccessConfig() {
  const stored = await chrome.storage.local.get(["toolAccess"]);
  toolAccessConfig = normalizeToolAccessConfig(stored.toolAccess);
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

function sendFeatureFlagsToBridge() {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
  try {
    bridgeSocket.send(JSON.stringify({
      type: "feature-flags/set",
      flags: {
        tempEmail: {
          enabled: tempEmailConfig.enabled === true,
          apiUrl: tempEmailConfig.apiUrl || "",
          apiKey: tempEmailConfig.apiKey || ""
        },
        toolAccess: toolAccessConfig,
        // Only advertise availability. The Tavily key stays in the extension;
        // the bridge runs the search itself when an MCP client calls the tool.
        webSearch: {
          enabled: isWebSearchAvailable(webSearchConfig)
        }
      }
    }));
  } catch (e) {
    // best-effort
  }
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
    } catch {
      // ignore
    }
    bridgeSocket = null;
  }
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

  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "register",
      client: "scrapeflow-extension",
      version: chrome.runtime.getManifest().version,
      token: bridgeConfig.token || ""
    }));
  };

  socket.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.type === "register/ok") {
      bridgeStatus.connected = true;
      bridgeStatus.lastError = "";
      bridgeStatus.lastConnectedAt = Date.now();
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
      try {
        const rawResult = WEB_SEARCH_TOOL_NAMES.has(message.name)
          ? await executeWebSearchTool(message.name, message.arguments || {}, webSearchConfig)
          : await executePageTool(message.name, message.arguments || {});
        const formatted = formatToolResultForMcp(rawResult);
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
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    connectBridge();
  }, RECONNECT_DELAY_MS);
}

loadMcpBridgeConfig().then(() => {
  scheduleMcpBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
});

loadTempEmailConfig();
loadToolAccessConfig();
syncNetworkAutoCaptureFromStorage();
