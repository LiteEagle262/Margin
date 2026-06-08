// sidepanel.js - Streamlined Agentic Scraper Chat Assistant with Vision & Tools

// State Management
let settings = {
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
    effort: "auto"
  },
  authManualKeys: {}
};

let openRouterModels = [];
let openRouterModelsLoading = false;
let openRouterEndpoints = [];
let openRouterEndpointsLoading = false;
let openRouterBalanceRequestId = 0;
let mcpToolRegistry = new Map(); // toolName -> { serverId, serverName, originalName }

let chats = {};            // Dictionary of chat sessions: { [chatId]: { id, title, messages: [], timestamp } }
let currentChatId = null;  // The ID of the active chat session
let globalWorkspace = {};  // Persistent file workspace: { [path]: { path, content, language, description, updatedAt, chatId } }
let uploadedImages = [];   // Stores Base64 data URLs for screenshots to be sent with next manual message
let isAgentRunning = false;
let agentStopRequested = false;
let agentAbortController = null;

const DEFAULT_SYSTEM_PROMPT = `You are ScrapeFlow, a professional browser-automation and web scraping AI assistant.
You can execute actions on the current webpage using your built-in tools (get_dom, take_screenshot, click_element, scroll_page, type_text, run_js, get_active_tab, list_tabs, navigate, get_authenticator_code, list_authenticator_domains). Use them to inspect, analyze, and build web scrapers on behalf of the user.
If a test login asks for a 2FA/authenticator code, use get_authenticator_code for the active domain when a manual key has been saved in settings.
For debugging API calls and page requests, use get_network_logs first because a settings-enabled hindsight buffer may already exist for the latched tab. If no logs are available, use start_network_capture before interacting with the page, then get_network_logs or get_network_log_detail to inspect URLs, status codes, headers, failures, and redacted bodies.
If MCP servers are configured, you also have additional tools prefixed with mcp__ — use those when they are relevant.

IMPORTANT — File output rules:
- NEVER paste full scripts or multi-line code in chat markdown/code blocks.
- ALWAYS use write_file to save scripts, configs, and other files. The user gets a compact file card they can click to view and copy.
- Files are saved to a persistent workspace shared across chats. Use list_files for an overview, search_files to find files by name or content, get_file_info for metadata, read_file to load contents, rename_file and delete_file to manage files.
- After write_file, give a brief explanation only — do not repeat the file contents.`;

const AUTHENTICATOR_SYSTEM_PROMPT_ADDENDUM =
  "If a test login asks for a 2FA/authenticator code, use get_authenticator_code for the active domain when a manual key has been saved in settings.";

const CONTEXT_PACKING = {
  maxWindowShare: 0.86,
  minResponseReserve: 4096,
  maxResponseReserve: 24000,
  recentToolResultsInline: 6,
  archiveToolResultTokens: 2000
};

const EYE_ICON = `
  <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
`;

const LOCK_ICON = `
  <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="11" width="18" height="10" rx="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
`;

const SEND_ICON = `
  <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
`;

const STOP_ICON = `
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="1"/>
  </svg>
`;

const EDIT_ICON = `
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
  </svg>
`;

const CHECK_ICON = `
  <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
`;

const X_ICON = `
  <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
`;

// Tool schemas declared to OpenRouter
const BROWSER_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_dom",
      description: "Retrieve the text body content and truncated HTML DOM representation of the current active webpage.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Capture a screenshot of the visible viewport area of the current active webpage. Use this to visually see page structures, verify layout loading, or debug automation states.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Perform a mouse click on a page element using its CSS selector.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The CSS selector of the target element to click." }
        },
        required: ["selector"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_page",
      description: "Scroll the active page view up or down.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
          amount: { type: "number", description: "Pixels to scroll. Defaults to 500." }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Type text into a designated input element on the page.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "The CSS selector of the input element." },
          text: { type: "string", description: "The text value to enter." }
        },
        required: ["selector", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_js",
      description: "Execute arbitrary Javascript in the webpage context and retrieve the return result.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The Javascript snippet to evaluate on the page." }
        },
        required: ["code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_active_tab",
      description: "Get metadata about the currently active browser tab (id, url, title).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List all tabs in the current browser window.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the active tab to a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Destination URL." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_network_capture",
      description: "Start recording HTTP/network requests on the active tab. Use this when get_network_logs has no hindsight buffer yet, then reload or interact with the page.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_network_capture",
      description: "Stop recording network requests on the active tab.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_network_logs",
      description: "List captured network requests from the active or latched tab, including persisted session hindsight when available. Filter by URL substring, method, status code, failed state, or resource type. Set include_body to true to include redacted request/response bodies.",
      parameters: {
        type: "object",
        properties: {
          url_contains: { type: "string", description: "Filter logs to URLs containing this substring." },
          method: { type: "string", description: "Filter by HTTP method, e.g. GET or POST." },
          status: { type: "number", description: "Filter by HTTP status code, e.g. 200 or 404." },
          type: { type: "string", description: "Filter by resource type, e.g. XHR, Fetch, Document, Script." },
          failed: { type: "boolean", description: "Filter to failed requests when true, or successful/non-failed requests when false." },
          limit: { type: "number", description: "Max entries to return. Defaults to 50." },
          include_body: { type: "boolean", description: "Include redacted request/response bodies in results. Defaults to false." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_network_log_detail",
      description: "Get full details for a single network request including redacted headers and response body. Use the request id from get_network_logs.",
      parameters: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "The request id from get_network_logs." }
        },
        required: ["request_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clear_network_logs",
      description: "Clear all captured network logs for the active tab.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_authenticator_code",
      description: "Generate a current 6-digit TOTP authenticator code from a saved manual key for a domain. If domain is omitted, uses the active tab hostname.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Optional hostname or URL. Defaults to the current active tab hostname." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_authenticator_domains",
      description: "List domains that have saved authenticator manual keys. Does not reveal the keys.",
      parameters: { type: "object", properties: {} }
    }
  }
];

const WORKSPACE_TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or update a script/file in the persistent workspace. Use this for all scraper scripts, configs, and code — never dump code in chat. The user sees a compact clickable file card.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File name or path, e.g. scraper.js, utils/helpers.py" },
          content: { type: "string", description: "Full file contents." },
          language: { type: "string", description: "Optional language hint, e.g. javascript, python." },
          description: { type: "string", description: "Optional one-line summary of what the file does." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for easier recall, e.g. [\"scraper\", \"amazon\"]."
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace by path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_context_item",
      description: "Retrieve the full original content for an archived tool result by context_item_id when a previous compact reference says more detail is available.",
      parameters: {
        type: "object",
        properties: {
          context_item_id: { type: "string", description: "The context item id shown in an archived tool result reference." }
        },
        required: ["context_item_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the persistent workspace with paths, languages, line counts, descriptions, and tags.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Optional tag filter — only list files with this tag." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search workspace files by path, description, tags, or file content. Use this to recall files when you are unsure of the exact path.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term." },
          search_in: {
            type: "string",
            enum: ["all", "path", "description", "content", "tags"],
            description: "Where to search. Defaults to all."
          },
          limit: { type: "number", description: "Max results. Defaults to 20." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_file_info",
      description: "Get metadata about a workspace file without loading full contents (path, language, line count, description, tags, last updated).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a workspace file to a new path.",
      parameters: {
        type: "object",
        properties: {
          old_path: { type: "string", description: "Current file path." },
          new_path: { type: "string", description: "New file path." }
        },
        required: ["old_path", "new_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete." }
        },
        required: ["path"]
      }
    }
  }
];

const WORKSPACE_TOOL_NAMES = new Set([
  "write_file", "read_file", "list_files", "search_files",
  "read_context_item", "get_file_info", "rename_file", "delete_file"
]);

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
    initProviderRoutingSettings();
    initMcpSettings();
    initMcpBridgeSettings();
    initAuthManualKeySettings();
    initChatEvents();
    initUploadEvents();
    initFileViewer();
    initUsageBar();
    initLatchTab();
    renderWorkspaceStrip();
    updateModelBadge();
    refreshOpenRouterBalance();
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

// ----------------------------------------------------
// STATE & PERSISTENCE
// ----------------------------------------------------
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(["apiKey", "model", "customModel", "systemPrompt", "mcpServers", "mcpBridge", "tempEmail", "networkCapture", "providerRouting", "reasoning", "authManualKeys"]);
    settings.apiKey = result.apiKey || "";
    settings.model = result.model || "anthropic/claude-3.5-sonnet";
    if (settings.model === "custom" && result.customModel) {
      settings.model = result.customModel;
    }
    settings.systemPrompt = result.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    settings.mcpServers = Array.isArray(result.mcpServers) ? result.mcpServers : [];
    settings.mcpBridge = normalizeMcpBridgeSettings(result.mcpBridge);
    settings.tempEmail = normalizeTempEmailSettings(result.tempEmail);
    settings.networkCapture = normalizeNetworkCaptureSettings(result.networkCapture);
    settings.providerRouting = normalizeProviderRoutingSettings(result.providerRouting);
    settings.reasoning = normalizeReasoningSettings(result.reasoning);
    settings.authManualKeys = normalizeAuthManualKeys(result.authManualKeys);

    const apiKeyInput = document.getElementById("openrouter-api-key");
    if (apiKeyInput) apiKeyInput.value = settings.apiKey;

    syncModelPickerValue();
    renderMcpServersList();
    renderMcpBridgeSettings();
    renderTempEmailSettings();
    renderNetworkCaptureSettings();
    renderProviderRoutingSettings();
    renderReasoningSettings();
    renderAuthManualKeys();

    const systemPromptTextarea = document.getElementById("system-prompt");
    if (systemPromptTextarea) systemPromptTextarea.value = settings.systemPrompt;
  } catch (e) {
    console.error("Error loading settings:", e);
  }
}

// Load multiple chats history
async function loadGlobalWorkspace() {
  try {
    const result = await chrome.storage.local.get(["globalWorkspace"]);
    globalWorkspace = result.globalWorkspace || {};
  } catch (e) {
    console.error("Error loading global workspace:", e);
    globalWorkspace = {};
  }
}

async function saveGlobalWorkspace() {
  try {
    await chrome.storage.local.set({ globalWorkspace });
  } catch (e) {
    console.error("Error saving global workspace:", e);
  }
  renderWorkspaceStrip();
}

// ----------------------------------------------------
// WORKSPACE STRIP & FILE VIEWER
// ----------------------------------------------------
// The strip above the input is the chat-scoped file index: it shows only the
// files that belong to the currently open chat (extensions, userscripts,
// scrapers, configs — whatever the agent produced in this conversation).
// Re-renders on every workspace mutation and on chat switch.
function renderWorkspaceStrip() {
  const strip = document.getElementById("workspace-strip");
  const chipsEl = document.getElementById("workspace-strip-chips");
  if (!strip || !chipsEl) return;

  // Always visible — even an empty chat shows the strip with a hint, so the
  // user learns where files will appear once the agent saves them.
  strip.classList.remove("hidden");

  const files = Object.values(getActiveChatFiles())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const countEl = strip.querySelector(".workspace-count");
  if (countEl) {
    countEl.textContent = files.length === 0
      ? "empty"
      : (files.length === 1 ? "1 file" : `${files.length} files`);
  }

  strip.classList.toggle("is-empty", files.length === 0);
  chipsEl.innerHTML = "";

  if (files.length === 0) {
    const hint = document.createElement("div");
    hint.className = "workspace-empty-hint";
    hint.innerHTML = `
      <span class="empty-hint-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14"/><path d="M5 12h14"/>
        </svg>
      </span>
      <span>Ask for a scraper, userscript, or extension — files saved here pop up as chips you can open and copy.</span>
    `;
    chipsEl.appendChild(hint);
    return;
  }

  const recentCutoff = Date.now() - 60 * 1000;

  files.forEach((file) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "workspace-chip";
    if ((file.updatedAt || 0) > recentCutoff) chip.classList.add("recent");

    const name = file.path.split("/").pop() || file.path;
    const lines = file.content.split("\n").length;

    chip.innerHTML = `
      <span class="chip-dot" aria-hidden="true"></span>
      <span class="chip-name">${escapeHtml(name)}</span>
      <span class="chip-meta">${lines}L</span>
    `;
    chip.title = `${file.path}${file.description ? `\n${file.description}` : ""}`;
    chip.addEventListener("click", () => openFileViewer(file.path));
    chipsEl.appendChild(chip);
  });
}

function openFileViewer(path) {
  const file = getWorkspaceFile(path);
  const overlay = document.getElementById("file-viewer-overlay");
  if (!file || !overlay) return;

  const nameEl = overlay.querySelector(".file-viewer-name");
  const metaEl = overlay.querySelector(".file-viewer-meta");
  const codeEl = overlay.querySelector(".file-viewer-code code");
  const copyBtn = overlay.querySelector(".file-viewer-copy");
  if (!nameEl || !metaEl || !codeEl || !copyBtn) return;

  const lines = file.content.split("\n").length;
  nameEl.textContent = file.path;
  metaEl.textContent = `${file.language} · ${lines} lines${file.description ? ` · ${file.description}` : ""}`;
  codeEl.textContent = file.content;
  codeEl.className = `language-${file.language}`;

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  // Defer focus so the transition can play.
  requestAnimationFrame(() => overlay.classList.add("open"));

  copyBtn.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(file.content).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1300);
    });
  };
}

function closeFileViewer() {
  const overlay = document.getElementById("file-viewer-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  // Wait for fade transition before hiding so visual feels intentional.
  setTimeout(() => overlay.classList.add("hidden"), 160);
}

function initFileViewer() {
  const overlay = document.getElementById("file-viewer-overlay");
  if (!overlay) return;
  const closeBtn = overlay.querySelector(".file-viewer-close");
  closeBtn?.addEventListener("click", closeFileViewer);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFileViewer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeFileViewer();
  });
}

// ----------------------------------------------------
// USAGE BAR: CONTEXT RING + COST METER
// ----------------------------------------------------
// Estimates next-turn context usage by category and tracks accumulated cost
// across the chat using OpenRouter's reported usage. Token counts use the
// chars/4 heuristic — accurate enough for a UX gauge, and we surface model-
// reported actuals via the cost path for the spend number.
const USAGE_CATEGORIES = [
  { key: "system",       label: "System prompt", color: "#5e9cff" },
  { key: "browserTools", label: "Browser tools", color: "#7dd3a7" },
  { key: "mcpTools",     label: "MCP tools",     color: "#b794f4" },
  { key: "chat",         label: "Conversation",  color: "#f6c177" },
  { key: "toolIO",       label: "Tool I/O",      color: "#eb7676" },
  { key: "images",       label: "Images",        color: "#9aa0a6" }
];

function approxTokens(text) {
  if (text === undefined || text === null) return 0;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return Math.ceil(s.length / 4);
}

