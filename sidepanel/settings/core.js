import { settings, setSettings } from "../state/store.js";
import { readStoredSettings, writeStoredSettings } from "../state/persistence.js";
import { SETTINGS_SECTIONS } from "./registry.js";
import { showToast } from "../lib/toast.js";
import { downloadTextFile } from "../lib/download.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/context.js";
import { AI_PROVIDERS, getProviderDefinition, normalizeProviderId } from "../api/provider.js";
import { syncModelPickerValue, updateModelBadge, refreshProviderBadge } from "../ui/model-picker.js";
import { refreshMcpTools } from "../tools/execute.js";
import { BUILT_IN_TOOL_NAMES, DEFAULT_ENABLED_TOOLS } from "./sections/tool-access.js";

const AUTOSAVE_DELAY_MS = 350;

let autosaveTimer = null;
let autosaveQueue = Promise.resolve();
let lastSavedSnapshot = "";

function normalizeProviderConfig(raw, fallbackModel) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    model: typeof value.model === "string" && value.model.trim()
      ? value.model.trim()
      : fallbackModel,
  };
}

function normalizeProviderConfigs(value) {
  const stored = value.providerConfigs && typeof value.providerConfigs === "object"
    ? value.providerConfigs
    : null;
  const legacyModel = typeof value.model === "string" && value.model.trim()
    ? value.model.trim()
    : AI_PROVIDERS.openrouter.defaultModel;
  const legacyApiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";

  return {
    openrouter: normalizeProviderConfig(
      stored?.openrouter || { apiKey: legacyApiKey, model: legacyModel },
      AI_PROVIDERS.openrouter.defaultModel,
    ),
    openai: {
      ...normalizeProviderConfig(stored?.openai, AI_PROVIDERS.openai.defaultModel),
      apiKey: "",
    },
  };
}

function setAutosaveStatus(state, message) {
  const status = document.getElementById("settings-save-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function announceSettingsSaved() {
  setAutosaveStatus("saved", "Saved");
}

export async function loadSettings() {
  try {
    const result = await readStoredSettings();
    setSettings(normalizeAppConfig(result));
    const storageObject = buildSettingsStorageObject(settings);
    // The MCP bridge reads the raw stored allowlist, so a tool added in a later
    // version stays invisible there until the map is rewritten with its default.
    const storedToolAccess = result.toolAccess?.enabled;
    const needsToolAccessMigration = !result.toolAccess ||
      [...BUILT_IN_TOOL_NAMES].some((name) => !Object.hasOwn(storedToolAccess || {}, name));
    const needsProviderMigration = !result.providerConfigs ||
      String(result.apiKey || "").trim() !== "" ||
      String(result.customModel || "").trim() !== "" ||
      String(result.providerConfigs?.openai?.apiKey || "").trim() !== "" ||
      needsToolAccessMigration;
    if (needsProviderMigration) {
      await writeStoredSettings(storageObject);
    }
    renderSettingsFormFromState();
    lastSavedSnapshot = JSON.stringify(storageObject);
    announceSettingsSaved();
  } catch (e) {
    console.error("Error loading settings:", e);
  }
}

export function normalizeAppConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const aiProvider = normalizeProviderId(value.aiProvider);
  const providerConfigs = normalizeProviderConfigs(value);
  if (
    providerConfigs.openrouter.model === "custom" &&
    typeof value.customModel === "string" &&
    value.customModel.trim()
  ) {
    providerConfigs.openrouter.model = value.customModel.trim();
  }
  const activeProvider = providerConfigs[aiProvider];
  const storedPrompt = typeof value.systemPrompt === "string" && value.systemPrompt.trim()
    ? value.systemPrompt.trim()
    : DEFAULT_SYSTEM_PROMPT;

  const config = {
    aiProvider,
    providerConfigs,
    dataSharingConsent: value.dataSharingConsent === true,
    apiKey: aiProvider === "openrouter" ? activeProvider.apiKey : "",
    model: activeProvider.model,
    systemPrompt: storedPrompt,
  };
  for (const section of SETTINGS_SECTIONS) {
    if (section.key) config[section.key] = section.normalize(value[section.key]);
  }
  return config;
}

export function buildSettingsStorageObject(config = settings) {
  const normalized = normalizeAppConfig(config);
  return {
    ...normalized,
    // Keep retired single-provider fields non-secret for downgrade compatibility.
    apiKey: "",
    model: normalized.providerConfigs.openrouter.model,
    customModel: "",
  };
}

export function renderSettingsFormFromState() {
  const providerInput = document.getElementById("ai-provider");
  const apiKeyInput = document.getElementById("provider-api-key");
  const consentInput = document.getElementById("data-sharing-consent");
  if (providerInput) providerInput.value = settings.aiProvider;
  if (apiKeyInput) apiKeyInput.value = settings.apiKey;
  if (consentInput) consentInput.checked = settings.dataSharingConsent === true;

  renderActiveProviderFields();

  syncModelPickerValue();
  for (const section of SETTINGS_SECTIONS) {
    section.render?.();
  }

  const systemPromptTextarea = document.getElementById("system-prompt");
  if (systemPromptTextarea) systemPromptTextarea.value = settings.systemPrompt;
}

