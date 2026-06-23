// Settings section: OpenRouter reasoning effort and thinking output.

import { settings } from "../../state/store.js";

const REASONING_EFFORTS = new Set(["auto", "none", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizeReasoningSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    effort: REASONING_EFFORTS.has(value.effort) ? value.effort : "auto",
    showThinking: value.showThinking === true,
    keepThinkingOpen: value.keepThinkingOpen === true
  };
}

function collectReasoningFromUI() {
  const effortInput = document.getElementById("reasoning-effort");
  const showThinkingInput = document.getElementById("reasoning-show-thinking");
  return normalizeReasoningSettings({
    effort: effortInput ? effortInput.value : settings.reasoning.effort,
    showThinking: showThinkingInput ? showThinkingInput.checked : settings.reasoning.showThinking,
    keepThinkingOpen: settings.reasoning.keepThinkingOpen
  });
}

function renderReasoningSettings() {
  const effortInput = document.getElementById("reasoning-effort");
  const showThinkingInput = document.getElementById("reasoning-show-thinking");
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  if (effortInput) effortInput.value = reasoning.effort;
  if (showThinkingInput) showThinkingInput.checked = reasoning.showThinking;
}

export function buildReasoningPreferences(options = {}) {
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  const prefs = {};
  if (reasoning.effort !== "auto") prefs.effort = reasoning.effort;
  if (options.includeThinkingOutput && reasoning.showThinking) prefs.exclude = false;
  return Object.keys(prefs).length ? prefs : null;
}

export const reasoningSection = {
  key: "reasoning",
  normalize: normalizeReasoningSettings,
  render: renderReasoningSettings,
  collect: collectReasoningFromUI
};
