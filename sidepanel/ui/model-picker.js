// sidepanel/ui/model-picker.js - Model search/picker dropdown, active-model
// badge, and the OpenRouter balance badge.

import { settings, openRouterModels, setOpenRouterModels, openRouterModelsLoading, setOpenRouterModelsLoading, setOpenRouterEndpoints, isAgentRunning } from "../state/store.js";
import { escapeHtml, formatModelPrice, formatUsdBalance } from "../lib/format.js";
import { fetchModels, fetchCredits, fetchKeyBalance } from "../api/openrouter.js";
import { renderProviderRoutingSettings } from "../settings/sections/provider-routing.js";
import { updateUsageBar } from "./usage-bar.js";

let openRouterBalanceRequestId = 0;

export function updateModelBadge() {
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
  badge.setAttribute("aria-label", title);
  badge.classList.toggle("active", state === "active");
  badge.classList.toggle("loading", state === "loading");
  badge.classList.toggle("error", state === "error");
}

export async function refreshOpenRouterBalance() {
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

// ----------------------------------------------------
// OPENROUTER MODEL PICKER
// ----------------------------------------------------
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

async function fetchOpenRouterModels() {
  const apiKeyInput = document.getElementById("openrouter-api-key");
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : settings.apiKey;
  if (!apiKey) {
    setModelPickerStatus("Add your OpenRouter API key above to load models.", true);
    return [];
  }

  setOpenRouterModelsLoading(true);
  setModelPickerStatus("Loading models from OpenRouter...");

  try {
    setOpenRouterModels(await fetchModels(apiKey));

    setModelPickerStatus(`${openRouterModels.length} models loaded. Search to pick one.`);
    syncModelPickerValue();
    return openRouterModels;
  } catch (err) {
    console.error("Model fetch error:", err);
    setModelPickerStatus(err.message, true);
    return [];
  } finally {
    setOpenRouterModelsLoading(false);
  }
}

export async function ensureOpenRouterModelsLoaded() {
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
    const inputModalities = Array.isArray(model.architecture?.input_modalities)
      ? model.architecture.input_modalities.filter(item => item && item !== "text").join("+")
      : "";
    const metaParts = [
      model.context_length ? `${Math.round(model.context_length / 1000)}k ctx` : "",
      formatModelPrice(model.pricing),
      inputModalities ? `input: ${inputModalities}` : "",
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
  setOpenRouterEndpoints([]);
  settings.providerRouting.order = [];
  renderProviderRoutingSettings();
}

export function initModelPicker() {
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
      setOpenRouterModels([]);
      await fetchOpenRouterModels();
      renderModelDropdown(filterModels(modelSearch.value));
    });
  }

  if (apiKeyInput) {
    apiKeyInput.addEventListener("change", () => {
      setOpenRouterModels([]);
      settings.apiKey = apiKeyInput.value.trim();
      updateModelBadge();
      refreshOpenRouterBalance();
    });
  }
}