function getActiveModelInfo() {
  const id = settings.model;
  const match = openRouterModels.find(m => m.id === id);
  return {
    id,
    name: match?.name || id,
    contextWindow: Number(match?.context_length) || 128000,
    promptRate: Number(match?.pricing?.prompt) || 0,
    completionRate: Number(match?.pricing?.completion) || 0,
    hasInfo: !!match
  };
}

function getResponseReserveTokens(contextWindow) {
  const reserve = Math.round(contextWindow * 0.12);
  return Math.max(
    CONTEXT_PACKING.minResponseReserve,
    Math.min(CONTEXT_PACKING.maxResponseReserve, reserve)
  );
}

function getModelMessageBudget() {
  const model = getActiveModelInfo();
  const contextWindow = model.contextWindow || 128000;
  const toolsTokens = approxTokens(getAllAgentTools());
  const systemTokens = approxTokens(getEffectiveSystemPrompt());
  const reserveTokens = getResponseReserveTokens(contextWindow);
  const maxPromptTokens = Math.floor(contextWindow * CONTEXT_PACKING.maxWindowShare);
  return Math.max(2000, maxPromptTokens - reserveTokens - toolsTokens - systemTokens);
}

function countApiMessageTokens(message) {
  let total = approxTokens(message.role || "");
  if (typeof message.content === "string") {
    total += approxTokens(message.content);
  } else if (Array.isArray(message.content)) {
    message.content.forEach(part => {
      if (part.type === "text") total += approxTokens(part.text || "");
      if (part.type === "image_url") total += 1024;
    });
  }
  if (Array.isArray(message.tool_calls)) total += approxTokens(message.tool_calls);
  if (message.tool_call_id) total += approxTokens(message.tool_call_id);
  if (message.name) total += approxTokens(message.name);
  return total;
}

function blockTokenCount(block) {
  return block.messages.reduce((sum, message) => sum + countApiMessageTokens(message), 0);
}

function getRecentInlineToolCallIds(messages) {
  const ids = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "tool" || !msg.tool_call_id) continue;
    ids.add(msg.tool_call_id);
    if (ids.size >= CONTEXT_PACKING.recentToolResultsInline) break;
  }
  return ids;
}

function getContextItemId(msg) {
  return `tool_${msg.tool_call_id || ""}`;
}

function getContextItem(contextItemId) {
  const activeChat = chats[currentChatId];
  if (!activeChat || !Array.isArray(activeChat.messages)) return null;
  return activeChat.messages.find(msg =>
    msg.role === "tool" && getContextItemId(msg) === contextItemId
  ) || null;
}

function summarizeToolContent(content) {
  const text = String(content || "");
  const oneLine = text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  return oneLine || "(empty result)";
}

function formatToolContentForModel(msg, inlineToolCallIds) {
  const content = String(msg.content || "");
  const shouldArchive =
    msg.tool_call_id &&
    !inlineToolCallIds.has(msg.tool_call_id) &&
    approxTokens(content) > CONTEXT_PACKING.archiveToolResultTokens;

  if (!shouldArchive) return content;

  const contextItemId = getContextItemId(msg);
  return [
    `[Archived tool result: ${contextItemId}]`,
    `Tool: ${msg.name || "unknown"}`,
    `Original size: about ${formatTokens(approxTokens(content))} tokens.`,
    `Preview: ${summarizeToolContent(content)}`,
    `Use read_context_item with context_item_id="${contextItemId}" if you need the full original result.`
  ].join("\n");
}

function formatStoredMessageForModel(msg, inlineToolCallIds) {
  if (msg.role === "user") {
    const contents = [];
    contents.push({ type: "text", text: msg.content || "Analyze page elements." });
    if (msg.images && msg.images.length > 0) {
      msg.images.forEach(imgBase64 => {
        contents.push({
          type: "image_url",
          image_url: { url: imgBase64 }
        });
      });
    }
    return { role: "user", content: contents };
  }

  if (msg.role === "assistant") {
    if (msg.tool_calls) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls
      };
    }
    return { role: "assistant", content: msg.content || "" };
  }

  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: msg.tool_call_id,
      name: msg.name,
      content: formatToolContentForModel(msg, inlineToolCallIds)
    };
  }

  return null;
}

function buildModelMessageBlocks(activeChat) {
  if (!activeChat || !Array.isArray(activeChat.messages)) return [];
  const inlineToolCallIds = getRecentInlineToolCallIds(activeChat.messages);
  const blocks = [];

  for (let i = 0; i < activeChat.messages.length; i++) {
    const msg = activeChat.messages[i];
    if (!msg || msg.role === "tool-status" || msg.role === "file-artifact") continue;

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const blockMessages = [formatStoredMessageForModel(msg, inlineToolCallIds)];
      const expectedToolIds = new Set(msg.tool_calls.map(tc => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < activeChat.messages.length) {
        const next = activeChat.messages[j];
        if (next?.role === "tool-status" || next?.role === "file-artifact") {
          j++;
          continue;
        }
        if (next?.role === "tool" && expectedToolIds.has(next.tool_call_id)) {
          blockMessages.push(formatStoredMessageForModel(next, inlineToolCallIds));
          j++;
          continue;
        }
        break;
      }
      blocks.push({ messages: blockMessages });
      i = j - 1;
      continue;
    }

    if (msg.role === "tool") continue;

    const formatted = formatStoredMessageForModel(msg, inlineToolCallIds);
    if (formatted) blocks.push({ messages: [formatted] });
  }

  return blocks;
}

function buildApiMessagesForChat(activeChat) {
  const systemMessage = { role: "system", content: getEffectiveSystemPrompt() };
  const budget = getModelMessageBudget();
  const blocks = buildModelMessageBlocks(activeChat);
  const selected = [];
  let used = 0;
  let omitted = 0;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const blockTokens = blockTokenCount(block);
    if (selected.length > 0 && used + blockTokens > budget) {
      omitted = i + 1;
      break;
    }
    selected.unshift(block);
    used += blockTokens;
  }

  if (omitted > 0) {
    systemMessage.content += `\n\nContext note: ${omitted} older conversation block(s) were left out to fit the active model context window. Older large tool results may be available through read_context_item when referenced by id.`;
  }

  return [
    systemMessage,
    ...selected.flatMap(block => block.messages)
  ];
}

function computeContextBreakdown() {
  const breakdown = { system: 0, browserTools: 0, mcpTools: 0, chat: 0, toolIO: 0, images: 0 };

  breakdown.system += approxTokens(getEffectiveSystemPrompt());
  breakdown.browserTools += approxTokens([...BROWSER_TOOLS, ...WORKSPACE_TOOLS]);
  const mcpTools = getMcpToolSchemas();
  if (mcpTools.length > 0) breakdown.mcpTools += approxTokens(mcpTools);

  const activeChat = chats[currentChatId];
  if (activeChat) {
    const apiMessages = buildApiMessagesForChat(activeChat).slice(1);
    apiMessages.forEach(msg => {
      if (msg.role === "user") {
        if (Array.isArray(msg.content)) {
          msg.content.forEach(part => {
            if (part.type === "text") breakdown.chat += approxTokens(part.text || "");
            if (part.type === "image_url") breakdown.images += 1024;
          });
        } else {
          breakdown.chat += approxTokens(msg.content || "");
        }
      } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        breakdown.chat += approxTokens(msg.content || "");
        breakdown.toolIO += approxTokens(msg.tool_calls);
      } else if (msg.role === "assistant") {
        breakdown.chat += countApiMessageTokens(msg);
      } else if (msg.role === "tool") {
        breakdown.toolIO += countApiMessageTokens(msg);
      }
    });
  }

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function formatCost(usd) {
  if (!usd) return "0.0000";
  if (usd < 0.01) return usd.toFixed(4);
  if (usd < 1) return usd.toFixed(3);
  return usd.toFixed(2);
}

function updateUsageBar() {
  const ringBtn = document.getElementById("context-ring-btn");
  const tooltip = document.getElementById("context-tooltip");
  const costEl = document.getElementById("cost-meter");
  if (!ringBtn || !tooltip || !costEl) return;

  const model = getActiveModelInfo();
  const { total, breakdown } = computeContextBreakdown();
  const window = model.contextWindow;
  const pct = window > 0 ? Math.min(100, (total / window) * 100) : 0;

  // Ring: stroke-dasharray uses pathLength="100" so the arc maps to percent.
  const ringProgress = ringBtn.querySelector(".ring-progress");
  if (ringProgress) {
    ringProgress.style.strokeDasharray = `${pct} 100`;
  }
  ringBtn.classList.toggle("near-limit", pct >= 75 && pct < 90);
  ringBtn.classList.toggle("over-limit", pct >= 90);

  ringBtn.querySelector(".context-percent").textContent = `${Math.round(pct)}%`;
  ringBtn.querySelector(".context-summary").textContent =
    `${formatTokens(total)} of ${formatTokens(window)} ctx`;

  // Tooltip header + breakdown rows
  tooltip.querySelector(".tooltip-total").textContent = `${formatTokens(total)} tokens`;
  tooltip.querySelector(".tooltip-model").textContent = model.name;
  tooltip.querySelector(".tooltip-window").textContent = `${formatTokens(window)} ctx window`;

  const bar = tooltip.querySelector(".tooltip-bar");
  const list = tooltip.querySelector(".tooltip-breakdown");
  bar.innerHTML = "";
  list.innerHTML = "";

  USAGE_CATEGORIES.forEach(cat => {
    const value = breakdown[cat.key] || 0;
    const share = total > 0 ? (value / total) * 100 : 0;
    if (value === 0) return;

    const seg = document.createElement("span");
    seg.className = "tooltip-bar-seg";
    seg.style.width = `${share}%`;
    seg.style.background = cat.color;
    seg.title = `${cat.label}: ${formatTokens(value)}`;
    bar.appendChild(seg);

    const li = document.createElement("li");
    li.innerHTML = `
      <span class="cat-swatch" style="background:${cat.color}"></span>
      <span class="cat-label">${cat.label}</span>
      <span class="cat-tokens">${formatTokens(value)}</span>
      <span class="cat-pct">${share < 1 ? "<1" : Math.round(share)}%</span>
    `;
    list.appendChild(li);
  });

  if (total === 0) {
    list.innerHTML = `<li class="tooltip-empty">No context yet — send a message to populate.</li>`;
  }

  // Cost meter — sourced from accumulated actuals reported by OpenRouter.
  const activeChat = chats[currentChatId];
  const cost = activeChat?.cost?.totalUsd || 0;
  costEl.querySelector(".cost-amount").textContent = formatCost(cost);
  costEl.classList.toggle("has-spend", cost > 0);
  costEl.title = activeChat?.cost
    ? `Prompt: ${formatTokens(activeChat.cost.promptTokens || 0)} tok · Completion: ${formatTokens(activeChat.cost.completionTokens || 0)} tok\nThis chat: $${formatCost(cost)}`
    : "No spend recorded yet for this chat.";
}

function recordUsage(usage) {
  // Called after each OpenRouter response. `usage` shape:
  // { prompt_tokens, completion_tokens, total_tokens, cost? }
  if (!usage || !currentChatId) return;
  const chat = chats[currentChatId];
  if (!chat) return;

  if (!chat.cost) chat.cost = { promptTokens: 0, completionTokens: 0, totalUsd: 0 };
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  chat.cost.promptTokens += prompt;
  chat.cost.completionTokens += completion;

  // OpenRouter sometimes returns a top-level `cost` (in USD). When absent,
  // derive it from model pricing rates.
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
    chat.cost.totalUsd += usage.cost;
  } else {
    const model = getActiveModelInfo();
    chat.cost.totalUsd += prompt * model.promptRate + completion * model.completionRate;
  }

  updateUsageBar();
}

function initUsageBar() {
  const ringBtn = document.getElementById("context-ring-btn");
  const tooltip = document.getElementById("context-tooltip");
  if (!ringBtn || !tooltip) return;

  const show = () => {
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
  };
  const hide = () => {
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  };

  ringBtn.addEventListener("mouseenter", show);
  ringBtn.addEventListener("focus", show);
  ringBtn.addEventListener("mouseleave", hide);
  ringBtn.addEventListener("blur", hide);
  ringBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (tooltip.classList.contains("visible")) hide(); else show();
  });
  tooltip.addEventListener("mouseenter", show);
  tooltip.addEventListener("mouseleave", hide);

  updateUsageBar();
}

function syncChatFileToGlobal(path, fileRecord) {
  globalWorkspace[path] = { ...fileRecord };
}

function removeGlobalFile(path) {
  delete globalWorkspace[path];
}

function getWorkspaceFile(path) {
  const chatFiles = getActiveChatFiles();
  return chatFiles[path] || globalWorkspace[path] || null;
}

function getAllWorkspaceFiles() {
  const merged = { ...globalWorkspace };
  const chatFiles = getActiveChatFiles();
  Object.assign(merged, chatFiles);
  return merged;
}

function formatFileListing(file) {
  const lines = file.content.split("\n").length;
  const tags = Array.isArray(file.tags) && file.tags.length > 0
    ? ` [${file.tags.join(", ")}]`
    : "";
  const desc = file.description ? `: ${file.description}` : "";
  return `- ${file.path} (${file.language}, ${lines} lines)${tags}${desc}`;
}

// Load multiple chats history
async function loadChats() {
  try {
    const result = await chrome.storage.local.get(["chats", "currentChatId"]);
    chats = result.chats || {};
    currentChatId = result.currentChatId || null;

    Object.values(chats).forEach(chat => {
      if (!chat.files) chat.files = {};
      Object.entries(chat.files).forEach(([path, file]) => {
        if (!globalWorkspace[path] || (file.updatedAt || 0) >= (globalWorkspace[path].updatedAt || 0)) {
          globalWorkspace[path] = { ...file, chatId: chat.id };
        }
      });
    });

    if (Object.keys(chats).length === 0 || !currentChatId) {
      // Create fresh chat session if empty
      createNewChatSession();
    } else {
      renderChatHistory();
      renderHistoryList();
    }
  } catch (e) {
    console.error("Error loading chats:", e);
  }
}

// Create a new chat session
function createNewChatSession() {
  const id = Date.now().toString();
  chats[id] = {
    id: id,
    title: "New Chat",
    messages: [],
    files: {},
    timestamp: Date.now()
  };
  currentChatId = id;
  saveChats();
  renderChatHistory();
  renderHistoryList();
}

async function saveChats() {
  try {
    await chrome.storage.local.set({ chats, currentChatId });
  } catch (e) {
    console.error("Error saving chats to storage:", e);
  }
}

