import { settings, setChats, setCurrentChatId, setGlobalWorkspace, setUploadedAttachments, setOpenRouterModels, setOpenRouterEndpoints } from "./state/store.js";
import { loadGlobalWorkspace } from "./state/persistence.js";
import { showToast } from "./lib/toast.js";
import { EYE_ICON, LOCK_ICON } from "./ui/icons.js";
import { SETTINGS_SECTIONS } from "./settings/registry.js";
import { loadSettings, switchActiveProvider, scheduleSettingsAutosave, flushSettingsAutosave, exportConfig, importConfigFile } from "./settings/core.js";
import { loadChats, createNewChatSession } from "./features/chats.js";
import { exportGlobalWorkspace, importRawChatFile } from "./features/chat-export.js";
import { initNetworkLogs } from "./features/network-logs.js";
import { refreshMcpTools } from "./tools/execute.js";
import { initHistoryDrawer } from "./ui/history-drawer.js";
import { initSettingsToggle } from "./ui/navigation.js";
import { initModelPicker, updateModelBadge, refreshProviderBadge, ensureProviderModelsLoaded } from "./ui/model-picker.js";
import { initChatEvents, initUploadEvents } from "./ui/composer.js";
import { initFileViewer, renderWorkspaceStrip } from "./ui/workspace-strip.js";
import { initUsageBar } from "./ui/usage-bar.js";
import { initLatchTab } from "./ui/latch-tab.js";
import { logoutOpenAIAccount } from "./api/openai.js";

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
      refreshMcpTools().catch((error) => console.warn("Could not load MCP tools:", error));
    }
    initHistoryDrawer();
    initSettingsToggle();
    initModelPicker();
    for (const section of SETTINGS_SECTIONS) {
      section.init?.();
    }
    initSettingsAutosave();
    initChatEvents();
    initUploadEvents();
    initFileViewer();
    initNetworkLogs();
    initUsageBar();
    initLatchTab();
    renderWorkspaceStrip();
    updateModelBadge();
    refreshProviderBadge();
    ensureProviderModelsLoaded().then(updateModelBadge).catch(() => {});
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

function initSettingsAutosave() {
  const settingsForm = document.getElementById("settings-form");
  const providerInput = document.getElementById("ai-provider");
  if (!settingsForm || settingsForm.dataset.autosaveReady === "true") return;
  settingsForm.dataset.autosaveReady = "true";

  providerInput?.addEventListener("change", () => {
    switchActiveProvider(providerInput.value);
    setOpenRouterModels([]);
    setOpenRouterEndpoints([]);
    updateModelBadge();
    refreshProviderBadge();
    ensureProviderModelsLoaded().then(updateModelBadge).catch(() => {});
  });

  settingsForm.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
    if (event.target.type === "checkbox" || event.target.type === "radio") return;
    if (event.target.id === "model-search") return;
    scheduleSettingsAutosave();
  });

  settingsForm.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") return;
    if (event.target?.id === "data-sharing-consent") {
      settings.dataSharingConsent = event.target.checked;
    }
    updateModelBadge();
    refreshProviderBadge();
    scheduleSettingsAutosave({ immediate: true });
  });

  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    flushSettingsAutosave();
  });

  settingsForm.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.dataset.noAutosave === "true") return;
    if (["reset-data-btn", "import-config-btn"].includes(button.id)) return;
    queueMicrotask(() => scheduleSettingsAutosave());
  });

  window.addEventListener("pagehide", () => {
    flushSettingsAutosave();
  });
}

const resetDataBtn = document.getElementById("reset-data-btn");
if (resetDataBtn) {
  resetDataBtn.addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear all settings and chat history?")) {
      try {
        await Promise.allSettled([logoutOpenAIAccount()]);
        await Promise.all([
          chrome.storage.local.clear(),
          chrome.storage.session.clear(),
        ]);
        setChats({});
        setGlobalWorkspace({});
        setCurrentChatId(null);
        setUploadedAttachments([]);
        createNewChatSession();
        await loadSettings();
        updateModelBadge();
        refreshProviderBadge();
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

const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
const providerApiKeyInput = document.getElementById("provider-api-key");
if (toggleKeyVisibilityBtn && providerApiKeyInput) {
  toggleKeyVisibilityBtn.addEventListener("click", () => {
    if (providerApiKeyInput.type === "password") {
      providerApiKeyInput.type = "text";
      toggleKeyVisibilityBtn.innerHTML = LOCK_ICON;
      toggleKeyVisibilityBtn.title = "Hide key";
      toggleKeyVisibilityBtn.setAttribute("aria-label", "Hide API key");
    } else {
      providerApiKeyInput.type = "password";
      toggleKeyVisibilityBtn.innerHTML = EYE_ICON;
      toggleKeyVisibilityBtn.title = "Show key";
      toggleKeyVisibilityBtn.setAttribute("aria-label", "Show API key");
    }
  });
}
