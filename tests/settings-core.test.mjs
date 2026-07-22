import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRedactedSettingsExport,
  buildSettingsStorageObject,
  normalizeAppConfig,
  scheduleSettingsAutosave,
} from "../sidepanel/settings/core.js";
import { normalizeOpenRouterReasoning } from "../sidepanel/api/openrouter.js";
import {
  buildReasoningPreferences,
  getModelReasoningProfile,
  resolveReasoningEffort,
  syncReasoningForActiveModel,
} from "../sidepanel/settings/sections/reasoning.js";
import { settings, setOpenRouterModels, setSettings } from "../sidepanel/state/store.js";

test("OpenRouter reasoning metadata preserves exact effort and mandatory rules", () => {
  assert.deepEqual(normalizeOpenRouterReasoning({
    supported_efforts: ["high", "medium", "low", "none", "high", "invalid effort"],
    default_effort: "medium",
    default_enabled: true,
    mandatory: true,
  }), {
    supported_efforts: ["high", "medium", "low"],
    default_effort: "medium",
    default_enabled: true,
    mandatory: true,
  });

  assert.deepEqual(normalizeOpenRouterReasoning({
    supported_efforts: null,
    default_effort: "high",
    default_enabled: false,
    mandatory: false,
  }), {
    supported_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    default_effort: "high",
    default_enabled: false,
    mandatory: false,
  });

  assert.deepEqual(normalizeOpenRouterReasoning({ mandatory: false }), {
    supported_efforts: ["none"],
    default_effort: "",
    default_enabled: null,
    mandatory: false,
  });
});

test("reasoning profiles clamp settings to the selected model's published levels", () => {
  const openAIProfile = getModelReasoningProfile("openai", {
    id: "gpt-5.6-sol",
    name: "GPT-5.6-Sol",
    supported_parameters: ["reasoning"],
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "max", description: "Deep" },
      { effort: "ultra", description: "Delegated" },
    ],
  });
  assert.deepEqual(openAIProfile.supportedEfforts, ["low", "max", "ultra"]);
  assert.equal(openAIProfile.defaultEffort, "low");
  assert.equal(resolveReasoningEffort(openAIProfile, "ultra"), "ultra");
  assert.equal(resolveReasoningEffort(openAIProfile, "medium"), "auto");

  const mandatoryRouterProfile = getModelReasoningProfile("openrouter", {
    id: "vendor/reasoner",
    name: "Reasoner",
    supported_parameters: ["reasoning"],
    reasoning: normalizeOpenRouterReasoning({
      supported_efforts: ["high", "low"],
      default_effort: "high",
      default_enabled: true,
      mandatory: true,
    }),
  });
  assert.deepEqual(mandatoryRouterProfile.supportedEfforts, ["low", "high"]);
  assert.equal(resolveReasoningEffort(mandatoryRouterProfile, "none"), "auto");
  assert.equal(resolveReasoningEffort(mandatoryRouterProfile, "high"), "high");

  assert.equal(getModelReasoningProfile("openrouter", {
    id: "vendor/plain",
    supported_parameters: [],
  }).supported, false);
});

test("reasoning requests omit Auto and unsupported efforts", () => {
  const previousSettings = structuredClone(settings);
  try {
    setOpenRouterModels([{
      id: "vendor/reasoner",
      name: "Reasoner",
      supported_parameters: ["reasoning"],
      reasoning: normalizeOpenRouterReasoning({
        supported_efforts: ["low", "high"],
        default_effort: "low",
        mandatory: true,
      }),
    }]);
    setSettings({
      ...previousSettings,
      aiProvider: "openrouter",
      model: "vendor/reasoner",
      reasoning: { effort: "auto", showThinking: true, keepThinkingOpen: false },
    });
    assert.equal(buildReasoningPreferences(), null);

    settings.reasoning.effort = "high";
    assert.deepEqual(buildReasoningPreferences(), { effort: "high" });

    settings.reasoning.effort = "none";
    assert.equal(buildReasoningPreferences(), null);
  } finally {
    setOpenRouterModels([]);
    setSettings(previousSettings);
  }
});

test("reasoning selector rerenders and coerces stale effort after a model change", () => {
  const previousSettings = structuredClone(settings);
  const originalDocument = globalThis.document;
  const select = {
    children: [],
    disabled: false,
    value: "",
    replaceChildren(...children) { this.children = children; },
  };
  const help = { textContent: "" };
  const showThinking = { checked: false };
  const fields = new Map([
    ["reasoning-effort", select],
    ["reasoning-effort-help", help],
    ["reasoning-show-thinking", showThinking],
  ]);
  globalThis.document = {
    getElementById(id) { return fields.get(id) || null; },
    createElement() { return { value: "", textContent: "", title: "" }; },
  };

  try {
    setOpenRouterModels([{
      id: "gpt-5.6-sol",
      name: "GPT-5.6-Sol",
      supported_parameters: ["reasoning"],
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "max", description: "Deep" },
        { effort: "ultra", description: "Delegated" },
      ],
    }]);
    setSettings({
      ...previousSettings,
      aiProvider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium", showThinking: true, keepThinkingOpen: false },
    });

    const result = syncReasoningForActiveModel();
    assert.equal(result.changed, true);
    assert.equal(settings.reasoning.effort, "auto");
    assert.deepEqual(select.children.map((option) => option.value), ["auto", "low", "max", "ultra"]);
    assert.equal(select.children[0].textContent, "Auto (Low default)");
    assert.equal(select.disabled, false);
    assert.equal(help.textContent, "Synced to GPT-5.6-Sol. Default: Low.");
    assert.equal(showThinking.checked, true);
  } finally {
    globalThis.document = originalDocument;
    setOpenRouterModels([]);
    setSettings(previousSettings);
  }
});

