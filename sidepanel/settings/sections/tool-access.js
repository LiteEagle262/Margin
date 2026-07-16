// Settings section: per-tool enable/disable for the built-in agent tools.
// Owns the canonical list of built-in tool names (DEFAULT_ENABLED_TOOLS),
// which tool dispatch also checks.

import { settings } from "../../state/store.js";
import { escapeHtml } from "../../lib/format.js";

const TOOL_ACCESS_GROUPS = [
  {
    id: "browser",
    label: "Browser control",
    tools: [
      "take_snapshot", "click_element", "fill_element", "fill_form", "type_text",
      "hover_element", "press_key", "scroll_page", "wait_for", "navigate",
      "get_active_tab", "list_tabs", "take_screenshot", "get_dom", "run_js", "evaluate_script"
    ]
  },
  {
    id: "network",
    label: "Network debugging",
    tools: ["start_network_capture", "stop_network_capture", "get_network_logs", "get_network_log_detail", "clear_network_logs"]
  },
  {
    id: "recon",
    label: "API & recon",
    tools: ["http_request", "get_cookies", "get_storage", "list_scripts", "search_scripts"]
  },
  {
    id: "workspace",
    label: "Workspace files",
    tools: ["write_file", "read_file", "list_files", "search_files", "read_context_item", "get_file_info", "rename_file", "delete_file"]
  },
  {
    id: "search",
    label: "Web search",
    tools: ["search_web", "fetch_search_result"]
  },
  {
    id: "auth",
    label: "Authenticator",
    tools: ["get_authenticator_code", "list_authenticator_domains"]
  }
];

export const DEFAULT_ENABLED_TOOLS = new Set(TOOL_ACCESS_GROUPS.flatMap(group => group.tools));

const TOOL_LABELS = {
  take_snapshot: "Page snapshot",
  click_element: "Click",
  fill_element: "Fill field",
  fill_form: "Fill form",
  type_text: "Type focused text",
  hover_element: "Hover",
  press_key: "Press key",
  scroll_page: "Scroll",
  wait_for: "Wait for page state",
  navigate: "Navigate",
  get_active_tab: "Active tab",
  list_tabs: "List tabs",
  take_screenshot: "Screenshot",
  get_dom: "Raw DOM",
  run_js: "Raw JS",
  evaluate_script: "Evaluate function",
  start_network_capture: "Start network capture",
  stop_network_capture: "Stop network capture",
  get_network_logs: "List network logs",
  get_network_log_detail: "Network log detail",
  clear_network_logs: "Clear network logs",
  write_file: "Write file",
  read_file: "Read file",
  list_files: "List files",
  search_files: "Search files",
  search_web: "Search web",
  fetch_search_result: "Fetch search result",
  read_context_item: "Read archived context",
  get_file_info: "File info",
  rename_file: "Rename file",
  delete_file: "Delete file",
  get_authenticator_code: "Authenticator code",
  list_authenticator_domains: "Authenticator domains",
  http_request: "HTTP request",
  get_cookies: "Read cookies",
  get_storage: "Read storage",
  list_scripts: "List scripts",
  search_scripts: "Search scripts"
};

export function normalizeToolAccessSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const enabled = value.enabled && typeof value.enabled === "object" ? value.enabled : {};
  const normalized = {};
  DEFAULT_ENABLED_TOOLS.forEach((toolName) => {
    normalized[toolName] = enabled[toolName] !== false;
  });
  return { enabled: normalized };
}

export function isBuiltInToolEnabled(toolName) {
  const access = normalizeToolAccessSettings(settings.toolAccess);
  return access.enabled[toolName] !== false;
}

function getEnabledBuiltInToolNames() {
  const access = normalizeToolAccessSettings(settings.toolAccess);
  return Object.entries(access.enabled)
    .filter(([, enabled]) => enabled !== false)
    .map(([name]) => name);
}

export function renderToolAccessSettings() {
  const list = document.getElementById("tool-access-list");
  const badge = document.getElementById("tool-access-status-badge");
  if (!list) return;

  const access = normalizeToolAccessSettings(settings.toolAccess);
  list.innerHTML = "";

  TOOL_ACCESS_GROUPS.forEach((group) => {
    const wrapper = document.createElement("div");
    wrapper.className = "tool-access-group";
    const enabledCount = group.tools.filter((name) => access.enabled[name] !== false).length;
    wrapper.innerHTML = `
      <div class="tool-access-group-header">
        <span>${escapeHtml(group.label)}</span>
        <span>${enabledCount}/${group.tools.length}</span>
      </div>
      <div class="tool-access-grid"></div>
    `;
    const grid = wrapper.querySelector(".tool-access-grid");
    group.tools.forEach((toolName) => {
      const label = document.createElement("label");
      label.className = "tool-access-toggle";
      label.innerHTML = `
        <input type="checkbox" class="tool-access-input" data-tool-name="${escapeHtml(toolName)}"${access.enabled[toolName] !== false ? " checked" : ""}>
        <span>${escapeHtml(TOOL_LABELS[toolName] || toolName)}</span>
      `;
      grid.appendChild(label);
    });
    list.appendChild(wrapper);
  });

  if (badge) {
    const total = DEFAULT_ENABLED_TOOLS.size;
    const enabled = getEnabledBuiltInToolNames().length;
    badge.textContent = enabled === total ? "All on" : `${enabled}/${total} on`;
    badge.className = enabled === total ? "mcp-bridge-badge connected" : "mcp-bridge-badge pending";
  }
}

function collectToolAccessFromUI() {
  const list = document.getElementById("tool-access-list");
  if (!list) return normalizeToolAccessSettings(settings.toolAccess);
  const enabled = {};
  DEFAULT_ENABLED_TOOLS.forEach((toolName) => {
    const input = list.querySelector(`.tool-access-input[data-tool-name="${CSS.escape(toolName)}"]`);
    enabled[toolName] = input ? input.checked === true : true;
  });
  return normalizeToolAccessSettings({ enabled });
}

function initToolAccessSettings() {
  const enableAllBtn = document.getElementById("enable-all-tools-btn");
  const disableRiskyBtn = document.getElementById("disable-risky-tools-btn");
  const list = document.getElementById("tool-access-list");

  enableAllBtn?.addEventListener("click", () => {
    list?.querySelectorAll(".tool-access-input").forEach((input) => { input.checked = true; });
    settings.toolAccess = collectToolAccessFromUI();
    renderToolAccessSettings();
  });

  disableRiskyBtn?.addEventListener("click", () => {
    const risky = new Set(["run_js", "evaluate_script", "navigate", "get_authenticator_code", "delete_file", "rename_file", "clear_network_logs", "http_request", "get_cookies", "get_storage"]);
    list?.querySelectorAll(".tool-access-input").forEach((input) => {
      if (risky.has(input.dataset.toolName)) input.checked = false;
    });
    settings.toolAccess = collectToolAccessFromUI();
    renderToolAccessSettings();
  });

  list?.addEventListener("change", (event) => {
    if (!event.target?.classList?.contains("tool-access-input")) return;
    settings.toolAccess = collectToolAccessFromUI();
    renderToolAccessSettings();
  });
}

export const toolAccessSection = {
  key: "toolAccess",
  normalize: normalizeToolAccessSettings,
  render: renderToolAccessSettings,
  collect: collectToolAccessFromUI,
  init: initToolAccessSettings
};
