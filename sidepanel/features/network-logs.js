import { downloadTextFile } from "../lib/download.js";
import { showToast } from "../lib/toast.js";

let currentSnapshot = null;

function sendNetworkSnapshotRequest(includeBody = false) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: "network-logs/snapshot",
      arguments: { include_body: includeBody }
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Could not load network logs."));
        return;
      }
      resolve(response.result);
    });
  });
}

function formatStatus(entry) {
  if (entry.failed) return "failed";
  if (entry.status == null) return "pending";
  return String(entry.status);
}

function statusClass(entry) {
  if (entry.failed) return "failed";
  const status = Number(entry.status);
  if (!Number.isFinite(status)) return "pending";
  if (status >= 500) return "error";
  if (status >= 400) return "warning";
  if (status >= 300) return "redirect";
  if (status >= 200) return "success";
  return "pending";
}

function matchesStatusFilter(entry, filter) {
  if (!filter) return true;
  if (filter === "failed") return entry.failed === true;
  const status = Number(entry.status);
  if (!Number.isFinite(status)) return false;
  const bucket = Math.floor(status / 100);
  return filter === `${bucket}xx`;
}

function entrySearchText(entry) {
  return [
    entry.method,
    entry.url,
    entry.type,
    entry.status,
    entry.statusText,
    entry.mimeType,
    entry.failureReason
  ].filter(value => value != null).join(" ").toLowerCase();
}

function filteredEntries() {
  const entries = currentSnapshot?.entries || [];
  const searchInput = document.getElementById("network-logs-search");
  const statusFilter = document.getElementById("network-logs-status-filter");
  const needle = String(searchInput?.value || "").trim().toLowerCase();
  const status = statusFilter?.value || "";

  return entries.filter((entry) => {
    if (!matchesStatusFilter(entry, status)) return false;
    if (!needle) return true;
    return entrySearchText(entry).includes(needle);
  });
}

function renderNetworkLogs() {
  const list = document.getElementById("network-logs-list");
  const meta = document.getElementById("network-logs-meta");
  if (!list || !meta) return;

  const entries = filteredEntries();
  const total = currentSnapshot?.totalBufferedForTab || 0;
  const tab = currentSnapshot?.tab;
  const target = tab?.title || tab?.url || "current tab";
  meta.textContent = currentSnapshot
    ? `${entries.length} shown of ${total} buffered for ${target}`
    : "No logs loaded";

  if (!currentSnapshot) {
    list.innerHTML = `<div class="network-logs-empty">Open this viewer again after capture has started.</div>`;
    return;
  }

  if (entries.length === 0) {
    list.innerHTML = `<div class="network-logs-empty">No network logs match the current filters.</div>`;
    return;
  }

  list.replaceChildren(...entries.slice().reverse().map((entry) => {
    const item = document.createElement("details");
    item.className = "network-log-item";

    const summary = document.createElement("summary");
    summary.className = "network-log-summary";

    const status = document.createElement("span");
    status.className = `network-log-status ${statusClass(entry)}`;
    status.textContent = formatStatus(entry);

    const method = document.createElement("span");
    method.className = "network-log-method";
    method.textContent = entry.method || "GET";

    const url = document.createElement("span");
    url.className = "network-log-url";
    url.textContent = entry.url || "";

    const type = document.createElement("span");
    type.className = "network-log-type";
    type.textContent = entry.type || "other";

    summary.append(status, method, url, type);

    const detail = document.createElement("pre");
    detail.className = "network-log-detail";
    detail.textContent = JSON.stringify(entry, null, 2);

    item.append(summary, detail);
    return item;
  }));
}

function setBusy(isBusy) {
  [
    "header-network-logs-btn",
    "view-network-logs-btn",
    "download-network-logs-btn",
    "network-logs-refresh-btn",
    "network-logs-download-btn"
  ].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = isBusy;
    button.classList.toggle("is-busy", isBusy);
  });
}

function openNetworkLogsOverlay() {
  const overlay = document.getElementById("network-logs-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function closeNetworkLogsOverlay() {
  const overlay = document.getElementById("network-logs-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  setTimeout(() => overlay.classList.add("hidden"), 160);
}

async function loadNetworkLogsForViewer() {
  setBusy(true);
  try {
    currentSnapshot = await sendNetworkSnapshotRequest(false);
    openNetworkLogsOverlay();
    renderNetworkLogs();
    if (!currentSnapshot.entries?.length) {
      showToast("No network logs available for this tab.");
    }
  } catch (err) {
    console.error("Could not load network logs:", err);
    showToast("Could not load network logs: " + (err.message || "unknown error"));
  } finally {
    setBusy(false);
  }
}

async function downloadCurrentNetworkLogs() {
  setBusy(true);
  try {
    const snapshot = await sendNetworkSnapshotRequest(true);
    const exported = {
      exportType: "margin-network-logs",
      exportedAt: new Date().toISOString(),
      ...snapshot
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(
      `margin-network-logs-${stamp}.json`,
      JSON.stringify(exported, null, 2),
      "application/json;charset=utf-8"
    );
    showToast(`Downloaded ${snapshot.entries?.length || 0} network log${snapshot.entries?.length === 1 ? "" : "s"}.`);
  } catch (err) {
    console.error("Could not download network logs:", err);
    showToast("Could not download network logs: " + (err.message || "unknown error"));
  } finally {
    setBusy(false);
  }
}

export function initNetworkLogs() {
  const openButtons = [
    document.getElementById("header-network-logs-btn"),
    document.getElementById("view-network-logs-btn")
  ].filter(Boolean);
  openButtons.forEach((button) => button.addEventListener("click", loadNetworkLogsForViewer));

  document.getElementById("download-network-logs-btn")?.addEventListener("click", downloadCurrentNetworkLogs);
  document.getElementById("network-logs-download-btn")?.addEventListener("click", downloadCurrentNetworkLogs);
  document.getElementById("network-logs-refresh-btn")?.addEventListener("click", loadNetworkLogsForViewer);
  document.getElementById("network-logs-close-btn")?.addEventListener("click", closeNetworkLogsOverlay);
  document.getElementById("network-logs-search")?.addEventListener("input", renderNetworkLogs);
  document.getElementById("network-logs-status-filter")?.addEventListener("change", renderNetworkLogs);

  const overlay = document.getElementById("network-logs-overlay");
  overlay?.addEventListener("click", (event) => {
    if (event.target === overlay) closeNetworkLogsOverlay();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay && !overlay.classList.contains("hidden")) {
      closeNetworkLogsOverlay();
    }
  });
}
