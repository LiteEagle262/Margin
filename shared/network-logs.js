import { normalizeNetworkCaptureSettings } from "./settings-schema.js";
import { SENSITIVE_FIELD_RE, redactUrlSecrets } from "./redact-url.js";

const NETWORK_STORAGE_KEY = "marginNetworkLogs";
const NETWORK_SETTINGS_KEY = "networkCapture";
const MAX_LOG_ENTRIES = 1500;
const MAX_RETURNED_ENTRIES = 150;
const MAX_BODY_LENGTH = 8000;
const MAX_PERSISTED_BODY_LENGTH = 4000;
const PERSIST_THROTTLE_MS = 2000;
const MAX_WS_FRAMES = 100;
const MAX_FRAME_LENGTH = 2000;

const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const BODY_TEXT_MIME_RE = /^(application\/json|application\/.*\+json|text\/|application\/x-www-form-urlencoded|application\/xml|application\/graphql|application\/javascript)/i;

const DEFAULT_NETWORK_SETTINGS = {
  autoCaptureLatchedTab: false,
  persistSessionLogs: true,
  captureResponseBodies: true,
  redactSensitiveData: true
};

const networkState = {
  tabs: new Map(),
  nextPublicId: 1,
  persistTimer: null,
  hydrated: false,
  hydratePromise: null,
  settings: { ...DEFAULT_NETWORK_SETTINGS }
};

function getTabNetworkState(tabId) {
  if (!networkState.tabs.has(tabId)) {
    networkState.tabs.set(tabId, {
      capturing: false,
      manualCapture: false,
      autoCapture: false,
      entries: [],
      requestMap: new Map(),
      publicIdMap: new Map(),
      attached: false,
      lastError: ""
    });
  }
  return networkState.tabs.get(tabId);
}

async function loadNetworkCaptureSettings() {
  try {
    const stored = await chrome.storage.local.get([NETWORK_SETTINGS_KEY]);
    networkState.settings = normalizeNetworkCaptureSettings(stored[NETWORK_SETTINGS_KEY]);
  } catch {
    networkState.settings = { ...DEFAULT_NETWORK_SETTINGS };
  }
  return networkState.settings;
}

export function isNetworkCaptureActive(tabId) {
  const state = networkState.tabs.get(tabId);
  return state?.capturing === true;
}

function shouldRedact() {
  return networkState.settings.redactSensitiveData !== false;
}

function redactValue(value) {
  if (!shouldRedact()) return value;
  return "[redacted]";
}

function redactHeaders(headers = {}) {
  if (!headers || typeof headers !== "object") return {};
  return Object.entries(headers).reduce((acc, [key, value]) => {
    acc[key] = SENSITIVE_HEADER_RE.test(key) ? redactValue(value) : value;
    return acc;
  }, {});
}

export function redactNetworkUrl(rawUrl) {
  const value = String(rawUrl || "");
  if (!shouldRedact() || !value) return value;
  return redactUrlSecrets(value);
}

function redactJsonValue(value, key = "") {
  if (!shouldRedact()) return value;
  if (SENSITIVE_FIELD_RE.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [childKey, childValue]) => {
      acc[childKey] = redactJsonValue(childValue, childKey);
      return acc;
    }, {});
  }
  return value;
}

function redactTextBody(text, mimeType = "") {
  if (!shouldRedact() || typeof text !== "string" || !text) return text;

  if (/json/i.test(mimeType) || /^[\s\r\n]*[\[{]/.test(text)) {
    try {
      return JSON.stringify(redactJsonValue(JSON.parse(text)), null, 2);
    } catch {
      // Fall through to conservative token-pattern redaction.
    }
  }

  return text
    .replace(/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|csrf|xsrf|session)[^=&:"'\s]{0,40}\s*[=:]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/gi, "$1[redacted]")
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)([^\r\n]+)/gi, "$1[redacted]");
}

function truncateText(text, maxLength) {
  if (typeof text !== "string" || text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxLength), truncated: true };
}

function isProbablyTextBody(mimeType = "") {
  return BODY_TEXT_MIME_RE.test(String(mimeType || "").toLowerCase());
}

function attachDebuggerToTab(tabId) {
  if (!chrome.debugger?.attach) {
    return Promise.reject(new Error("Chrome debugger access is unavailable. Reload Margin after granting its required permissions."));
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("Already attached") && !err.message.includes("debugger is already attached")) {
        reject(new Error(err.message));
        return;
      }
      const state = getTabNetworkState(tabId);
      state.attached = true;
      state.lastError = "";
      resolve();
    });
  });
}

function sendDebuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function decodeResponseBody(bodyResult, mimeType = "") {
  if (!bodyResult || bodyResult.body == null) return null;
  if (bodyResult.base64Encoded && !isProbablyTextBody(mimeType)) {
    return { text: "[binary body omitted]", truncated: false, binary: true };
  }

  let body = bodyResult.body;
  if (bodyResult.base64Encoded) {
    try {
      body = atob(body);
    } catch {
      return { text: "[binary body omitted - base64 decode failed]", truncated: false, binary: true };
    }
  }

  const redacted = redactTextBody(body, mimeType);
  return truncateText(redacted, MAX_BODY_LENGTH);
}

// WebSocket opcodes: 1=text, 2=binary, 8=close, 9=ping, 10=pong.
function pushWsFrame(entry, frame) {
  if (!Array.isArray(entry.frames)) entry.frames = [];
  entry.frameCount = (entry.frameCount || 0) + 1;

  let payload = frame.payload;
  if (typeof payload === "string") {
    if (frame.opcode === 2) {
      payload = "[binary frame omitted]";
    } else {
      payload = redactTextBody(payload, "application/json");
      const { text, truncated } = truncateText(payload, MAX_FRAME_LENGTH);
      payload = truncated ? `${text} …[truncated]` : text;
    }
  }

  const record = { direction: frame.direction, ts: frame.timestamp ?? null, payload };
  if (frame.opcode != null) record.opcode = frame.opcode;
  if (frame.eventName) record.eventName = frame.eventName;
  if (frame.eventId) record.eventId = frame.eventId;
  entry.frames.push(record);
  while (entry.frames.length > MAX_WS_FRAMES) entry.frames.shift();
}

function createPublicRequestId(tabId, cdpRequestId) {
  return `${tabId}-${networkState.nextPublicId++}-${String(cdpRequestId).replace(/[^a-z0-9._:-]/gi, "_")}`;
}

function rebuildIndexes(state) {
  state.requestMap = new Map();
  state.publicIdMap = new Map();
  for (const entry of state.entries) {
    state.publicIdMap.set(entry.id, entry);
    state.requestMap.set(entry.cdpRequestId, entry);
  }
}

function addEntry(tabId, entry) {
  const state = getTabNetworkState(tabId);
  state.entries.push(entry);
  state.publicIdMap.set(entry.id, entry);
  state.requestMap.set(entry.cdpRequestId, entry);

  while (state.entries.length > MAX_LOG_ENTRIES) {
    const removed = state.entries.shift();
    state.publicIdMap.delete(removed.id);
    if (state.requestMap.get(removed.cdpRequestId) === removed) {
      state.requestMap.delete(removed.cdpRequestId);
    }
  }

  scheduleNetworkPersist();
}

function serializeEntry(entry, includeBodies = true) {
  const copy = { ...entry };
  delete copy._responseBodyFetched;
  copy.url = redactNetworkUrl(copy.url);
  copy.redirectedTo = redactNetworkUrl(copy.redirectedTo);
  copy.requestHeaders = redactHeaders(copy.requestHeaders || {});
  copy.responseHeaders = redactHeaders(copy.responseHeaders || {});
  copy.postData = copy.postData ? redactTextBody(copy.postData, copy.requestHeaders?.["content-type"] || "") : copy.postData;
  copy.responseBody = copy.responseBody ? redactTextBody(copy.responseBody, copy.mimeType || "") : copy.responseBody;
  if (typeof copy.responseBody === "string") {
    const limit = includeBodies ? MAX_PERSISTED_BODY_LENGTH : 0;
    if (limit === 0) {
      copy.responseBody = null;
      copy.bodyTruncated = copy.bodyTruncated || false;
    } else {
      const truncated = truncateText(copy.responseBody, limit);
      copy.responseBody = truncated.text;
      copy.bodyTruncated = copy.bodyTruncated || truncated.truncated;
    }
  }
  return copy;
}

