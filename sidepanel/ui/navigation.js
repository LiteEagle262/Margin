import { ensureProviderModelsLoaded } from "./model-picker.js";
import { syncMcpBridgeStatusPolling } from "../settings/sections/mcp-bridge.js";
import { syncOpenAIAccountPolling } from "../settings/sections/openai-account.js";

export function initSettingsToggle() {
  const toggleSettingsBtn = document.getElementById("toggle-settings-btn");
  const backToChatBtn = document.getElementById("back-to-chat-btn");

  if (toggleSettingsBtn) {
    toggleSettingsBtn.addEventListener("click", () => {
      const settingsView = document.getElementById("settings-view");
      if (settingsView && settingsView.classList.contains("active")) {
        switchView("chat");
      } else {
        switchView("settings");
      }
    });
  }

  if (backToChatBtn) {
    backToChatBtn.addEventListener("click", () => {
      switchView("chat");
    });
  }
}

export function switchView(viewName) {
  const chatView = document.getElementById("chat-view");
  const settingsView = document.getElementById("settings-view");
  const toggleSettingsBtn = document.getElementById("toggle-settings-btn");
  const headerNewChatBtn = document.getElementById("header-new-chat-btn");
  const headerExportChatBtn = document.getElementById("header-export-chat-btn");
  const headerClearChatBtn = document.getElementById("header-clear-chat-btn");

  if (viewName === "settings") {
    if (chatView) chatView.classList.remove("active");
    if (settingsView) settingsView.classList.add("active");
    if (toggleSettingsBtn) toggleSettingsBtn.classList.add("active");
    if (headerNewChatBtn) headerNewChatBtn.classList.add("hidden");
    if (headerExportChatBtn) headerExportChatBtn.classList.add("hidden");
    if (headerClearChatBtn) headerClearChatBtn.classList.add("hidden");
    ensureProviderModelsLoaded();
    syncMcpBridgeStatusPolling();
    syncOpenAIAccountPolling();
  } else {
    if (settingsView) settingsView.classList.remove("active");
    if (chatView) chatView.classList.add("active");
    if (toggleSettingsBtn) toggleSettingsBtn.classList.remove("active");
    if (headerNewChatBtn) headerNewChatBtn.classList.remove("hidden");
    if (headerExportChatBtn) headerExportChatBtn.classList.remove("hidden");
    if (headerClearChatBtn) headerClearChatBtn.classList.remove("hidden");
    syncMcpBridgeStatusPolling();
    syncOpenAIAccountPolling();

    const chatHistory = document.getElementById("chat-history");
    if (chatHistory) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  }
}
