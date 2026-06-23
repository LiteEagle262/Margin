// sidepanel/ui/latch-tab.js - Latch the agent to a specific browser tab.

import { showToast } from "../lib/toast.js";

// ----------------------------------------------------
// LATCH TO TAB
// ----------------------------------------------------
// "Latched" means every browser tool (get_dom, click, screenshot, run_js, etc.)
// operates on a fixed tabId instead of whatever happens to be in focus. This
// lets the user keep working on a scraper for one page while clicking around
// in other tabs to look things up.
export function initLatchTab() {
  const latchBtn = document.getElementById("latch-tab-btn");
  const unlatchBtn = document.getElementById("unlatch-tab-btn");
  const focusBtn = document.getElementById("focus-latched-tab-btn");

  if (latchBtn) {
    latchBtn.addEventListener("click", async () => {
      const existing = await getLatchedTab();
      if (existing) {
        await chrome.runtime.sendMessage({ type: "latch-tab/clear" });
        showToast("Unlatched");
      } else {
        const res = await chrome.runtime.sendMessage({ type: "latch-tab/set" });
        if (res?.ok && res.tab) {
          const label = res.tab.title || res.tab.url || "tab";
          showToast(`Latched to ${label.slice(0, 40)}`);
        } else {
          showToast("Failed to latch: " + (res?.error || "no active tab"));
        }
      }
      await renderLatchedTab();
    });
  }

  if (unlatchBtn) {
    unlatchBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "latch-tab/clear" });
      showToast("Unlatched");
      await renderLatchedTab();
    });
  }

  if (focusBtn) {
    focusBtn.addEventListener("click", async () => {
      const tab = await getLatchedTab();
      if (!tab) return;
      try {
        await chrome.tabs.update(tab.tabId, { active: true });
        if (typeof tab.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch (e) {
        showToast("Could not focus tab (it may be closed)");
        await chrome.runtime.sendMessage({ type: "latch-tab/clear" });
        await renderLatchedTab();
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && changes.latchedTab) {
      renderLatchedTab();
    }
  });

  renderLatchedTab();
}

export async function getLatchedTab() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "latch-tab/get" });
    return res?.tab || null;
  } catch {
    return null;
  }
}

export async function renderLatchedTab() {
  const latchBtn = document.getElementById("latch-tab-btn");
  const latchedBar = document.getElementById("latched-tab-bar");
  const latchedText = document.getElementById("latched-tab-text");

  const tab = await getLatchedTab();

  if (tab) {
    if (latchBtn) {
      latchBtn.classList.add("latched");
      latchBtn.title = `Latched to: ${tab.title || tab.url}. Click to unlatch.`;
    }
    if (latchedBar) latchedBar.classList.remove("hidden");
    if (latchedText) {
      let host = "";
      try { host = new URL(tab.url).host; } catch { host = ""; }
      const title = (tab.title || "").trim();
      latchedText.textContent = title
        ? (host ? `${title} — ${host}` : title)
        : (host || tab.url || "Tab");
      latchedText.title = tab.url || title;
    }
  } else {
    if (latchBtn) {
      latchBtn.classList.remove("latched");
      latchBtn.title = "Latch extension to current tab";
    }
    if (latchedBar) latchedBar.classList.add("hidden");
  }
}
