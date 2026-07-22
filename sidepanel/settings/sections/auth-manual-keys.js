import { settings } from "../../state/store.js";
import { escapeHtml } from "../../lib/format.js";
import { showToast } from "../../lib/toast.js";

function normalizeAuthDomain(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/^www\./, "")
      .trim();
  }
}

function normalizeAuthManualKey(value) {
  return String(value || "")
    .replace(/^otpauth:\/\/totp\/[^?]+\?/i, "")
    .replace(/.*(?:^|[?&])secret=([^&]+).*/i, "$1")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export function normalizeAuthManualKeys(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return Object.entries(source).reduce((acc, [domain, key]) => {
    const normalizedDomain = normalizeAuthDomain(domain);
    const normalizedKey = normalizeAuthManualKey(key);
    if (normalizedDomain && normalizedKey) acc[normalizedDomain] = normalizedKey;
    return acc;
  }, {});
}

async function getCurrentTabDomain() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "page-tool", name: "get_active_tab", arguments: {} });
    const payload = typeof response?.result === "string" ? JSON.parse(response.result) : response?.result;
    return normalizeAuthDomain(payload?.url || "");
  } catch {
    return "";
  }
}

function createAuthManualKeyRow(domain = "", manualKey = "") {
  const row = document.createElement("div");
  row.className = "auth-key-row";
  row.innerHTML = `
    <input type="text" class="auth-domain-input" placeholder="example.com" value="${escapeHtml(domain)}" autocomplete="off">
    <input type="password" class="auth-secret-input" placeholder="manual key" value="${escapeHtml(manualKey)}" autocomplete="off">
    <button type="button" class="mcp-remove-btn auth-remove-btn">Remove</button>
  `;
  row.querySelector(".auth-remove-btn")?.addEventListener("click", () => {
    const list = row.parentElement;
    row.remove();
    list?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return row;
}

function renderAuthManualKeys() {
  const list = document.getElementById("auth-manual-keys-list");
  const badge = document.getElementById("auth-manual-keys-badge");
  if (!list) return;

  const entries = Object.entries(normalizeAuthManualKeys(settings.authManualKeys))
    .sort(([a], [b]) => a.localeCompare(b));
  list.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mcp-status";
    empty.textContent = "No authenticator manual keys saved.";
    list.appendChild(empty);
  } else {
    entries.forEach(([domain, manualKey]) => {
      list.appendChild(createAuthManualKeyRow(domain, manualKey));
    });
  }

  if (badge) {
    badge.textContent = entries.length === 0 ? "None" : `${entries.length} saved`;
    badge.className = entries.length === 0 ? "mcp-bridge-badge" : "mcp-bridge-badge connected";
  }
}

function collectAuthManualKeysFromUI() {
  const list = document.getElementById("auth-manual-keys-list");
  if (!list) return normalizeAuthManualKeys(settings.authManualKeys);

  const keys = {};
  list.querySelectorAll(".auth-key-row").forEach((row) => {
    const domain = normalizeAuthDomain(row.querySelector(".auth-domain-input")?.value);
    const manualKey = normalizeAuthManualKey(row.querySelector(".auth-secret-input")?.value);
    if (domain && manualKey) keys[domain] = manualKey;
  });
  return keys;
}

function addAuthManualKeyRow(domain = "", manualKey = "") {
  const list = document.getElementById("auth-manual-keys-list");
  if (!list) return;
  if (!list.querySelector(".auth-key-row")) list.innerHTML = "";
  list.appendChild(createAuthManualKeyRow(domain, manualKey));
  list.dispatchEvent(new Event("change", { bubbles: true }));
}

function initAuthManualKeySettings() {
  const addCurrentBtn = document.getElementById("add-current-domain-auth-key-btn");
  const addComboBtn = document.getElementById("add-auth-combo-btn");
  const comboInput = document.getElementById("auth-domain-key-combo");

  addCurrentBtn?.addEventListener("click", async () => {
    const domain = await getCurrentTabDomain();
    if (!domain) {
      showToast("No active website domain found");
      return;
    }
    addAuthManualKeyRow(domain, "");
    showToast(`Added ${domain}`);
  });

  addComboBtn?.addEventListener("click", () => {
    const value = comboInput?.value || "";
    const parts = value.split(/\s*:\s*/);
    if (parts.length < 2) {
      showToast("Use domain : manual key");
      return;
    }
    const domain = normalizeAuthDomain(parts.shift());
    const manualKey = normalizeAuthManualKey(parts.join(":"));
    if (!domain || !manualKey) {
      showToast("Domain and manual key are required");
      return;
    }
    addAuthManualKeyRow(domain, manualKey);
    if (comboInput) comboInput.value = "";
    showToast(`Added ${domain}`);
  });
}

export const authManualKeysSection = {
  key: "authManualKeys",
  normalize: normalizeAuthManualKeys,
  render: renderAuthManualKeys,
  collect: collectAuthManualKeysFromUI,
  init: initAuthManualKeySettings
};
