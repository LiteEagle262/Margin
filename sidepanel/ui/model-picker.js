import { settings, openRouterModels, setOpenRouterModels, openRouterModelsLoading, setOpenRouterModelsLoading, setOpenRouterEndpoints, isAgentRunning } from "../state/store.js";
import { escapeHtml, formatModelPrice, formatUsdBalance } from "../lib/format.js";
import { fetchCredits, fetchKeyBalance } from "../api/openrouter.js";
import { fetchProviderModels, getProviderLabel } from "../api/provider.js";
import { getOpenAIAuthStatus } from "../api/openai.js";
import { renderProviderRoutingSettings } from "../settings/sections/provider-routing.js";
import { syncReasoningForActiveModel } from "../settings/sections/reasoning.js";
import { updateUsageBar } from "./usage-bar.js";

let openRouterBalanceRequestId = 0;
let providerModelsRequestId = 0;
let openAIProviderReady = false;

export function isActiveProviderReady() {
  return settings.aiProvider === "openai" ? openAIProviderReady : Boolean(settings.apiKey);
}

export function updateModelBadge() {
  const activeModelBadge = document.getElementById("active-model-badge");
  const sendBtn = document.getElementById("send-btn");
  
  if (!activeModelBadge) return;
  
  if (!settings.dataSharingConsent) {
    activeModelBadge.textContent = "Consent";
    activeModelBadge.classList.remove("active");
    if (sendBtn && !isAgentRunning) sendBtn.disabled = true;
    return;
  }

  if (!isActiveProviderReady()) {
    activeModelBadge.textContent = settings.aiProvider === "openai" ? "Link OpenAI" : "No API Key";
    activeModelBadge.classList.remove("active");
    if (sendBtn && !isAgentRunning) sendBtn.disabled = true;
    return;
  }
  
  const displayModel = settings.model || "No model";
  activeModelBadge.textContent = displayModel.split("/").pop();
  activeModelBadge.classList.add("active");
  if (sendBtn && !isAgentRunning) sendBtn.disabled = false;
  updateUsageBar();
}


function setOpenRouterBalanceBadge(text, { state = "", title = "OpenRouter balance" } = {}) {
  const badge = document.getElementById("openrouter-balance-badge");
  if (!badge) return;

  // The session line renders its own accent "bal" key, mirroring the "model" key.
  badge.textContent = text.replace(/^Balance\s*/, "");
  badge.title = title;
  badge.setAttribute("aria-label", title);
  badge.classList.toggle("active", state === "active");
  badge.classList.toggle("loading", state === "loading");
  badge.classList.toggle("error", state === "error");
}

export async function refreshProviderBadge() {
  const requestId = ++openRouterBalanceRequestId;
  const badge = document.getElementById("openrouter-balance-badge");
  const reloadBtn = document.getElementById("reload-balance-btn");

  if (settings.aiProvider !== "openrouter") {
    badge?.classList.add("hidden");
    reloadBtn?.classList.add("hidden");
    try {
      const status = await getOpenAIAuthStatus();
      openAIProviderReady = status.linked === true;
    } catch {
      openAIProviderReady = false;
    }
    updateModelBadge();
    return;
  }
  openAIProviderReady = false;
  badge?.classList.remove("hidden");
  reloadBtn?.classList.remove("hidden");

  if (!settings.dataSharingConsent) {
    setOpenRouterBalanceBadge("Consent required", {
      title: "Accept the provider-processing disclosure before connecting OpenRouter"
    });
    return;
  }

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
    const credits = await fetchCredits(settings.apiKey);
    if (requestId !== openRouterBalanceRequestId) return;

    if (credits.ok) {
      const { totalCredits, totalUsage, balance } = credits;

      if (!Number.isFinite(balance)) {
        throw new Error("OpenRouter credits response did not include total credits and usage.");
      }

      setOpenRouterBalanceBadge(`Balance ${formatUsdBalance(balance)}`, {
        state: "active",
        title: `OpenRouter balance: ${formatUsdBalance(balance)} (${formatUsdBalance(totalUsage)} used of ${formatUsdBalance(totalCredits)})`
      });
      return;
    }

    const keyBalance = await fetchKeyBalance(settings.apiKey);
    if (requestId !== openRouterBalanceRequestId) return;

    if (keyBalance) {
      setOpenRouterBalanceBadge(keyBalance.label, {
        state: "active",
        title: keyBalance.title
      });
      return;
    }

    throw new Error(`OpenRouter credits error (${credits.status}): ${credits.errorText}`);
  } catch (err) {
    if (requestId !== openRouterBalanceRequestId) return;
    console.error("OpenRouter balance fetch error:", err);
    setOpenRouterBalanceBadge("Balance unavailable", {
      state: "error",
      title: err.message
    });
  }
}

export function getModelDisplayName(modelId) {
  const match = openRouterModels.find(m => m.id === modelId);
  return match ? match.name : modelId;
}

