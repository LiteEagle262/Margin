import { settings } from "../../state/store.js";
import { normalizeTempEmailSettings } from "../../../shared/settings-schema.js";

function renderTempEmailSettings() {
  const enabledInput = document.getElementById("temp-email-enabled");
  const urlInput = document.getElementById("temp-email-api-url");
  const keyInput = document.getElementById("temp-email-api-key");
  const badge = document.getElementById("temp-email-status-badge");

  if (enabledInput) enabledInput.checked = settings.tempEmail.enabled === true;
  if (urlInput) urlInput.value = settings.tempEmail.apiUrl || "";
  if (keyInput) keyInput.value = settings.tempEmail.apiKey || "";

  if (badge) {
    if (!settings.tempEmail.enabled) {
      badge.textContent = "Off";
      badge.className = "mcp-bridge-badge";
    } else if (!settings.tempEmail.apiUrl || !settings.tempEmail.apiKey) {
      badge.textContent = "Missing config";
      badge.className = "mcp-bridge-badge error";
    } else {
      badge.textContent = "Enabled";
      badge.className = "mcp-bridge-badge connected";
    }
  }
}

function collectTempEmailFromUI() {
  const enabledInput = document.getElementById("temp-email-enabled");
  const urlInput = document.getElementById("temp-email-api-url");
  const keyInput = document.getElementById("temp-email-api-key");

  return normalizeTempEmailSettings({
    enabled: enabledInput ? enabledInput.checked : settings.tempEmail.enabled,
    apiUrl: urlInput ? urlInput.value : settings.tempEmail.apiUrl,
    apiKey: keyInput ? keyInput.value : settings.tempEmail.apiKey
  });
}

export const tempEmailSection = {
  key: "tempEmail",
  normalize: normalizeTempEmailSettings,
  render: renderTempEmailSettings,
  collect: collectTempEmailFromUI
};
