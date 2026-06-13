// shared/browser-tools.js - Browser automation tools for ScrapeFlow
// Used by background.js (MCP bridge).

import { isNetworkCaptureActive, executeNetworkTool } from "./network-logs.js";

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
export async function getActiveTabId() {
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

function normalizeAuthenticatorDomain(value) {
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

function normalizeAuthenticatorSecret(value) {
  return String(value || "")
    .replace(/^otpauth:\/\/totp\/[^?]+\?/i, "")
    .replace(/.*(?:^|[?&])secret=([^&]+).*/i, "$1")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function decodeBase32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = normalizeAuthenticatorSecret(secret).replace(/=+$/g, "");
  let bits = "";
  const bytes = [];

  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      throw new Error("Manual key is not valid base32.");
    }
    bits += value.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      bytes.push(parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }

  if (bytes.length === 0) throw new Error("Manual key is empty.");
  return new Uint8Array(bytes);
}

async function generateTotp(secret, now = Date.now()) {
  const period = 30;
  const digits = 6;
  const counter = Math.floor(now / 1000 / period);
  const keyBytes = decodeBase32(secret);
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(4, counter, false);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = String(binary % (10 ** digits)).padStart(digits, "0");
  const secondsRemaining = period - (Math.floor(now / 1000) % period);
  return { code, period, digits, secondsRemaining };
}

async function getAuthenticatorKeyMap() {
  const stored = await chrome.storage.local.get(["authManualKeys"]);
  const raw = stored.authManualKeys && typeof stored.authManualKeys === "object" ? stored.authManualKeys : {};
  return Object.entries(raw).reduce((acc, [domain, key]) => {
    const normalizedDomain = normalizeAuthenticatorDomain(domain);
    const normalizedKey = normalizeAuthenticatorSecret(key);
    if (normalizedDomain && normalizedKey) acc[normalizedDomain] = normalizedKey;
    return acc;
  }, {});
}

function findAuthenticatorKeyForDomain(keys, domain) {
  if (keys[domain]) return { domain, manualKey: keys[domain] };
  const match = Object.keys(keys)
    .filter((savedDomain) => domain === savedDomain || domain.endsWith(`.${savedDomain}`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? { domain: match, manualKey: keys[match] } : null;
}

async function getCurrentAuthenticatorDomain(args = {}) {
  if (args.domain) return normalizeAuthenticatorDomain(args.domain);
  const tab = await getActiveTabInfo();
  return normalizeAuthenticatorDomain(tab?.url || "");
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

function toolOk(tool, message, data = {}) {
  return { ok: true, tool, message, data };
}

function toolError(tool, errorCode, message, data = {}) {
  return {
    ok: false,
    tool,
    error_code: errorCode,
    recoverable: data.recoverable !== false,
    message,
    data,
    next_actions: data.next_actions || [{ tool: "take_snapshot", reason: "Refresh page state and choose a current element uid." }]
  };
}

async function takePageSnapshot(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 80, 10), 200);
  const verbose = args.verbose === true;
  return await runScriptInActiveTab((snapshotArgs) => {
    const max = snapshotArgs.limit;
    const includeVerbose = snapshotArgs.verbose === true;
    const roleMap = {
      A: "link",
      BUTTON: "button",
      INPUT: "textbox",
      TEXTAREA: "textbox",
      SELECT: "combobox",
      OPTION: "option",
      SUMMARY: "button"
    };
    const interactiveSelector = [
      "a[href]", "button", "input", "textarea", "select", "option", "summary",
      "[role]", "[tabindex]", "[contenteditable='true']", "[onclick]"
    ].join(",");

    function hash(value) {
      let h = 2166136261;
      const text = String(value || "");
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36).slice(0, 6);
    }

    function cssPath(el) {
      if (!el || el.nodeType !== 1) return "";
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        const cls = Array.from(node.classList || []).slice(0, 2);
        if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    }

    function accessibleName(el) {
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy.split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      if (el.labels && el.labels.length) {
        const text = Array.from(el.labels).map((label) => label.innerText).join(" ").trim();
        if (text) return text;
      }
      if (el.alt) return String(el.alt).trim();
      if (el.placeholder) return String(el.placeholder).trim();
      if (el.title) return String(el.title).trim();
      return String(el.innerText || el.value || "").replace(/\s+/g, " ").trim();
    }

    function roleFor(el) {
      return el.getAttribute("role") || roleMap[el.tagName] || (el.isContentEditable ? "textbox" : "generic");
    }

    function isVisible(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const seen = new Set();
    let candidates = Array.from(document.querySelectorAll(interactiveSelector));
    if (includeVerbose) {
      candidates = candidates.concat(Array.from(document.querySelectorAll("h1,h2,h3,p,li,td,th,label")));
    }

    const elements = [];
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!includeVerbose && !isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const name = accessibleName(el).slice(0, 160);
      const role = roleFor(el);
      const selector = cssPath(el);
      const uid = `sf-${elements.length + 1}-${el.tagName.toLowerCase()}-${hash(`${role}|${name}|${selector}`)}`;
      elements.push({
        uid,
        role,
        name,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        selector,
        visible: isVisible(el),
        enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
        checked: typeof el.checked === "boolean" ? el.checked : undefined,
        value: ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ? String(el.value || "").slice(0, 120) : undefined,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
      if (elements.length >= max) break;
    }

    return {
      snapshot_id: `snap-${Date.now().toString(36)}`,
      url: location.href,
      title: document.title,
      text_preview: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1200),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      focused_uid: null,
      element_count: elements.length,
      elements
    };
  }, [{ limit, verbose }]);
}

async function maybeAttachSnapshot(result, args = {}) {
  if (!args.include_snapshot) return result;
  try {
    result.data = result.data || {};
    result.data.snapshot = await takePageSnapshot({ limit: 80, verbose: false });
  } catch (err) {
    result.data.snapshot_error = err.message;
  }
  return result;
}

async function interactWithElement(tool, args = {}, action = "click") {
  const result = await runScriptInActiveTab((input) => {
    function hash(value) {
      let h = 2166136261;
      const text = String(value || "");
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36).slice(0, 6);
    }
    function cssPath(el) {
      if (!el || el.nodeType !== 1) return "";
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let part = node.tagName.toLowerCase();
        const cls = Array.from(node.classList || []).slice(0, 2);
        if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    }
    function nameFor(el) {
      return (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || "").replace(/\s+/g, " ").trim();
    }
    function roleFor(el) {
      return el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox" }[el.tagName]) || "generic";
    }
    function isVisible(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }
    function uidFor(el, index) {
      const selector = cssPath(el);
      const name = nameFor(el).slice(0, 160);
      const role = roleFor(el);
      return `sf-${index + 1}-${el.tagName.toLowerCase()}-${hash(`${role}|${name}|${selector}`)}`;
    }
    function summarize(el, index) {
      const rect = el.getBoundingClientRect();
      return {
        uid: uidFor(el, index),
        role: roleFor(el),
        name: nameFor(el).slice(0, 120),
        tag: el.tagName.toLowerCase(),
        selector: cssPath(el),
        visible: isVisible(el),
        enabled: !el.disabled && el.getAttribute("aria-disabled") !== "true",
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    }
    const nodes = Array.from(document.querySelectorAll([
      "a[href]", "button", "input", "textarea", "select", "option", "summary",
      "[role]", "[tabindex]", "[contenteditable='true']", "[onclick]"
    ].join(",")));
    let el = null;
    let index = -1;
    if (input.uid) {
      index = nodes.findIndex((node, idx) => uidFor(node, idx) === input.uid);
      el = index >= 0 ? nodes[index] : null;
    }
    if (!el && input.selector) {
      el = document.querySelector(input.selector);
      index = Math.max(0, nodes.indexOf(el));
    }
    if (!el) {
      const needle = String(input.selector || input.uid || "").toLowerCase();
      const candidates = nodes
        .map((node, idx) => summarize(node, idx))
        .filter((item) => item.name.toLowerCase().includes(needle) || item.selector.toLowerCase().includes(needle))
        .slice(0, 8);
      return { ok: false, error_code: "target_not_found", message: "No matching element was found.", candidates };
    }
    if (!isVisible(el)) {
      return { ok: false, error_code: "target_not_visible", message: "Element exists but is not visible.", target: summarize(el, index) };
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: false, error_code: "target_disabled", message: "Element exists but is disabled.", target: summarize(el, index) };
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    el.focus?.();
    const target = summarize(el, index);
    if (input.action === "click") {
      if (input.dblClick) {
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
      } else {
        el.click();
      }
      return { ok: true, message: "Element clicked.", target };
    }
    if (input.action === "hover") {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
      return { ok: true, message: "Element hovered.", target };
    }
    if (input.action === "fill" || input.action === "type") {
      const value = String(input.value ?? input.text ?? "");
      const tag = el.tagName;
      const type = String(el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        el.checked = value === "true" || value === "1" || value.toLowerCase() === "yes";
      } else if (tag === "SELECT") {
        el.value = value;
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, message: "Element value set.", target, value };
    }
    return { ok: false, error_code: "unknown_action", message: `Unknown action ${input.action}.`, target };
  }, [{ ...args, action }]);

  if (!result || result.ok !== true) {
    return toolError(tool, result?.error_code || "action_failed", result?.message || "Element action failed.", {
      target: result?.target,
      candidates: result?.candidates || [],
      next_actions: result?.candidates?.length
        ? [{ tool: "click_element", reason: "Retry with one of the returned candidate uids." }, { tool: "take_snapshot", reason: "Refresh page state." }]
        : [{ tool: "take_snapshot", reason: "Refresh page state and choose a current element uid." }]
    });
  }
  return await maybeAttachSnapshot(toolOk(tool, result.message, { target: result.target, value: result.value }), args);
}

async function pressKeyInActiveTab(args = {}) {
  const key = String(args.key || "").trim();
  if (!key) return toolError("press_key", "missing_key", "press_key requires key.", { recoverable: false });
  const result = await runScriptInActiveTab((keyText) => {
    const parts = keyText.split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.pop() || keyText;
    const init = {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: parts.includes("Control"),
      shiftKey: parts.includes("Shift"),
      altKey: parts.includes("Alt"),
      metaKey: parts.includes("Meta")
    };
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { activeTag: target?.tagName || "", key };
  }, [key]);
  return await maybeAttachSnapshot(toolOk("press_key", `Pressed ${key}.`, result), args);
}

async function waitForPageState(args = {}) {
  const timeout = Math.min(Math.max(Number(args.timeout) || 8000, 250), 60000);
  const result = await runScriptInActiveTab((input) => {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const textOk = input.text ? (document.body?.innerText || "").includes(input.text) : true;
        const selectorOk = input.selector ? !!document.querySelector(input.selector) : true;
        const urlOk = input.url_contains ? location.href.includes(input.url_contains) : true;
        if (textOk && selectorOk && urlOk) {
          resolve({ ok: true, url: location.href, elapsed_ms: Date.now() - start });
          return;
        }
        if (Date.now() - start >= input.timeout) {
          resolve({
            ok: false,
            url: location.href,
            elapsed_ms: Date.now() - start,
            text_matched: textOk,
            selector_matched: selectorOk,
            url_matched: urlOk,
            text_preview: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500)
          });
          return;
        }
        setTimeout(check, 150);
      };
      check();
    });
  }, [{ ...args, timeout }]);
  if (!result?.ok) {
    return toolError("wait_for", "timeout", "Timed out waiting for requested page state.", {
      ...result,
      next_actions: [{ tool: "take_snapshot", reason: "Inspect current page state after timeout." }]
    });
  }
  return await maybeAttachSnapshot(toolOk("wait_for", "Requested page state appeared.", result), { include_snapshot: args.include_snapshot !== false });
}