export function renderActiveProviderFields() {
  const provider = getProviderDefinition(settings.aiProvider);
  const openRouterPanel = document.getElementById("openrouter-api-panel");
  const apiKeyLabel = document.getElementById("provider-api-key-label");
  const apiKeyInput = document.getElementById("provider-api-key");
  const openRouterHelp = document.getElementById("openrouter-key-help");
  const routingSection = document.getElementById("provider-routing-section");

  if (apiKeyLabel) apiKeyLabel.textContent = provider.keyLabel;
  if (apiKeyInput) {
    apiKeyInput.placeholder = provider.keyPlaceholder;
    apiKeyInput.value = settings.aiProvider === "openrouter" ? settings.apiKey : "";
  }
  openRouterPanel?.classList.toggle("hidden", settings.aiProvider !== "openrouter");
  openRouterHelp?.classList.toggle("hidden", settings.aiProvider !== "openrouter");
  routingSection?.classList.toggle("hidden", settings.aiProvider !== "openrouter");

  const modelSearch = document.getElementById("model-search");
  if (modelSearch) modelSearch.placeholder = `Search ${provider.label} models...`;
  const modelStatus = document.getElementById("model-picker-status");
  if (modelStatus) {
    modelStatus.textContent = settings.aiProvider === "openai"
      ? "Link ChatGPT to load subscription-compatible models."
      : `Add your ${provider.label} key, then search and pick a model.`;
    modelStatus.style.color = "";
  }
}

export function collectSettingsFromUI({ providerId } = {}) {
  const providerInput = document.getElementById("ai-provider");
  const apiKeyInput = document.getElementById("provider-api-key");
  const consentInput = document.getElementById("data-sharing-consent");
  const modelSelectedInput = document.getElementById("model-selected");
  const modelSearchInput = document.getElementById("model-search");
  const systemPromptTextarea = document.getElementById("system-prompt");

  const pickedModel = modelSelectedInput ? modelSelectedInput.value.trim() : "";
  const typedModel = modelSearchInput ? modelSearchInput.value.trim() : "";

  const selectedProvider = normalizeProviderId(
    providerId || providerInput?.value || settings.aiProvider,
  );
  const providerConfigs = {
    openrouter: { ...settings.providerConfigs.openrouter },
    openai: { ...settings.providerConfigs.openai },
  };
  providerConfigs[selectedProvider] = {
    apiKey: selectedProvider === "openrouter" && apiKeyInput
      ? apiKeyInput.value.trim()
      : providerConfigs[selectedProvider].apiKey,
    model: pickedModel || typedModel || providerConfigs[selectedProvider].model,
  };

  const collected = {
    ...settings,
    aiProvider: selectedProvider,
    providerConfigs,
    dataSharingConsent: consentInput ? consentInput.checked : settings.dataSharingConsent,
    systemPrompt: systemPromptTextarea ? systemPromptTextarea.value.trim() : settings.systemPrompt,
  };
  for (const section of SETTINGS_SECTIONS) {
    if (section.key) collected[section.key] = section.collect ? section.collect() : settings[section.key];
  }
  return normalizeAppConfig(collected);
}

export function switchActiveProvider(nextProvider) {
  const previousProvider = settings.aiProvider;
  const snapshot = collectSettingsFromUI({ providerId: previousProvider });
  snapshot.aiProvider = normalizeProviderId(nextProvider);
  setSettings(normalizeAppConfig(snapshot));
  renderSettingsFormFromState();
}

export async function persistSettings(nextSettings = settings) {
  setSettings(normalizeAppConfig(nextSettings));
  const storageObject = buildSettingsStorageObject(settings);
  await writeStoredSettings(storageObject);
  lastSavedSnapshot = JSON.stringify(storageObject);
  announceSettingsSaved();
}

async function persistAutosaveSnapshot(storageObject) {
  const serialized = JSON.stringify(storageObject);
  if (serialized === lastSavedSnapshot) {
    announceSettingsSaved();
    return;
  }

  const previous = lastSavedSnapshot ? JSON.parse(lastSavedSnapshot) : {};
  await writeStoredSettings(storageObject);
  setSettings(normalizeAppConfig(storageObject));
  lastSavedSnapshot = serialized;

  if (JSON.stringify(previous.mcpServers) !== JSON.stringify(storageObject.mcpServers)) {
    refreshMcpTools().catch((error) => console.warn("Could not refresh MCP tools:", error));
  }
  announceSettingsSaved();
}

export function scheduleSettingsAutosave({ immediate = false } = {}) {
  clearTimeout(autosaveTimer);
  setAutosaveStatus("saving", "Saving…");

  const enqueue = () => {
    const storageObject = buildSettingsStorageObject(collectSettingsFromUI());
    autosaveQueue = autosaveQueue
      .catch(() => {})
      .then(() => persistAutosaveSnapshot(storageObject))
      .catch((error) => {
        console.error("Could not autosave settings:", error);
        setAutosaveStatus("error", "Save failed");
      });
    return autosaveQueue;
  };

  if (immediate) return enqueue();
  autosaveTimer = setTimeout(enqueue, AUTOSAVE_DELAY_MS);
  return autosaveQueue;
}

