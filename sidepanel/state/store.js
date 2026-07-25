import { isSafeVirtualPath, safeRecord } from "../lib/safe-record.js";

const listeners = new Map();

export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

function emit(key) {
  const subs = listeners.get(key);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn();
    } catch (err) {
      console.error(`State listener for "${key}" failed:`, err);
    }
  }
}

export let settings = {
  aiProvider: "openrouter",
  providerConfigs: {
    openrouter: {
      apiKey: "",
      model: "anthropic/claude-3.5-sonnet"
    },
    openai: {
      apiKey: "",
      model: "gpt-5.6-sol"
    }
  },
  dataSharingConsent: false,
  apiKey: "",
  model: "anthropic/claude-3.5-sonnet",
  systemPrompt: "",
  mcpServers: [],
  mcpBridge: {
    enabled: false,
    port: 9229,
    token: ""
  },
  tempEmail: {
    enabled: false,
    apiUrl: "",
    apiKey: ""
  },
  webSearch: {
    enabled: false,
    provider: "tavily",
    apiKey: "",
    searchDepth: "basic",
    maxResults: 5,
    includeAnswer: false
  },
  toolAccess: {},
  networkCapture: {
    autoCaptureLatchedTab: false,
    persistSessionLogs: true,
    captureResponseBodies: true,
    redactSensitiveData: true
  },
  providerRouting: {
    enabled: false,
    mode: "auto",
    order: [],
    allowFallbacks: true
  },
  reasoning: {
    effort: "auto",
    showThinking: false,
    keepThinkingOpen: false
  },
  agentLimits: {
    maxToolCalls: 14,
    fallbackContextWindow: 128000
  },
  authManualKeys: {},
  appearance: {
    hue: 348,
    saturation: 58,
    lightness: 50
  }
};

export function setSettings(next) {
  settings = next;
  emit("settings");
}

export let chats = {};
export let currentChatId = null;

export function setChats(next) {
  chats = safeRecord(next);
  for (const chat of Object.values(chats)) {
    if (chat && typeof chat === "object") chat.files = safeRecord(chat.files, isSafeVirtualPath);
  }
  emit("chats");
}

export function setCurrentChatId(id) {
  currentChatId = id;
  emit("currentChatId");
}

export let globalWorkspace = {};

export function setGlobalWorkspace(next) {
  globalWorkspace = safeRecord(next, isSafeVirtualPath);
  emit("globalWorkspace");
}

export let uploadedAttachments = [];

export function setUploadedAttachments(next) {
  uploadedAttachments = next;
  emit("uploadedAttachments");
}

export let isAgentRunning = false;
export let agentStopRequested = false;
export let agentAbortController = null;
export let activeToolRunStats = null;
export let activeAgentChatId = null;

export function beginAgentRunState(chatId = currentChatId) {
  isAgentRunning = true;
  agentStopRequested = false;
  activeAgentChatId = chatId || null;
  agentAbortController = new AbortController();
  activeToolRunStats = {
    failures: {},
    readOnlyCalls: {},
    toolCallCount: 0
  };
  emit("agentRun");
}

export function endAgentRunState() {
  isAgentRunning = false;
  agentStopRequested = false;
  activeAgentChatId = null;
  agentAbortController = null;
  activeToolRunStats = null;
  emit("agentRun");
}

export function requestAgentStop() {
  agentStopRequested = true;
  emit("agentRun");
}

export let openRouterModels = [];
export let openRouterModelsLoading = false;
export let openRouterEndpoints = [];
export let openRouterEndpointsLoading = false;

export function setOpenRouterModels(next) {
  openRouterModels = next;
  emit("openRouterModels");
}

export function setOpenRouterModelsLoading(next) {
  openRouterModelsLoading = next;
}

export function setOpenRouterEndpoints(next) {
  openRouterEndpoints = next;
  emit("openRouterEndpoints");
}

export function setOpenRouterEndpointsLoading(next) {
  openRouterEndpointsLoading = next;
}

export const mcpToolRegistry = new Map();
export const mcpConnections = new Map();