export function syncModelPickerValue() {
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

async function fetchActiveProviderModels() {
  const requestId = ++providerModelsRequestId;
  const providerId = settings.aiProvider;
  const apiKeyInput = document.getElementById("provider-api-key");
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : settings.apiKey;
  const providerLabel = getProviderLabel(providerId);
  if (!settings.dataSharingConsent) {
    setModelPickerStatus("Accept the data-sharing disclosure before connecting a provider.", true);
    return [];
  }
  if (providerId === "openai") {
    await refreshProviderBadge();
    if (requestId !== providerModelsRequestId || settings.aiProvider !== providerId) return [];
    if (!openAIProviderReady) {
      setModelPickerStatus("Link your ChatGPT account first.", true);
      return [];
    }
  } else if (!apiKey) {
    setModelPickerStatus(`Add your ${providerLabel} key above to load models.`, true);
    return [];
  }

  setOpenRouterModelsLoading(true);
  setModelPickerStatus(`Loading models from ${providerLabel}...`);

  try {
    const models = await fetchProviderModels(providerId, apiKey);
    const currentKey = document.getElementById("provider-api-key")?.value.trim() || settings.apiKey;
    if (
      requestId !== providerModelsRequestId ||
      settings.aiProvider !== providerId ||
      (providerId === "openrouter" && currentKey !== apiKey)
    ) return [];

    setOpenRouterModels(models);
    if (providerId === "openai" && !openRouterModels.some((model) => model.id === settings.model)) {
      const defaultModel = openRouterModels.find((model) => model.isDefault) || openRouterModels[0];
      if (defaultModel) {
        settings.model = defaultModel.id;
        settings.providerConfigs.openai.model = defaultModel.id;
        const selectedInput = document.getElementById("model-selected");
        if (selectedInput) selectedInput.value = defaultModel.id;
        document.getElementById("model-search")?.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    const reasoningSync = syncReasoningForActiveModel();
    if (reasoningSync.changed) {
      document.getElementById("reasoning-effort")?.dispatchEvent(new Event("change", { bubbles: true }));
    }

    setModelPickerStatus(`${openRouterModels.length} models loaded. Search to pick one.`);
    syncModelPickerValue();
    return openRouterModels;
  } catch (err) {
    console.error("Model fetch error:", err);
    setModelPickerStatus(err.message, true);
    return [];
  } finally {
    if (requestId === providerModelsRequestId) setOpenRouterModelsLoading(false);
  }
}

export async function ensureProviderModelsLoaded() {
  if (openRouterModels.length > 0 || openRouterModelsLoading) return;
  await fetchActiveProviderModels();
}

function filterModels(query) {
  const q = query.trim().toLowerCase();
  if (!q) return openRouterModels.slice(0, 50);

  return openRouterModels.filter(model => {
    const haystack = `${model.name || ""} ${model.id || ""} ${model.description || ""}`.toLowerCase();
    return haystack.includes(q);
  }).slice(0, 50);
}

function renderModelDropdown(models) {
  const dropdown = document.getElementById("model-dropdown");
  if (!dropdown) return;

  dropdown.innerHTML = "";

  if (!settings.dataSharingConsent) {
    dropdown.innerHTML = `<div class="model-dropdown-empty">Accept the data-sharing disclosure first.</div>`;
    dropdown.classList.remove("hidden");
    return;
  }

  if (!isActiveProviderReady() && !document.getElementById("provider-api-key")?.value.trim()) {
    dropdown.innerHTML = `<div class="model-dropdown-empty">${settings.aiProvider === "openai" ? "Link OpenAI to load models." : "Add your API key to load models."}</div>`;
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
    const supportsReasoning = (model.reasoning && typeof model.reasoning === "object") ||
      (Array.isArray(model.supported_parameters) && model.supported_parameters.includes("reasoning"));
    const inputModalities = Array.isArray(model.architecture?.input_modalities)
      ? model.architecture.input_modalities.filter(item => item && item !== "text").join("+")
      : "";
    const metaParts = [
      model.context_length ? `${Math.round(model.context_length / 1000)}k ctx` : "",
      formatModelPrice(model.pricing),
      inputModalities ? `input: ${inputModalities}` : "",
      supportsTools ? "tools" : "",
      supportsReasoning ? "reasoning" : ""
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
  settings.providerConfigs[settings.aiProvider].model = model.id;
  syncReasoningForActiveModel();
  if (modelSelected) modelSelected.value = model.id;
  if (modelSearch) modelSearch.value = model.name || model.id;
  if (dropdown) dropdown.classList.add("hidden");
  setOpenRouterEndpoints([]);
  settings.providerRouting.order = [];
  renderProviderRoutingSettings();
  modelSearch?.dispatchEvent(new Event("change", { bubbles: true }));
}

export function initModelPicker() {
  const modelSearch = document.getElementById("model-search");
  const modelPicker = document.getElementById("model-picker");
  const refreshBtn = document.getElementById("refresh-models-btn");
  const apiKeyInput = document.getElementById("provider-api-key");
  let searchTimer = null;

  if (!modelSearch) return;

  syncModelPickerValue();

  modelSearch.addEventListener("focus", async () => {
    await ensureProviderModelsLoaded();
    renderModelDropdown(filterModels(modelSearch.value));
  });

  modelSearch.addEventListener("input", () => {
    const modelSelected = document.getElementById("model-selected");
    if (modelSelected) modelSelected.value = "";
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
      } else {
        const customModelId = modelSearch.value.trim();
        if (customModelId) {
          settings.model = customModelId;
          settings.providerConfigs[settings.aiProvider].model = customModelId;
          syncReasoningForActiveModel();
          const modelSelected = document.getElementById("model-selected");
          if (modelSelected) modelSelected.value = customModelId;
          if (dropdown) dropdown.classList.add("hidden");
          setModelPickerStatus(`Using custom model ID: ${customModelId}`);
          modelSearch.dispatchEvent(new Event("change", { bubbles: true }));
        }
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
      setOpenRouterModels([]);
      await fetchActiveProviderModels();
      renderModelDropdown(filterModels(modelSearch.value));
    });
  }

  if (apiKeyInput) {
    apiKeyInput.addEventListener("change", () => {
      if (settings.aiProvider !== "openrouter") return;
      setOpenRouterModels([]);
      settings.apiKey = apiKeyInput.value.trim();
      settings.providerConfigs[settings.aiProvider].apiKey = settings.apiKey;
      updateModelBadge();
      refreshProviderBadge();
    });
  }
}
