// shared/browser-tools.js - Browser automation tools for ScrapeFlow
// Used by background.js (MCP bridge) via importScripts.

importScripts("shared/network-logs.js");

// Returns the latched tab record from session storage if any, else null.
// Auto-clears the entry if the tab no longer exists.
async function getLatchedTabRecord() {
  try {
    const stored = await chrome.storage.session.get(["latchedTab"]);
    const latched = stored.latchedTab;
    if (!latched || typeof latched.tabId !== "number") return null;
    try {
      const tab = await chrome.tabs.get(latched.tabId);
      return tab ? { tabId: tab.id, url: tab.url || latched.url || "", title: tab.title || latched.title || "", windowId: tab.windowId } : null;
    } catch {
      await chrome.storage.session.remove("latchedTab");
      return null;
    }
  } catch {
    return null;
  }
}

// All browser tools route through this. When a tab is latched, every tool
// targets that tab — even when the user has navigated to a different tab in
// the foreground. When no latch is set, falls back to the active tab.
async function getActiveTabId() {
  const latched = await getLatchedTabRecord();
  if (latched) return latched.tabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function getActiveTabInfo() {
  const latched = await getLatchedTabRecord();
  if (latched) {
    return {
      id: latched.tabId,
      url: latched.url,
      title: latched.title,
      windowId: latched.windowId,
      latched: true
    };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return {
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    windowId: tab.windowId,
    latched: false
  };
}

async function listOpenTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(tab => ({
    id: tab.id,
    url: tab.url || "",
    title: tab.title || "",
    active: tab.active === true
  }));
}

async function navigateActiveTab(url) {
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error("No active tab in current window.");
  await chrome.tabs.update(tabId, { url });
  return `Navigated active tab to ${url}`;
}

async function runScriptInActiveTab(func, args = []) {
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error("No active tab in current window.");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return results && results[0] ? results[0].result : null;
}

async function runJsViaDebugger(code) {
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error("No active tab in current window.");

  const keepAttached = isNetworkCaptureActive(tabId);

  return new Promise((resolve) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("Already attached") && !err.message.includes("debugger is already attached")) {
        resolve(`Error attaching debugger: ${err.message}`);
        return;
      }

      chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: code,
        returnByValue: true,
        awaitPromise: true
      }, (result) => {
        const cmdErr = chrome.runtime.lastError;

        const finish = (value) => {
          if (keepAttached) {
            resolve(value);
            return;
          }
          chrome.debugger.detach({ tabId }, () => {
            void chrome.runtime.lastError;
            resolve(value);
          });
        };

        if (cmdErr) {
          finish(`Error executing script: ${cmdErr.message}`);
          return;
        }

        if (result.exceptionDetails) {
          const desc = result.exceptionDetails.exception
            ? result.exceptionDetails.exception.description
            : "Execution threw an exception";
          finish(`Error executing script: ${desc}`);
        } else {
          const resObj = result.result || {};
          if (resObj.value !== undefined) {
            finish(typeof resObj.value === "object" ? JSON.stringify(resObj.value) : String(resObj.value));
          } else if (resObj.description !== undefined) {
            finish(String(resObj.description));
          } else {
            finish(String(resObj.type || "undefined"));
          }
        }
      });
    });
  });
}

// Capture a screenshot of an arbitrary tab (even when not the foreground tab)
// via the debugger. captureVisibleTab cannot reach background tabs.
async function captureTabViaDebugger(tabId) {
  const keepAttached = isNetworkCaptureActive(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("Already attached") && !err.message.includes("debugger is already attached")) {
        reject(new Error(err.message));
        return;
      }
      const finish = (fn) => {
        if (keepAttached) { fn(); return; }
        chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; fn(); });
      };
      chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png" }, (result) => {
        const cmdErr = chrome.runtime.lastError;
        if (cmdErr) {
          finish(() => reject(new Error(cmdErr.message)));
          return;
        }
        if (!result || !result.data) {
          finish(() => reject(new Error("No screenshot data returned")));
          return;
        }
        finish(() => resolve(`data:image/png;base64,${result.data}`));
      });
    });
  });
}

