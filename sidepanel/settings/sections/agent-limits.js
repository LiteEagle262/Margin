import { settings } from "../../state/store.js";

export const DEFAULT_MAX_TOOL_CALLS = 30;
export const DEFAULT_FALLBACK_CONTEXT_WINDOW = 128000;
const MAX_MAX_TOOL_CALLS = 500;
const MIN_FALLBACK_CONTEXT_WINDOW = 4000;

export function normalizeAgentLimitsSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};

  // Blank, 0, or invalid falls back to the default; there is no "unlimited".
  let maxToolCalls = Math.floor(Number(value.maxToolCalls));
  if (!Number.isFinite(maxToolCalls) || maxToolCalls < 1) {
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
  }
  if (maxToolCalls > MAX_MAX_TOOL_CALLS) {
    maxToolCalls = MAX_MAX_TOOL_CALLS;
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

export function getMaxToolCalls() {
  return normalizeAgentLimitsSettings(settings.agentLimits).maxToolCalls;
}

export function getFallbackContextWindow() {
  return normalizeAgentLimitsSettings(settings.agentLimits).fallbackContextWindow;
}

export const agentLimitsSection = {
  key: "agentLimits",
  normalize: normalizeAgentLimitsSettings,
  render: renderAgentLimitsSettings,
  collect: collectAgentLimitsFromUI
};
