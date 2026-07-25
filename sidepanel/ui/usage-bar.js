import { chats, currentChatId, settings } from "../state/store.js";
import { approxTokens, formatTokens, formatCost } from "../lib/format.js";
import { getEffectiveSystemPrompt, getActiveModelInfo, buildApiMessagesForChat, countApiMessageTokens } from "../agent/context.js";
import { getMcpToolSchemas, filterEnabledToolSchemas } from "../tools/execute.js";
import { BROWSER_TOOLS, WORKSPACE_TOOLS, WEB_SEARCH_TOOLS } from "../../shared/tool-schemas.js";

const USAGE_REFRESH_DELAY_MS = 200;

let usageRefreshTimer = null;

const USAGE_CATEGORIES = [
  { key: "system",       label: "System prompt", color: "#5e9cff" },
  { key: "browserTools", label: "Browser tools", color: "#7dd3a7" },
  { key: "mcpTools",     label: "MCP tools",     color: "#b794f4" },
  { key: "chat",         label: "Conversation",  color: "#f6c177" },
  { key: "toolIO",       label: "Tool I/O",      color: "#eb7676" },
  { key: "images",       label: "Attachments",   color: "#9aa0a6" }
];


export function computeContextBreakdown() {
  const breakdown = { system: 0, browserTools: 0, mcpTools: 0, chat: 0, toolIO: 0, images: 0 };

  breakdown.system += approxTokens(getEffectiveSystemPrompt());
  breakdown.browserTools += approxTokens([
    ...filterEnabledToolSchemas(BROWSER_TOOLS),
    ...filterEnabledToolSchemas(WORKSPACE_TOOLS),
    ...filterEnabledToolSchemas(WEB_SEARCH_TOOLS)
  ]);
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
            if (part.type === "file" || part.type === "input_audio") breakdown.images += 2048;
            if (part.type === "video_url") breakdown.images += 4096;
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

export function updateUsageBar() {
  clearTimeout(usageRefreshTimer);
  usageRefreshTimer = setTimeout(renderUsageBar, USAGE_REFRESH_DELAY_MS);
}

function renderUsageBar() {
  const ringBtn = document.getElementById("context-ring-btn");
  const tooltip = document.getElementById("context-tooltip");
  const costEl = document.getElementById("cost-meter");
  if (!ringBtn || !tooltip || !costEl) return;

  const model = getActiveModelInfo();
  const { total, breakdown } = computeContextBreakdown();
  const known = model.contextKnown;
  const window = model.contextWindow;
  const pct = known && window > 0 ? Math.min(100, (total / window) * 100) : 0;

  const ringProgress = ringBtn.querySelector(".ring-progress");
  if (ringProgress) {
    ringProgress.style.strokeDasharray = known ? `${pct} 100` : "0 100";
  }
  ringBtn.classList.toggle("near-limit", known && pct >= 75 && pct < 90);
  ringBtn.classList.toggle("over-limit", known && pct >= 90);

  ringBtn.querySelector(".context-percent").textContent = known ? `${Math.round(pct)}%` : "–";
  ringBtn.querySelector(".context-summary").textContent = known
    ? `${formatTokens(total)} of ${formatTokens(window)} ctx`
    : `${formatTokens(total)} used · max unknown`;

  tooltip.querySelector(".tooltip-total").textContent = `${formatTokens(total)} tokens`;
  tooltip.querySelector(".tooltip-model").textContent = model.name;
  tooltip.querySelector(".tooltip-window").textContent = known
    ? `${formatTokens(window)} ctx window`
    : "context window unknown";

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

  const activeChat = chats[currentChatId];
  const cost = activeChat?.cost?.totalUsd || 0;
  const promptTokens = activeChat?.cost?.promptTokens || 0;
  const completionTokens = activeChat?.cost?.completionTokens || 0;
  const costIcon = costEl.querySelector(".cost-icon");
  if (settings.aiProvider === "openai") {
    if (costIcon) costIcon.textContent = "T";
    costEl.querySelector(".cost-amount").textContent = formatTokens(promptTokens + completionTokens);
    costEl.classList.toggle("has-spend", promptTokens + completionTokens > 0);
    costEl.title = `Prompt: ${formatTokens(promptTokens)} tok · Completion: ${formatTokens(completionTokens)} tok\nCheck OpenAI billing for cost.`;
  } else {
    if (costIcon) costIcon.textContent = "$";
    costEl.querySelector(".cost-amount").textContent = formatCost(cost);
    costEl.classList.toggle("has-spend", cost > 0);
    costEl.title = activeChat?.cost
      ? `Prompt: ${formatTokens(promptTokens)} tok · Completion: ${formatTokens(completionTokens)} tok\nThis chat: $${formatCost(cost)}`
      : "No spend recorded yet for this chat.";
  }
}

export function recordUsage(usage) {
  recordUsageForChat(usage, currentChatId);
}

export function recordUsageForChat(usage, chatId) {
  if (!usage || !chatId) return;
  const chat = chats[chatId];
  if (!chat) return;

  if (!chat.cost) chat.cost = { promptTokens: 0, completionTokens: 0, totalUsd: 0 };
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  chat.cost.promptTokens += prompt;
  chat.cost.completionTokens += completion;

  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
    chat.cost.totalUsd += usage.cost;
  } else {
    const model = getActiveModelInfo();
    chat.cost.totalUsd += prompt * model.promptRate + completion * model.completionRate;
  }

  updateUsageBar();
}


export function initUsageBar() {
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
