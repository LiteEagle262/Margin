import { settings } from "../../state/store.js";
import { normalizeNetworkCaptureSettings } from "../../../shared/settings-schema.js";
import { downloadTextFile } from "../../lib/download.js";
import { showToast } from "../../lib/toast.js";

const TOOL_JOURNAL_KEY = "toolJournal";

async function downloadToolJournal() {
  try {
    const stored = await chrome.storage.local.get(TOOL_JOURNAL_KEY);
    const entries = Array.isArray(stored[TOOL_JOURNAL_KEY]) ? stored[TOOL_JOURNAL_KEY] : [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(
      `margin-activity-log-${stamp}.json`,
      JSON.stringify(entries, null, 2),
      "application/json;charset=utf-8"
    );
  } catch (err) {
    console.error("Could not download activity log:", err);
    showToast("Could not download activity log: " + (err.message || "unknown error"));
  }
}

async function clearToolJournal() {
  try {
    await chrome.storage.local.set({ [TOOL_JOURNAL_KEY]: [] });
    showToast("Activity log cleared.");
  } catch (err) {
    console.error("Could not clear activity log:", err);
    showToast("Could not clear activity log: " + (err.message || "unknown error"));
  }
}

function setNetworkCaptureBadge(capture) {
  const badge = document.getElementById("network-capture-status-badge");
  if (!badge) return;

  if (!capture.autoCaptureLatchedTab) {
    badge.textContent = "Manual";
    badge.className = "mcp-bridge-badge";
    badge.title = "Network capture starts only when requested.";
    return;
  }

  badge.textContent = "Auto ready";
  badge.className = "mcp-bridge-badge connected";
  badge.title = "Automatic network capture will follow the latched tab.";
}

function refreshNetworkCaptureBadge() {
  const capture = normalizeNetworkCaptureSettings(settings.networkCapture);
  setNetworkCaptureBadge(capture);
}

function renderNetworkCaptureSettings() {
  const autoInput = document.getElementById("network-auto-capture-latched");
  const persistInput = document.getElementById("network-persist-session");
  const bodiesInput = document.getElementById("network-capture-bodies");
  const redactInput = document.getElementById("network-redact-sensitive");

  const capture = normalizeNetworkCaptureSettings(settings.networkCapture);
  if (autoInput) autoInput.checked = capture.autoCaptureLatchedTab === true;
  if (persistInput) persistInput.checked = capture.persistSessionLogs === true;
  if (bodiesInput) bodiesInput.checked = capture.captureResponseBodies === true;
  if (redactInput) redactInput.checked = capture.redactSensitiveData === true;

  setNetworkCaptureBadge(capture);
}

function initNetworkCaptureSettings() {
  document.getElementById("download-tool-journal-btn")?.addEventListener("click", downloadToolJournal);
  document.getElementById("clear-tool-journal-btn")?.addEventListener("click", clearToolJournal);

  const autoInput = document.getElementById("network-auto-capture-latched");
  if (!autoInput) return;

  autoInput.addEventListener("change", () => {
    settings.networkCapture = collectNetworkCaptureFromUI();
    refreshNetworkCaptureBadge();
  });
}

function collectNetworkCaptureFromUI() {
  const autoInput = document.getElementById("network-auto-capture-latched");
  const persistInput = document.getElementById("network-persist-session");
  const bodiesInput = document.getElementById("network-capture-bodies");
  const redactInput = document.getElementById("network-redact-sensitive");

  return normalizeNetworkCaptureSettings({
    autoCaptureLatchedTab: autoInput ? autoInput.checked : settings.networkCapture.autoCaptureLatchedTab,
    persistSessionLogs: persistInput ? persistInput.checked : settings.networkCapture.persistSessionLogs,
    captureResponseBodies: bodiesInput ? bodiesInput.checked : settings.networkCapture.captureResponseBodies,
    redactSensitiveData: redactInput ? redactInput.checked : settings.networkCapture.redactSensitiveData
  });
}

export const networkCaptureSection = {
  key: "networkCapture",
  normalize: normalizeNetworkCaptureSettings,
  render: renderNetworkCaptureSettings,
  collect: collectNetworkCaptureFromUI,
  init: initNetworkCaptureSettings
};