async function hydrateNetworkState() {
  if (networkState.hydrated) return;
  if (networkState.hydratePromise) {
    await networkState.hydratePromise;
    return;
  }

  networkState.hydratePromise = (async () => {
    await loadNetworkCaptureSettings();
    if (!networkState.settings.persistSessionLogs) {
      networkState.hydrated = true;
      return;
    }

    try {
      const stored = await chrome.storage.session.get([NETWORK_STORAGE_KEY]);
      const snapshot = stored[NETWORK_STORAGE_KEY];
      if (!snapshot || typeof snapshot !== "object") {
        networkState.hydrated = true;
        return;
      }

      networkState.nextPublicId = Math.max(Number(snapshot.nextPublicId) || 1, 1);
      Object.entries(snapshot.tabs || {}).forEach(([tabIdText, tabSnapshot]) => {
        const tabId = Number(tabIdText);
        if (!Number.isFinite(tabId) || !tabSnapshot) return;
        const state = getTabNetworkState(tabId);
        state.entries = Array.isArray(tabSnapshot.entries)
          ? tabSnapshot.entries.slice(-MAX_LOG_ENTRIES)
          : [];
        state.capturing = false;
        state.manualCapture = false;
        state.autoCapture = false;
        state.attached = false;
        rebuildIndexes(state);
      });
    } catch {
      // Session persistence is best-effort.
    } finally {
      networkState.hydrated = true;
      networkState.hydratePromise = null;
    }
  })();

  await networkState.hydratePromise;
}

function scheduleNetworkPersist() {
  if (!networkState.settings.persistSessionLogs) return;
  if (networkState.persistTimer) return;
  networkState.persistTimer = setTimeout(() => {
    networkState.persistTimer = null;
    persistNetworkState();
  }, PERSIST_THROTTLE_MS);
}

async function persistNetworkState() {
  if (!networkState.settings.persistSessionLogs) return;
  const tabs = {};
  for (const [tabId, state] of networkState.tabs.entries()) {
    if (state.entries.length === 0) continue;
    tabs[String(tabId)] = {
      entries: state.entries.map((entry) => serializeEntry(entry, networkState.settings.captureResponseBodies))
    };
  }
  try {
    await chrome.storage.session.set({
      [NETWORK_STORAGE_KEY]: {
        version: 2,
        nextPublicId: networkState.nextPublicId,
        savedAt: Date.now(),
        tabs
      }
    });
  } catch {
    // Best-effort. The live in-memory buffer still works if storage is full.
  }
}

async function clearPersistedNetworkState(tabId = null) {
  if (tabId == null) {
    await chrome.storage.session.remove(NETWORK_STORAGE_KEY);
    return;
  }
  try {
    const stored = await chrome.storage.session.get([NETWORK_STORAGE_KEY]);
    const snapshot = stored[NETWORK_STORAGE_KEY];
    if (!snapshot?.tabs) return;
    delete snapshot.tabs[String(tabId)];
    await chrome.storage.session.set({ [NETWORK_STORAGE_KEY]: snapshot });
  } catch {}
}