// ----------------------------------------------------
// UI NAVIGATION & LAYOUT
// ----------------------------------------------------
function initHistoryDrawer() {
  const hamburgerBtn = document.getElementById("hamburger-menu-btn");
  const backdrop = document.getElementById("drawer-backdrop");
  const drawer = document.getElementById("history-drawer");
  const newChatBtn = document.getElementById("new-chat-btn");

  if (hamburgerBtn && drawer && backdrop) {
    hamburgerBtn.addEventListener("click", () => {
      drawer.classList.add("active");
      backdrop.classList.remove("hidden");
      setTimeout(() => backdrop.classList.add("active"), 10);
    });

    const closeDrawer = () => {
      drawer.classList.remove("active");
      backdrop.classList.remove("active");
      setTimeout(() => backdrop.classList.add("hidden"), 250);
    };

    backdrop.addEventListener("click", closeDrawer);

    if (newChatBtn) {
      newChatBtn.addEventListener("click", () => {
        createNewChatSession();
        closeDrawer();
      });
    }
  }
}

// Render the list of chat sessions inside left drawer
function renderHistoryList() {
  const historyList = document.getElementById("history-list");
  if (!historyList) return;

  historyList.innerHTML = "";

  // Sort chats by timestamp descending
  const sortedSessions = Object.values(chats).sort((a, b) => b.timestamp - a.timestamp);

  sortedSessions.forEach(session => {
    const item = document.createElement("div");
    item.className = `history-item ${session.id === currentChatId ? "active" : ""}`;
    
    // Title text block
    const textSpan = document.createElement("span");
    textSpan.className = "history-item-title";
    textSpan.textContent = session.title || "New Chat";
    textSpan.addEventListener("click", () => {
      currentChatId = session.id;
      saveChats();
      renderChatHistory();
      renderHistoryList();
      
      // Close drawer
      const backdrop = document.getElementById("drawer-backdrop");
      const drawer = document.getElementById("history-drawer");
      if (drawer && backdrop) {
        drawer.classList.remove("active");
        backdrop.classList.remove("active");
        setTimeout(() => backdrop.classList.add("hidden"), 250);
      }
    });
    item.appendChild(textSpan);

    // Delete Button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "history-item-delete";
    deleteBtn.title = "Delete Chat";
    deleteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
      </svg>
    `;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChatSession(session.id);
    });
    item.appendChild(deleteBtn);

    historyList.appendChild(item);
  });
}

// Delete Chat session
function deleteChatSession(id) {
  if (confirm("Are you sure you want to delete this chat session?")) {
    delete chats[id];
    if (currentChatId === id) {
      const keys = Object.keys(chats);
      if (keys.length > 0) {
        currentChatId = keys[0];
      } else {
        createNewChatSession();
        return;
      }
    }
    saveChats();
    renderChatHistory();
    renderHistoryList();
  }
}

// Settings Toggle Panel
function initSettingsToggle() {
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

function switchView(viewName) {
  const chatView = document.getElementById("chat-view");
  const settingsView = document.getElementById("settings-view");
  const toggleSettingsBtn = document.getElementById("toggle-settings-btn");
  const headerNewChatBtn = document.getElementById("header-new-chat-btn");
  const headerClearChatBtn = document.getElementById("header-clear-chat-btn");

  if (viewName === "settings") {
    if (chatView) chatView.classList.remove("active");
    if (settingsView) settingsView.classList.add("active");
    if (toggleSettingsBtn) toggleSettingsBtn.classList.add("active");
    if (headerNewChatBtn) headerNewChatBtn.classList.add("hidden");
    if (headerClearChatBtn) headerClearChatBtn.classList.add("hidden");
    ensureOpenRouterModelsLoaded();
  } else {
    if (settingsView) settingsView.classList.remove("active");
    if (chatView) chatView.classList.add("active");
    if (toggleSettingsBtn) toggleSettingsBtn.classList.remove("active");
    if (headerNewChatBtn) headerNewChatBtn.classList.remove("hidden");
    if (headerClearChatBtn) headerClearChatBtn.classList.remove("hidden");
    
    const chatHistory = document.getElementById("chat-history");
    if (chatHistory) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  }
}

// Settings Save Submission
const settingsForm = document.getElementById("settings-form");
if (settingsForm) {
  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const apiKeyInput = document.getElementById("openrouter-api-key");
      const modelSelectedInput = document.getElementById("model-selected");
      const modelSearchInput = document.getElementById("model-search");
      const systemPromptTextarea = document.getElementById("system-prompt");

      settings.apiKey = apiKeyInput ? apiKeyInput.value.trim() : "";
      const pickedModel = modelSelectedInput ? modelSelectedInput.value.trim() : "";
      const typedModel = modelSearchInput ? modelSearchInput.value.trim() : "";
      settings.model = pickedModel || typedModel || settings.model;
      settings.systemPrompt = systemPromptTextarea ? systemPromptTextarea.value.trim() : DEFAULT_SYSTEM_PROMPT;
      settings.mcpServers = collectMcpServersFromUI();
      settings.mcpBridge = collectMcpBridgeFromUI();
      settings.tempEmail = collectTempEmailFromUI();
      settings.networkCapture = collectNetworkCaptureFromUI();
      settings.providerRouting = collectProviderRoutingFromUI();
      settings.reasoning = collectReasoningFromUI();
      settings.authManualKeys = collectAuthManualKeysFromUI();

      await chrome.storage.local.set({
        apiKey: settings.apiKey,
        model: settings.model,
        systemPrompt: settings.systemPrompt,
        mcpServers: settings.mcpServers,
        mcpBridge: settings.mcpBridge,
        tempEmail: settings.tempEmail,
        networkCapture: settings.networkCapture,
        providerRouting: settings.providerRouting,
        reasoning: settings.reasoning,
        authManualKeys: settings.authManualKeys
      });
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
        chats = {};
        globalWorkspace = {};
        currentChatId = null;
        uploadedImages = [];
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

function setSendButtonMode(mode) {
  const sendBtn = document.getElementById("send-btn");
  const chatTextarea = document.getElementById("chat-textarea");
  if (!sendBtn) return;

  if (mode === "stop") {
    sendBtn.classList.add("stop-mode", "active");
    sendBtn.disabled = false;
    sendBtn.title = "Stop";
    sendBtn.setAttribute("aria-label", "Stop response");
    sendBtn.innerHTML = STOP_ICON;
    return;
  }

  sendBtn.classList.remove("stop-mode");
  sendBtn.innerHTML = SEND_ICON;
  sendBtn.title = "Send";
  sendBtn.setAttribute("aria-label", "Send message");

  const hasContent = (chatTextarea && chatTextarea.value.trim()) || uploadedImages.length > 0;
  sendBtn.classList.toggle("active", hasContent);
  sendBtn.disabled = !settings.apiKey;
}

function beginAgentRun() {
  isAgentRunning = true;
  agentStopRequested = false;
  agentAbortController = new AbortController();
  setSendButtonMode("stop");
}

function endAgentRun() {
  isAgentRunning = false;
  agentAbortController = null;
  setSendButtonMode("send");
}

function stopAgent() {
  if (!isAgentRunning) return;
  agentStopRequested = true;
  if (agentAbortController) {
    agentAbortController.abort();
  }
}

async function recordAgentStopped() {
  if (!currentChatId || !chats[currentChatId]) return;
  const activeChat = chats[currentChatId];
  const lastMsg = activeChat.messages[activeChat.messages.length - 1];
  if (lastMsg?.content === "Response stopped.") return;
  const messageIndex = activeChat.messages.push({ role: "assistant", content: "Response stopped." }) - 1;
  appendMessageUI("assistant", "*Response stopped.*", [], true, { messageIndex });
  await saveChats();
}

function updateModelBadge() {
  const activeModelBadge = document.getElementById("active-model-badge");
  const sendBtn = document.getElementById("send-btn");
  
  if (!activeModelBadge) return;
  
  if (!settings.apiKey) {
    activeModelBadge.textContent = "No API Key";
    activeModelBadge.classList.remove("active");
    if (sendBtn && !isAgentRunning) sendBtn.disabled = true;
    return;
  }
  
  const displayModel = settings.model || "No model";
  activeModelBadge.textContent = displayModel.split("/").pop();
  activeModelBadge.classList.add("active");
  if (sendBtn && !isAgentRunning) sendBtn.disabled = false;
  // Model change shifts the context window + pricing rates the meter uses.
  updateUsageBar();
}

function setOpenRouterBalanceBadge(text, { state = "", title = "OpenRouter balance" } = {}) {
  const badge = document.getElementById("openrouter-balance-badge");
  if (!badge) return;

  badge.textContent = text;
  badge.title = title;
  badge.classList.toggle("active", state === "active");
  badge.classList.toggle("loading", state === "loading");
  badge.classList.toggle("error", state === "error");
}

function formatUsdBalance(value) {
  if (!Number.isFinite(value)) return "--";
  const absValue = Math.abs(value);
  const digits = absValue < 1 ? 4 : 2;
  return `${value < 0 ? "-" : ""}$${absValue.toFixed(digits)}`;
}

async function refreshOpenRouterBalance() {
  const requestId = ++openRouterBalanceRequestId;

  if (!settings.apiKey) {
    setOpenRouterBalanceBadge("Balance --", {
      title: "Add an OpenRouter API key to show balance"
    });
    return;
  }

  setOpenRouterBalanceBadge("Balance ...", {
    state: "loading",
    title: "Refreshing OpenRouter balance"
  });

  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "HTTP-Referer": "https://github.com/scrapeflow",
        "X-Title": "ScrapeFlow Chat"
      }
    });

    if (requestId !== openRouterBalanceRequestId) return;

    if (response.ok) {
      const payload = await response.json();
      const totalCredits = Number(payload?.data?.total_credits);
      const totalUsage = Number(payload?.data?.total_usage);
      const balance = totalCredits - totalUsage;

      if (!Number.isFinite(balance)) {
        throw new Error("OpenRouter credits response did not include total credits and usage.");
      }

      setOpenRouterBalanceBadge(`Balance ${formatUsdBalance(balance)}`, {
        state: "active",
        title: `OpenRouter balance: ${formatUsdBalance(balance)} (${formatUsdBalance(totalUsage)} used of ${formatUsdBalance(totalCredits)})`
      });
      return;
    }

    const creditsError = await response.text();
    const keyBalance = await fetchOpenRouterKeyBalance(settings.apiKey);
    if (requestId !== openRouterBalanceRequestId) return;

    if (keyBalance) {
      setOpenRouterBalanceBadge(keyBalance.label, {
        state: "active",
        title: keyBalance.title
      });
      return;
    }

    throw new Error(`OpenRouter credits error (${response.status}): ${creditsError}`);
  } catch (err) {
    if (requestId !== openRouterBalanceRequestId) return;
    console.error("OpenRouter balance fetch error:", err);
    setOpenRouterBalanceBadge("Balance unavailable", {
      state: "error",
      title: err.message
    });
  }
}

async function fetchOpenRouterKeyBalance(apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/scrapeflow",
      "X-Title": "ScrapeFlow Chat"
    }
  });

  if (!response.ok) return null;

  const payload = await response.json();
  const data = payload?.data || {};
  const remaining = Number(data.limit_remaining);
  const usage = Number(data.usage);
  const limit = Number(data.limit);

  if (Number.isFinite(remaining)) {
    const limitText = Number.isFinite(limit) ? ` of ${formatUsdBalance(limit)}` : "";
    return {
      label: `Key ${formatUsdBalance(remaining)}`,
      title: `OpenRouter key remaining: ${formatUsdBalance(remaining)}${limitText}`
    };
  }

  if (Number.isFinite(usage)) {
    return {
      label: `Used ${formatUsdBalance(usage)}`,
      title: `OpenRouter key usage: ${formatUsdBalance(usage)}`
    };
  }

  return null;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

// ----------------------------------------------------
// OPENROUTER MODEL PICKER
// ----------------------------------------------------
function getModelDisplayName(modelId) {
  const match = openRouterModels.find(m => m.id === modelId);
  return match ? match.name : modelId;
}

function syncModelPickerValue() {
  const modelSearch = document.getElementById("model-search");
  const modelSelected = document.getElementById("model-selected");
  if (!modelSearch || !modelSelected) return;

  modelSelected.value = settings.model || "";
  modelSearch.value = settings.model ? getModelDisplayName(settings.model) : "";
}

function setModelPickerStatus(message, isError = false) {
  const statusEl = document.getElementById("model-picker-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? "var(--danger)" : "";
}

async function fetchOpenRouterModels() {
  const apiKeyInput = document.getElementById("openrouter-api-key");
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : settings.apiKey;
  if (!apiKey) {
    setModelPickerStatus("Add your OpenRouter API key above to load models.", true);
    return [];
  }

  openRouterModelsLoading = true;
  setModelPickerStatus("Loading models from OpenRouter...");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models?output_modalities=text", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/scrapeflow",
        "X-Title": "ScrapeFlow Chat"
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to load models (${response.status}): ${errText}`);
    }

    const data = await response.json();
    openRouterModels = (data.data || [])
      .filter(model => model.id)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

    setModelPickerStatus(`${openRouterModels.length} models loaded. Search to pick one.`);
    syncModelPickerValue();
    return openRouterModels;
  } catch (err) {
    console.error("Model fetch error:", err);
    setModelPickerStatus(err.message, true);
    return [];
  } finally {
    openRouterModelsLoading = false;
  }
}

async function ensureOpenRouterModelsLoaded() {
  if (openRouterModels.length > 0 || openRouterModelsLoading) return;
  await fetchOpenRouterModels();
}

function filterModels(query) {
  const q = query.trim().toLowerCase();
  if (!q) return openRouterModels.slice(0, 50);

  return openRouterModels.filter(model => {
    const haystack = `${model.name || ""} ${model.id || ""} ${model.description || ""}`.toLowerCase();
    return haystack.includes(q);
  }).slice(0, 50);
}

function formatModelPrice(pricing) {
  if (!pricing) return "";
  const prompt = pricing.prompt ? `$${(Number(pricing.prompt) * 1_000_000).toFixed(2)}/M in` : "";
  const completion = pricing.completion ? `$${(Number(pricing.completion) * 1_000_000).toFixed(2)}/M out` : "";
  return [prompt, completion].filter(Boolean).join(" · ");
}

