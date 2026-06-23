// sidepanel/state/store.js - Central app state.
//
// Consumers import the live bindings and read them directly; ES module live
// bindings mean reads always see the current value. Mutating an object's
// properties is fine from anywhere, but REASSIGNING a top-level value must go
// through its set* function here so the swap is visible to every module and
// subscribers get notified.

const listeners = new Map(); // key -> Set<fn>

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

// ---- Settings (placeholder shape until loadSettings() normalizes from storage)
export let settings = {
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
  authManualKeys: {}
};

export function setSettings(next) {
  settings = next;
  emit("settings");
}

// ---- Chats
export let chats = {};            // { [chatId]: { id, title, messages: [], files: {}, timestamp } }
export let currentChatId = null;  // The ID of the active chat session

export function setChats(next) {
  chats = next;
  emit("chats");
}

export function setCurrentChatId(id) {
  currentChatId = id;
  emit("currentChatId");
}

// ---- Workspace files
export let globalWorkspace = {};  // { [path]: { path, content, language, description, updatedAt, chatId } }

export function setGlobalWorkspace(next) {
  globalWorkspace = next;
  emit("globalWorkspace");
}

// ---- Composer attachments
export let uploadedAttachments = []; // Files queued for the next manual message

export function setUploadedAttachments(next) {
  uploadedAttachments = next;
  emit("uploadedAttachments");
}

// ---- Agent run lifecycle
export let isAgentRunning = false;
export let agentStopRequested = false;
export let agentAbortController = null;
export let activeToolRunStats = null;

export function beginAgentRunState() {
  isAgentRunning = true;
  agentStopRequested = false;
  agentAbortController = new AbortController();
  activeToolRunStats = {
    failures: {},
    readOnlyCalls: {},
    browserToolCount: 0
  };
  emit("agentRun");
}

export function endAgentRunState() {
  isAgentRunning = false;
  agentAbortController = null;
  activeToolRunStats = null;
  emit("agentRun");
}

export function requestAgentStop() {
  agentStopRequested = true;
  emit("agentRun");
}

// ---- OpenRouter caches
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

// ---- MCP connections
export const mcpToolRegistry = new Map(); // toolName -> { serverId, serverName, originalName, schema }
export const mcpConnections = new Map();  // serverId -> { sessionId, tools, server }
