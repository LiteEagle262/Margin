import { settings } from "../../state/store.js";
import { showToast } from "../../lib/toast.js";
import { normalizeMcpBridgeSettings, DEFAULT_MCP_BRIDGE_PORT } from "../../../shared/settings-schema.js";

function buildMcpBridgeConfigSnippet(config) {
  const payload = {
    mcpServers: {
      margin: {
        command: "node",
        args: ["ABSOLUTE_PATH_TO_EXTENSION/mcp-server/index.js"],
        env: {
          MARGIN_MCP_PORT: String(config.port || DEFAULT_MCP_BRIDGE_PORT),
          ...(config.token ? { MARGIN_MCP_TOKEN: config.token } : {})
        }
      }
    }
  };
  return JSON.stringify(payload, null, 2);
}

async function renderMcpBridgeSettings() {
  const enabledInput = document.getElementById("mcp-bridge-enabled");
  const portInput = document.getElementById("mcp-bridge-port");
  const tokenInput = document.getElementById("mcp-bridge-token");
  const snippetEl = document.getElementById("mcp-bridge-config-snippet");

  try {
    const response = await chrome.runtime.sendMessage({ type: "mcp-bridge/get-status" });
    if (response?.config) {
      settings.mcpBridge = normalizeMcpBridgeSettings({
        ...settings.mcpBridge,
        ...response.config,
        token: settings.mcpBridge.token || response.config.token || ""
      });
    }
  } catch {
    // Background may be unavailable during startup.
  }

  if (enabledInput) enabledInput.checked = settings.mcpBridge.enabled === true;
  if (portInput) portInput.value = String(settings.mcpBridge.port || DEFAULT_MCP_BRIDGE_PORT);
  if (tokenInput) tokenInput.value = settings.mcpBridge.token || "";
  if (snippetEl) snippetEl.textContent = buildMcpBridgeConfigSnippet(settings.mcpBridge);

  refreshMcpBridgeStatus();
}

function collectMcpBridgeFromUI() {
  const enabledInput = document.getElementById("mcp-bridge-enabled");
  const portInput = document.getElementById("mcp-bridge-port");
  const tokenInput = document.getElementById("mcp-bridge-token");

  return normalizeMcpBridgeSettings({
    enabled: enabledInput ? enabledInput.checked : settings.mcpBridge.enabled,
    port: portInput ? Number(portInput.value) : settings.mcpBridge.port,
    token: tokenInput ? tokenInput.value.trim() : settings.mcpBridge.token
  });
}

async function refreshMcpBridgeStatus() {
  const badge = document.getElementById("mcp-bridge-status-badge");
  if (!badge) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: "mcp-bridge/get-status" });
    const enabled = response?.config?.enabled === true;
    const connected = response?.status?.connected === true;

    if (!enabled) {
      badge.textContent = "Disabled";
      badge.className = "mcp-bridge-badge";
      return;
    }

    if (connected) {
      badge.textContent = "Bridge connected";
      badge.className = "mcp-bridge-badge connected";
      return;
    }

    badge.textContent = response?.status?.lastError
      ? `Waiting (${response.status.lastError})`
      : "Waiting for MCP server";
    badge.className = "mcp-bridge-badge pending";
  } catch (err) {
    badge.textContent = "Status unavailable";
    badge.className = "mcp-bridge-badge error";
  }
}

function initMcpBridgeSettings() {
  const enabledInput = document.getElementById("mcp-bridge-enabled");
  const portInput = document.getElementById("mcp-bridge-port");
  const tokenInput = document.getElementById("mcp-bridge-token");
  const copyTokenBtn = document.getElementById("copy-mcp-bridge-token-btn");
  const regenTokenBtn = document.getElementById("regenerate-mcp-bridge-token-btn");
  const copyConfigBtn = document.getElementById("copy-mcp-bridge-config-btn");

  const updateSnippet = () => {
    const snippetEl = document.getElementById("mcp-bridge-config-snippet");
    if (snippetEl) {
      snippetEl.textContent = buildMcpBridgeConfigSnippet(collectMcpBridgeFromUI());
    }
  };

  [enabledInput, portInput, tokenInput].forEach(el => {
    el?.addEventListener("input", updateSnippet);
    el?.addEventListener("change", updateSnippet);
  });

  copyTokenBtn?.addEventListener("click", async () => {
    const token = tokenInput?.value || "";
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      showToast("Auth token copied");
    } catch {
      showToast("Could not copy token");
    }
  });

  regenTokenBtn?.addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "mcp-bridge/regenerate-token" });
      if (response?.token && tokenInput) {
        tokenInput.value = response.token;
        settings.mcpBridge.token = response.token;
        updateSnippet();
        tokenInput.dispatchEvent(new Event("change", { bubbles: true }));
        showToast("New auth token generated");
      }
    } catch (err) {
      showToast("Could not regenerate token");
    }
  });

  copyConfigBtn?.addEventListener("click", async () => {
    const snippet = buildMcpBridgeConfigSnippet(collectMcpBridgeFromUI());
    try {
      await navigator.clipboard.writeText(snippet);
      showToast("MCP config copied");
    } catch {
      showToast("Could not copy config");
    }
  });

  renderMcpBridgeSettings();
  setInterval(refreshMcpBridgeStatus, 4000);
}

export const mcpBridgeSection = {
  key: "mcpBridge",
  normalize: normalizeMcpBridgeSettings,
  render: renderMcpBridgeSettings,
  collect: collectMcpBridgeFromUI,
  init: initMcpBridgeSettings
};
