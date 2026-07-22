import {
  settings,
  openRouterModels,
  openRouterEndpoints,
  openRouterEndpointsLoading,
  setOpenRouterEndpoints,
  setOpenRouterEndpointsLoading
} from "../../state/store.js";
import {
  escapeHtml,
  formatEndpointPrice,
  formatPercent,
  formatLatency,
  formatThroughput,
  endpointFeatureSummary
} from "../../lib/format.js";
import { fetchModelEndpoints, modelEndpointsUrl } from "../../api/openrouter.js";

const PROVIDER_ROUTING_MODES = new Set(["auto", "ordered", "price", "throughput", "latency"]);

function normalizeProviderSlug(value) {
  return String(value || "").trim();
}

function endpointSlug(endpoint) {
  return normalizeProviderSlug(endpoint?.tag || endpoint?.provider_slug || endpoint?.provider || endpoint?.name || endpoint?.provider_name);
}

export function normalizeProviderRoutingSettings(raw) {
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

export function buildProviderPreferences() {
  if (settings.aiProvider !== "openrouter") return null;
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

function setProviderRoutingStatus(message, isError = false) {
  const statusEl = document.getElementById("provider-routing-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? "var(--danger)" : "";
}

export function renderProviderRoutingSettings() {
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
  if (settings.aiProvider !== "openrouter") return [];
  const apiKeyInput = document.getElementById("provider-api-key");
  const apiKey = apiKeyInput ? apiKeyInput.value.trim() : settings.apiKey;
  const modelId = selectedModelIdFromUI();
  const url = modelEndpointsUrl(modelId);

  if (!settings.dataSharingConsent) {
    setProviderRoutingStatus("Accept the provider-processing disclosure before connecting OpenRouter.", true);
    return [];
  }
  if (!apiKey) {
    setProviderRoutingStatus("Add your OpenRouter API key above to load provider endpoints.", true);
    return [];
  }
  if (!url) {
    setProviderRoutingStatus("Pick an OpenRouter model before loading providers.", true);
    return [];
  }

  setOpenRouterEndpointsLoading(true);
  renderProviderRoutingSettings();
  setProviderRoutingStatus("Loading provider endpoints from OpenRouter...");

  try {
    const endpoints = await fetchModelEndpoints(apiKey, modelId);
    setOpenRouterEndpoints(endpoints
      .filter(endpoint => endpointSlug(endpoint))
      .sort((a, b) => (a.provider_name || a.name || endpointSlug(a)).localeCompare(b.provider_name || b.name || endpointSlug(b))));
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
    setOpenRouterEndpointsLoading(false);
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

export const providerRoutingSection = {
  key: "providerRouting",
  normalize: normalizeProviderRoutingSettings,
  render: renderProviderRoutingSettings,
  collect: collectProviderRoutingFromUI,
  init: initProviderRoutingSettings
};