function renderModelDropdown(models) {
  const dropdown = document.getElementById("model-dropdown");
  if (!dropdown) return;

  dropdown.innerHTML = "";

  if (!settings.apiKey && !document.getElementById("openrouter-api-key")?.value.trim()) {
    dropdown.innerHTML = `<div class="model-dropdown-empty">Add your API key to load models.</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  if (openRouterModelsLoading) {
    dropdown.innerHTML = `<div class="model-dropdown-empty">Loading models...</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  if (openRouterModels.length === 0) {
    dropdown.innerHTML = `<div class="model-dropdown-empty">No models loaded. Click refresh.</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  if (models.length === 0) {
    dropdown.innerHTML = `<div class="model-dropdown-empty">No models match your search.</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  models.forEach(model => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-option";
    btn.setAttribute("role", "option");
    btn.dataset.modelId = model.id;

    const supportsTools = Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools");
    const metaParts = [
      model.context_length ? `${Math.round(model.context_length / 1000)}k ctx` : "",
      formatModelPrice(model.pricing),
      supportsTools ? "tools" : ""
    ].filter(Boolean);

    btn.innerHTML = `
      <span class="model-option-name">${escapeHtml(model.name || model.id)}</span>
      <span class="model-option-id">${escapeHtml(model.id)}</span>
      ${metaParts.length ? `<span class="model-option-meta">${escapeHtml(metaParts.join(" · "))}</span>` : ""}
    `;

    btn.addEventListener("click", () => selectModel(model));
    dropdown.appendChild(btn);
  });

  dropdown.classList.remove("hidden");
}

function selectModel(model) {
  const modelSearch = document.getElementById("model-search");
  const modelSelected = document.getElementById("model-selected");
  const dropdown = document.getElementById("model-dropdown");

  settings.model = model.id;
  if (modelSelected) modelSelected.value = model.id;
  if (modelSearch) modelSearch.value = model.name || model.id;
  if (dropdown) dropdown.classList.add("hidden");
  openRouterEndpoints = [];
  settings.providerRouting.order = [];
  renderProviderRoutingSettings();
}

function initModelPicker() {
  const modelSearch = document.getElementById("model-search");
  const modelPicker = document.getElementById("model-picker");
  const refreshBtn = document.getElementById("refresh-models-btn");
  const apiKeyInput = document.getElementById("openrouter-api-key");
  let searchTimer = null;

  if (!modelSearch) return;

  syncModelPickerValue();

  modelSearch.addEventListener("focus", async () => {
    await ensureOpenRouterModelsLoaded();
    renderModelDropdown(filterModels(modelSearch.value));
  });

  modelSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderModelDropdown(filterModels(modelSearch.value));
    }, 120);
  });

  modelSearch.addEventListener("keydown", (e) => {
    const dropdown = document.getElementById("model-dropdown");
    const options = dropdown ? Array.from(dropdown.querySelectorAll(".model-option")) : [];
    const active = dropdown ? dropdown.querySelector(".model-option.active") : null;
    let activeIndex = active ? options.indexOf(active) : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, options.length - 1);
      options.forEach(opt => opt.classList.remove("active"));
      if (options[activeIndex]) options[activeIndex].classList.add("active");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      options.forEach(opt => opt.classList.remove("active"));
      if (options[activeIndex]) options[activeIndex].classList.add("active");
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = active || options[0];
      if (pick && pick.dataset.modelId) {
        const model = openRouterModels.find(m => m.id === pick.dataset.modelId);
        if (model) selectModel(model);
      }
    } else if (e.key === "Escape") {
      if (dropdown) dropdown.classList.add("hidden");
    }
  });

  document.addEventListener("click", (e) => {
    if (modelPicker && !modelPicker.contains(e.target)) {
      const dropdown = document.getElementById("model-dropdown");
      if (dropdown) dropdown.classList.add("hidden");
      syncModelPickerValue();
    }
  });

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      openRouterModels = [];
      await fetchOpenRouterModels();
      renderModelDropdown(filterModels(modelSearch.value));
    });
  }

  if (apiKeyInput) {
    apiKeyInput.addEventListener("change", () => {
      openRouterModels = [];
      settings.apiKey = apiKeyInput.value.trim();
      updateModelBadge();
      refreshOpenRouterBalance();
    });
  }
}

// ----------------------------------------------------
// OPENROUTER REASONING & PROVIDER ROUTING
// ----------------------------------------------------
const REASONING_EFFORTS = new Set(["auto", "none", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeReasoningSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    effort: REASONING_EFFORTS.has(value.effort) ? value.effort : "auto"
  };
}

function collectReasoningFromUI() {
  const effortInput = document.getElementById("reasoning-effort");
  return normalizeReasoningSettings({
    effort: effortInput ? effortInput.value : settings.reasoning.effort
  });
}

function renderReasoningSettings() {
  const effortInput = document.getElementById("reasoning-effort");
  if (!effortInput) return;
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  effortInput.value = reasoning.effort;
}

function buildReasoningPreferences() {
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  if (reasoning.effort === "auto") return null;
  return { effort: reasoning.effort };
}

const PROVIDER_ROUTING_MODES = new Set(["auto", "ordered", "price", "throughput", "latency"]);

function normalizeProviderSlug(value) {
  return String(value || "").trim();
}

function endpointSlug(endpoint) {
  return normalizeProviderSlug(endpoint?.tag || endpoint?.provider_slug || endpoint?.provider || endpoint?.name || endpoint?.provider_name);
}

function normalizeProviderRoutingSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const mode = PROVIDER_ROUTING_MODES.has(value.mode) ? value.mode : "auto";
  const order = Array.isArray(value.order)
    ? value.order.map(normalizeProviderSlug).filter(Boolean)
    : [];

  return {
    enabled: value.enabled === true,
    mode,
    order,
    allowFallbacks: value.allowFallbacks !== false
  };
}

function collectProviderRoutingFromUI() {
  const enabledInput = document.getElementById("provider-routing-enabled");
  const modeInput = document.getElementById("provider-routing-mode");
  const fallbackInput = document.getElementById("provider-allow-fallbacks");
  const providerInputs = Array.from(document.querySelectorAll(".provider-select-input"));
  const selected = Array.from(document.querySelectorAll(".provider-select-input:checked"))
    .map(input => normalizeProviderSlug(input.value))
    .filter(Boolean);

  return normalizeProviderRoutingSettings({
    enabled: enabledInput ? enabledInput.checked : settings.providerRouting.enabled,
    mode: modeInput ? modeInput.value : settings.providerRouting.mode,
    order: providerInputs.length ? selected : settings.providerRouting.order,
    allowFallbacks: fallbackInput ? fallbackInput.checked : settings.providerRouting.allowFallbacks
  });
}

function buildProviderPreferences() {
  const routing = normalizeProviderRoutingSettings(settings.providerRouting);
  if (!routing.enabled || routing.mode === "auto") return null;

  const provider = {};
  if (routing.mode === "ordered") {
    if (routing.order.length === 0) return null;
    provider.order = routing.order;
    provider.allow_fallbacks = routing.allowFallbacks;
  } else {
    provider.sort = routing.mode;
  }

  return provider;
}

function selectedModelIdFromUI() {
  const picked = document.getElementById("model-selected")?.value.trim();
  const typed = document.getElementById("model-search")?.value.trim();
  if (picked) return picked;
  const typedMatch = openRouterModels.find(model => model.id === typed || model.name === typed);
  return typedMatch?.id || settings.model || typed || "";
}

function modelEndpointsUrl(modelId) {
  const parts = String(modelId || "").split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const author = encodeURIComponent(parts.shift());
  const slug = parts.map(encodeURIComponent).join("/");
  return `https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`;
}

function setProviderRoutingStatus(message, isError = false) {
  const statusEl = document.getElementById("provider-routing-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? "var(--danger)" : "";
}

function formatEndpointPrice(pricing) {
  if (!pricing) return "n/a";
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  const inPrice = Number.isFinite(prompt) ? `$${(prompt * 1_000_000).toFixed(2)} in` : "";
  const outPrice = Number.isFinite(completion) ? `$${(completion * 1_000_000).toFixed(2)} out` : "";
  return [inPrice, outPrice].filter(Boolean).join(" / ") || "n/a";
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number >= 99 ? 1 : 0)}%` : "n/a";
}

function formatLatency(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number < 10 ? 2 : 1)}s` : "n/a";
}

function formatThroughput(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)} tok/s` : "n/a";
}

function endpointFeatureSummary(endpoint) {
  const parts = [
    endpoint.quantization || "",
    endpoint.context_length ? `${Math.round(Number(endpoint.context_length) / 1000)}k ctx` : "",
    endpoint.max_completion_tokens ? `${Math.round(Number(endpoint.max_completion_tokens) / 1000)}k max out` : "",
    endpoint.supports_implicit_caching ? "cache" : "",
    Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes("tools") ? "tools" : ""
  ].filter(Boolean);
  return parts.join(" / ") || "standard";
}

function renderProviderRoutingSettings() {
  const enabledInput = document.getElementById("provider-routing-enabled");
  const modeInput = document.getElementById("provider-routing-mode");
  const fallbackInput = document.getElementById("provider-allow-fallbacks");
  const comparison = document.getElementById("provider-comparison");
  if (!comparison) return;

  const routing = normalizeProviderRoutingSettings(settings.providerRouting);
  if (enabledInput) enabledInput.checked = routing.enabled;
  if (modeInput) modeInput.value = routing.mode;
  if (fallbackInput) fallbackInput.checked = routing.allowFallbacks;
  comparison.innerHTML = "";

  if (openRouterEndpointsLoading) {
    comparison.innerHTML = `<div class="provider-empty">Loading provider endpoints...</div>`;
    return;
  }

  if (openRouterEndpoints.length === 0) {
    comparison.innerHTML = `<div class="provider-empty">No provider data loaded for this model yet.</div>`;
    return;
  }

  const selected = new Set(routing.order);
  const table = document.createElement("div");
  table.className = "provider-table";
  table.innerHTML = `
    <div class="provider-row provider-row-head">
      <span>Use</span>
      <span>Provider</span>
      <span>Price</span>
      <span>Latency</span>
      <span>Throughput</span>
      <span>Uptime</span>
      <span>Features</span>
    </div>
  `;

  openRouterEndpoints.forEach((endpoint) => {
    const slug = endpointSlug(endpoint);
    const row = document.createElement("label");
    row.className = "provider-row provider-row-body";
    const isSelected = selected.has(slug);
    if (isSelected) row.classList.add("selected");

    row.innerHTML = `
      <span><input type="checkbox" class="provider-select-input" value="${escapeHtml(slug)}" ${isSelected ? "checked" : ""}></span>
      <span>
        <strong>${escapeHtml(endpoint.provider_name || endpoint.name || slug || "Unknown")}</strong>
        <small>${escapeHtml(slug || "no slug")}</small>
      </span>
      <span>${escapeHtml(formatEndpointPrice(endpoint.pricing))}</span>
      <span>${escapeHtml(formatLatency(endpoint.latency_last_30m?.p50))}</span>
      <span>${escapeHtml(formatThroughput(endpoint.throughput_last_30m?.p50))}</span>
      <span>${escapeHtml(formatPercent(endpoint.uptime_last_30m ?? endpoint.uptime_last_1d))}</span>
      <span>${escapeHtml(endpointFeatureSummary(endpoint))}</span>
    `;

    row.querySelector(".provider-select-input")?.addEventListener("change", () => {
      settings.providerRouting = collectProviderRoutingFromUI();
      renderProviderRoutingSettings();
    });
    table.appendChild(row);
  });

  comparison.appendChild(table);
}

async function fetchOpenRouterEndpoints() {
  const apiKeyInput = document.getElementById("openrouter-api-key");
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : settings.apiKey;
  const modelId = selectedModelIdFromUI();
  const url = modelEndpointsUrl(modelId);

  if (!apiKey) {
    setProviderRoutingStatus("Add your OpenRouter API key above to load provider endpoints.", true);
    return [];
  }
  if (!url) {
    setProviderRoutingStatus("Pick an OpenRouter model before loading providers.", true);
    return [];
  }

  openRouterEndpointsLoading = true;
  renderProviderRoutingSettings();
  setProviderRoutingStatus("Loading provider endpoints from OpenRouter...");

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/scrapeflow",
        "X-Title": "ScrapeFlow Chat"
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to load providers (${response.status}): ${errText}`);
    }

    const data = await response.json();
    openRouterEndpoints = (data.data?.endpoints || [])
      .filter(endpoint => endpointSlug(endpoint))
      .sort((a, b) => (a.provider_name || a.name || endpointSlug(a)).localeCompare(b.provider_name || b.name || endpointSlug(b)));
    settings.providerRouting.order = settings.providerRouting.order.filter(slug =>
      openRouterEndpoints.some(endpoint => endpointSlug(endpoint) === slug)
    );
    setProviderRoutingStatus(`${openRouterEndpoints.length} providers loaded for ${modelId}.`);
    return openRouterEndpoints;
  } catch (err) {
    console.error("Provider endpoint fetch error:", err);
    setProviderRoutingStatus(err.message, true);
    return [];
  } finally {
    openRouterEndpointsLoading = false;
    renderProviderRoutingSettings();
  }
}

function initProviderRoutingSettings() {
  const enabledInput = document.getElementById("provider-routing-enabled");
  const modeInput = document.getElementById("provider-routing-mode");
  const fallbackInput = document.getElementById("provider-allow-fallbacks");
  const refreshBtn = document.getElementById("refresh-providers-btn");

  [enabledInput, modeInput, fallbackInput].forEach(el => {
    el?.addEventListener("change", () => {
      settings.providerRouting = collectProviderRoutingFromUI();
      renderProviderRoutingSettings();
    });
  });

  refreshBtn?.addEventListener("click", async () => {
    await fetchOpenRouterEndpoints();
  });

  renderProviderRoutingSettings();
}

// ----------------------------------------------------
// MCP SERVER SUPPORT
// ----------------------------------------------------
function createMcpServerId() {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mcpToolName(serverId, toolName) {
  return `mcp__${serverId}__${toolName}`;
}

function parseMcpToolName(fullName) {
  if (!String(fullName || "").startsWith("mcp__")) return null;
  const parts = fullName.slice(5).split("__");
  if (parts.length < 2) return null;
  return { serverId: parts[0], toolName: parts.slice(1).join("__") };
}

function renderMcpServersList() {
  const list = document.getElementById("mcp-servers-list");
  if (!list) return;

  list.innerHTML = "";
  const servers = settings.mcpServers.length ? settings.mcpServers : [];

  if (servers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mcp-status";
    empty.textContent = "No MCP servers configured.";
    list.appendChild(empty);
    return;
  }

  servers.forEach(server => {
    list.appendChild(createMcpServerCard(server));
  });
}

function createMcpServerCard(server) {
  const card = document.createElement("div");
  card.className = "mcp-server-card";
  card.dataset.serverId = server.id;

  card.innerHTML = `
    <div class="mcp-server-row">
      <input type="text" class="mcp-name-input" placeholder="Server name" value="${escapeHtml(server.name || "")}">
      <label><input type="checkbox" class="mcp-enabled-input" ${server.enabled !== false ? "checked" : ""}> Enabled</label>
      <button type="button" class="mcp-remove-btn">Remove</button>
    </div>
    <div class="mcp-server-row">
      <input type="url" class="mcp-url-input" placeholder="https://example.com/mcp" value="${escapeHtml(server.url || "")}">
    </div>
    <div class="mcp-status mcp-test-status"></div>
  `;

  card.querySelector(".mcp-remove-btn").addEventListener("click", () => {
    settings.mcpServers = settings.mcpServers.filter(s => s.id !== server.id);
    renderMcpServersList();
  });

  card.querySelector(".mcp-url-input").addEventListener("blur", () => {
    testMcpServerConnection(server.id, card);
  });

  return card;
}

function collectMcpServersFromUI() {
  const list = document.getElementById("mcp-servers-list");
  if (!list) return settings.mcpServers;

  return Array.from(list.querySelectorAll(".mcp-server-card")).map(card => ({
    id: card.dataset.serverId,
    name: card.querySelector(".mcp-name-input")?.value.trim() || "MCP Server",
    url: card.querySelector(".mcp-url-input")?.value.trim() || "",
    enabled: card.querySelector(".mcp-enabled-input")?.checked !== false
  }));
}

function initMcpSettings() {
  const addBtn = document.getElementById("add-mcp-server-btn");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => {
    settings.mcpServers.push({
      id: createMcpServerId(),
      name: "MCP Server",
      url: "",
      enabled: true
    });
    renderMcpServersList();
  });
}

function normalizeMcpBridgeSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    port: Number(value.port) || 9229,
    token: String(value.token || "")
  };
}

function buildMcpBridgeConfigSnippet(config) {
  const payload = {
    mcpServers: {
      scrapeflow: {
        command: "node",
        args: ["ABSOLUTE_PATH_TO_EXTENSION/mcp-server/index.js"],
        env: {
          SCRAPEFLOW_MCP_PORT: String(config.port || 9229),
          ...(config.token ? { SCRAPEFLOW_MCP_TOKEN: config.token } : {})
        }
      }
    }
  };
  return JSON.stringify(payload, null, 2);
}

async function renderMcpBridgeSettings() {
  const enabledInput = document.getElementById("mcp-bridge-enabled");
  const portInput = document.getElementById("mcp-bridge-port");
  const tokenInput = document.getElementById("mcp-bridge-token");
  const snippetEl = document.getElementById("mcp-bridge-config-snippet");

  try {
    const response = await chrome.runtime.sendMessage({ type: "mcp-bridge/get-status" });
    if (response?.config) {
      settings.mcpBridge = normalizeMcpBridgeSettings({
        ...settings.mcpBridge,
        ...response.config,
        token: settings.mcpBridge.token || response.config.token || ""
      });
    }
  } catch {
    // Background may be unavailable during startup.
  }

  if (enabledInput) enabledInput.checked = settings.mcpBridge.enabled === true;
  if (portInput) portInput.value = String(settings.mcpBridge.port || 9229);
  if (tokenInput) tokenInput.value = settings.mcpBridge.token || "";
  if (snippetEl) snippetEl.textContent = buildMcpBridgeConfigSnippet(settings.mcpBridge);

  refreshMcpBridgeStatus();
}

function collectMcpBridgeFromUI() {
  const enabledInput = document.getElementById("mcp-bridge-enabled");
  const portInput = document.getElementById("mcp-bridge-port");
  const tokenInput = document.getElementById("mcp-bridge-token");

  return normalizeMcpBridgeSettings({
    enabled: enabledInput ? enabledInput.checked : settings.mcpBridge.enabled,
    port: portInput ? Number(portInput.value) : settings.mcpBridge.port,
    token: tokenInput ? tokenInput.value.trim() : settings.mcpBridge.token
  });
}

function normalizeTempEmailSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: value.enabled === true,
    apiUrl: typeof value.apiUrl === "string" ? value.apiUrl.trim() : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : ""
  };
}

function renderTempEmailSettings() {
  const enabledInput = document.getElementById("temp-email-enabled");
  const urlInput = document.getElementById("temp-email-api-url");
  const keyInput = document.getElementById("temp-email-api-key");
  const badge = document.getElementById("temp-email-status-badge");

  if (enabledInput) enabledInput.checked = settings.tempEmail.enabled === true;
  if (urlInput) urlInput.value = settings.tempEmail.apiUrl || "";
  if (keyInput) keyInput.value = settings.tempEmail.apiKey || "";

  if (badge) {
    if (!settings.tempEmail.enabled) {
      badge.textContent = "Off";
      badge.className = "mcp-bridge-badge";
    } else if (!settings.tempEmail.apiUrl || !settings.tempEmail.apiKey) {
      badge.textContent = "Missing config";
      badge.className = "mcp-bridge-badge error";
    } else {
      badge.textContent = "Enabled";
      badge.className = "mcp-bridge-badge connected";
    }
  }
}

function collectTempEmailFromUI() {
  const enabledInput = document.getElementById("temp-email-enabled");
  const urlInput = document.getElementById("temp-email-api-url");
  const keyInput = document.getElementById("temp-email-api-key");

  return normalizeTempEmailSettings({
    enabled: enabledInput ? enabledInput.checked : settings.tempEmail.enabled,
    apiUrl: urlInput ? urlInput.value : settings.tempEmail.apiUrl,
    apiKey: keyInput ? keyInput.value : settings.tempEmail.apiKey
  });
}

function normalizeNetworkCaptureSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    autoCaptureLatchedTab: value.autoCaptureLatchedTab === true,
    persistSessionLogs: value.persistSessionLogs !== false,
    captureResponseBodies: value.captureResponseBodies !== false,
    redactSensitiveData: value.redactSensitiveData !== false
  };
}

function renderNetworkCaptureSettings() {
  const autoInput = document.getElementById("network-auto-capture-latched");
  const persistInput = document.getElementById("network-persist-session");
  const bodiesInput = document.getElementById("network-capture-bodies");
  const redactInput = document.getElementById("network-redact-sensitive");
  const badge = document.getElementById("network-capture-status-badge");

  const capture = normalizeNetworkCaptureSettings(settings.networkCapture);
  if (autoInput) autoInput.checked = capture.autoCaptureLatchedTab === true;
  if (persistInput) persistInput.checked = capture.persistSessionLogs === true;
  if (bodiesInput) bodiesInput.checked = capture.captureResponseBodies === true;
  if (redactInput) redactInput.checked = capture.redactSensitiveData === true;

  if (badge) {
    badge.textContent = capture.autoCaptureLatchedTab ? "Latched tab" : "Manual";
    badge.className = capture.autoCaptureLatchedTab ? "mcp-bridge-badge connected" : "mcp-bridge-badge";
  }
}

function collectNetworkCaptureFromUI() {
  const autoInput = document.getElementById("network-auto-capture-latched");
  const persistInput = document.getElementById("network-persist-session");
  const bodiesInput = document.getElementById("network-capture-bodies");
  const redactInput = document.getElementById("network-redact-sensitive");

  return normalizeNetworkCaptureSettings({
    autoCaptureLatchedTab: autoInput ? autoInput.checked : settings.networkCapture.autoCaptureLatchedTab,
    persistSessionLogs: persistInput ? persistInput.checked : settings.networkCapture.persistSessionLogs,
    captureResponseBodies: bodiesInput ? bodiesInput.checked : settings.networkCapture.captureResponseBodies,
    redactSensitiveData: redactInput ? redactInput.checked : settings.networkCapture.redactSensitiveData
  });
}

function normalizeAuthDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/^www\./, "")
      .trim();
  }
}

function normalizeAuthManualKey(value) {
  return String(value || "")
    .replace(/^otpauth:\/\/totp\/[^?]+\?/i, "")
    .replace(/.*(?:^|[?&])secret=([^&]+).*/i, "$1")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function normalizeAuthManualKeys(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return Object.entries(source).reduce((acc, [domain, key]) => {
    const normalizedDomain = normalizeAuthDomain(domain);
    const normalizedKey = normalizeAuthManualKey(key);
    if (normalizedDomain && normalizedKey) acc[normalizedDomain] = normalizedKey;
    return acc;
  }, {});
}

async function getCurrentTabDomain() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "page-tool", name: "get_active_tab", arguments: {} });
    const payload = typeof response?.result === "string" ? JSON.parse(response.result) : response?.result;
    return normalizeAuthDomain(payload?.url || "");
  } catch {
    return "";
  }
}

function createAuthManualKeyRow(domain = "", manualKey = "") {
  const row = document.createElement("div");
  row.className = "auth-key-row";
  row.innerHTML = `
    <input type="text" class="auth-domain-input" placeholder="example.com" value="${escapeHtml(domain)}" autocomplete="off">
    <input type="password" class="auth-secret-input" placeholder="manual key" value="${escapeHtml(manualKey)}" autocomplete="off">
    <button type="button" class="mcp-remove-btn auth-remove-btn">Remove</button>
  `;
  row.querySelector(".auth-remove-btn")?.addEventListener("click", () => row.remove());
  return row;
}

function renderAuthManualKeys() {
  const list = document.getElementById("auth-manual-keys-list");
  const badge = document.getElementById("auth-manual-keys-badge");
  if (!list) return;

  const entries = Object.entries(normalizeAuthManualKeys(settings.authManualKeys))
    .sort(([a], [b]) => a.localeCompare(b));
  list.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mcp-status";
    empty.textContent = "No authenticator manual keys saved.";
    list.appendChild(empty);
  } else {
    entries.forEach(([domain, manualKey]) => {
      list.appendChild(createAuthManualKeyRow(domain, manualKey));
    });
  }

  if (badge) {
    badge.textContent = entries.length === 0 ? "None" : `${entries.length} saved`;
    badge.className = entries.length === 0 ? "mcp-bridge-badge" : "mcp-bridge-badge connected";
  }
}

function collectAuthManualKeysFromUI() {
  const list = document.getElementById("auth-manual-keys-list");
  if (!list) return normalizeAuthManualKeys(settings.authManualKeys);

  const keys = {};
  list.querySelectorAll(".auth-key-row").forEach((row) => {
    const domain = normalizeAuthDomain(row.querySelector(".auth-domain-input")?.value);
    const manualKey = normalizeAuthManualKey(row.querySelector(".auth-secret-input")?.value);
    if (domain && manualKey) keys[domain] = manualKey;
  });
  return keys;
}

function addAuthManualKeyRow(domain = "", manualKey = "") {
  const list = document.getElementById("auth-manual-keys-list");
  if (!list) return;
  if (!list.querySelector(".auth-key-row")) list.innerHTML = "";
  list.appendChild(createAuthManualKeyRow(domain, manualKey));
}

function initAuthManualKeySettings() {
  const addCurrentBtn = document.getElementById("add-current-domain-auth-key-btn");
  const addComboBtn = document.getElementById("add-auth-combo-btn");
  const comboInput = document.getElementById("auth-domain-key-combo");

  addCurrentBtn?.addEventListener("click", async () => {
    const domain = await getCurrentTabDomain();
    if (!domain) {
      showToast("No active website domain found");
      return;
    }
    addAuthManualKeyRow(domain, "");
    showToast(`Added ${domain}`);
  });

  addComboBtn?.addEventListener("click", () => {
    const value = comboInput?.value || "";
    const parts = value.split(/\s*:\s*/);
    if (parts.length < 2) {
      showToast("Use domain : manual key");
      return;
    }
    const domain = normalizeAuthDomain(parts.shift());
    const manualKey = normalizeAuthManualKey(parts.join(":"));
    if (!domain || !manualKey) {
      showToast("Domain and manual key are required");
      return;
    }
    addAuthManualKeyRow(domain, manualKey);
    if (comboInput) comboInput.value = "";
    showToast(`Added ${domain}`);
  });
}

async function refreshMcpBridgeStatus() {
  const badge = document.getElementById("mcp-bridge-status-badge");
  if (!badge) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: "mcp-bridge/get-status" });
    const enabled = response?.config?.enabled === true;
    const connected = response?.status?.connected === true;

    if (!enabled) {
      badge.textContent = "Disabled";
      badge.className = "mcp-bridge-badge";
      return;
    }

    if (connected) {
      badge.textContent = "Bridge connected";
      badge.className = "mcp-bridge-badge connected";
      return;
    }

    badge.textContent = response?.status?.lastError
      ? `Waiting (${response.status.lastError})`
      : "Waiting for MCP server";
    badge.className = "mcp-bridge-badge pending";
  } catch (err) {
    badge.textContent = "Status unavailable";
    badge.className = "mcp-bridge-badge error";
  }
}

function initMcpBridgeSettings() {
  const enabledInput = document.getElementById("mcp-bridge-enabled");
  const portInput = document.getElementById("mcp-bridge-port");
  const tokenInput = document.getElementById("mcp-bridge-token");
  const copyTokenBtn = document.getElementById("copy-mcp-bridge-token-btn");
  const regenTokenBtn = document.getElementById("regenerate-mcp-bridge-token-btn");
  const copyConfigBtn = document.getElementById("copy-mcp-bridge-config-btn");

  const updateSnippet = () => {
    const snippetEl = document.getElementById("mcp-bridge-config-snippet");
    if (snippetEl) {
      snippetEl.textContent = buildMcpBridgeConfigSnippet(collectMcpBridgeFromUI());
    }
  };

  [enabledInput, portInput, tokenInput].forEach(el => {
    el?.addEventListener("input", updateSnippet);
    el?.addEventListener("change", updateSnippet);
  });

  copyTokenBtn?.addEventListener("click", async () => {
    const token = tokenInput?.value || "";
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      showToast("Auth token copied");
    } catch {
      showToast("Could not copy token");
    }
  });

  regenTokenBtn?.addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "mcp-bridge/regenerate-token" });
      if (response?.token && tokenInput) {
        tokenInput.value = response.token;
        settings.mcpBridge.token = response.token;
        updateSnippet();
        showToast("New auth token generated");
      }
    } catch (err) {
      showToast("Could not regenerate token");
    }
  });

  copyConfigBtn?.addEventListener("click", async () => {
    const snippet = buildMcpBridgeConfigSnippet(collectMcpBridgeFromUI());
    try {
      await navigator.clipboard.writeText(snippet);
      showToast("MCP config copied");
    } catch {
      showToast("Could not copy config");
    }
  });

  renderMcpBridgeSettings();
  setInterval(refreshMcpBridgeStatus, 4000);
}

async function mcpJsonRpcRequest(url, method, params = {}, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  const newSessionId = response.headers.get("Mcp-Session-Id") || sessionId;
  const raw = await response.text();

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    const dataLine = raw.split("\n").find(line => line.startsWith("data: "));
    if (dataLine) {
      payload = JSON.parse(dataLine.slice(6));
    } else {
      throw new Error("Invalid MCP response format");
    }
  }

  if (payload.error) {
    throw new Error(payload.error.message || "MCP request failed");
  }

  return { result: payload.result, sessionId: newSessionId };
}

