// shared/network-logs.js - CDP Network domain capture for request debugging

const MAX_LOG_ENTRIES = 200;
const MAX_BODY_LENGTH = 8000;

const networkState = {
  tabs: new Map()
};

function getTabNetworkState(tabId) {
  if (!networkState.tabs.has(tabId)) {
    networkState.tabs.set(tabId, {
      capturing: false,
      entries: [],
      requestMap: new Map()
    });
  }
  return networkState.tabs.get(tabId);
}

function isNetworkCaptureActive(tabId) {
  const state = networkState.tabs.get(tabId);
  return state?.capturing === true;
}

function attachDebuggerToTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("Already attached") && !err.message.includes("debugger is already attached")) {
        reject(new Error(err.message));
        return;
      }
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

function decodeResponseBody(bodyResult) {
  if (!bodyResult || bodyResult.body == null) return null;
  let body = bodyResult.body;
  if (bodyResult.base64Encoded) {
    try {
      body = atob(body);
    } catch {
      return "[binary body — base64 decode failed]";
    }
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { text: body.slice(0, MAX_BODY_LENGTH), truncated: true };
  }
  return { text: body, truncated: false };
}

function fetchResponseBody(tabId, requestId, entry) {
  chrome.debugger.sendCommand(
    { tabId },
    "Network.getResponseBody",
    { requestId },
    (bodyResult) => {
      if (chrome.runtime.lastError || !bodyResult) return;
      const decoded = decodeResponseBody(bodyResult);
      if (!decoded) return;
      entry.responseBody = decoded.text;
      entry.bodyTruncated = decoded.truncated;
    }
  );
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const state = getTabNetworkState(source.tabId);
  if (!state.capturing) return;

  if (method === "Network.requestWillBeSent") {
    const entry = {
      id: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type || params.initiator?.type || "other",
      timestamp: params.timestamp,
      requestHeaders: params.request.headers || {},
      postData: params.request.postData || null,
      status: null,
      statusText: null,
      responseHeaders: null,
      mimeType: null,
      responseBody: null,
      bodyTruncated: false
    };
    state.requestMap.set(params.requestId, entry);
    state.entries.push(entry);
    if (state.entries.length > MAX_LOG_ENTRIES) {
      const removed = state.entries.shift();
      state.requestMap.delete(removed.id);
    }
  }

  if (method === "Network.responseReceived") {
    const entry = state.requestMap.get(params.requestId);
    if (entry) {
      entry.status = params.response.status;
      entry.statusText = params.response.statusText;
      entry.responseHeaders = params.response.headers || {};
      entry.mimeType = params.response.mimeType;
    }
  }

  if (method === "Network.loadingFinished") {
    const entry = state.requestMap.get(params.requestId);
    if (entry && entry.responseBody == null) {
      fetchResponseBody(source.tabId, params.requestId, entry);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  networkState.tabs.delete(tabId);
});

async function startNetworkCapture(tabId) {
  if (!tabId) throw new Error("No active tab in current window.");
  const state = getTabNetworkState(tabId);
  if (state.capturing) {
    return "Network capture is already active on the current tab.";
  }

  await attachDebuggerToTab(tabId);
  await sendDebuggerCommand(tabId, "Network.enable");
  state.capturing = true;
  return "Network capture started on the active tab. Reload or interact with the page, then use get_network_logs to inspect requests.";
}

async function stopNetworkCapture(tabId) {
  if (!tabId) throw new Error("No active tab in current window.");
  const state = getTabNetworkState(tabId);
  if (!state.capturing) {
    return "Network capture was not active on the current tab.";
  }

  state.capturing = false;
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve("Network capture stopped.");
    });
  });
}

function formatLogEntry(entry, includeBody = false) {
  const base = {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    type: entry.type,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType
  };

  if (includeBody) {
    base.requestHeaders = entry.requestHeaders;
    base.responseHeaders = entry.responseHeaders;
    base.postData = entry.postData;
    base.responseBody = entry.responseBody;
    base.bodyTruncated = entry.bodyTruncated;
  }

  return base;
}

function getNetworkLogs(tabId, args = {}) {
  const state = getTabNetworkState(tabId);
  let entries = [...state.entries];

  if (args.url_contains) {
    const needle = String(args.url_contains).toLowerCase();
    entries = entries.filter((entry) => entry.url.toLowerCase().includes(needle));
  }
  if (args.method) {
    const method = String(args.method).toUpperCase();
    entries = entries.filter((entry) => entry.method.toUpperCase() === method);
  }
  if (args.status != null) {
    entries = entries.filter((entry) => entry.status === Number(args.status));
  }
  if (args.type) {
    entries = entries.filter((entry) => entry.type === args.type);
  }

  const limit = Math.min(Number(args.limit) || 50, 100);
  entries = entries.slice(-limit);
  const includeBody = args.include_body === true;

  if (entries.length === 0) {
    if (state.capturing) {
      return "No network requests captured yet. Reload the page or trigger actions to generate traffic.";
    }
    return "No network logs available. Call start_network_capture first to begin recording.";
  }

  return JSON.stringify({
    capturing: state.capturing,
    count: entries.length,
    entries: entries.map((entry) => formatLogEntry(entry, includeBody))
  }, null, 2);
}

function getNetworkLogDetail(tabId, requestId) {
  const state = getTabNetworkState(tabId);
  const entry = state.requestMap.get(requestId)
    || state.entries.find((item) => item.id === requestId);
  if (!entry) {
    return `Error: Request "${requestId}" not found. Use get_network_logs to list available request IDs.`;
  }
  return JSON.stringify(formatLogEntry(entry, true), null, 2);
}

function clearNetworkLogs(tabId) {
  const state = getTabNetworkState(tabId);
  state.entries = [];
  state.requestMap.clear();
  return "Network logs cleared for the active tab.";
}

async function executeNetworkTool(name, args = {}, tabId) {
  try {
    switch (name) {
      case "start_network_capture":
        return await startNetworkCapture(tabId);
      case "stop_network_capture":
        return await stopNetworkCapture(tabId);
      case "get_network_logs":
        return getNetworkLogs(tabId, args);
      case "get_network_log_detail":
        if (!args.request_id) return "Error: get_network_log_detail requires request_id.";
        return getNetworkLogDetail(tabId, args.request_id);
      case "clear_network_logs":
        return clearNetworkLogs(tabId);
      default:
        return null;
    }
  } catch (err) {
    return `Error executing network tool "${name}": ${err.message}`;
  }
}

const NETWORK_TOOL_NAMES = new Set([
  "start_network_capture",
  "stop_network_capture",
  "get_network_logs",
  "get_network_log_detail",
  "clear_network_logs"
]);
