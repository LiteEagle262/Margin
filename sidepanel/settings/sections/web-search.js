import { settings } from "../../state/store.js";
import { normalizeWebSearchSettings } from "../../api/tavily.js";
import { renderToolAccessSettings } from "./tool-access.js";

function renderWebSearchSettings() {
  const enabledInput = document.getElementById("web-search-enabled");
  const providerInput = document.getElementById("web-search-provider");
  const keyInput = document.getElementById("web-search-api-key");
  const depthInput = document.getElementById("web-search-depth");
  const maxInput = document.getElementById("web-search-max-results");
  const answerInput = document.getElementById("web-search-include-answer");
  const badge = document.getElementById("web-search-status-badge");

  const config = normalizeWebSearchSettings(settings.webSearch);
  if (enabledInput) enabledInput.checked = config.enabled;
  if (providerInput) providerInput.value = config.provider;
  if (keyInput) keyInput.value = config.apiKey;
  if (depthInput) depthInput.value = config.searchDepth;
  if (maxInput) maxInput.value = String(config.maxResults);
  if (answerInput) answerInput.checked = config.includeAnswer;

  if (badge) {
    const ready = config.enabled && Boolean(config.apiKey);
    badge.textContent = ready ? "Tavily on" : (config.enabled ? "Needs key" : "Off");
    badge.className = ready ? "mcp-bridge-badge connected" : (config.enabled ? "mcp-bridge-badge pending" : "mcp-bridge-badge");
  }
}

function collectWebSearchFromUI() {
  const enabledInput = document.getElementById("web-search-enabled");
  const providerInput = document.getElementById("web-search-provider");
  const keyInput = document.getElementById("web-search-api-key");
  const depthInput = document.getElementById("web-search-depth");
  const maxInput = document.getElementById("web-search-max-results");
  const answerInput = document.getElementById("web-search-include-answer");

  return normalizeWebSearchSettings({
    enabled: enabledInput ? enabledInput.checked === true : settings.webSearch?.enabled,
    provider: providerInput ? providerInput.value : settings.webSearch?.provider,
    apiKey: keyInput ? keyInput.value : settings.webSearch?.apiKey,
    searchDepth: depthInput ? depthInput.value : settings.webSearch?.searchDepth,
    maxResults: maxInput ? maxInput.value : settings.webSearch?.maxResults,
    includeAnswer: answerInput ? answerInput.checked === true : settings.webSearch?.includeAnswer
  });
}

function initWebSearchSettings() {
  const ids = [
    "web-search-enabled",
    "web-search-provider",
    "web-search-api-key",
    "web-search-depth",
    "web-search-max-results",
    "web-search-include-answer"
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    const syncWebSearchSettings = () => {
      settings.webSearch = collectWebSearchFromUI();
      renderWebSearchSettings();
      renderToolAccessSettings();
    };
    el?.addEventListener("change", syncWebSearchSettings);
    if (el?.tagName === "INPUT") {
      el.addEventListener("input", syncWebSearchSettings);
    }
  });
}

export const webSearchSection = {
  key: "webSearch",
  normalize: normalizeWebSearchSettings,
  render: renderWebSearchSettings,
  collect: collectWebSearchFromUI,
  init: initWebSearchSettings
};
