// Settings section: CDP network capture behavior.

import { settings } from "../../state/store.js";
import { normalizeNetworkCaptureSettings } from "../../../shared/settings-schema.js";

function renderNetworkCaptureSettings() {
  const autoInput = document.getElementById("network-auto-capture-latched");
  const persistInput = document.getElementById("network-persist-session");
  const bodiesInput = document.getElementById("network-capture-bodies");
  const redactInput = document.getElementById("network-redact-sensitive");
  const badge = document.getElementById("network-capture-status-badge");

  const capture = normalizeNetworkCaptureSettings(settings.networkCapture);
  if (autoInput) autoInput.checked = capture.autoCaptureLatchedTab === true;
  if (persistInput) persistInput.checked = capture.persistSessionLogs === true;
  if (bodiesInput) bodiesInput.checked = capture.captureResponseBodies === true;
  if (redactInput) redactInput.checked = capture.redactSensitiveData === true;

  if (badge) {
    badge.textContent = capture.autoCaptureLatchedTab ? "Latched tab" : "Manual";
    badge.className = capture.autoCaptureLatchedTab ? "mcp-bridge-badge connected" : "mcp-bridge-badge";
  }
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
  collect: collectNetworkCaptureFromUI
};
