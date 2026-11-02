import { getActiveTabId, executePageTool, formatToolResultForMcp, fitResultToBridge } from "./shared/browser-tools.js";
import { getNetworkLogSnapshot, syncNetworkAutoCapture } from "./shared/network-logs.js";
import {
  normalizeMcpBridgeSettings,
  normalizeLoomBridgeSettings,
  DEFAULT_MCP_BRIDGE_PORT
} from "./shared/settings-schema.js";
import { createBridgeConnection, randomHex } from "./background/bridge-connection.js";
import { askLoomHost, createLoomLink } from "./background/loom-link.js";
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
import { BATCH_TOOL_NAME, runBatch } from "./shared/batch-core.js";

// A server holds its client's first tools/list open for a few seconds; starting
// low puts the first retries inside that window instead of after it. The cap
// bounds discovery of a freshly started server even after a long-idle bridge —
// a failed loopback connect every 5s is negligible.
const RECONNECT_BASE_DELAY_MS = 750;
const RECONNECT_MAX_DELAY_MS = 5000;
const KEEPALIVE_ALARM = "margin-bridge-keepalive";
// Asks the Loom host again while not connected: twice in the first minute
// after the worker starts, then every 5 minutes.
const LOOM_RETRY_ALARM = "margin-loom-retry";
const LOOM_EARLY_RETRY_WINDOW_MS = 60 * 1000;
const workerStartedAt = Date.now();

// Keep extension secrets inaccessible to any future content script.
if (chrome.storage.local.setAccessLevel) {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) => console.warn("Could not restrict local storage access:", error));
}

let bridgeConfig = {
  enabled: false,
  port: DEFAULT_MCP_BRIDGE_PORT,
  token: ""
};

