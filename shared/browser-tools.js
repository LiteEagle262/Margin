import { isNetworkCaptureActive, executeNetworkTool } from "./network-logs.js";

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

// A latch takes precedence over the foreground tab for every browser tool.
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
  let destination;
  try {
    destination = new URL(url);
  } catch {
    throw new Error("Navigation requires a valid http:// or https:// URL.");
  }
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new Error("Margin navigation is limited to http:// and https:// URLs.");
  }
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error("No active tab in current window.");
  await chrome.tabs.update(tabId, { url: destination.href });
  return `Navigated active tab to ${destination.href}`;
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

// The debugger can capture a latched background tab; captureVisibleTab cannot.
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

// Run requests in-page so the selected tab's origin and cookies apply.
async function httpRequestViaPage(args = {}) {
  const url = String(args.url || "").trim();
  if (!url) return toolError("http_request", "missing_url", "http_request requires url.", { recoverable: false });
  const maxChars = Math.min(Math.max(Number(args.max_response_chars) || 20000, 0), 200000);

  const result = await runScriptInActiveTab(async (input) => {
    const started = performance.now();
    try {
      const method = String(input.method || "GET").toUpperCase();
      const init = { method, credentials: input.credentials || "include" };
      if (input.headers && typeof input.headers === "object") init.headers = input.headers;
      if (input.body != null && method !== "GET" && method !== "HEAD") init.body = String(input.body);
      const resp = await fetch(input.url, init);
      const headers = {};
      resp.headers.forEach((value, key) => { headers[key] = value; });
      const raw = await resp.text();
      const truncated = raw.length > input.maxChars;
      return {
        status: resp.status,
        statusText: resp.statusText,
        final_url: resp.url,
        redirected: resp.redirected === true,
        response_headers: headers,
        body: truncated ? raw.slice(0, input.maxChars) : raw,
        body_truncated: truncated,
        body_length: raw.length,
        timing_ms: Math.round(performance.now() - started)
      };
    } catch (err) {
      return { _error: String((err && err.message) || err), timing_ms: Math.round(performance.now() - started) };
    }
  }, [{ url, method: args.method, headers: args.headers, body: args.body, credentials: args.credentials, maxChars }]);

  if (!result) {
    return toolError("http_request", "execution_failed", "Request could not run in the page context. Ensure a normal web page is the active tab.", { recoverable: false });
  }
  if (result._error) {
    return toolError("http_request", "request_failed", `Request failed: ${result._error}`, {
      timing_ms: result.timing_ms,
      next_actions: [{ tool: "http_request", reason: "Adjust URL/headers/body and retry. Cross-origin targets may be blocked by the page's CORS policy." }]
    });
  }
  return toolOk("http_request", `HTTP ${result.status} ${result.statusText} in ${result.timing_ms}ms`, result);
}

// chrome.cookies is required for httpOnly cookies that page scripts cannot access.
async function getCookiesForTool(args = {}) {
  let targetUrl = "";
  if (args.domain) {
    const raw = String(args.domain).trim();
    targetUrl = raw.includes("://") ? raw : `https://${raw.replace(/^\/+/, "")}`;
  } else {
    const tab = await getActiveTabInfo();
    targetUrl = tab?.url || "";
  }
  if (!targetUrl) return "Error: No domain supplied and no active tab URL available.";

  let normalizedUrl;
  try {
    normalizedUrl = new URL(targetUrl).toString();
  } catch {
    return `Error: Invalid domain or URL "${targetUrl}".`;
  }

  const query = { url: normalizedUrl };
  if (args.name) query.name = String(args.name);
  const cookies = await chrome.cookies.getAll(query);
  const mapped = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: c.sameSite || "unspecified",
    session: c.session === true,
    expirationDate: c.expirationDate || null
  }));
  return JSON.stringify({ url: normalizedUrl, count: mapped.length, cookies: mapped }, null, 2);
}

async function getStorageForTool(args = {}) {
  const type = String(args.type || "all").toLowerCase();
  const keys = Array.isArray(args.keys) ? args.keys.map(String) : null;
  const result = await runScriptInActiveTab((input) => {
    function dump(storage) {
      const out = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (input.keys && !input.keys.includes(key)) continue;
        out[key] = storage.getItem(key);
      }
      return out;
    }
    const data = { url: location.href };
    try {
      if (input.type === "local" || input.type === "all") data.localStorage = dump(window.localStorage);
      if (input.type === "session" || input.type === "all") data.sessionStorage = dump(window.sessionStorage);
    } catch (err) {
      data.error = String((err && err.message) || err);
    }
    return data;
  }, [{ type, keys }]);
  if (!result) return "Error: Failed to read page storage.";
  return JSON.stringify(result, null, 2);
}

