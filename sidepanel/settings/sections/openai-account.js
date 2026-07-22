import { settings, setOpenRouterModels } from "../../state/store.js";
import { showToast } from "../../lib/toast.js";
import {
  cancelOpenAILogin,
  getOpenAIAuthStatus,
  logoutOpenAIAccount,
  openOpenAIDevicePage,
  pollOpenAILogin,
  startOpenAILogin,
} from "../../api/openai.js";
import { ensureProviderModelsLoaded, refreshProviderBadge } from "../../ui/model-picker.js";

let refreshTimer = null;
let refreshInFlight = false;
let lastReadyState = "";
let loginStartInFlight = false;

function setStatus(text, state = "") {
  const badge = document.getElementById("openai-oauth-status-badge");
  if (!badge) return;
  badge.textContent = text;
  badge.className = `mcp-bridge-badge${state ? ` ${state}` : ""}`;
}

function renderAccount(status) {
  const accountText = document.getElementById("openai-account-status");
  const linkButton = document.getElementById("openai-link-account-btn");
  const logoutButton = document.getElementById("openai-logout-btn");
  const linked = status?.linked === true;
  const account = status?.account;

  if (linked) {
    const identity = account?.email || "ChatGPT account";
    const plan = account?.planType ? ` · ${String(account.planType).replaceAll("_", " ")}` : "";
    if (accountText) accountText.textContent = `Linked as ${identity}${plan}`;
    setStatus("Linked", "connected");
  } else if (status?.pending) {
    if (accountText) accountText.textContent = "Finish sign-in on OpenAI, then return here.";
    setStatus("Waiting", "pending");
  } else {
    if (accountText) accountText.textContent = "No ChatGPT account linked.";
    setStatus("Not linked");
  }

  if (linkButton) {
    linkButton.textContent = linked ? "Relink ChatGPT" : status?.pending ? "Get new code" : "Link ChatGPT";
  }
  logoutButton?.classList.toggle("hidden", !linked);
}

function renderDeviceFlow(pending) {
  const panel = document.getElementById("openai-device-flow");
  const code = document.getElementById("openai-device-code");
  panel?.classList.toggle("hidden", !pending);
  if (code) code.textContent = pending?.userCode || "";
}

function syncProviderReadiness(status) {
  const next = status?.linked ? `ready:${status.account?.email || "account"}` : "not-ready";
  if (next === lastReadyState) return;
  lastReadyState = next;
  refreshProviderBadge();
  if (status?.linked) {
    setOpenRouterModels([]);
    ensureProviderModelsLoaded().catch(() => {});
  }
}

function renderStatus(status) {
  renderAccount(status);
  renderDeviceFlow(status?.pending || null);
  syncProviderReadiness(status);
}

async function refreshOpenAIStatus({ poll = false } = {}) {
  if (settings.aiProvider !== "openai" || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const status = poll ? await pollOpenAILogin() : await getOpenAIAuthStatus();
    renderStatus(status);
    if (poll && status.linked) showToast("ChatGPT account linked.");
  } catch (error) {
    setStatus("Sign-in error", "error");
    const accountText = document.getElementById("openai-account-status");
    if (accountText) accountText.textContent = error.message;
  } finally {
    refreshInFlight = false;
  }
}

function renderOpenAIAccountSettings() {
  document.getElementById("openai-subscription-panel")?.classList.toggle("hidden", settings.aiProvider !== "openai");
  refreshOpenAIStatus();
}

function initOpenAIAccountSettings() {
  const linkButton = document.getElementById("openai-link-account-btn");
  linkButton?.addEventListener("click", async () => {
    if (loginStartInFlight) return;
    loginStartInFlight = true;
    linkButton.disabled = true;
    try {
      setStatus("Starting", "pending");
      const pending = await startOpenAILogin();
      renderStatus({ linked: false, account: null, pending });
      showToast(`Enter code ${pending.userCode} on the OpenAI page.`);
    } catch (error) {
      setStatus("Sign-in error", "error");
      showToast(error.message);
    } finally {
      loginStartInFlight = false;
      linkButton.disabled = false;
    }
  });

  document.getElementById("openai-copy-code-btn")?.addEventListener("click", async () => {
    const code = document.getElementById("openai-device-code")?.textContent?.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast("OpenAI code copied.");
    } catch {
      showToast("Could not copy the code. Select it manually.");
    }
  });

  document.getElementById("openai-open-device-btn")?.addEventListener("click", async () => {
    try {
      await openOpenAIDevicePage();
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("openai-cancel-login-btn")?.addEventListener("click", async () => {
    try {
      renderStatus(await cancelOpenAILogin());
      showToast("OpenAI sign-in cancelled.");
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById("openai-logout-btn")?.addEventListener("click", async () => {
    try {
      renderStatus(await logoutOpenAIAccount());
      setOpenRouterModels([]);
      showToast("ChatGPT account unlinked from Margin.");
    } catch (error) {
      showToast(error.message);
    }
  });

  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (settings.aiProvider !== "openai") return;
    const status = await getOpenAIAuthStatus().catch(() => null);
    if (!status) return;
    if (status.pending) await refreshOpenAIStatus({ poll: true });
    else renderStatus(status);
  }, 4000);
}

export const openAIAccountSection = {
  render: renderOpenAIAccountSettings,
  init: initOpenAIAccountSettings,
};
