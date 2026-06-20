// sidepanel.js - Entry point: initializes state, wires up the UI modules,
// and owns the top-level settings-form/header chrome.

import { settings, setChats, setCurrentChatId, setGlobalWorkspace, setUploadedAttachments } from "./state/store.js";
import { loadGlobalWorkspace } from "./state/persistence.js";
import { showToast } from "./lib/toast.js";
import { EYE_ICON, LOCK_ICON } from "./ui/icons.js";
import { SETTINGS_SECTIONS } from "./settings/registry.js";
import { loadSettings, collectSettingsFromUI, persistSettings, exportConfig, importConfigFile } from "./settings/core.js";
import { loadChats, createNewChatSession } from "./features/chats.js";
import { exportGlobalWorkspace, importRawChatFile } from "./features/chat-export.js";
import { initNetworkLogs } from "./features/network-logs.js";
import { refreshMcpTools } from "./tools/execute.js";
import { initHistoryDrawer } from "./ui/history-drawer.js";
import { initSettingsToggle, switchView } from "./ui/navigation.js";
import { initModelPicker, updateModelBadge, refreshOpenRouterBalance, ensureOpenRouterModelsLoaded } from "./ui/model-picker.js";
import { initChatEvents, initUploadEvents } from "./ui/composer.js";
import { initFileViewer, renderWorkspaceStrip } from "./ui/workspace-strip.js";
import { initUsageBar } from "./ui/usage-bar.js";
import { initLatchTab } from "./ui/latch-tab.js";

// Initialize Sidebar
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

async function init() {
  try {
    await loadSettings();
    await loadGlobalWorkspace();
    await loadChats();
    if (settings.mcpServers.some(s => s.enabled !== false && s.url)) {
      await refreshMcpTools();
    }
    initHistoryDrawer();
    initSettingsToggle();
    initModelPicker();
    for (const section of SETTINGS_SECTIONS) {
      section.init?.();
    }
    initChatEvents();
    initUploadEvents();
    initFileViewer();
    initNetworkLogs();
    initUsageBar();
    initLatchTab();
    renderWorkspaceStrip();
    updateModelBadge();
    refreshOpenRouterBalance();
    // Load the OpenRouter model list at startup so the active model's real
    // context window (and pricing) is known immediately, instead of falling
    // back to the configured default. Refresh the meter once it arrives.
    ensureOpenRouterModelsLoaded().then(updateModelBadge).catch(() => {});
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

// Settings Save Submission
const settingsForm = document.getElementById("settings-form");
if (settingsForm) {
  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await persistSettings(collectSettingsFromUI());
      await refreshMcpTools();
      chrome.runtime.sendMessage({ type: "mcp-bridge/reconnect" });
      chrome.runtime.sendMessage({ type: "mcp-bridge/feature-flags-changed" });
      chrome.runtime.sendMessage({ type: "network-capture/settings-changed" });
      updateModelBadge();
      refreshOpenRouterBalance();
      showToast("Settings saved successfully!");
      switchView("chat");
    } catch (err) {
      console.error("Error saving settings:", err);
    }
  });
}

// Reset Data
const resetDataBtn = document.getElementById("reset-data-btn");
if (resetDataBtn) {
  resetDataBtn.addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear all settings and chat history?")) {
      try {
        await chrome.storage.local.clear();
        setChats({});
        setGlobalWorkspace({});
        setCurrentChatId(null);
        setUploadedAttachments([]);
        createNewChatSession();
        await loadSettings();
        updateModelBadge();
        refreshOpenRouterBalance();
        renderWorkspaceStrip();
        showToast("All data cleared.");
      } catch (err) {
        console.error("Error resetting data:", err);
      }
    }
  });
}

const exportGlobalWorkspaceBtn = document.getElementById("export-global-workspace-btn");
if (exportGlobalWorkspaceBtn) {
  exportGlobalWorkspaceBtn.addEventListener("click", exportGlobalWorkspace);
}

const exportConfigBtn = document.getElementById("export-config-btn");
if (exportConfigBtn) {
  exportConfigBtn.addEventListener("click", exportConfig);
}

const importConfigBtn = document.getElementById("import-config-btn");
const importConfigInput = document.getElementById("import-config-input");
if (importConfigBtn && importConfigInput) {
  importConfigBtn.addEventListener("click", () => {
    importConfigInput.value = "";
    importConfigInput.click();
  });
  importConfigInput.addEventListener("change", () => {
    const file = importConfigInput.files?.[0];
    importConfigFile(file);
  });
}

const importChatRawBtn = document.getElementById("import-chat-raw-btn");
const importChatRawInput = document.getElementById("import-chat-raw-input");
if (importChatRawBtn && importChatRawInput) {
  importChatRawBtn.addEventListener("click", () => {
    importChatRawInput.value = "";
    importChatRawInput.click();
  });
  importChatRawInput.addEventListener("change", () => {
    const file = importChatRawInput.files?.[0];
    importRawChatFile(file);
  });
}

// Key Visibility mask
const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
const openrouterApiKeyInput = document.getElementById("openrouter-api-key");
if (toggleKeyVisibilityBtn && openrouterApiKeyInput) {
  toggleKeyVisibilityBtn.addEventListener("click", () => {
    if (openrouterApiKeyInput.type === "password") {
      openrouterApiKeyInput.type = "text";
      toggleKeyVisibilityBtn.innerHTML = LOCK_ICON;
      toggleKeyVisibilityBtn.title = "Hide key";
      toggleKeyVisibilityBtn.setAttribute("aria-label", "Hide API key");
    } else {
      openrouterApiKeyInput.type = "password";
      toggleKeyVisibilityBtn.innerHTML = EYE_ICON;
      toggleKeyVisibilityBtn.title = "Show key";
      toggleKeyVisibilityBtn.setAttribute("aria-label", "Show API key");
    }
  });
}
