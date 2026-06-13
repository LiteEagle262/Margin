// sidepanel/settings/core.js - Settings aggregation over the section
// registry, persistence round-trip, and config import/export.

import { settings, setSettings } from "../state/store.js";
import { readStoredSettings, writeStoredSettings } from "../state/persistence.js";
import { SETTINGS_SECTIONS } from "./registry.js";
import { showToast } from "../lib/toast.js";
import { downloadTextFile } from "../lib/download.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/context.js";
import { syncModelPickerValue, updateModelBadge, refreshOpenRouterBalance } from "../ui/model-picker.js";
import { refreshMcpTools } from "../tools/execute.js";

const CONFIG_EXPORT_VERSION = 2;

// ----------------------------------------------------
// STATE & PERSISTENCE
// ----------------------------------------------------
export async function loadSettings() {
  try {
    const result = await readStoredSettings();
    setSettings(normalizeAppConfig(result));
    renderSettingsFormFromState();
  } catch (e) {
    console.error("Error loading settings:", e);
  }
}

export function normalizeAppConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  let model = typeof value.model === "string" && value.model.trim()
    ? value.model.trim()
    : "anthropic/claude-3.5-sonnet";
  if (model === "custom" && typeof value.customModel === "string" && value.customModel.trim()) {
    model = value.customModel.trim();
  }

  const config = {
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    model,
    systemPrompt: typeof value.systemPrompt === "string" && value.systemPrompt.trim()
      ? value.systemPrompt.trim()
      : DEFAULT_SYSTEM_PROMPT
  };
  for (const section of SETTINGS_SECTIONS) {
    config[section.key] = section.normalize(value[section.key]);
  }
  return config;
}

// normalizeAppConfig emits exactly the keys we persist (core fields plus one
// per registered section), so the storage object is just the normalized config.
export function buildSettingsStorageObject(config = settings) {
  return normalizeAppConfig(config);
}

export function renderSettingsFormFromState() {
  const apiKeyInput = document.getElementById("openrouter-api-key");
  if (apiKeyInput) apiKeyInput.value = settings.apiKey;

  syncModelPickerValue();
  for (const section of SETTINGS_SECTIONS) {
    section.render?.();
  }

  const systemPromptTextarea = document.getElementById("system-prompt");
  if (systemPromptTextarea) systemPromptTextarea.value = settings.systemPrompt;
}

export function collectSettingsFromUI() {
  const apiKeyInput = document.getElementById("openrouter-api-key");
  const modelSelectedInput = document.getElementById("model-selected");
  const modelSearchInput = document.getElementById("model-search");
  const systemPromptTextarea = document.getElementById("system-prompt");

  const pickedModel = modelSelectedInput ? modelSelectedInput.value.trim() : "";
  const typedModel = modelSearchInput ? modelSearchInput.value.trim() : "";

  const collected = {
    ...settings,
    apiKey: apiKeyInput ? apiKeyInput.value.trim() : settings.apiKey,
    model: pickedModel || typedModel || settings.model,
    systemPrompt: systemPromptTextarea ? systemPromptTextarea.value.trim() : settings.systemPrompt
  };
  for (const section of SETTINGS_SECTIONS) {
    collected[section.key] = section.collect ? section.collect() : settings[section.key];
  }
  return normalizeAppConfig(collected);
}

export async function persistSettings(nextSettings = settings) {
  setSettings(normalizeAppConfig(nextSettings));
  await writeStoredSettings(buildSettingsStorageObject(settings));
}

function buildConfigExport(config = settings) {
  return {
    exportType: "scrapeflow-config",
    version: CONFIG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: buildSettingsStorageObject(config)
  };
}

function unwrapImportedConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Import file is not a JSON object.");
  }
  if (raw.exportType && raw.exportType !== "scrapeflow-config") {
    throw new Error("This is not a ScrapeFlow config export.");
  }
  const source = raw.exportType === "scrapeflow-config" ? raw.settings : raw;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Config export is missing its settings payload.");
  }
  return source;
}

export function exportConfig() {
  try {
    const exportSettings = collectSettingsFromUI();
    const rawJson = JSON.stringify(buildConfigExport(exportSettings), null, 2);
    downloadTextFile("scrapeflow-config.json", rawJson, "application/json;charset=utf-8");
    showToast("Config exported.");
  } catch (err) {
    console.error("Could not export config:", err);
    showToast("Could not export config: " + (err.message || "unknown error"));
  }
}

export async function importConfigFile(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const importedSettings = normalizeAppConfig(unwrapImportedConfig(raw));

    await persistSettings(importedSettings);
    renderSettingsFormFromState();
    await refreshMcpTools();
    chrome.runtime.sendMessage({ type: "mcp-bridge/reconnect" });
    chrome.runtime.sendMessage({ type: "mcp-bridge/feature-flags-changed" });
    chrome.runtime.sendMessage({ type: "network-capture/settings-changed" });
    updateModelBadge();
    refreshOpenRouterBalance();
    showToast("Config imported.");
  } catch (err) {
    console.error("Could not import config:", err);
    showToast("Could not import config: " + (err.message || "invalid file"));
  }
}
