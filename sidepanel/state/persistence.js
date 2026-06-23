// sidepanel/state/persistence.js - chrome.storage I/O for app state.
// Normalization of stored settings stays with the settings code; this module
// only reads and writes.

import { chats, currentChatId, globalWorkspace, setGlobalWorkspace } from "./store.js";

export const SETTINGS_STORAGE_KEYS = [
  "apiKey",
  "model",
  "customModel",
  "systemPrompt",
  "mcpServers",
  "mcpBridge",
  "tempEmail",
  "webSearch",
  "toolAccess",
  "networkCapture",
  "providerRouting",
  "reasoning",
  "agentLimits",
  "authManualKeys"
];

export async function readStoredSettings() {
  return chrome.storage.local.get(SETTINGS_STORAGE_KEYS);
}

export async function writeStoredSettings(storageObject) {
  await chrome.storage.local.set(storageObject);
}

export async function saveChats() {
  try {
    await chrome.storage.local.set({ chats, currentChatId });
  } catch (e) {
    console.error("Error saving chats to storage:", e);
  }
}

export async function loadGlobalWorkspace() {
  try {
    const result = await chrome.storage.local.get(["globalWorkspace"]);
    setGlobalWorkspace(result.globalWorkspace || {});
  } catch (e) {
    console.error("Error loading global workspace:", e);
    setGlobalWorkspace({});
  }
}

export async function persistGlobalWorkspace() {
  try {
    await chrome.storage.local.set({ globalWorkspace });
  } catch (e) {
    console.error("Error saving global workspace:", e);
  }
}