function fetchResponseBody(tabId, requestId, entry) {
  if (networkState.settings.captureResponseBodies === false) return;
  if (!entry || entry._responseBodyFetched) return;
  entry._responseBodyFetched = true;

  chrome.debugger.sendCommand(
    { tabId },
    "Network.getResponseBody",
    { requestId },
    (bodyResult) => {
      const err = chrome.runtime.lastError;
      if (err || !bodyResult) {
        if (err) entry.bodyError = err.message;
        scheduleNetworkPersist();
        return;
      }
      const decoded = decodeResponseBody(bodyResult, entry.mimeType);
      if (!decoded) return;
      entry.responseBody = decoded.text;
      entry.bodyTruncated = decoded.truncated;
      entry.bodyBinary = decoded.binary === true;
      scheduleNetworkPersist();
    }
  );
}

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  if (!source.tabId) return;
  const state = getTabNetworkState(source.tabId);
  if (!state.capturing) return;

  if (method === "Network.requestWillBeSent") {
    const previousEntry = state.requestMap.get(params.requestId);
    if (previousEntry && params.redirectResponse) {
      previousEntry.status = params.redirectResponse.status;
      previousEntry.statusText = params.redirectResponse.statusText;
      previousEntry.responseHeaders = redactHeaders(params.redirectResponse.headers || {});
      previousEntry.mimeType = params.redirectResponse.mimeType || previousEntry.mimeType;
      previousEntry.redirectedTo = redactNetworkUrl(params.request.url);
    }

    const entry = {
      id: createPublicRequestId(source.tabId, params.requestId),
      cdpRequestId: params.requestId,
      url: redactNetworkUrl(params.request.url),
      method: params.request.method,
      type: params.type || params.initiator?.type || "other",
      timestamp: params.timestamp,
      wallTime: params.wallTime || null,
      requestHeaders: redactHeaders(params.request.headers || {}),
      postData: params.request.postData ? redactTextBody(params.request.postData, params.request.headers?.["content-type"] || "") : null,
      status: null,
      statusText: null,
      responseHeaders: null,
      mimeType: null,
      responseBody: null,
      bodyTruncated: false,
      bodyBinary: false,
      bodyError: "",
      encodedDataLength: null,
      fromDiskCache: false,
      fromServiceWorker: false,
      failed: false,
      failureReason: "",
      redirectedTo: "",
      initiatorType: params.initiator?.type || ""
    };
    addEntry(source.tabId, entry);
  }

  if (method === "Network.requestWillBeSentExtraInfo") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.requestHeaders = { ...entry.requestHeaders, ...redactHeaders(params.headers || {}) };
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.responseReceived") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.status = params.response.status;
      entry.statusText = params.response.statusText;
      entry.responseHeaders = redactHeaders(params.response.headers || {});
      entry.mimeType = params.response.mimeType;
      entry.fromDiskCache = params.response.fromDiskCache === true;
      entry.fromServiceWorker = params.response.fromServiceWorker === true;
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.responseReceivedExtraInfo") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.responseHeaders = { ...(entry.responseHeaders || {}), ...redactHeaders(params.headers || {}) };
      if (entry.status == null && params.statusCode != null) entry.status = params.statusCode;
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.loadingFinished") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.encodedDataLength = params.encodedDataLength;
      fetchResponseBody(source.tabId, params.requestId, entry);
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.loadingFailed") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.failed = true;
      entry.failureReason = params.errorText || "loading failed";
      entry.blockedReason = params.blockedReason || "";
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.webSocketCreated") {
    const entry = {
      id: createPublicRequestId(source.tabId, params.requestId),
      cdpRequestId: params.requestId,
      url: redactNetworkUrl(params.url),
      method: "WS",
      type: "WebSocket",
      timestamp: null,
      wallTime: null,
      requestHeaders: {},
      postData: null,
      status: null,
      statusText: null,
      responseHeaders: null,
      mimeType: null,
      responseBody: null,
      bodyTruncated: false,
      bodyBinary: false,
      bodyError: "",
      encodedDataLength: null,
      fromDiskCache: false,
      fromServiceWorker: false,
      failed: false,
      failureReason: "",
      redirectedTo: "",
      initiatorType: params.initiator?.type || "",
      frames: [],
      frameCount: 0,
      wsClosed: false
    };
    addEntry(source.tabId, entry);
  }

  if (method === "Network.webSocketWillSendHandshakeRequest") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.requestHeaders = redactHeaders(params.request?.headers || {});
      entry.timestamp = params.timestamp;
      entry.wallTime = params.wallTime || null;
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.webSocketHandshakeResponseReceived") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.status = params.response?.status ?? 101;
      entry.statusText = params.response?.statusText || "Switching Protocols";
      entry.responseHeaders = redactHeaders(params.response?.headers || {});
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      pushWsFrame(entry, {
        direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
        opcode: params.response?.opcode,
        timestamp: params.timestamp,
        payload: params.response?.payloadData
      });
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.webSocketFrameError") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.failed = true;
      entry.failureReason = params.errorMessage || "websocket frame error";
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.webSocketClosed") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.wsClosed = true;
      scheduleNetworkPersist();
    }
  }

  if (method === "Network.eventSourceMessageReceived") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      if (!entry.type || entry.type === "other") entry.type = "EventSource";
      pushWsFrame(entry, {
        direction: "received",
        eventName: params.eventName || "message",
        eventId: params.eventId || "",
        timestamp: params.timestamp,
        payload: params.data
      });
      scheduleNetworkPersist();
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  networkState.tabs.delete(tabId);
  clearPersistedNetworkState(tabId);
});

chrome.debugger?.onDetach?.addListener((source, reason) => {
  if (!source.tabId) return;
  const state = networkState.tabs.get(source.tabId);
  if (!state) return;
  state.capturing = false;
  state.manualCapture = false;
  state.autoCapture = false;
  state.attached = false;
  state.lastError = reason || "";
});

