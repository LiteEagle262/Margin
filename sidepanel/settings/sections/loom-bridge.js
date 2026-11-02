import { settings } from "../../state/store.js";
import { normalizeLoomBridgeSettings } from "../../../shared/settings-schema.js";

let statusPollTimer = null;

// state -> [badge, sentence, badge style]
const LOOM_STATUS_LABELS = {
  off: ["Off", "Off", ""],
  checking: ["Looking", "Looking for Loom", "pending"],
  missing: ["Not found", "Loom not found on this computer", ""],
  "not-running": ["Not running", "Loom isn't running", "pending"],
  connecting: ["Connecting", "Connecting to Loom", "pending"],
  connected: ["Connected", "Connected to Loom", "connected"]
};

export function describeLoomStatus(response) {
  if (response?.enabled === false) return LOOM_STATUS_LABELS.off;
  const state = response?.status?.state;
  const labels = LOOM_STATUS_LABELS[state] || LOOM_STATUS_LABELS.checking;
  const detail = String(response?.status?.detail || "").trim();
  return detail && (state === "not-running" || state === "connecting")
    ? [labels[0], `${labels[1]}: ${detail}`, labels[2]]
    : labels;
}

async function refreshLoomBridgeStatus() {
  const badge = document.getElementById("loom-bridge-status-badge");
  const line = document.getElementById("loom-bridge-status-text");
  if (!badge && !line) return;

  let labels;
  try {
    labels = describeLoomStatus(await chrome.runtime.sendMessage({ type: "loom-bridge/get-status" }));
  } catch {
    labels = ["Unavailable", "Status unavailable", "error"];
  }
  const [badgeText, sentence, style] = labels;
  if (badge) {
    badge.textContent = badgeText;
    badge.className = style ? `mcp-bridge-badge ${style}` : "mcp-bridge-badge";
  }
  if (line) line.textContent = sentence;
}

// Each poll wakes the MV3 service worker, so only poll while Settings is open.
export function syncLoomBridgeStatusPolling() {
  const settingsVisible = document.getElementById("settings-view")?.classList.contains("active") === true;
  const shouldPoll = settingsVisible && settings.loomBridge?.enabled === true;

  if (shouldPoll && !statusPollTimer) {
    statusPollTimer = setInterval(refreshLoomBridgeStatus, 4000);
  } else if (!shouldPoll && statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function collectLoomBridgeFromUI() {
  const enabledInput = document.getElementById("loom-bridge-enabled");
  return normalizeLoomBridgeSettings({
    enabled: enabledInput ? enabledInput.checked : settings.loomBridge?.enabled
  });
}

function renderLoomBridgeSettings() {
  const enabledInput = document.getElementById("loom-bridge-enabled");
  const loom = normalizeLoomBridgeSettings(settings.loomBridge);
  if (enabledInput) enabledInput.checked = loom.enabled;
  refreshLoomBridgeStatus();
  syncLoomBridgeStatusPolling();
}

function initLoomBridgeSettings() {
  const enabledInput = document.getElementById("loom-bridge-enabled");
  enabledInput?.addEventListener("change", () => {
    settings.loomBridge = collectLoomBridgeFromUI();
    syncLoomBridgeStatusPolling();
    // The background reacts once autosave has written the switch.
    setTimeout(refreshLoomBridgeStatus, 600);
  });
}

export const loomBridgeSection = {
  key: "loomBridge",
  normalize: normalizeLoomBridgeSettings,
  render: renderLoomBridgeSettings,
  collect: collectLoomBridgeFromUI,
  init: initLoomBridgeSettings
};
