import { settings, openRouterModels } from "../../state/store.js";

const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const REASONING_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const REASONING_EFFORT_LABELS = Object.freeze({
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
});

function normalizeReasoningEffort(value, fallback = "") {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  return effort === "auto" || REASONING_EFFORT_PATTERN.test(effort) ? effort : fallback;
}

function normalizeSupportedEfforts(value) {
  const seen = new Set();
  const efforts = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const effort = normalizeReasoningEffort(typeof entry === "string" ? entry : entry?.effort);
    if (!effort || effort === "auto" || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push(effort);
  }
  const rank = new Map(REASONING_EFFORT_ORDER.map((effort, index) => [effort, index]));
  return efforts.sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

function effortDescriptions(value) {
  const descriptions = {};
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object") continue;
    const effort = normalizeReasoningEffort(entry.effort);
    const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 240) : "";
    if (effort && effort !== "auto" && description) descriptions[effort] = description;
  }
  return descriptions;
}

export function getModelReasoningProfile(providerId, model) {
  const id = typeof model?.id === "string" ? model.id : "";
  const name = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : id;
  if (!id) {
    return {
      providerId,
      modelId: "",
      modelName: "",
      supported: null,
      supportedEfforts: [],
      defaultEffort: "",
      defaultEnabled: null,
      mandatory: false,
      descriptions: {},
    };
  }

  const parameterSupport = Array.isArray(model.supported_parameters) &&
    model.supported_parameters.includes("reasoning");
  const metadata = model.reasoning && typeof model.reasoning === "object" ? model.reasoning : {};
  const rawEfforts = providerId === "openai"
    ? model.supported_reasoning_levels
    : metadata.supported_efforts;
  const supportedEfforts = normalizeSupportedEfforts(rawEfforts);
  const requestedDefault = normalizeReasoningEffort(
    providerId === "openai" ? model.default_reasoning_level : metadata.default_effort,
  );
  const defaultEffort = requestedDefault && supportedEfforts.includes(requestedDefault)
    ? requestedDefault
    : "";
  const hasMetadata = providerId === "openai"
    ? Array.isArray(model.supported_reasoning_levels)
    : model.reasoning && typeof model.reasoning === "object";

  return {
    providerId,
    modelId: id,
    modelName: name,
    supported: hasMetadata || parameterSupport || metadata.mandatory === true,
    supportedEfforts,
    defaultEffort,
    defaultEnabled: typeof metadata.default_enabled === "boolean" ? metadata.default_enabled : null,
    mandatory: metadata.mandatory === true,
    descriptions: providerId === "openai" ? effortDescriptions(model.supported_reasoning_levels) : {},
  };
}

export function getActiveModelReasoningProfile() {
  const model = openRouterModels.find((entry) => entry.id === settings.model);
  return getModelReasoningProfile(settings.aiProvider, model);
}

export function resolveReasoningEffort(profile, requestedEffort) {
  const effort = normalizeReasoningEffort(requestedEffort, "auto");
  if (effort === "auto" || profile?.supported !== true) return "auto";
  return profile.supportedEfforts.includes(effort) ? effort : "auto";
}

export function resolveReasoningEffortForActiveModel(requestedEffort) {
  return resolveReasoningEffort(getActiveModelReasoningProfile(), requestedEffort);
}

export function normalizeReasoningSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    effort: normalizeReasoningEffort(value.effort, "auto"),
    showThinking: value.showThinking === true,
    keepThinkingOpen: value.keepThinkingOpen === true
  };
}

function collectReasoningFromUI() {
  const effortInput = document.getElementById("reasoning-effort");
  const showThinkingInput = document.getElementById("reasoning-show-thinking");
  const keepOpenInput = document.getElementById("reasoning-keep-open");
  return normalizeReasoningSettings({
    effort: effortInput ? effortInput.value : settings.reasoning.effort,
    showThinking: showThinkingInput ? showThinkingInput.checked : settings.reasoning.showThinking,
    keepThinkingOpen: keepOpenInput ? keepOpenInput.checked : settings.reasoning.keepThinkingOpen
  });
}