async function enableNetworkCapture(tabId, mode = "manual") {
  if (!tabId) throw new Error("No active tab in current window.");
  await hydrateNetworkState();
  const state = getTabNetworkState(tabId);

  if (!state.capturing) {
    await attachDebuggerToTab(tabId);
    try {
      await sendDebuggerCommand(tabId, "Network.enable", {
        maxPostDataSize: MAX_BODY_LENGTH
      });
    } catch (error) {
      state.attached = false;
      await new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      state.lastError = error.message;
      throw error;
    }
  }

  if (mode === "auto") state.autoCapture = true;
  else state.manualCapture = true;
  state.capturing = true;
  state.lastError = "";
  return state;
}

async function startNetworkCapture(tabId, options = {}) {
  const state = await enableNetworkCapture(tabId, options.mode || "manual");
  if (options.mode === "auto") {
    return "Network auto-capture is active for the latched tab.";
  }
  if (state.autoCapture) {
    return "Network capture is active on this tab. Auto-capture is also keeping a hindsight buffer.";
  }
  return "Network capture started on the active tab. Reload or interact with the page, then use get_network_logs to inspect requests.";
}

async function detachIfUnused(tabId, state) {
  if (state.manualCapture || state.autoCapture) {
    state.capturing = true;
    return;
  }
  state.capturing = false;
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  state.attached = false;
}

async function stopNetworkCapture(tabId, options = {}) {
  if (!tabId) throw new Error("No active tab in current window.");
  await hydrateNetworkState();
  const state = getTabNetworkState(tabId);
  if (!state.capturing && !state.manualCapture && !state.autoCapture) {
    return "Network capture was not active on the current tab.";
  }

  if (options.mode === "auto") {
    state.autoCapture = false;
  } else {
    state.manualCapture = false;
  }

  await detachIfUnused(tabId, state);
  return options.mode === "auto" ? "Network auto-capture stopped." : "Network capture stopped.";
}

async function stopAllAutoNetworkCaptures() {
  await hydrateNetworkState();
  const stops = [];
  for (const [tabId, state] of networkState.tabs.entries()) {
    if (!state.autoCapture) continue;
    state.autoCapture = false;
    stops.push(detachIfUnused(tabId, state));
  }
  await Promise.all(stops);
}

export async function syncNetworkAutoCapture(latchedTab = null) {
  await hydrateNetworkState();
  await loadNetworkCaptureSettings();

  if (!networkState.settings.autoCaptureLatchedTab || !latchedTab?.tabId) {
    await stopAllAutoNetworkCaptures();
    return "Network auto-capture is off.";
  }

  try {
    await startNetworkCapture(latchedTab.tabId, { mode: "auto" });
  } catch (error) {
    const state = getTabNetworkState(latchedTab.tabId);
    state.autoCapture = false;
    state.capturing = state.manualCapture === true;
    state.lastError = error.message;
    return `Network auto-capture could not start: ${error.message}`;
  }

  for (const [tabId, state] of networkState.tabs.entries()) {
    if (tabId === latchedTab.tabId || !state.autoCapture) continue;
    state.autoCapture = false;
    await detachIfUnused(tabId, state);
  }

  return "Network auto-capture is active for the latched tab.";
}

function formatLogEntry(entry, includeBody = false) {
  const base = {
    id: entry.id,
    method: entry.method,
    url: redactNetworkUrl(entry.url),
    type: entry.type,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    failed: entry.failed === true,
    failureReason: entry.failureReason || "",
    fromDiskCache: entry.fromDiskCache === true,
    fromServiceWorker: entry.fromServiceWorker === true,
    encodedDataLength: entry.encodedDataLength
  };

  if (entry.redirectedTo) base.redirectedTo = redactNetworkUrl(entry.redirectedTo);

  if (Array.isArray(entry.frames)) {
    base.frameCount = entry.frameCount || entry.frames.length;
    base.wsClosed = entry.wsClosed === true;
  }

  if (includeBody) {
    base.requestHeaders = redactHeaders(entry.requestHeaders || {});
    base.responseHeaders = redactHeaders(entry.responseHeaders || {});
    base.postData = entry.postData ? redactTextBody(entry.postData, entry.requestHeaders?.["content-type"] || "") : entry.postData;
    base.responseBody = entry.responseBody ? redactTextBody(entry.responseBody, entry.mimeType || "") : entry.responseBody;
    base.bodyTruncated = entry.bodyTruncated;
    base.bodyBinary = entry.bodyBinary;
    base.bodyError = entry.bodyError;
    if (Array.isArray(entry.frames)) base.frames = entry.frames;
  }

  return base;
}