async function connectMcpServer(server) {
  if (!server.url) throw new Error("Missing MCP server URL");

  let sessionId = null;
  const init = await mcpJsonRpcRequest(server.url, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ScrapeFlow", version: "1.0.0" }
  }, sessionId);
  sessionId = init.sessionId;

  await fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })
  }).catch(() => {});

  const toolsResp = await mcpJsonRpcRequest(server.url, "tools/list", {}, sessionId);
  return {
    sessionId,
    tools: toolsResp.result?.tools || []
  };
}

async function callMcpTool(server, sessionId, toolName, args) {
  const resp = await mcpJsonRpcRequest(server.url, "tools/call", {
    name: toolName,
    arguments: args || {}
  }, sessionId);
  return resp.result;
}

async function testMcpServerConnection(serverId, cardEl) {
  const statusEl = cardEl?.querySelector(".mcp-test-status");
  const url = cardEl?.querySelector(".mcp-url-input")?.value.trim();
  if (!statusEl) return;

  if (!url) {
    statusEl.textContent = "";
    statusEl.className = "mcp-status mcp-test-status";
    return;
  }

  statusEl.textContent = "Testing connection...";
  statusEl.className = "mcp-status mcp-test-status";

  try {
    const connection = await connectMcpServer({ url });
    statusEl.textContent = `Connected · ${connection.tools.length} tool(s)`;
    statusEl.className = "mcp-status mcp-test-status connected";
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = "mcp-status mcp-test-status error";
  }
}

const mcpConnections = new Map(); // serverId -> { sessionId, tools, server }

async function refreshMcpTools() {
  mcpToolRegistry.clear();
  mcpConnections.clear();

  const enabledServers = settings.mcpServers.filter(s => s.enabled !== false && s.url);
  for (const server of enabledServers) {
    try {
      const connection = await connectMcpServer(server);
      mcpConnections.set(server.id, { ...connection, server });
      connection.tools.forEach(tool => {
        const fullName = mcpToolName(server.id, tool.name);
        mcpToolRegistry.set(fullName, {
          serverId: server.id,
          serverName: server.name || "MCP Server",
          originalName: tool.name,
          schema: tool
        });
      });
    } catch (err) {
      console.warn(`MCP server "${server.name}" failed:`, err);
    }
  }
}

function getMcpToolSchemas() {
  const schemas = [];
  mcpToolRegistry.forEach((entry, fullName) => {
    const tool = entry.schema;
    schemas.push({
      type: "function",
      function: {
        name: fullName,
        description: `[MCP: ${entry.serverName}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} }
      }
    });
  });
  return schemas;
}

function getAllAgentTools() {
  return [...BROWSER_TOOLS, ...WORKSPACE_TOOLS, ...getMcpToolSchemas()];
}

function inferLanguageFromPath(path, fallback = "text") {
  const ext = String(path || "").split(".").pop()?.toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    json: "json", html: "html", css: "css", sh: "shell",
    md: "markdown", yaml: "yaml", yml: "yaml", sql: "sql"
  };
  return map[ext] || fallback;
}

function getActiveChatFiles() {
  const chat = chats[currentChatId];
  if (!chat) return {};
  if (!chat.files) chat.files = {};
  return chat.files;
}

async function executeWorkspaceTool(name, args = {}) {
  const files = getActiveChatFiles();

  switch (name) {
    case "write_file": {
      if (!args.path || !args.content) {
        return "Error: write_file requires path and content.";
      }
      const path = String(args.path).trim();
      const existing = getWorkspaceFile(path);
      const language = args.language || inferLanguageFromPath(path);
      const tags = Array.isArray(args.tags)
        ? args.tags.map(String).filter(Boolean)
        : (existing?.tags || []);
      const record = {
        path,
        content: String(args.content),
        language,
        description: args.description ? String(args.description) : (existing?.description || ""),
        tags,
        updatedAt: Date.now(),
        chatId: currentChatId
      };
      files[path] = record;
      syncChatFileToGlobal(path, record);
      await saveChats();
      await saveGlobalWorkspace();
      const lines = String(args.content).split("\n").length;
      return {
        type: "file",
        action: existing ? "updated" : "created",
        path,
        language,
        lines,
        description: record.description,
        message: `Saved ${path} (${lines} lines).`
      };
    }

    case "read_file": {
      const path = String(args.path || "").trim();
      const file = getWorkspaceFile(path);
      if (!file) {
        return `Error: File "${path}" not found in workspace. Use list_files or search_files to find available files.`;
      }
      return file.content;
    }

    case "read_context_item": {
      const contextItemId = String(args.context_item_id || "").trim();
      if (!contextItemId) return "Error: read_context_item requires context_item_id.";
      const item = getContextItem(contextItemId);
      if (!item) {
        return `Error: Context item "${contextItemId}" was not found in the current chat.`;
      }
      return item.content || "";
    }

    case "list_files": {
      const allFiles = Object.values(getAllWorkspaceFiles());
      const tagFilter = args.tag ? String(args.tag).trim().toLowerCase() : "";
      const entries = allFiles.filter((file) => {
        if (!tagFilter) return true;
        return Array.isArray(file.tags) && file.tags.some((tag) => String(tag).toLowerCase() === tagFilter);
      });
      if (entries.length === 0) {
        return tagFilter
          ? `No files found with tag "${args.tag}".`
          : "Workspace is empty — no files saved yet.";
      }
      return entries
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(formatFileListing)
        .join("\n");
    }

    case "search_files": {
      const query = String(args.query || "").trim().toLowerCase();
      if (!query) return "Error: search_files requires query.";
      const searchIn = args.search_in || "all";
      const limit = Math.min(Number(args.limit) || 20, 50);
      const matches = Object.values(getAllWorkspaceFiles()).filter((file) => {
        const pathMatch = file.path.toLowerCase().includes(query);
        const descMatch = String(file.description || "").toLowerCase().includes(query);
        const contentMatch = file.content.toLowerCase().includes(query);
        const tagMatch = Array.isArray(file.tags) && file.tags.some((tag) => String(tag).toLowerCase().includes(query));
        if (searchIn === "path") return pathMatch;
        if (searchIn === "description") return descMatch;
        if (searchIn === "content") return contentMatch;
        if (searchIn === "tags") return tagMatch;
        return pathMatch || descMatch || contentMatch || tagMatch;
      });
      if (matches.length === 0) return `No files matched "${args.query}".`;
      return matches
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit)
        .map(formatFileListing)
        .join("\n");
    }

    case "get_file_info": {
      const path = String(args.path || "").trim();
      const file = getWorkspaceFile(path);
      if (!file) return `Error: File "${path}" not found in workspace.`;
      return JSON.stringify({
        path: file.path,
        language: file.language,
        lines: file.content.split("\n").length,
        description: file.description || "",
        tags: file.tags || [],
        updatedAt: file.updatedAt || null,
        chatId: file.chatId || null
      }, null, 2);
    }

    case "rename_file": {
      const oldPath = String(args.old_path || "").trim();
      const newPath = String(args.new_path || "").trim();
      if (!oldPath || !newPath) return "Error: rename_file requires old_path and new_path.";
      const file = getWorkspaceFile(oldPath);
      if (!file) return `Error: File "${oldPath}" not found in workspace.`;
      if (getWorkspaceFile(newPath) && newPath !== oldPath) {
        return `Error: Destination path "${newPath}" already exists.`;
      }
      const renamed = { ...file, path: newPath, updatedAt: Date.now() };
      delete files[oldPath];
      files[newPath] = renamed;
      removeGlobalFile(oldPath);
      syncChatFileToGlobal(newPath, renamed);
      await saveChats();
      await saveGlobalWorkspace();
      return `Renamed ${oldPath} -> ${newPath}.`;
    }

    case "delete_file": {
      const path = String(args.path || "").trim();
      const file = getWorkspaceFile(path);
      if (!file) return `Error: File "${path}" not found in workspace.`;
      delete files[path];
      removeGlobalFile(path);
      await saveChats();
      await saveGlobalWorkspace();
      return `Deleted ${path}.`;
    }

    default:
      return `Error: Unknown workspace tool "${name}"`;
  }
}

async function executePageToolViaBackground(name, args = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "page-tool", name, arguments: args }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(`Error: ${chrome.runtime.lastError.message}`);
        return;
      }
      resolve(response?.result ?? "Error: No response from background service worker.");
    });
  });
}

async function executeMcpTool(fullName, args) {
  const entry = mcpToolRegistry.get(fullName);
  if (!entry) return `Error: Unknown MCP tool "${fullName}"`;

  const connection = mcpConnections.get(entry.serverId);
  if (!connection) {
    await refreshMcpTools();
  }
  const activeConnection = mcpConnections.get(entry.serverId);
  if (!activeConnection) {
    return `Error: MCP server for tool "${entry.originalName}" is not connected.`;
  }

  try {
    const result = await callMcpTool(
      activeConnection.server,
      activeConnection.sessionId,
      entry.originalName,
      args
    );

    if (result?.content) {
      return result.content.map(item => {
        if (item.type === "text") return item.text;
        if (item.type === "image") return `[image: ${item.mimeType || "image"}]`;
        return JSON.stringify(item);
      }).join("\n");
    }

    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return `Error executing MCP tool "${entry.originalName}": ${err.message}`;
  }
}

async function executeTool(name, args = {}) {
  if (parseMcpToolName(name)) {
    return executeMcpTool(name, args);
  }
  if (WORKSPACE_TOOL_NAMES.has(name)) {
    return executeWorkspaceTool(name, args);
  }
  return executePageToolViaBackground(name, args);
}

// ----------------------------------------------------
// CHAT LAYOUTS & EVENT HANDLERS
// ----------------------------------------------------
function initChatEvents() {
  const sendBtn = document.getElementById("send-btn");
  const chatTextarea = document.getElementById("chat-textarea");
  const headerNewChatBtn = document.getElementById("header-new-chat-btn");
  const headerClearChatBtn = document.getElementById("header-clear-chat-btn");

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      if (isAgentRunning) {
        stopAgent();
      } else {
        handleSendMessage();
      }
    });
  }

  if (headerNewChatBtn) {
    headerNewChatBtn.addEventListener("click", () => {
      createNewChatSession();
      showToast("Started new chat session");
    });
  }

  if (headerClearChatBtn) {
    headerClearChatBtn.addEventListener("click", async () => {
      if (currentChatId && chats[currentChatId]) {
        if (confirm("Are you sure you want to clear this chat's messages?")) {
          chats[currentChatId].messages = [];
          chats[currentChatId].title = "New Chat";
          await saveChats();
          renderChatHistory();
          renderHistoryList();
          showToast("Chat cleared");
        }
      }
    });
  }

  if (chatTextarea) {
    chatTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isAgentRunning) return;
        handleSendMessage();
      }
    });

    chatTextarea.addEventListener("input", () => {
      chatTextarea.style.height = "auto";
      chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 120) + "px";
      
      if (sendBtn) {
        if (chatTextarea.value.trim() || uploadedImages.length > 0) {
          sendBtn.classList.add("active");
        } else {
          sendBtn.classList.remove("active");
        }
      }
    });
  }
}

// ----------------------------------------------------
// LATCH TO TAB
// ----------------------------------------------------
// "Latched" means every browser tool (get_dom, click, screenshot, run_js, etc.)
// operates on a fixed tabId instead of whatever happens to be in focus. This
// lets the user keep working on a scraper for one page while clicking around
// in other tabs to look things up.
function initLatchTab() {
  const latchBtn = document.getElementById("latch-tab-btn");
  const unlatchBtn = document.getElementById("unlatch-tab-btn");
  const focusBtn = document.getElementById("focus-latched-tab-btn");

  if (latchBtn) {
    latchBtn.addEventListener("click", async () => {
      const existing = await getLatchedTab();
      if (existing) {
        await chrome.runtime.sendMessage({ type: "latch-tab/clear" });
        showToast("Unlatched");
      } else {
        const res = await chrome.runtime.sendMessage({ type: "latch-tab/set" });
        if (res?.ok && res.tab) {
          const label = res.tab.title || res.tab.url || "tab";
          showToast(`Latched to ${label.slice(0, 40)}`);
        } else {
          showToast("Failed to latch: " + (res?.error || "no active tab"));
        }
      }
      await renderLatchedTab();
    });
  }

  if (unlatchBtn) {
    unlatchBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "latch-tab/clear" });
      showToast("Unlatched");
      await renderLatchedTab();
    });
  }

  if (focusBtn) {
    focusBtn.addEventListener("click", async () => {
      const tab = await getLatchedTab();
      if (!tab) return;
      try {
        await chrome.tabs.update(tab.tabId, { active: true });
        if (typeof tab.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch (e) {
        showToast("Could not focus tab (it may be closed)");
        await chrome.runtime.sendMessage({ type: "latch-tab/clear" });
        await renderLatchedTab();
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && changes.latchedTab) {
      renderLatchedTab();
    }
  });

  renderLatchedTab();
}

async function getLatchedTab() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "latch-tab/get" });
    return res?.tab || null;
  } catch {
    return null;
  }
}

async function renderLatchedTab() {
  const latchBtn = document.getElementById("latch-tab-btn");
  const latchedBar = document.getElementById("latched-tab-bar");
  const latchedText = document.getElementById("latched-tab-text");

  const tab = await getLatchedTab();

  if (tab) {
    if (latchBtn) {
      latchBtn.classList.add("latched");
      latchBtn.title = `Latched to: ${tab.title || tab.url}. Click to unlatch.`;
    }
    if (latchedBar) latchedBar.classList.remove("hidden");
    if (latchedText) {
      let host = "";
      try { host = new URL(tab.url).host; } catch { host = ""; }
      const title = (tab.title || "").trim();
      latchedText.textContent = title
        ? (host ? `${title} — ${host}` : title)
        : (host || tab.url || "Tab");
      latchedText.title = tab.url || title;
    }
  } else {
    if (latchBtn) {
      latchBtn.classList.remove("latched");
      latchBtn.title = "Latch extension to current tab";
    }
    if (latchedBar) latchedBar.classList.add("hidden");
  }
}

// Render Chat history logs
function renderChatHistory() {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  chatHistory.innerHTML = `
    <div class="message system-msg">
      <div class="message-content">
        <p><strong>ScrapeFlow is ready.</strong></p>
        <p>Add your OpenRouter key in settings, then ask for scraper scripts, page inspection, or browser actions.</p>
        <p>Files appear as cards you can open and copy. Browser tool calls collapse into a single "Activity" trace — click to expand.</p>
      </div>
    </div>
  `;

  const activeChat = chats[currentChatId];
  if (activeChat && activeChat.messages) {
    activeChat.messages.forEach((msg, index) => {
      if (msg.role === "user" || msg.role === "assistant") {
        appendMessageUI(msg.role, msg.content, msg.images || [], false, { messageIndex: index });
      } else if (msg.role === "tool-status") {
        appendMessageUI("tool-status", msg.content, [], false);
      } else if (msg.role === "file-artifact") {
        appendMessageUI("file-artifact", msg.content, [], false);
      }
    });
  }

  renderWorkspaceStrip();
  updateUsageBar();
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function appendMessageUI(role, content, images = [], shouldScroll = true, options = {}) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  // Tool calls flow into a single collapsible "Activity" group so they don't
  // dominate the conversation. Consecutive tool-status messages append into
  // the existing group; any other message type breaks the run.
  if (role === "tool-status") {
    const group = ensureActivityGroup(chatHistory);
    const body = group.querySelector(".activity-group-body");
    body.appendChild(renderToolStatus(content));
    updateActivityCount(group);
    if (shouldScroll) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
      updateUsageBar();
    }
    return;
  }

  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;
  if (Number.isInteger(options.messageIndex)) {
    msgDiv.dataset.messageIndex = String(options.messageIndex);
  }

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  if (role === "file-artifact") {
    msgDiv.className = "message file-artifact-msg";
    msgDiv.appendChild(renderFileArtifact(content));
    chatHistory.appendChild(msgDiv);
    if (shouldScroll) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
      updateUsageBar();
    }
    return;
  }

  // Images
  if (images && images.length > 0) {
    const imgContainer = document.createElement("div");
    imgContainer.className = "msg-images-container";
    images.forEach(imgDataUrl => {
      const img = document.createElement("img");
      img.className = "msg-attached-img";
      img.src = imgDataUrl;
      imgContainer.appendChild(img);
    });
    contentDiv.appendChild(imgContainer);
  }
  
  // Text
  const textParagraph = document.createElement("div");
  textParagraph.className = "markdown message-text";
  textParagraph.innerHTML = formatMarkdown(content);
  contentDiv.appendChild(textParagraph);
  
  msgDiv.appendChild(contentDiv);
  
  const metaDiv = document.createElement("div");
  metaDiv.className = "message-meta";
  const metaLabel = document.createElement("span");
  metaLabel.className = "message-meta-label";
  metaLabel.textContent = getMessageMetaLabel(role, options.messageIndex);
  metaDiv.appendChild(metaLabel);

  if (canEditStoredMessage(role, options.messageIndex)) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "message-edit-btn";
    editBtn.title = "Edit message";
    editBtn.setAttribute("aria-label", "Edit message");
    editBtn.innerHTML = EDIT_ICON;
    editBtn.addEventListener("click", () => startMessageEdit(msgDiv, options.messageIndex));
    metaDiv.appendChild(editBtn);
  }
  msgDiv.appendChild(metaDiv);
  
  chatHistory.appendChild(msgDiv);
  
  bindCopyButtons(contentDiv);

  if (shouldScroll) {
    chatHistory.scrollTop = chatHistory.scrollHeight;
    updateUsageBar();
  }
}

function getMessageMetaLabel(role, messageIndex) {
  const fallback = role === "user" ? "You" : "ScrapeFlow";
  const msg = getStoredMessage(messageIndex);
  if (!msg?.editedAt) return fallback;
  return `${fallback} - edited`;
}

function getStoredMessage(messageIndex) {
  if (!Number.isInteger(messageIndex) || !currentChatId || !chats[currentChatId]) return null;
  const messages = chats[currentChatId].messages;
  if (!Array.isArray(messages) || messageIndex < 0 || messageIndex >= messages.length) return null;
  return messages[messageIndex] || null;
}

function canEditStoredMessage(role, messageIndex) {
  if (isAgentRunning) return false;
  const msg = getStoredMessage(messageIndex);
  if (!msg || msg.role !== role) return false;
  if (role === "user") return true;
  return role === "assistant" && !Array.isArray(msg.tool_calls);
}

function startMessageEdit(msgDiv, messageIndex) {
  const msg = getStoredMessage(messageIndex);
  if (!msg || !canEditStoredMessage(msg.role, messageIndex)) return;

  const contentDiv = msgDiv.querySelector(".message-content");
  const messageText = contentDiv?.querySelector(".message-text");
  const metaDiv = msgDiv.querySelector(".message-meta");
  if (!contentDiv || !messageText || !metaDiv) return;

  const originalText = msg.content || "";
  const editor = document.createElement("div");
  editor.className = "message-editor";
  editor.innerHTML = `
    <textarea class="message-edit-textarea" rows="3"></textarea>
    <div class="message-edit-actions">
      <button type="button" class="message-edit-action message-edit-save" title="Save edit" aria-label="Save edit">${CHECK_ICON}</button>
      <button type="button" class="message-edit-action" title="Cancel edit" aria-label="Cancel edit">${X_ICON}</button>
    </div>
  `;

  const textarea = editor.querySelector(".message-edit-textarea");
  const saveBtn = editor.querySelector(".message-edit-save");
  const cancelBtn = editor.querySelector(".message-edit-action:not(.message-edit-save)");

  textarea.value = originalText;
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";

  const finishCancel = () => {
    editor.replaceWith(messageText);
    metaDiv.classList.remove("editing");
  };

  messageText.replaceWith(editor);
  metaDiv.classList.add("editing");
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finishCancel();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      commitMessageEdit(messageIndex, textarea.value);
    }
  });

  saveBtn.addEventListener("click", () => commitMessageEdit(messageIndex, textarea.value));
  cancelBtn.addEventListener("click", finishCancel);
}

async function commitMessageEdit(messageIndex, nextContent) {
  const msg = getStoredMessage(messageIndex);
  if (!msg || !canEditStoredMessage(msg.role, messageIndex)) return;

  const trimmed = String(nextContent || "").trim();
  if (!trimmed && (!Array.isArray(msg.images) || msg.images.length === 0)) {
    showToast("Message cannot be empty");
    return;
  }

  const activeChat = chats[currentChatId];
  const originalRole = msg.role;
  const changed = (msg.content || "") !== trimmed;

  if (!changed) {
    renderChatHistory();
    return;
  }

  activeChat.messages[messageIndex] = {
    ...msg,
    content: trimmed,
    editedAt: Date.now()
  };
  activeChat.timestamp = Date.now();

  if (messageIndex === 0 && originalRole === "user") {
    activeChat.title = trimmed ? (trimmed.slice(0, 24) + (trimmed.length > 24 ? "..." : "")) : "Image Upload Chat";
  }

  if (originalRole === "user") {
    activeChat.messages = activeChat.messages.slice(0, messageIndex + 1);
  }

  await saveChats();
  renderChatHistory();
  renderHistoryList();

  if (originalRole !== "user") {
    showToast("Message edited");
    return;
  }
  if (!settings.apiKey) {
    showToast("Message edited. Add an API key to regenerate.");
    return;
  }

  showToast("Message edited. Regenerating...");
  beginAgentRun();
  try {
    await runAgentCycle();
  } finally {
    if (agentStopRequested) {
      await recordAgentStopped();
    }
    endAgentRun();
  }
}

function sanitizeToolDisplay(name, args, result) {
  if (name === "write_file") {
    const lineCount = args?.content ? String(args.content).split("\n").length : undefined;
    return {
      args: args ? { path: args.path, lines: lineCount } : undefined,
      result: result && typeof result === "object" && result.type === "file"
        ? { path: result.path, action: result.action, lines: result.lines }
        : result
    };
  }
  if (name === "read_file") {
    const summary = typeof result === "string"
      ? `${result.split("\n").length} lines loaded`
      : result;
    return {
      args: args ? { path: args.path } : undefined,
      result: summary
    };
  }
  if (name === "list_files" || name === "search_files") {
    return { args: args?.query || args?.tag ? args : undefined, result: typeof result === "string" ? result.slice(0, 800) : result };
  }
  if (name === "get_file_info" || name === "delete_file" || name === "rename_file") {
    return { args, result: typeof result === "string" ? result.slice(0, 500) : result };
  }
  if (name.startsWith("get_network") || name.startsWith("start_network") || name.startsWith("stop_network") || name === "clear_network_logs") {
    return {
      args: args && Object.keys(args).length > 0 ? args : undefined,
      result: typeof result === "string" ? result.slice(0, 3000) : result
    };
  }
  return { args, result };
}

function renderFileArtifact(artifact) {
  const file = getWorkspaceFile(artifact.path);
  const wrapper = document.createElement("div");
  wrapper.className = "message-content";

  if (!file) {
    wrapper.innerHTML = `<div class="file-artifact missing"><span class="file-name">${escapeHtml(artifact.path || "unknown")}</span><span class="file-meta">File no longer in workspace</span></div>`;
    return wrapper;
  }

  const lines = file.content.split("\n").length;
  const actionLabel = artifact.action === "updated" ? "Updated" : "Created";
  const actionClass = artifact.action === "updated" ? "updated" : "created";
  const codeId = `file-code-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const card = document.createElement("div");
  card.className = `file-artifact action-${actionClass}`;
  card.innerHTML = `
    <button type="button" class="file-artifact-header" aria-expanded="false">
      <span class="file-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </span>
      <span class="file-info">
        <span class="file-name">${escapeHtml(file.path)}</span>
        <span class="file-meta">
          <span class="file-action-tag ${actionClass}">${escapeHtml(actionLabel)}</span>
          <span class="file-meta-sep">·</span>
          <span>${escapeHtml(file.language)}</span>
          <span class="file-meta-sep">·</span>
          <span>${lines} lines</span>
          ${file.description ? `<span class="file-meta-sep">·</span><span class="file-desc">${escapeHtml(file.description)}</span>` : ""}
        </span>
      </span>
      <span class="file-actions">
        <button type="button" class="copy-file-btn">Copy</button>
        <span class="file-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </span>
    </button>
    <div class="file-artifact-body hidden">
      <pre><code id="${codeId}" class="language-${escapeHtml(file.language)}">${escapeHtml(file.content)}</code></pre>
    </div>
  `;

  bindFileArtifact(card, file);
  wrapper.appendChild(card);
  return wrapper;
}

function bindFileArtifact(card, file) {
  const header = card.querySelector(".file-artifact-header");
  const body = card.querySelector(".file-artifact-body");
  const copyBtn = card.querySelector(".copy-file-btn");

  if (header && body) {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".copy-file-btn")) return;
      const expanded = body.classList.toggle("hidden") === false;
      card.classList.toggle("expanded", expanded);
      header.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(file.content).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1300);
      });
    });
  }
}