function reasoningEffortLabel(effort) {
  return REASONING_EFFORT_LABELS[effort] || effort
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function renderReasoningSettings(profile = getActiveModelReasoningProfile()) {
  const effortInput = document.getElementById("reasoning-effort");
  const help = document.getElementById("reasoning-effort-help");
  const showThinkingInput = document.getElementById("reasoning-show-thinking");
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  if (effortInput) {
    const auto = document.createElement("option");
    auto.value = "auto";
    if (profile.supported === false) {
      auto.textContent = "Unavailable";
    } else if (profile.supported === null) {
      auto.textContent = "Auto (load model details)";
    } else if (profile.defaultEnabled === false || profile.defaultEffort === "none") {
      auto.textContent = "Auto (off by default)";
    } else if (profile.defaultEffort) {
      auto.textContent = `Auto (${reasoningEffortLabel(profile.defaultEffort)} default)`;
    } else {
      auto.textContent = "Auto (provider default)";
    }
    const options = [auto];
    for (const effort of profile.supportedEfforts) {
      const option = document.createElement("option");
      option.value = effort;
      option.textContent = reasoningEffortLabel(effort);
      if (profile.descriptions[effort]) option.title = profile.descriptions[effort];
      options.push(option);
    }
    effortInput.replaceChildren(...options);
    effortInput.disabled = profile.supported !== true || profile.supportedEfforts.length === 0;
    effortInput.value = resolveReasoningEffort(profile, reasoning.effort);
  }
  if (help) {
    if (profile.supported === null) {
      help.textContent = "Load or select a model to sync its reasoning options.";
    } else if (profile.supported === false) {
      help.textContent = `${profile.modelName || "This model"} does not advertise reasoning support. Margin will omit reasoning settings.`;
    } else if (profile.supportedEfforts.length === 0) {
      help.textContent = `${profile.modelName} supports reasoning, but the provider did not publish effort levels. Margin will use the provider default.`;
    } else {
      const defaultText = profile.defaultEnabled === false || profile.defaultEffort === "none"
        ? " Reasoning is off by default."
        : profile.defaultEffort
        ? ` Default: ${reasoningEffortLabel(profile.defaultEffort)}.`
        : "";
      const mandatoryText = profile.mandatory ? " Reasoning is required for this model." : "";
      help.textContent = `Synced to ${profile.modelName}.${defaultText}${mandatoryText}`;
    }
  }
  if (showThinkingInput) showThinkingInput.checked = reasoning.showThinking;
  const keepOpenInput = document.getElementById("reasoning-keep-open");
  if (keepOpenInput) keepOpenInput.checked = reasoning.keepThinkingOpen;
}

export function syncReasoningForActiveModel() {
  const profile = getActiveModelReasoningProfile();
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  const effort = resolveReasoningEffort(profile, reasoning.effort);
  const changed = effort !== reasoning.effort;
  settings.reasoning = { ...reasoning, effort };
  renderReasoningSettings(profile);
  return { profile, changed };
}

export function buildReasoningPreferences() {
  const reasoning = normalizeReasoningSettings(settings.reasoning);
  const profile = getActiveModelReasoningProfile();
  if (profile.supported !== true) return null;
  const prefs = {};
  const effort = resolveReasoningEffort(profile, reasoning.effort);
  if (effort !== "auto") prefs.effort = effort;
  return Object.keys(prefs).length ? prefs : null;
}

function initReasoningSettings() {
  const rerenderChat = async () => {
    // Dynamic imports avoid a static cycle (chat-view imports this module).
    const { flushSettingsAutosave } = await import("../core.js");
    await flushSettingsAutosave();
    const { renderChatHistory } = await import("../../ui/chat-view.js");
    renderChatHistory();
  };
  document.getElementById("reasoning-show-thinking")?.addEventListener("change", rerenderChat);
  document.getElementById("reasoning-keep-open")?.addEventListener("change", rerenderChat);
}

export const reasoningSection = {
  key: "reasoning",
  normalize: normalizeReasoningSettings,
  render: syncReasoningForActiveModel,
  collect: collectReasoningFromUI,
  init: initReasoningSettings
};
