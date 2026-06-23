// background.js - ScrapeFlow background service worker

importScripts("shared/browser-tools.js");

const DEFAULT_MCP_BRIDGE_PORT = 9229;
const DEFAULT_LOCAL_BRIDGE_PORT = 9230;
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

let localBridgeSocket = null;
let localBridgeReconnectTimer = null;
let localBridgeConfig = {
  enabled: false,
  port: DEFAULT_LOCAL_BRIDGE_PORT,
  token: ""
};
let localBridgeStatus = {
  connected: false,
  lastError: "",
  lastConnectedAt: null,
  workspace: "",
  mode: "workspace",
  codex: false
};
const localBridgePendingRequests = new Map();

let tempEmailConfig = {
  enabled: false,
  apiUrl: "",
  apiKey: ""
};

let toolAccessConfig = {
  enabled: {}
};

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting side panel behavior:", error));

chrome.runtime.onInstalled.addListener(async () => {
  await ensureMcpBridgeDefaults();
  await loadMcpBridgeConfig();
  await ensureLocalBridgeDefaults();
  await loadLocalBridgeConfig();
  await loadTempEmailConfig();
  await loadToolAccessConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
  scheduleLocalBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadMcpBridgeConfig();
  await loadLocalBridgeConfig();
  await loadTempEmailConfig();
  await loadToolAccessConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
  scheduleLocalBridgeConnection();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.mcpBridge) {
    bridgeConfig = normalizeMcpBridgeConfig(changes.mcpBridge.newValue);
    scheduleMcpBridgeConnection();
  }
  if (changes.localBridge) {
    localBridgeConfig = normalizeLocalBridgeConfig(changes.localBridge.newValue);
    scheduleLocalBridgeConnection();
  }
  if (changes.tempEmail) {
    tempEmailConfig = normalizeTempEmailConfig(changes.tempEmail.newValue);
    sendFeatureFlagsToBridge();
  }
  if (changes.toolAccess) {
    toolAccessConfig = normalizeToolAccessConfig(changes.toolAccess.newValue);
    sendFeatureFlagsToBridge();
  }
  if (changes.networkCapture) {
    syncNetworkAutoCaptureFromStorage();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!bridgeConfig.enabled && !localBridgeConfig.enabled) return;
  if (bridgeConfig.enabled && (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN)) {
    scheduleMcpBridgeConnection();
  }
  if (localBridgeConfig.enabled && (!localBridgeSocket || localBridgeSocket.readyState !== WebSocket.OPEN)) {
    scheduleLocalBridgeConnection();
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
      sendFeatureFlagsToBridge();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "local-bridge/get-status") {
    sendResponse({
      ok: true,
      config: {
        enabled: localBridgeConfig.enabled,
        port: localBridgeConfig.port,
        token: localBridgeConfig.token
      },
      status: localBridgeStatus
    });
    return false;
  }

  if (message?.type === "local-bridge/reconnect") {
    scheduleLocalBridgeConnection(true);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "local-bridge/regenerate-token") {
    ensureLocalBridgeDefaults(true).then((token) => {
      sendResponse({ ok: true, token });
    });
    return true;
  }

  if (message?.type === "local-bridge/request") {
    sendLocalBridgeRequest(message.message || {}).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
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

function normalizeMcpBridgeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    port: Number(value.port) || DEFAULT_MCP_BRIDGE_PORT,
    token: String(value.token || "")
  };
}

function normalizeLocalBridgeConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    port: Number(value.port) || DEFAULT_LOCAL_BRIDGE_PORT,
    token: String(value.token || "")
  };
}

async function ensureLocalBridgeDefaults(forceNewToken = false) {
  const stored = await chrome.storage.local.get(["localBridge"]);
  const current = stored.localBridge;
  if (current && current.token && !forceNewToken) {
    return current.token;
  }
  const token = generateBridgeToken();
  const next = {
    enabled: current?.enabled === true,
    port: Number(current?.port) || DEFAULT_LOCAL_BRIDGE_PORT,
    token
  };
  await chrome.storage.local.set({ localBridge: next });
  localBridgeConfig = next;
  return token;
}

async function loadLocalBridgeConfig() {
  await ensureLocalBridgeDefaults(false);
  const stored = await chrome.storage.local.get(["localBridge"]);
  localBridgeConfig = normalizeLocalBridgeConfig(stored.localBridge);
}

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
  bridgeConfig = normalizeMcpBridgeConfig(stored.mcpBridge);
}

function normalizeTempEmailConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    apiUrl: typeof value.apiUrl === "string" ? value.apiUrl.trim() : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : ""
  };
}