function filterEntries(entries, args = {}) {
  let filtered = [...entries];

  if (args.url_contains) {
    const needle = String(args.url_contains).toLowerCase();
    filtered = filtered.filter((entry) => entry.url.toLowerCase().includes(needle));
  }
  if (args.method) {
    const method = String(args.method).toUpperCase();
    filtered = filtered.filter((entry) => entry.method.toUpperCase() === method);
  }
  if (args.status != null) {
    filtered = filtered.filter((entry) => entry.status === Number(args.status));
  }
  if (args.type) {
    const type = String(args.type).toLowerCase();
    filtered = filtered.filter((entry) => String(entry.type || "").toLowerCase() === type);
  }
  if (args.failed != null) {
    const failed = args.failed === true || args.failed === "true";
    filtered = filtered.filter((entry) => entry.failed === failed);
  }

  return filtered;
}

async function getNetworkLogs(tabId, args = {}) {
  await hydrateNetworkState();
  const state = getTabNetworkState(tabId);
  let entries = filterEntries(state.entries, args);
  const limit = Math.min(Number(args.limit) || 50, MAX_RETURNED_ENTRIES);
  entries = entries.slice(-limit);
  const includeBody = args.include_body === true;

  if (entries.length === 0) {
    if (state.capturing) {
      return "No network requests captured yet. Reload the page or trigger actions to generate traffic.";
    }
    if (state.entries.length > 0) {
      return "No network logs matched those filters.";
    }
    return "No network logs available for this tab. Enable auto-capture for the latched tab or call start_network_capture first.";
  }

  return JSON.stringify({
    capturing: state.capturing,
    autoCapture: state.autoCapture,
    persistedSessionBuffer: networkState.settings.persistSessionLogs,
    redaction: networkState.settings.redactSensitiveData ? "sensitive URL parameters, headers, and common secret fields redacted" : "off",
    count: entries.length,
    totalBufferedForTab: state.entries.length,
    entries: entries.map((entry) => formatLogEntry(entry, includeBody))
  }, null, 2);
}

export async function getNetworkLogSnapshot(tabId, args = {}) {
  if (!tabId) throw new Error("No active tab in current window.");
  await hydrateNetworkState();
  const state = getTabNetworkState(tabId);
  const includeBody = args.include_body === true;

  return {
    capturing: state.capturing,
    autoCapture: state.autoCapture,
    persistedSessionBuffer: networkState.settings.persistSessionLogs,
    redaction: networkState.settings.redactSensitiveData ? "sensitive URL parameters, headers, and common secret fields redacted" : "off",
    totalBufferedForTab: state.entries.length,
    maxBufferedForTab: MAX_LOG_ENTRIES,
    maxReturnedForTool: MAX_RETURNED_ENTRIES,
    entries: state.entries.map((entry) => formatLogEntry(entry, includeBody))
  };
}

async function getNetworkLogDetail(tabId, requestId) {
  await hydrateNetworkState();
  const state = getTabNetworkState(tabId);
  const entry = state.publicIdMap.get(requestId)
    || state.entries.find((item) => item.id === requestId || item.cdpRequestId === requestId);
  if (!entry) {
    return `Error: Request "${requestId}" not found. Use get_network_logs to list available request IDs.`;
  }
  return JSON.stringify(formatLogEntry(entry, true), null, 2);
}

async function clearNetworkLogs(tabId) {
  await hydrateNetworkState();
  const state = getTabNetworkState(tabId);
  state.entries = [];
  state.requestMap.clear();
  state.publicIdMap.clear();
  await clearPersistedNetworkState(tabId);
  return "Network logs cleared for the active tab.";
}

export async function executeNetworkTool(name, args = {}, tabId) {
  try {
    switch (name) {
      case "start_network_capture":
        return await startNetworkCapture(tabId);
      case "stop_network_capture":
        return await stopNetworkCapture(tabId);
      case "get_network_logs":
        return await getNetworkLogs(tabId, args);
      case "get_network_log_detail":
        if (!args.request_id) return "Error: get_network_log_detail requires request_id.";
        return await getNetworkLogDetail(tabId, args.request_id);
      case "clear_network_logs":
        return await clearNetworkLogs(tabId);
      default:
        return null;
    }
  } catch (err) {
    return `Error executing network tool "${name}": ${err.message}`;
  }
}

hydrateNetworkState();