// Off until storage is read, so an alarm that wakes the worker cannot ask the
// host for a user who switched Loom off.
let loomConfig = { enabled: false };

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
  await startLoomLink();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadMcpBridgeConfig();
  await loadToolAccessConfig();
  await loadWebSearchConfig();
  await syncNetworkAutoCaptureFromStorage();
  scheduleMcpBridgeConnection();
  await startLoomLink();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.mcpBridge) {
    bridgeConfig = normalizeMcpBridgeSettings(changes.mcpBridge.newValue);
    scheduleMcpBridgeConnection(true);
  }
  if (changes.loomBridge) {
    loomConfig = normalizeLoomBridgeSettings(changes.loomBridge.newValue);
    applyLoomConfig();
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
  if (alarm.name === LOOM_RETRY_ALARM) {
    if (loomConfig.enabled) {
      scheduleLoomRetry();
      loomLink.check();
    }
    return;
  }
  if (alarm.name !== KEEPALIVE_ALARM) return;
  manualBridge.ensureConnected();
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
      status: manualBridge.status
    });
    return false;
  }

  // The Loom token never leaves the background, so it is not in this reply.
  if (message?.type === "loom-bridge/get-status") {
    sendResponse({ ok: true, enabled: loomConfig.enabled, status: loomLink.getStatus() });
    return false;
  }

  if (message?.type === "mcp-bridge/reconnect") {
    scheduleMcpBridgeConnection(true);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "mcp-bridge/regenerate-token") {
    // Without the catch a rejection leaves the settings UI awaiting a response
    // that never arrives, the same way the old bridge panel routing hung.
    ensureMcpBridgeDefaults(true).then((token) => {
      sendResponse({ ok: true, token });
    }).catch((err) => {
      sendResponse({ ok: false, error: err?.message || String(err) });
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
  if (surface !== "panel") {
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

async function loadMcpBridgeConfig() {
  await ensureMcpBridgeDefaults(false);
  const stored = await chrome.storage.local.get(["mcpBridge"]);
  bridgeConfig = normalizeMcpBridgeSettings(stored.mcpBridge);
}

async function loadLoomBridgeConfig() {
  const stored = await chrome.storage.local.get(["loomBridge"]);
  loomConfig = normalizeLoomBridgeSettings(stored.loomBridge);
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

function buildBridgeFeatureFlags() {
  return {
    tools: buildBridgeToolSchemas(),
    toolAccess: toolAccessConfig,
    // Only advertise availability. The Tavily key stays in the extension,
    // which runs the search when an MCP client calls the tool.
    webSearch: {
      enabled: isWebSearchAvailable(webSearchConfig)
    }
  };
}

function sendFeatureFlagsToBridge() {
  manualBridge.sendFeatureFlags();
  loomLink.sendFeatureFlags();
}

// Every tool the bridge advertises (MCP_PROXIED_TOOLS = BROWSER_TOOLS +
// RECON_TOOLS) runs in this service worker, so the bridge never needs an open
// side panel and there is no redundant background -> panel -> background round
// trip. browser_batch runs the shared batch core here with a background
// adapter; the panel runs the same core for the in-chat agent.
// Default deny, matching the direct tool/call path above: a tool with no Tool
// Access entry must not become reachable by wrapping it in a batch when a direct
// call would refuse it.
function isBatchActionEnabled(tool) {
  return isStoredToolEnabled(tool);
}

// The bridge has no agent run, so the in-chat tool budget and loop guards do
// not apply here — only the per-action access gate does.
function runBridgeBatch(args, surface) {
  return runBatch(args, {
    // Each action is journaled individually. Calling executePageTool here skips
    // the "page-tool" message handler that normally records them, and a lone
    // browser_batch entry would leave the audit trail without the actions.
    runTool: async (tool, toolArgs) => {
      try {
        const result = await executePageTool(tool, toolArgs);
        recordToolJournalEntry({ surface, tool, args: toolArgs, outcome: journalOutcome(result) });
        return result;
      } catch (err) {
        recordToolJournalEntry({ surface, tool, args: toolArgs, outcome: "error" });
        throw err;
      }
    },
    isToolEnabled: isBatchActionEnabled
  });
}

async function runBridgePageTool(message, surface) {
  const args = message.arguments || {};
  try {
    const result = message.name === BATCH_TOOL_NAME
      ? await runBridgeBatch(args, surface)
      : await executePageTool(message.name, args);
    recordToolJournalEntry({ surface, tool: message.name, args, outcome: journalOutcome(result) });
    return result;
  } catch (err) {
    recordToolJournalEntry({ surface, tool: message.name, args, outcome: "error" });
    throw err;
  }
}

// Bridge web searches run entirely in the background, so this is the only
// place they can be journaled — they never reach executePageTool.
async function runBridgeWebSearch(message, surface) {
  const args = message.arguments || {};
  try {
    const result = await executeWebSearchTool(message.name, args, webSearchConfig);
    recordToolJournalEntry({ surface, tool: message.name, args, outcome: journalOutcome(result) });
    return result;
  } catch (err) {
    recordToolJournalEntry({ surface, tool: message.name, args, outcome: "error" });
    throw err;
  }
}

// Both bridges run calls through here, so Tool Access gates them the same way.
async function handleBridgeToolCall(message, surface) {
  await toolAccessReady;
  if (!isStoredToolEnabled(message.name)) {
    return {
      content: [{ type: "text", text: `Tool "${message.name}" is disabled in Margin settings.` }],
      isError: true
    };
  }
  try {
    return WEB_SEARCH_TOOL_NAMES.has(message.name)
      ? formatToolResultForMcp(await runBridgeWebSearch(message, surface))
      : formatToolResultForMcp(await runBridgePageTool(message, surface));
  } catch (err) {
    return {
      content: [{ type: "text", text: err.message || String(err) }],
      isError: true
    };
  }
}

const bridgeConnectionOptions = {
  buildFeatureFlags: buildBridgeFeatureFlags,
  fitResult: fitResultToBridge,
  getVersion: () => chrome.runtime.getManifest().version
};

// The user's own MCP bridge (Claude Code, Cursor, ...), set up in Settings.
const manualBridge = createBridgeConnection({
  ...bridgeConnectionOptions,
  getTarget: () => bridgeConfig,
  handleToolCall: (message) => handleBridgeToolCall(message, "bridge"),
  baseDelayMs: RECONNECT_BASE_DELAY_MS,
  maxDelayMs: RECONNECT_MAX_DELAY_MS
});

// Loom for Windows. Its port and token come only from the native host.
const loomLink = createLoomLink({
  askHost: () => askLoomHost(chrome.runtime),
  isEnabled: () => loomConfig.enabled,
  connectionOptions: {
    ...bridgeConnectionOptions,
    handleToolCall: (message) => handleBridgeToolCall(message, "loom")
  },
  log: (text) => console.debug(`Margin: ${text}`)
});

function scheduleMcpBridgeConnection(force = false) {
  manualBridge.schedule(force);
}

function scheduleLoomRetry() {
  const early = Date.now() - workerStartedAt < LOOM_EARLY_RETRY_WINDOW_MS;
  chrome.alarms.create(LOOM_RETRY_ALARM, { delayInMinutes: early ? 0.5 : 5 });
}

function applyLoomConfig() {
  if (!loomConfig.enabled) {
    chrome.alarms.clear(LOOM_RETRY_ALARM).catch(() => {});
    loomLink.stop();
    return;
  }
  scheduleLoomRetry();
  loomLink.check();
}

async function startLoomLink() {
  await loadLoomBridgeConfig();
  applyLoomConfig();
}

loadMcpBridgeConfig().then(() => {
  scheduleMcpBridgeConnection();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
});

loadToolAccessConfig();
loadWebSearchConfig();
syncNetworkAutoCaptureFromStorage();
startLoomLink();