export function flushSettingsAutosave() {
  clearTimeout(autosaveTimer);
  return scheduleSettingsAutosave({ immediate: true });
}

function redactUrlSecrets(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function buildRedactedSettingsExport(config = settings) {
  const portable = buildSettingsStorageObject(config);
  portable.apiKey = "";
  portable.providerConfigs = {
    openrouter: { ...portable.providerConfigs.openrouter, apiKey: "" },
    openai: { ...portable.providerConfigs.openai, apiKey: "" },
  };
  portable.mcpBridge = { ...portable.mcpBridge, token: "" };
  portable.webSearch = { ...portable.webSearch, apiKey: "" };
  portable.authManualKeys = {};
  portable.mcpServers = portable.mcpServers.map((server) => ({
    ...server,
    url: redactUrlSecrets(server.url),
  }));
  return portable;
}

function buildConfigExport(config = settings) {
  return {
    exportType: "margin-config",
    exportedAt: new Date().toISOString(),
    settings: buildRedactedSettingsExport(config),
  };
}

function unwrapImportedConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Import file is not a JSON object.");
  }
  const supportedTypes = new Set(["margin-config"]);
  if (raw.exportType && !supportedTypes.has(raw.exportType)) {
    throw new Error("This is not a Margin config export.");
  }
  const source = supportedTypes.has(raw.exportType) ? raw.settings : raw;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Config export is missing its settings payload.");
  }
  return source;
}

function restoreOmittedSecrets(imported) {
  const restored = structuredClone(imported);
  const importedProviders = restored.providerConfigs && typeof restored.providerConfigs === "object"
    ? restored.providerConfigs
    : {};
  restored.providerConfigs = {
    openrouter: {
      ...importedProviders.openrouter,
      apiKey: importedProviders.openrouter?.apiKey || settings.providerConfigs.openrouter.apiKey,
    },
    openai: {
      ...importedProviders.openai,
      apiKey: "",
    },
  };
  restored.mcpBridge = {
    ...(restored.mcpBridge || {}),
    token: restored.mcpBridge?.token || settings.mcpBridge.token,
  };
  restored.webSearch = {
    ...(restored.webSearch || {}),
    apiKey: restored.webSearch?.apiKey || settings.webSearch.apiKey,
  };
  if (!Object.keys(restored.authManualKeys || {}).length) {
    restored.authManualKeys = settings.authManualKeys;
  }
  return restored;
}

export function exportConfig() {
  try {
    const exportSettings = collectSettingsFromUI();
    const rawJson = JSON.stringify(buildConfigExport(exportSettings), null, 2);
    downloadTextFile("margin-config.json", rawJson, "application/json;charset=utf-8");
    showToast("Config exported without secrets.");
  } catch (err) {
    console.error("Could not export config:", err);
    showToast("Could not export config: " + (err.message || "unknown error"));
  }
}

function describeRiskyImportChanges(imported) {
  const changes = [];

  const newlyEnabled = [...BUILT_IN_TOOL_NAMES]
    .filter((name) =>
      imported.toolAccess.enabled[name] === true &&
      settings.toolAccess.enabled?.[name] !== true &&
      !DEFAULT_ENABLED_TOOLS.has(name))
    .sort();
  if (newlyEnabled.length > 0) {
    changes.push(`Turns on ${newlyEnabled.length} tool(s) that are off by default: ${newlyEnabled.join(", ")}`);
  }

  imported.mcpServers.forEach((server) => {
    const current = settings.mcpServers.find((existing) => existing.id === server.id);
    if (!current) {
      changes.push(`Adds MCP server "${server.name}" (${server.url || "no URL"})`);
    } else if (current.url !== server.url) {
      changes.push(`Repoints MCP server "${server.name}" to ${server.url || "no URL"}`);
    }
  });

  return changes;
}

export async function importConfigFile(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const importedSettings = normalizeAppConfig(restoreOmittedSecrets(unwrapImportedConfig(raw)));

    const riskyChanges = describeRiskyImportChanges(importedSettings);
    if (riskyChanges.length > 0) {
      const approved = confirm(
        `This config grants new access:\n\n- ${riskyChanges.join("\n- ")}\n\nImport it anyway?`,
      );
      if (!approved) {
        showToast("Config import cancelled.");
        return;
      }
    }

    await persistSettings(importedSettings);
    renderSettingsFormFromState();
    await refreshMcpTools();
    chrome.runtime.sendMessage({ type: "mcp-bridge/reconnect" });
    chrome.runtime.sendMessage({ type: "mcp-bridge/feature-flags-changed" });
    chrome.runtime.sendMessage({ type: "network-capture/settings-changed" });
    updateModelBadge();
    refreshProviderBadge();
    showToast("Config imported.");
  } catch (err) {
    console.error("Could not import config:", err);
    showToast("Could not import config: " + (err.message || "invalid file"));
  }
}