test("legacy single-provider settings migrate only to OpenRouter", () => {
  const config = normalizeAppConfig({
    apiKey: "legacy-openrouter-key",
    model: "vendor/legacy-model",
  });

  assert.equal(config.aiProvider, "openrouter");
  assert.equal(config.providerConfigs.openrouter.apiKey, "legacy-openrouter-key");
  assert.equal(config.providerConfigs.openrouter.model, "vendor/legacy-model");
  assert.equal(config.providerConfigs.openai.apiKey, "");
  assert.equal(config.apiKey, "legacy-openrouter-key");
});

test("OpenAI subscription settings discard legacy API credentials", () => {
  const config = normalizeAppConfig({
    aiProvider: "openai",
    providerConfigs: {
      openrouter: { apiKey: "router-key", model: "vendor/router-model" },
      openai: { apiKey: "openai-key", model: "gpt-5.4" },
    },
    dataSharingConsent: true,
  });

  assert.equal(config.apiKey, "");
  assert.equal(config.model, "gpt-5.4");
  assert.equal(config.providerConfigs.openrouter.apiKey, "router-key");
  assert.equal(config.dataSharingConsent, true);

  const stored = buildSettingsStorageObject(config);
  assert.equal(stored.apiKey, "", "legacy key slot must never contain the active OpenAI key");
  assert.equal(stored.model, "vendor/router-model");
  assert.equal(stored.providerConfigs.openai.apiKey, "");
});

test("config export removes credentials, URL secrets, and authenticator seeds", () => {
  const config = normalizeAppConfig({
    aiProvider: "openai",
    providerConfigs: {
      openrouter: { apiKey: "router-secret", model: "vendor/model" },
      openai: { apiKey: "openai-secret", model: "gpt-5.4" },
    },
    mcpBridge: { enabled: true, port: 9229, token: "bridge-secret" },
    mcpServers: [{
      id: "server-1",
      name: "Private MCP",
      enabled: true,
      url: "https://user:password@example.com/mcp?token=secret#fragment",
    }],
    tempEmail: { enabled: true, apiUrl: "https://mail.example.com", apiKey: "mail-secret" },
    webSearch: { enabled: true, provider: "tavily", apiKey: "search-secret" },
    authManualKeys: { "example.com": "JBSWY3DPEHPK3PXP" },
  });

  assert.equal(config.authManualKeys["example.com"], "JBSWY3DPEHPK3PXP");
  const exported = buildRedactedSettingsExport(config);
  assert.equal(exported.apiKey, "");
  assert.equal(exported.providerConfigs.openrouter.apiKey, "");
  assert.equal(exported.providerConfigs.openai.apiKey, "");
  assert.equal(exported.mcpBridge.token, "");
  assert.equal(Object.hasOwn(exported, "openaiOAuth"), false);
  assert.equal(exported.tempEmail.apiKey, "");
  assert.equal(exported.webSearch.apiKey, "");
  assert.deepEqual(exported.authManualKeys, {});
  assert.equal(exported.mcpServers[0].url, "https://example.com/mcp");
});

test("settings autosave persists the selected provider without a submit action", async () => {
  const savedStatus = { textContent: "", dataset: {} };
  const fields = new Map([
    ["ai-provider", { value: "openai" }],
    ["provider-api-key", { value: "openai-autosave-key" }],
    ["data-sharing-consent", { checked: true }],
    ["model-selected", { value: "gpt-5.4" }],
    ["model-search", { value: "gpt-5.4" }],
    ["system-prompt", { value: "Use the selected provider." }],
    ["settings-save-status", savedStatus],
  ]);
  const writes = [];
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;

  globalThis.document = {
    getElementById(id) { return fields.get(id) || null; },
    querySelectorAll() { return []; },
  };
  globalThis.chrome = {
    storage: { local: { async set(value) { writes.push(structuredClone(value)); } } },
  };
  setSettings(normalizeAppConfig({
    aiProvider: "openai",
    providerConfigs: {
      openrouter: { apiKey: "router-key", model: "vendor/router-model" },
      openai: { apiKey: "", model: "gpt-5.4" },
    },
  }));

  try {
    await scheduleSettingsAutosave({ immediate: true });
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
  }

  assert.equal(writes.length, 1);
  assert.equal(writes[0].aiProvider, "openai");
  assert.equal(writes[0].providerConfigs.openai.apiKey, "");
  assert.equal(writes[0].providerConfigs.openrouter.apiKey, "router-key");
  assert.equal(writes[0].apiKey, "");
  assert.equal(savedStatus.textContent, "Saved");
  assert.equal(savedStatus.dataset.state, "saved");
});
