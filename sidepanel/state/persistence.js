import { activeAgentChatId, chats, currentChatId, globalWorkspace, setGlobalWorkspace } from "./store.js";
import { isSafeRecordKey, isSafeVirtualPath, safeRecord } from "../lib/safe-record.js";
import { showToast } from "../lib/toast.js";

export const SETTINGS_STORAGE_KEYS = [
  "aiProvider",
  "providerConfigs",
  "dataSharingConsent",
  "apiKey",
  "model",
  "customModel",
  "systemPrompt",
  "mcpServers",
  "mcpBridge",
  "webSearch",
  "toolAccess",
  "networkCapture",
  "providerRouting",
  "reasoning",
  "agentLimits",
  "authManualKeys",
  "appearance"
];

export async function readStoredSettings() {
  return chrome.storage.local.get(SETTINGS_STORAGE_KEYS);
}

export async function writeStoredSettings(storageObject) {
  await chrome.storage.local.set(storageObject);
}

const CHAT_WRITE_INTERVAL_MS = 500;
let lastChatWriteAt = 0;
let queuedChatWrite = null;

function mergeStoredChats(stored) {
  if (!stored || typeof stored !== "object") return;
  for (const [id, chat] of Object.entries(stored)) {
    if (!isSafeRecordKey(id) || !chat || typeof chat !== "object") continue;
    if (id === activeAgentChatId) continue;
    const mine = chats[id];
    if (mine && Number(chat.timestamp || 0) <= Number(mine.timestamp || 0)) continue;
    chat.files = safeRecord(chat.files, isSafeVirtualPath);
    chats[id] = chat;
  }
}

async function writeChats() {
  lastChatWriteAt = Date.now();
  try {
    const stored = await chrome.storage.local.get("chats");
    mergeStoredChats(stored?.chats);
    await chrome.storage.local.set({ chats, currentChatId });
  } catch (e) {
    console.error("Error saving chats to storage:", e);
    showToast("Could not save this chat. Extension storage may be full.");
  }
}

export function saveChats() {
  if (queuedChatWrite) return queuedChatWrite;
  const wait = CHAT_WRITE_INTERVAL_MS - (Date.now() - lastChatWriteAt);
  if (wait <= 0) return writeChats();
  queuedChatWrite = new Promise((resolve) => {
    setTimeout(() => {
      queuedChatWrite = null;
      resolve(writeChats());
    }, wait);
  });
  return queuedChatWrite;
}

globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes.chats) return;
  mergeStoredChats(changes.chats.newValue);
});

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
