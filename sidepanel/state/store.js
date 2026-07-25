import { isSafeVirtualPath, safeRecord } from "../lib/safe-record.js";
import { AI_PROVIDERS } from "../api/provider.js";

export let settings = {
  aiProvider: "openrouter",
  providerConfigs: {
    openrouter: {
      apiKey: "",
      model: AI_PROVIDERS.openrouter.defaultModel
    },
    openai: {
      model: AI_PROVIDERS.openai.defaultModel
    }
  },
  dataSharingConsent: false,
  apiKey: "",
  model: AI_PROVIDERS.openrouter.defaultModel,
  systemPrompt: "",
  mcpServers: [],
  mcpBridge: {
    enabled: false,
    port: 9229,
    token: ""
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
}

export let chats = {};
export let currentChatId = null;

export function setChats(next) {
  chats = safeRecord(next);
  for (const chat of Object.values(chats)) {
    if (chat && typeof chat === "object") chat.files = safeRecord(chat.files, isSafeVirtualPath);
  }
}

export function setCurrentChatId(id) {
  currentChatId = id;
}

export let globalWorkspace = {};

export function setGlobalWorkspace(next) {
  globalWorkspace = safeRecord(next, isSafeVirtualPath);
}

export let uploadedAttachments = [];

export function setUploadedAttachments(next) {
  uploadedAttachments = next;
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
}

export function endAgentRunState() {
  isAgentRunning = false;
  agentStopRequested = false;
  activeAgentChatId = null;
  agentAbortController = null;
  activeToolRunStats = null;
}

export function requestAgentStop() {
  agentStopRequested = true;
}

export let openRouterModels = [];
export let openRouterModelsLoading = false;
export let openRouterEndpoints = [];
export let openRouterEndpointsLoading = false;

export function setOpenRouterModels(next) {
  openRouterModels = next;
}

export function setOpenRouterModelsLoading(next) {
  openRouterModelsLoading = next;
}

export function setOpenRouterEndpoints(next) {
  openRouterEndpoints = next;
}

export function setOpenRouterEndpointsLoading(next) {
  openRouterEndpointsLoading = next;
}

export const mcpToolRegistry = new Map();
export const mcpConnections = new Map();