function ensureActivityGroup(chatHistory) {
  const last = chatHistory.lastElementChild;
  if (last && last.classList.contains("tool-activity-group")) {
    return last;
  }

  const group = document.createElement("div");
  group.className = "message tool-activity-group";
  group.innerHTML = `
    <div class="activity-group-header">
      <span class="activity-group-title">
        <span class="activity-dot"></span>
        <span class="activity-count">1 step</span>
      </span>
      <button type="button" class="activity-expand-btn" aria-expanded="false">Show details</button>
    </div>
    <div class="activity-group-body"></div>
  `;

  const expandBtn = group.querySelector(".activity-expand-btn");
  expandBtn.addEventListener("click", () => {
    const allExpanded = !group.classList.contains("all-expanded");
    group.classList.toggle("all-expanded", allExpanded);
    expandBtn.textContent = allExpanded ? "Hide details" : "Show details";
    expandBtn.setAttribute("aria-expanded", allExpanded ? "true" : "false");
    group.querySelectorAll(".tool-card").forEach(card => {
      const body = card.querySelector(".tool-card-body");
      const summary = card.querySelector(".tool-card-summary");
      if (!body) return;
      body.classList.toggle("hidden", !allExpanded);
      card.classList.toggle("expanded", allExpanded);
      if (summary) summary.setAttribute("aria-expanded", allExpanded ? "true" : "false");
    });
  });

  chatHistory.appendChild(group);
  return group;
}

function updateActivityCount(group) {
  const count = group.querySelectorAll(".tool-card").length;
  const countEl = group.querySelector(".activity-count");
  if (countEl) countEl.textContent = count === 1 ? "1 step" : `${count} steps`;
}

function buildToolSummary(name, args, result, stage) {
  // Concise one-liner shown in the collapsed tool row. Tries to surface the
  // most relevant detail (path, URL, selector) so users get the gist without
  // expanding.
  if (stage === "call" && (result === undefined || result === null || result === "")) {
    if (name === "click_element") return args?.selector ? `→ ${args.selector}` : "clicking…";
    if (name === "navigate") return args?.url ? `→ ${args.url}` : "navigating…";
    if (name === "type_text") return args?.selector ? `into ${args.selector}` : "typing…";
    if (name === "run_js") return "running script";
    if (name === "get_dom") return "reading page";
    if (name === "take_screenshot") return "capturing screen";
    if (name === "scroll_page") return args?.direction ? `scroll ${args.direction}` : "scrolling";
    if (name === "read_file") return args?.path ? args.path : "reading file";
    if (name === "write_file") return args?.path ? args.path : "writing file";
    if (name === "list_files") return "listing workspace";
    if (name === "search_files") return args?.query ? `"${args.query}"` : "searching files";
    if (name === "get_active_tab" || name === "list_tabs") return "querying tabs";
    if (name && name.startsWith("start_network")) return "recording requests";
    if (name && name.startsWith("get_network")) return "inspecting requests";
    if (name && name.startsWith("mcp__")) return "calling";
    if (args && typeof args === "object") {
      const firstVal = Object.values(args)[0];
      if (typeof firstVal === "string") return firstVal.length > 60 ? firstVal.slice(0, 60) + "…" : firstVal;
    }
    return "running";
  }

  if (typeof result === "string") {
    const oneLine = result.replace(/\s+/g, " ").trim();
    if (!oneLine) return "done";
    return oneLine.length > 72 ? oneLine.slice(0, 72) + "…" : oneLine;
  }
  if (result && typeof result === "object") {
    if (typeof result.lines === "number") return `${result.lines} lines`;
    if (typeof result.path === "string") return result.path;
    if (Array.isArray(result)) return `${result.length} items`;
    const keys = Object.keys(result);
    if (keys.length) return keys.slice(0, 3).join(", ");
  }
  return "done";
}