async function listScriptsInPage() {
  const result = await runScriptInActiveTab(() => {
    const scripts = [];
    const seen = new Set();
    document.querySelectorAll("script").forEach((el) => {
      const src = el.src || "";
      if (src) {
        if (seen.has(src)) return;
        seen.add(src);
        scripts.push({ type: "external", url: src });
      } else if (el.textContent && el.textContent.trim()) {
        scripts.push({ type: "inline", length: el.textContent.length, preview: el.textContent.trim().slice(0, 120) });
      }
    });
    try {
      performance.getEntriesByType("resource")
        .filter((e) => e.initiatorType === "script" || /\.m?js(\?|$)/i.test(e.name))
        .forEach((e) => {
          if (seen.has(e.name)) return;
          seen.add(e.name);
          scripts.push({ type: "resource", url: e.name, transferSize: e.transferSize || 0 });
        });
    } catch {}
    return { url: location.href, count: scripts.length, scripts };
  });
  if (!result) return "Error: Failed to list page scripts.";
  return JSON.stringify(result, null, 2);
}

// Return matching bundle snippets rather than entire minified files.
async function searchScriptsInPage(args = {}) {
  const query = String(args.query || "");
  if (!query.trim()) return toolError("search_scripts", "missing_query", "search_scripts requires query.", { recoverable: false });
  const useRegex = args.regex === true;
  const maxMatches = Math.min(Math.max(Number(args.max_matches) || 30, 1), 200);

  const result = await runScriptInActiveTab(async (input) => {
    const urls = new Set();
    document.querySelectorAll("script[src]").forEach((el) => { if (el.src) urls.add(el.src); });
    try {
      performance.getEntriesByType("resource")
        .filter((e) => e.initiatorType === "script" || /\.m?js(\?|$)/i.test(e.name))
        .forEach((e) => urls.add(e.name));
    } catch {}

    let matcher = null;
    if (input.useRegex) {
      try {
        matcher = new RegExp(input.query, "i");
      } catch (err) {
        return { _error: `Invalid regex: ${String((err && err.message) || err)}` };
      }
    }
    const needle = input.query.toLowerCase();
    const matches = [];
    const scanned = [];
    const errors = [];

    for (const url of urls) {
      if (matches.length >= input.maxMatches) break;
      let text = "";
      try {
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) { errors.push({ url, error: `HTTP ${resp.status}` }); continue; }
        text = await resp.text();
      } catch (err) {
        errors.push({ url, error: String((err && err.message) || err) });
        continue;
      }
      scanned.push(url);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < input.maxMatches; i += 1) {
        const line = lines[i];
        const idx = matcher ? line.search(matcher) : line.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        // Cap windows around matches because minified bundles may be one line.
        let snippet = line;
        if (snippet.length > 400) {
          snippet = (idx > 200 ? "…" : "") + line.slice(Math.max(0, idx - 200), idx + 200) + (line.length > idx + 200 ? "…" : "");
        }
        matches.push({ url, line: i + 1, column: idx + 1, snippet });
      }
    }
    return { query: input.query, scanned_count: scanned.length, match_count: matches.length, matches, errors: errors.slice(0, 10) };
  }, [{ query, useRegex, maxMatches }]);

  if (!result) return toolError("search_scripts", "execution_failed", "Script search could not run in the page context.", { recoverable: false });
  if (result._error) return toolError("search_scripts", "invalid_query", result._error, { recoverable: false });
  return toolOk("search_scripts", `Found ${result.match_count} match(es) across ${result.scanned_count} script(s).`, result);
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
          // A latched background tab requires debugger capture.
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

      case "http_request": {
        return await httpRequestViaPage(args);
      }

      case "get_cookies": {
        return await getCookiesForTool(args);
      }

      case "get_storage": {
        return await getStorageForTool(args);
      }

      case "list_scripts": {
        return await listScriptsInPage();
      }

      case "search_scripts": {
        return await searchScriptsInPage(args);
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
          return `Error: No authenticator manual key saved for "${domain}". Add it in Margin settings first.`;
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
