import { settings } from "../../state/store.js";
import { normalizeNetworkCaptureSettings } from "../../../shared/settings-schema.js";

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
  refreshNetworkCaptureBadge();
}

function initNetworkCaptureSettings() {
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