async function executePageTool(name, args = {}) {
  try {
    switch (name) {
      case "get_active_tab": {
        const tab = await getActiveTabInfo();
        if (!tab) return "Error: No active tab found.";
        return JSON.stringify(tab, null, 2);
      }

      case "list_tabs": {
        const tabs = await listOpenTabs();
        return JSON.stringify(tabs, null, 2);
      }

      case "navigate": {
        if (!args.url) return "Error: navigate requires url.";
        return await navigateActiveTab(String(args.url));
      }

      case "get_dom": {
        const domResult = await runScriptInActiveTab(() => {
          const bodyText = document.body ? document.body.innerText : "";
          const outerHtml = document.documentElement ? document.documentElement.outerHTML : "";
          return {
            bodyText: bodyText.slice(0, 15000),
            outerHtml: outerHtml.slice(0, 80000)
          };
        });
        if (!domResult) return "Error: Failed to extract DOM content.";
        return `Successfully fetched DOM.
Text content:
${domResult.bodyText}

HTML markup (truncated to 80k characters):
${domResult.outerHtml}`;
      }

      case "take_screenshot": {
        const tabId = await getActiveTabId();
        if (!tabId) return "Error: No active tab found to capture.";
        let tab;
        try {
          tab = await chrome.tabs.get(tabId);
        } catch {
          return "Error: Target tab is no longer available.";
        }
        let screenshotDataUrl;
        let note = "Screenshot captured successfully.";
        if (tab.active) {
          screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        } else {
          // Latched tab isn't currently visible — use the debugger to capture it.
          screenshotDataUrl = await captureTabViaDebugger(tabId);
          note = "Screenshot captured from latched (background) tab.";
        }
        return {
          screenshot: screenshotDataUrl,
          message: note
        };
      }

      case "click_element": {
        const clickRes = await runScriptInActiveTab((selector) => {
          const el = document.querySelector(selector);
          if (el) {
            el.click();
            return `Successfully clicked element matching: "${selector}"`;
          }
          return `Error: Element matching selector "${selector}" was not found.`;
        }, [args.selector]);
        return clickRes;
      }

      case "scroll_page": {
        const scrollAmount = args.amount || 500;
        const scrollRes = await runScriptInActiveTab((direction, amount) => {
          window.scrollBy(0, direction === "up" ? -amount : amount);
          return `Successfully scrolled page ${direction} by ${amount}px.`;
        }, [args.direction, scrollAmount]);
        return scrollRes;
      }

      case "type_text": {
        const typeRes = await runScriptInActiveTab((selector, text) => {
          const el = document.querySelector(selector);
          if (el) {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return `Successfully typed text into element matching "${selector}"`;
          }
          return `Error: Input element matching selector "${selector}" was not found.`;
        }, [args.selector, args.text]);
        return typeRes;
      }

      case "run_js": {
        return await runJsViaDebugger(args.code);
      }

      case "start_network_capture":
      case "stop_network_capture":
      case "get_network_logs":
      case "get_network_log_detail":
      case "clear_network_logs": {
        const tabId = await getActiveTabId();
        return await executeNetworkTool(name, args, tabId);
      }

      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error executing tool "${name}": ${err.message}`;
  }
}

function formatToolResultForMcp(result) {
  if (typeof result === "object" && result && result.screenshot) {
    const base64 = String(result.screenshot).replace(/^data:image\/png;base64,/, "");
    return {
      content: [
        { type: "text", text: result.message || "Screenshot captured." },
        { type: "image", data: base64, mimeType: "image/png" }
      ],
      isError: false
    };
  }

  const text = typeof result === "string" ? result : JSON.stringify(result);
  const isError = text.startsWith("Error:");
  return {
    content: [{ type: "text", text }],
    isError
  };
}
