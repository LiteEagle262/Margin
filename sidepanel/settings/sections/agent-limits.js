// Settings section: agent run limits. Controls the tool loop limit — how many
// tool calls the agent may run for a single response before it is forced to
// stop and summarize (0 means unlimited) — and the fallback context window used
// for token budgeting when the active model's real context length is not known
// yet (e.g. before the OpenRouter model list has loaded, or while offline).

import { settings } from "../../state/store.js";

export const DEFAULT_MAX_TOOL_CALLS = 14;
export const DEFAULT_FALLBACK_CONTEXT_WINDOW = 128000;
// Floor so a typo can't starve the packer down to nothing.
const MIN_FALLBACK_CONTEXT_WINDOW = 4000;

export function normalizeAgentLimitsSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};

  let maxToolCalls = Math.floor(Number(value.maxToolCalls));
  // Reject non-numbers and negatives; 0 is valid and means "unlimited".
  if (!Number.isFinite(maxToolCalls) || maxToolCalls < 0) {
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
  }

  let fallbackContextWindow = Math.floor(Number(value.fallbackContextWindow));
  if (!Number.isFinite(fallbackContextWindow) || fallbackContextWindow < MIN_FALLBACK_CONTEXT_WINDOW) {
    fallbackContextWindow = DEFAULT_FALLBACK_CONTEXT_WINDOW;
  }

  return { maxToolCalls, fallbackContextWindow };
}

function collectAgentLimitsFromUI() {
  const toolCallsInput = document.getElementById("agent-max-tool-calls");
  const fallbackInput = document.getElementById("agent-fallback-context");
  return normalizeAgentLimitsSettings({
    maxToolCalls: toolCallsInput ? toolCallsInput.value : settings.agentLimits.maxToolCalls,
    fallbackContextWindow: fallbackInput ? fallbackInput.value : settings.agentLimits.fallbackContextWindow
  });
}

function renderAgentLimitsSettings() {
  const toolCallsInput = document.getElementById("agent-max-tool-calls");
  const fallbackInput = document.getElementById("agent-fallback-context");
  const limits = normalizeAgentLimitsSettings(settings.agentLimits);
  if (toolCallsInput) toolCallsInput.value = limits.maxToolCalls;
  if (fallbackInput) fallbackInput.value = limits.fallbackContextWindow;
}

// The configured tool loop limit. 0 means no limit.
export function getMaxToolCalls() {
  return normalizeAgentLimitsSettings(settings.agentLimits).maxToolCalls;
}

// Token budget fallback for when the active model's real context length is
// unknown. Should rarely be hit once the model list has loaded.
export function getFallbackContextWindow() {
  return normalizeAgentLimitsSettings(settings.agentLimits).fallbackContextWindow;
}

export const agentLimitsSection = {
  key: "agentLimits",
  normalize: normalizeAgentLimitsSettings,
  render: renderAgentLimitsSettings,
  collect: collectAgentLimitsFromUI
};