async function loadTempEmailConfig() {
  const stored = await chrome.storage.local.get(["tempEmail"]);
  tempEmailConfig = normalizeTempEmailConfig(stored.tempEmail);
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
        toolAccess: toolAccessConfig
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
        const rawResult = await executePageTool(message.name, message.arguments || {});
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

function sendLocalBridgeRequest(message, timeoutMs = 120000) {
  if (!localBridgeSocket || localBridgeSocket.readyState !== WebSocket.OPEN || !localBridgeStatus.connected) {
    return Promise.reject(new Error("Local CLI bridge is not connected"));
  }
  const id = message.id || crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      localBridgePendingRequests.delete(id);
      reject(new Error("Local CLI bridge request timed out"));
    }, timeoutMs);
    localBridgePendingRequests.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    localBridgeSocket.send(JSON.stringify({ ...message, id }));
  });
}

function scheduleLocalBridgeConnection(force = false) {
  if (localBridgeReconnectTimer) {
    clearTimeout(localBridgeReconnectTimer);
    localBridgeReconnectTimer = null;
  }
  if (force) disconnectLocalBridge();
  if (!localBridgeConfig.enabled) {
    disconnectLocalBridge();
    localBridgeStatus.lastError = "";
    return;
  }
  connectLocalBridge();
}

function disconnectLocalBridge() {
  if (localBridgeSocket) {
    localBridgeSocket.onopen = null;
    localBridgeSocket.onclose = null;
    localBridgeSocket.onerror = null;
    localBridgeSocket.onmessage = null;
    try {
      localBridgeSocket.close();
    } catch {
      // ignore
    }
    localBridgeSocket = null;
  }
  localBridgeStatus.connected = false;
  for (const pending of localBridgePendingRequests.values()) {
    pending.reject(new Error("Local CLI bridge disconnected"));
  }
  localBridgePendingRequests.clear();
}

function connectLocalBridge() {
  if (!localBridgeConfig.enabled) return;
  if (localBridgeSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(localBridgeSocket.readyState)) {
    return;
  }

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${localBridgeConfig.port}`);
  } catch (error) {
    localBridgeStatus.lastError = error.message || "Could not open local bridge socket";
    queueLocalBridgeReconnect();
    return;
  }
  localBridgeSocket = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "register",
      client: "scrapeflow-extension-local-workspace",
      version: chrome.runtime.getManifest().version,
      token: localBridgeConfig.token || ""
    }));
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.type === "register/ok") {
      localBridgeStatus = {
        connected: true,
        lastError: "",
        lastConnectedAt: Date.now(),
        workspace: message.workspace || "",
        mode: message.mode || "workspace",
        codex: message.codex === true
      };
      chrome.runtime.sendMessage({ type: "local-bridge/status", status: localBridgeStatus }).catch(() => {});
      return;
    }

    if (message.type === "register/error") {
      localBridgeStatus.connected = false;
      localBridgeStatus.lastError = message.error || "Registration failed";
      disconnectLocalBridge();
      queueLocalBridgeReconnect();
      return;
    }

    if (message.id && localBridgePendingRequests.has(message.id)) {
      const pending = localBridgePendingRequests.get(message.id);
      localBridgePendingRequests.delete(message.id);
      if (message.type === "tool/result") {
        if (message.result?.isError) {
          pending.reject(new Error(message.result.content?.[0]?.text || "Workspace tool failed"));
        } else {
          pending.resolve(message.result);
        }
      } else if (message.type === "codex/error" || message.error) {
        pending.reject(new Error(message.error || "Codex request failed"));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === "codex/event") {
      chrome.runtime.sendMessage({ type: "local-bridge/codex-event", event: message.event }).catch(() => {});
    }
  };

  socket.onclose = () => {
    if (localBridgeSocket === socket) localBridgeSocket = null;
    localBridgeStatus.connected = false;
    chrome.runtime.sendMessage({ type: "local-bridge/status", status: localBridgeStatus }).catch(() => {});
    if (localBridgeConfig.enabled) queueLocalBridgeReconnect();
  };

  socket.onerror = () => {
    localBridgeStatus.lastError = "WebSocket connection failed";
  };
}

function queueLocalBridgeReconnect() {
  if (!localBridgeConfig.enabled || localBridgeReconnectTimer) return;
  localBridgeReconnectTimer = setTimeout(() => {
    localBridgeReconnectTimer = null;
    connectLocalBridge();
  }, RECONNECT_DELAY_MS);
}

loadMcpBridgeConfig().then(() => {
  scheduleMcpBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
});

loadLocalBridgeConfig().then(() => {
  scheduleLocalBridgeConnection();
});

loadTempEmailConfig();
loadToolAccessConfig();
syncNetworkAutoCaptureFromStorage();