async function evaluateScriptFunction(args = {}) {
  const fnText = String(args.function || "");
  if (!fnText.trim()) return toolError("evaluate_script", "missing_function", "evaluate_script requires function.", { recoverable: false });
  const wrapped = `(${fnText})(...${JSON.stringify(Array.isArray(args.args) ? args.args : [])})`;
  const raw = await runJsViaDebugger(wrapped);
  if (typeof raw === "string" && raw.startsWith("Error executing script:")) {
    return toolError("evaluate_script", "script_error", raw, { next_actions: [{ tool: "evaluate_script", reason: "Fix the function body and retry." }] });
  }
  return toolOk("evaluate_script", "Script evaluated.", { result: raw });
}

export async function executePageTool(name, args = {}) {
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

      case "take_snapshot": {
        return toolOk("take_snapshot", "Page snapshot captured.", await takePageSnapshot(args));
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
        if (!args.uid && !args.selector) {
          return toolError("click_element", "missing_target", "click_element requires uid or selector.", { recoverable: false });
        }
        return await interactWithElement("click_element", args, "click");
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
        if (!args.uid && !args.selector) {
          const focused = await runScriptInActiveTab((text, submitKey) => {
            const el = document.activeElement;
            if (!el || el === document.body) return { ok: false, message: "No focused input is available." };
            el.value = String(text || "");
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            if (submitKey) {
              el.dispatchEvent(new KeyboardEvent("keydown", { key: submitKey, bubbles: true, cancelable: true }));
              el.dispatchEvent(new KeyboardEvent("keyup", { key: submitKey, bubbles: true, cancelable: true }));
            }
            return { ok: true, tag: el.tagName, submitKey };
          }, [args.text, args.submitKey || ""]);
          if (!focused?.ok) return toolError("type_text", "no_focused_input", focused?.message || "No focused input is available.");
          return await maybeAttachSnapshot(toolOk("type_text", "Typed into focused element.", focused), args);
        }
        return await interactWithElement("type_text", { ...args, value: args.text }, "type");
      }

      case "fill_element": {
        if (!args.uid && !args.selector) {
          return toolError("fill_element", "missing_target", "fill_element requires uid or selector.", { recoverable: false });
        }
        return await interactWithElement("fill_element", args, "fill");
      }

      case "fill_form": {
        if (!Array.isArray(args.elements) || args.elements.length === 0) {
          return toolError("fill_form", "missing_elements", "fill_form requires a non-empty elements array.", { recoverable: false });
        }
        const results = [];
        for (const element of args.elements) {
          const result = await interactWithElement("fill_element", element, "fill");
          results.push(result);
          if (!result.ok) break;
        }
        const failed = results.find((result) => !result.ok);
        if (failed) {
          return toolError("fill_form", failed.error_code || "field_failed", "At least one form field could not be filled.", {
            results,
            next_actions: failed.next_actions
          });
        }
        return await maybeAttachSnapshot(toolOk("fill_form", `Filled ${results.length} form field(s).`, { results }), args);
      }

      case "hover_element": {
        if (!args.uid && !args.selector) {
          return toolError("hover_element", "missing_target", "hover_element requires uid or selector.", { recoverable: false });
        }
        return await interactWithElement("hover_element", args, "hover");
      }

      case "press_key": {
        return await pressKeyInActiveTab(args);
      }

      case "wait_for": {
        return await waitForPageState(args);
      }

      case "run_js": {
        const result = await runJsViaDebugger(args.code);
        if (typeof result === "string" && result.includes("SyntaxError: Illegal return statement")) {
          return toolError("run_js", "illegal_return", result, {
            next_actions: [{ tool: "evaluate_script", reason: "Use evaluate_script with a function body instead of top-level return." }]
          });
        }
        return result;
      }

      case "evaluate_script": {
        return await evaluateScriptFunction(args);
      }

      case "start_network_capture":
      case "stop_network_capture":
      case "get_network_logs":
      case "get_network_log_detail":
      case "clear_network_logs": {
        const tabId = await getActiveTabId();
        return await executeNetworkTool(name, args, tabId);
      }

      case "list_authenticator_domains": {
        const keys = await getAuthenticatorKeyMap();
        return JSON.stringify({
          domains: Object.keys(keys).sort(),
          count: Object.keys(keys).length
        }, null, 2);
      }

      case "get_authenticator_code": {
        const domain = await getCurrentAuthenticatorDomain(args);
        if (!domain) return "Error: No domain supplied and no active website domain is available.";
        const keys = await getAuthenticatorKeyMap();
        const match = findAuthenticatorKeyForDomain(keys, domain);
        if (!match) {
          return `Error: No authenticator manual key saved for "${domain}". Add it in ScrapeFlow settings first.`;
        }
        const token = await generateTotp(match.manualKey);
        return JSON.stringify({
          domain,
          matched_domain: match.domain,
          code: token.code,
          seconds_remaining: token.secondsRemaining,
          period: token.period,
          digits: token.digits
        }, null, 2);
      }

      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error executing tool "${name}": ${err.message}`;
  }
}

export function formatToolResultForMcp(result) {
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

  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const isError = result?.ok === false || text.startsWith("Error:");
  return {
    content: [{ type: "text", text }],
    isError
  };
}