function renderToolStatus(content) {
  const details = normalizeToolStatus(content);
  const sanitized = sanitizeToolDisplay(details.name, details.args, details.result);
  const stage = details.stage || "status";
  const safeName = escapeHtml(details.name || "browser_tool");

  const hasArgs = sanitized.args !== undefined && sanitized.args !== null
    && (typeof sanitized.args !== "object" || Object.keys(sanitized.args).length > 0);
  const hasResult = sanitized.result !== undefined && sanitized.result !== null && sanitized.result !== "";
  const argsText = hasArgs ? prettyPrint(sanitized.args) : "";
  const resultText = hasResult ? prettyPrint(sanitized.result) : "";
  const hasBody = !!(argsText || resultText);

  const summaryLine = buildToolSummary(details.name, sanitized.args, sanitized.result, stage);

  const card = document.createElement("div");
  card.className = `tool-card stage-${escapeHtml(stage)}${hasBody ? "" : " no-body"}`;
  card.innerHTML = `
    <button type="button" class="tool-card-summary" aria-expanded="false"${hasBody ? "" : " disabled"}>
      <span class="tool-status-dot" data-stage="${escapeHtml(stage)}" aria-hidden="true"></span>
      <span class="tool-name-compact">${safeName}</span>
      ${summaryLine ? `<span class="tool-summary-text">${escapeHtml(summaryLine)}</span>` : ""}
      ${hasBody ? `
        <span class="tool-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>` : ""}
    </button>
    ${hasBody ? `
      <div class="tool-card-body hidden">
        ${argsText ? `<div class="tool-field"><span class="tool-label">Arguments</span><pre class="tool-value">${escapeHtml(argsText)}</pre></div>` : ""}
        ${resultText ? `<div class="tool-field"><span class="tool-label">Result</span><pre class="tool-value">${escapeHtml(resultText)}</pre></div>` : ""}
      </div>` : ""}
  `;

  const summary = card.querySelector(".tool-card-summary");
  const body = card.querySelector(".tool-card-body");
  if (summary && body) {
    summary.addEventListener("click", () => {
      const expanded = body.classList.toggle("hidden") === false;
      card.classList.toggle("expanded", expanded);
      summary.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  return card;
}

function normalizeToolStatus(content) {
  if (content && typeof content === "object") {
    return {
      stage: content.stage || "status",
      name: content.name || content.toolName || "browser_tool",
      args: content.args,
      result: content.result
    };
  }

  const text = String(content || "");
  const legacyCall = text.match(/Calling browser tool:\s*<strong>(.*?)<\/strong>/);
  if (legacyCall) {
    return { stage: "call", name: stripHtml(legacyCall[1]) };
  }

  if (text.startsWith("Result:")) {
    return { stage: "result", name: "browser_tool", result: text.replace(/^Result:\s*/, "") };
  }

  return { stage: "status", name: "browser_tool", result: stripHtml(text) };
}

function prettyPrint(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

function bindCopyButtons(scope) {
  scope.querySelectorAll(".copy-code-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute("data-copy-target");
      const codeBlock = targetId ? scope.querySelector(`#${CSS.escape(targetId)}`) : null;
      if (!codeBlock) return;

      navigator.clipboard.writeText(codeBlock.textContent).then(() => {
        btn.textContent = "Copied";
        setTimeout(() => btn.textContent = "Copy", 1300);
      });
    });
  });

  scope.querySelectorAll(".code-header-toggle").forEach(header => {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".copy-code-btn")) return;
      const container = header.closest(".code-container");
      const pre = container?.querySelector("pre");
      if (!container || !pre) return;
      container.classList.toggle("collapsed");
      pre.style.display = container.classList.contains("collapsed") ? "none" : "";
    });
  });
}

function formatMarkdown(text) {
  if (!text) return "";

  const source = String(text).replace(/\r\n/g, "\n");
  const codeBlocks = [];
  const tokenized = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const id = `code-${Date.now()}-${codeBlocks.length}`;
    codeBlocks.push({
      id,
      lang: (lang || "text").trim() || "text",
      code: code.replace(/^\n|\n$/g, "")
    });
    return `\n@@CODE_BLOCK_${codeBlocks.length - 1}@@\n`;
  });

  const blocks = tokenized.split(/\n{2,}/);
  const html = blocks.map(block => renderMarkdownBlock(block.trim(), codeBlocks)).filter(Boolean).join("");
  return html || `<p>${formatInlineMarkdown(escapeHtml(source))}</p>`;
}

function renderMarkdownBlock(block, codeBlocks) {
  if (!block) return "";

  const codeMatch = block.match(/^@@CODE_BLOCK_(\d+)@@$/);
  if (codeMatch) {
    const item = codeBlocks[Number(codeMatch[1])];
    if (!item) return "";
    const safeLang = escapeHtml(item.lang);
    const safeCode = escapeHtml(item.code);
    const lineCount = item.code.split("\n").length;
    return `
      <div class="code-container collapsed">
        <div class="code-header code-header-toggle">
          <span>${safeLang} · ${lineCount} lines</span>
          <button type="button" class="copy-code-btn" data-copy-target="${item.id}">Copy</button>
        </div>
        <pre style="display:none"><code id="${item.id}" class="language-${safeLang}">${safeCode}</code></pre>
      </div>
    `;
  }

  const lines = block.split("\n");
  if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
    const items = lines.map(line => `<li>${formatInlineMarkdown(escapeHtml(line.replace(/^\s*[-*]\s+/, "")))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }

  if (lines.every(line => /^\s*\d+\.\s+/.test(line))) {
    const items = lines.map(line => `<li>${formatInlineMarkdown(escapeHtml(line.replace(/^\s*\d+\.\s+/, "")))}</li>`).join("");
    return `<ol>${items}</ol>`;
  }

  if (lines.every(line => /^\s*>\s?/.test(line))) {
    const quote = lines.map(line => line.replace(/^\s*>\s?/, "")).join("<br>");
    return `<blockquote>${formatInlineMarkdown(escapeHtml(quote))}</blockquote>`;
  }

  const heading = block.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return `<h${level}>${formatInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`;
  }

  return `<p>${formatInlineMarkdown(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`;
}

function formatInlineMarkdown(html) {
  return html
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  return template.content.textContent || "";
}

// Send user message and kick off the response cycle
async function handleSendMessage() {
  const chatTextarea = document.getElementById("chat-textarea");
  const sendBtn = document.getElementById("send-btn");

  if (!chatTextarea || !currentChatId) return;

  const userInput = chatTextarea.value.trim();
  if (!userInput && uploadedImages.length === 0) return;

  if (!settings.apiKey) {
    showToast("Please configure your OpenRouter API Key first!");
    switchView("settings");
    return;
  }

  // Clear inputs
  chatTextarea.value = "";
  chatTextarea.style.height = "auto";
  if (sendBtn) sendBtn.classList.remove("active");

  const imagesToSend = [...uploadedImages];
  uploadedImages = [];
  renderPreviewArea();

  // Save session state details
  const activeChat = chats[currentChatId];
  activeChat.timestamp = Date.now();
  
  // Set chat title dynamically if first user message
  if (activeChat.messages.length === 0) {
    activeChat.title = userInput ? (userInput.slice(0, 24) + (userInput.length > 24 ? "..." : "")) : "Image Upload Chat";
  }

  // Append user message
  const messageIndex = activeChat.messages.push({ role: "user", content: userInput, images: imagesToSend }) - 1;
  appendMessageUI("user", userInput, imagesToSend, true, { messageIndex });
  await saveChats();
  renderHistoryList();

  // Kick off OpenRouter Agent loop
  beginAgentRun();
  try {
    await runAgentCycle();
  } finally {
    if (agentStopRequested) {
      await recordAgentStopped();
    }
    endAgentRun();
  }
}

// ----------------------------------------------------
// AGENT CONVERSATION RUN LOOP
// ----------------------------------------------------
function getEffectiveSystemPrompt() {
  const basePrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (basePrompt.includes("get_authenticator_code")) return basePrompt;
  return `${basePrompt}\n\n${AUTHENTICATOR_SYSTEM_PROMPT_ADDENDUM}`;
}

async function runAgentCycle() {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory || !currentChatId || agentStopRequested) return;

  const activeChat = chats[currentChatId];

  // 1. Render Thinking Loader
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "message assistant loading-msg";
  loadingDiv.innerHTML = `
    <div class="message-content">
      <span class="typing-indicator" aria-label="Thinking">
        <span></span><span></span><span></span>
      </span>
    </div>`;
  chatHistory.appendChild(loadingDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;

  try {
    const activeModel = settings.model;
    if (!activeModel) {
      throw new Error("No AI model selected. Open settings and pick a model.");
    }

    if (mcpToolRegistry.size === 0 && settings.mcpServers.some(s => s.enabled !== false && s.url)) {
      await refreshMcpTools();
    }

    // 2. Prepare model transcript from the UI chat history.
    const apiMessages = buildApiMessagesForChat(activeChat);

    const providerPreferences = buildProviderPreferences();
    const reasoningPreferences = buildReasoningPreferences();
    const requestBody = {
      model: activeModel,
      messages: apiMessages,
      tools: getAllAgentTools(),
      temperature: 0.2,
      // Request token + cost accounting on every completion.
      usage: { include: true }
    };
    if (providerPreferences) {
      requestBody.provider = providerPreferences;
    }
    if (reasoningPreferences) {
      requestBody.reasoning = reasoningPreferences;
    }

    // 3. OpenRouter fetch request
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.apiKey}`,
        "HTTP-Referer": "https://github.com/scrapeflow",
        "X-Title": "ScrapeFlow Chat"
      },
      body: JSON.stringify(requestBody),
      signal: agentAbortController?.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter Error (${response.status}): ${errText}`);
    }

    const data = await response.json();
    loadingDiv.remove(); // Clear Loader

    if (!data.choices || data.choices.length === 0) {
      throw new Error("Empty completion choices returned.");
    }

    // Capture real usage from OpenRouter so the cost meter is grounded in
    // actuals rather than the chars/4 estimate.
    if (data.usage) recordUsage(data.usage);

    const responseMsg = data.choices[0].message;

    // 4. Handle Tool execution or standard Assistant responses
    if (responseMsg.tool_calls && responseMsg.tool_calls.length > 0) {
      // Save assistant tool call in messages log
      activeChat.messages.push({
        role: "assistant",
        content: responseMsg.content || "",
        tool_calls: responseMsg.tool_calls
      });

      // Display text content if assistant returned thoughts along with tool call
      if (responseMsg.content) {
        appendMessageUI("assistant", responseMsg.content);
      }

      // Execute each tool call sequentially
      for (const toolCall of responseMsg.tool_calls) {
        if (agentStopRequested) return;

        const toolName = toolCall.function.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch (e) {}

        // Add a structured tool-call card in chat UI
        const callStatus = {
          stage: "call",
          name: toolName,
          args: toolArgs
        };
        if (toolName !== "write_file") {
          appendMessageUI("tool-status", callStatus);
          activeChat.messages.push({ role: "tool-status", content: callStatus });
        }

        // Run the action
        const result = await executeTool(toolName, toolArgs);

        let finalResultContent = "";
        let screenshotDataUrl = null;

        if (typeof result === "object" && result.screenshot) {
          finalResultContent = result.message;
          screenshotDataUrl = result.screenshot;
        } else if (typeof result === "object" && result.type === "file") {
          finalResultContent = JSON.stringify({
            success: true,
            path: result.path,
            action: result.action,
            lines: result.lines,
            message: result.message
          });

          const artifact = {
            path: result.path,
            action: result.action,
            language: result.language,
            lines: result.lines,
            description: result.description || ""
          };
          appendMessageUI("file-artifact", artifact);
          activeChat.messages.push({ role: "file-artifact", content: artifact });
        } else {
          finalResultContent = String(result);
        }

        // Push tool results message log
        activeChat.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: finalResultContent
        });

        // If screenshot, attach image in subsequent user feedback block to let AI vision models inspect it
        if (screenshotDataUrl) {
          const screenshotStatus = {
            stage: "result",
            name: toolName,
            result: "Screenshot captured and attached to the next model turn."
          };
          appendMessageUI("tool-status", screenshotStatus);
          activeChat.messages.push({ role: "tool-status", content: screenshotStatus });
          activeChat.messages.push({
            role: "user",
            content: "Here is the visual screenshot just captured from the active webpage viewport:",
            images: [screenshotDataUrl]
          });
        } else if (toolName === "write_file") {
          // File card already shown — skip redundant result card
        } else {
          // Truncate display content to keep logs neat
          const sanitized = sanitizeToolDisplay(toolName, toolArgs, result);
          const displaySummary = typeof sanitized.result === "string" && sanitized.result.length > 2000
            ? sanitized.result.slice(0, 2000) + "\n..."
            : sanitized.result;
          const resultStatus = {
            stage: "result",
            name: toolName,
            result: displaySummary
          };
          appendMessageUI("tool-status", resultStatus);
          activeChat.messages.push({ role: "tool-status", content: resultStatus });
        }
      }

      await saveChats();
      // Recurse / continue agent reasoning loop
      if (!agentStopRequested) {
        await runAgentCycle();
      }

    } else {
      // Regular response from assistant
      const aiReply = responseMsg.content || "";
      const messageIndex = activeChat.messages.push({ role: "assistant", content: aiReply }) - 1;
      appendMessageUI("assistant", aiReply, [], true, { messageIndex });
      await saveChats();
    }

  } catch (error) {
    if (loadingDiv) loadingDiv.remove();
    if (error.name === "AbortError" || agentStopRequested) return;
    console.error(error);
    const errorContent = `Error occurred during agent turn: ${error.message}`;
    const messageIndex = activeChat.messages.push({ role: "assistant", content: errorContent }) - 1;
    appendMessageUI("assistant", `**Error:** ${error.message}`, [], true, { messageIndex });
    await saveChats();
  }
}

// ----------------------------------------------------
// FILE UPLOAD ATTACHMENTS
// ----------------------------------------------------
function initUploadEvents() {
  const attachBtn = document.getElementById("attach-screenshot-btn");
  const fileInput = document.getElementById("screenshot-input");

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      Array.from(files).forEach(file => {
        if (!file.type.startsWith("image/")) {
          showToast("Only image files are allowed!");
          return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
          uploadedImages.push(event.target.result);
          renderPreviewArea();
          
          const sendBtn = document.getElementById("send-btn");
          if (sendBtn) sendBtn.classList.add("active");
        };
        reader.readAsDataURL(file);
      });

      fileInput.value = "";
    });
  }
}

function renderPreviewArea() {
  const previewArea = document.getElementById("screenshots-preview-area");
  if (!previewArea) return;

  previewArea.innerHTML = "";

  if (uploadedImages.length === 0) {
    previewArea.classList.add("hidden");
    return;
  }

  previewArea.classList.remove("hidden");

  uploadedImages.forEach((dataUrl, index) => {
    const item = document.createElement("div");
    item.className = "screenshot-preview-item";

    const img = document.createElement("img");
    img.src = dataUrl;
    item.appendChild(img);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-img-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.addEventListener("click", () => {
      uploadedImages.splice(index, 1);
      renderPreviewArea();
      
      const chatTextarea = document.getElementById("chat-textarea");
      const sendBtn = document.getElementById("send-btn");
      if (uploadedImages.length === 0 && (!chatTextarea || !chatTextarea.value.trim())) {
        if (sendBtn) sendBtn.classList.remove("active");
      }
    });
    item.appendChild(removeBtn);

    previewArea.appendChild(item);
  });
}
