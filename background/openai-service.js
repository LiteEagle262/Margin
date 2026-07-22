import {
  OPENAI_ACCESS_STORAGE_KEY,
  OPENAI_AUTH_STORAGE_KEY,
  OPENAI_CLIENT_ID,
  OPENAI_DEVICE_STORAGE_KEY,
  OPENAI_DEVICE_URL,
  OPENAI_ISSUER,
  OPENAI_MODELS_URL,
  OPENAI_RESPONSES_URL,
  OPENAI_SUBSCRIPTION_MODELS,
  buildOpenAIResponsesRequest,
  getPublicDeviceAuthorization,
  getPublicOpenAIAccount,
  normalizeDeviceAuthorization,
  normalizeOpenAIModelsResponse,
  normalizeOpenAITokens,
  parseOpenAIResponseBody,
  sanitizeOpenAIErrorBody,
} from "../shared/openai-protocol.js";

const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_MODEL_CATALOG_BYTES = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;
const MODEL_CATALOG_TIMEOUT_MS = 10 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
const WORKER_KEEPALIVE_INTERVAL_MS = 20 * 1000;
const MAX_DEVICE_POLL_BACKOFF_MS = 60 * 1000;

let refreshPromise = null;
let deviceStartPromise = null;
let devicePollPromise = null;
let deviceGeneration = 0;
let authGeneration = 0;

function formBody(values) {
  return new URLSearchParams(values).toString();
}

async function readBoundedResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("OpenAI returned a response larger than Margin can safely process.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("OpenAI returned a response larger than Margin can safely process.");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

async function responseError(response, label) {
  const body = await readBoundedResponse(response, 64 * 1024).catch(() => "");
  const detail = sanitizeOpenAIErrorBody(body);
  if (response.status === 401) return new Error("OpenAI sign-in expired. Link your ChatGPT account again.");
  if (response.status === 403) {
    return new Error(detail || "This ChatGPT account or plan did not authorize the requested Codex model.");
  }
  return new Error(`${label} (${response.status})${detail ? `: ${detail}` : ""}`);
}

async function loadAuth() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([OPENAI_AUTH_STORAGE_KEY]),
    chrome.storage.session.get([OPENAI_ACCESS_STORAGE_KEY]),
  ]);
  const persisted = local[OPENAI_AUTH_STORAGE_KEY] || {};
  const ephemeral = session[OPENAI_ACCESS_STORAGE_KEY] || {};
  return { ...persisted, ...ephemeral };
}

async function saveAuth(auth) {
  await Promise.all([
    chrome.storage.local.set({
      [OPENAI_AUTH_STORAGE_KEY]: {
        refreshToken: auth.refreshToken,
        accountId: auth.accountId || "",
        email: auth.email || "",
        planType: auth.planType || "",
        linkedAt: Date.now(),
      },
    }),
    chrome.storage.session.set({
      [OPENAI_ACCESS_STORAGE_KEY]: {
        accessToken: auth.accessToken,
        expiresAt: auth.expiresAt,
      },
    }),
  ]);
}

async function clearAuth() {
  authGeneration += 1;
  refreshPromise = null;
  await Promise.all([
    chrome.storage.local.remove(OPENAI_AUTH_STORAGE_KEY),
    chrome.storage.session.remove(OPENAI_ACCESS_STORAGE_KEY),
  ]);
}

async function tokenExchange(values, previousAuth = {}, canSave = null, expectedAuthGeneration = authGeneration) {
  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(values),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw await responseError(response, "OpenAI token exchange failed");
  const tokens = normalizeOpenAITokens(await response.json(), {
    previousRefreshToken: previousAuth.refreshToken || "",
  });
  tokens.accountId ||= previousAuth.accountId || "";
  tokens.email ||= previousAuth.email || "";
  tokens.planType ||= previousAuth.planType || "";
  if (expectedAuthGeneration !== authGeneration || (canSave && !canSave())) return null;
  await saveAuth(tokens);
  return tokens;
}

async function refreshAccessToken(auth) {
  try {
    const tokens = await tokenExchange({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }, auth);
    if (!tokens) throw new Error("OpenAI sign-in was cleared while refreshing.");
    return tokens;
  } catch (error) {
    if (/\(400\)|expired|invalid_grant/i.test(error.message)) await clearAuth();
    throw error;
  }
}

async function getAccessContext(forceRefresh = false) {
  const auth = await loadAuth();
  if (!auth.refreshToken) throw new Error("Link your ChatGPT account in Margin settings first.");
  if (!forceRefresh && auth.accessToken && Number(auth.expiresAt) > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
    return auth;
  }
  if (!refreshPromise) {
    const trackedRefresh = refreshAccessToken(auth).finally(() => {
      if (refreshPromise === trackedRefresh) refreshPromise = null;
    });
    refreshPromise = trackedRefresh;
  }
  return refreshPromise;
}

export async function getOpenAIOAuthStatus() {
  const [auth, deviceResult] = await Promise.all([
    loadAuth(),
    chrome.storage.session.get([OPENAI_DEVICE_STORAGE_KEY]),
  ]);
  const pending = deviceResult[OPENAI_DEVICE_STORAGE_KEY] || null;
  if (pending?.expiresAt && pending.expiresAt <= Date.now()) {
    await removePendingDeviceFlow(pendingFlowId(pending));
  }
  return {
    linked: Boolean(auth.refreshToken),
    account: getPublicOpenAIAccount(auth),
    pending: pending?.expiresAt > Date.now() ? getPublicDeviceAuthorization(pending) : null,
  };
}

export function startOpenAIDeviceAuthorization() {
  if (deviceStartPromise) return deviceStartPromise;
  const generation = ++deviceGeneration;
  devicePollPromise = null;
  const trackedStart = (async () => {
    await chrome.storage.session.remove(OPENAI_DEVICE_STORAGE_KEY);
    const response = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw await responseError(response, "Could not start OpenAI device sign-in");
    const pending = {
      ...normalizeDeviceAuthorization(await response.json()),
      flowId: crypto.randomUUID(),
    };
    if (generation !== deviceGeneration) {
      throw new Error("OpenAI sign-in was cancelled.");
    }
    await chrome.storage.session.set({ [OPENAI_DEVICE_STORAGE_KEY]: pending });
    if (generation !== deviceGeneration) {
      throw new Error("OpenAI sign-in was cancelled.");
    }
    await chrome.tabs.create({ url: OPENAI_DEVICE_URL, active: true });
    return getPublicDeviceAuthorization(pending);
  })().finally(() => {
    if (deviceStartPromise === trackedStart) deviceStartPromise = null;
  });
  deviceStartPromise = trackedStart;
  return trackedStart;
}

export async function openOpenAIDevicePage() {
  await chrome.tabs.create({ url: OPENAI_DEVICE_URL, active: true });
  return { opened: true };
}

export async function cancelOpenAIDeviceAuthorization() {
  deviceGeneration += 1;
  deviceStartPromise = null;
  devicePollPromise = null;
  await chrome.storage.session.remove(OPENAI_DEVICE_STORAGE_KEY);
  return getOpenAIOAuthStatus();
}

function pendingFlowId(pending) {
  return String(pending?.flowId || pending?.deviceAuthId || "");
}

async function getPendingDeviceFlow() {
  const stored = await chrome.storage.session.get([OPENAI_DEVICE_STORAGE_KEY]);
  return stored[OPENAI_DEVICE_STORAGE_KEY] || null;
}

async function isCurrentPendingDeviceFlow(flowId, expectedGeneration = null) {
  const current = await getPendingDeviceFlow();
  return (expectedGeneration === null || expectedGeneration === deviceGeneration) &&
    pendingFlowId(current) === flowId;
}

async function removePendingDeviceFlow(flowId, expectedGeneration = null) {
  if (await isCurrentPendingDeviceFlow(flowId, expectedGeneration)) {
    await chrome.storage.session.remove(OPENAI_DEVICE_STORAGE_KEY);
    return true;
  }
  return false;
}

async function updatePendingDeviceFlow(flowId, patch, expectedGeneration = null) {
  const current = await getPendingDeviceFlow();
  if (
    (expectedGeneration !== null && expectedGeneration !== deviceGeneration) ||
    pendingFlowId(current) !== flowId
  ) return false;
  await chrome.storage.session.set({
    [OPENAI_DEVICE_STORAGE_KEY]: { ...current, ...patch },
  });
  return true;
}

function getRetryAfterMs(response, now = Date.now()) {
  const value = String(response.headers?.get?.("retry-after") || "").trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

async function pollPendingDeviceFlow() {
  const generation = deviceGeneration;
  const pending = await getPendingDeviceFlow();
  if (!pending?.deviceAuthId || !pending?.userCode) return getOpenAIOAuthStatus();
  const flowId = pendingFlowId(pending);
  const now = Date.now();
  if (Number(pending.expiresAt) <= now) {
    await removePendingDeviceFlow(flowId, generation);
    throw new Error("OpenAI sign-in expired. Start again to get a new code.");
  }
  if (Number(pending.nextPollAt) > now) return getOpenAIOAuthStatus();

  const intervalMs = Math.max(Number(pending.intervalMs) || 8000, 1000);
  if (generation !== deviceGeneration) return getOpenAIOAuthStatus();
  const reserved = await updatePendingDeviceFlow(flowId, {
    nextPollAt: now + intervalMs,
    pollBackoffMs: intervalMs,
  }, generation);
  if (!reserved || generation !== deviceGeneration) return getOpenAIOAuthStatus();
  const response = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: pending.deviceAuthId,
      user_code: pending.userCode,
    }),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });

  if (!(await isCurrentPendingDeviceFlow(flowId, generation))) {
    return getOpenAIOAuthStatus();
  }
  if (response.status === 403 || response.status === 404) {
    return getOpenAIOAuthStatus();
  }
  if (response.status === 429) {
    const previousBackoff = Math.max(Number(pending.pollBackoffMs) || intervalMs, intervalMs);
    const retryAfterMs = getRetryAfterMs(response, now);
    const backoffMs = Math.min(
      Math.max(previousBackoff * 2, retryAfterMs, intervalMs),
      MAX_DEVICE_POLL_BACKOFF_MS,
    );
    await updatePendingDeviceFlow(flowId, {
      nextPollAt: Date.now() + backoffMs,
      pollBackoffMs: backoffMs,
    }, generation);
    return getOpenAIOAuthStatus();
  }
  if (!response.ok) {
    await removePendingDeviceFlow(flowId, generation);
    throw await responseError(response, "OpenAI device sign-in failed");
  }

  const authorization = await response.json();
  const code = String(authorization?.authorization_code || "");
  const verifier = String(authorization?.code_verifier || "");
  if (!code || !verifier) throw new Error("OpenAI returned an incomplete device sign-in result.");
  if (!(await isCurrentPendingDeviceFlow(flowId, generation))) {
    return getOpenAIOAuthStatus();
  }
  const tokens = await tokenExchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: verifier,
  }, {}, () => generation === deviceGeneration);
  if (!tokens) return getOpenAIOAuthStatus();
  await removePendingDeviceFlow(flowId, generation);
  return getOpenAIOAuthStatus();
}

export function pollOpenAIDeviceAuthorization() {
  if (!devicePollPromise) {
    const trackedPoll = pollPendingDeviceFlow().finally(() => {
      if (devicePollPromise === trackedPoll) devicePollPromise = null;
    });
    devicePollPromise = trackedPoll;
  }
  return devicePollPromise;
}

export async function logoutOpenAI() {
  deviceGeneration += 1;
  deviceStartPromise = null;
  devicePollPromise = null;
  await Promise.all([
    clearAuth(),
    chrome.storage.session.remove(OPENAI_DEVICE_STORAGE_KEY),
  ]);
  return getOpenAIOAuthStatus();
}

function openAIClientVersion() {
  const version = String(chrome.runtime?.getManifest?.().version || "").trim();
  return /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version) ? version : "0.0.0";
}

async function fetchOpenAIModelCatalog(auth) {
  const version = openAIClientVersion();
  const url = new URL(OPENAI_MODELS_URL);
  url.searchParams.set("client_version", version);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    originator: "margin",
    version,
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_CATALOG_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOpenAISubscriptionModels() {
  let auth = await getAccessContext();
  let response;
  try {
    response = await fetchOpenAIModelCatalog(auth);
  } catch {
    return structuredClone(OPENAI_SUBSCRIPTION_MODELS);
  }

  if (response.status === 401) {
    auth = await getAccessContext(true);
    try {
      response = await fetchOpenAIModelCatalog(auth);
    } catch {
      return structuredClone(OPENAI_SUBSCRIPTION_MODELS);
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw await responseError(response, "Could not load OpenAI models");
  }
  if (!response.ok) {
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return structuredClone(OPENAI_SUBSCRIPTION_MODELS);
    }
    throw await responseError(response, "Could not load OpenAI models");
  }

  try {
    const body = await readBoundedResponse(response, MAX_MODEL_CATALOG_BYTES);
    const models = normalizeOpenAIModelsResponse(JSON.parse(body));
    return models.length ? models : structuredClone(OPENAI_SUBSCRIPTION_MODELS);
  } catch {
    return structuredClone(OPENAI_SUBSCRIPTION_MODELS);
  }
}

async function fetchOpenAIResponse(request, sessionId, signal, forceRefresh = false) {
  const auth = await getAccessContext(forceRefresh);
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: "margin",
    "session-id": String(sessionId || crypto.randomUUID()).slice(0, 128),
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  return fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
}

export async function requestOpenAICompletion(requestBody, { signal, sessionId = "" } = {}) {
  const serialized = JSON.stringify(requestBody);
  if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("The OpenAI request is too large. Remove attachments or older context and try again.");
  }
  const request = buildOpenAIResponsesRequest(requestBody, { sessionId });
  let response = await fetchOpenAIResponse(request, sessionId, signal, false);
  if (response.status === 401) response = await fetchOpenAIResponse(request, sessionId, signal, true);
  if (!response.ok) throw await responseError(response, "OpenAI response failed");
  const body = await readBoundedResponse(response);
  return parseOpenAIResponseBody(body, response.headers.get("content-type") || "");
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {}
}

function startWorkerKeepalive() {
  return setInterval(() => {
    try {
      const result = chrome.runtime.getPlatformInfo();
      result?.catch?.(() => {});
    } catch {}
  }, WORKER_KEEPALIVE_INTERVAL_MS);
}

export function handleOpenAIResponsePort(port) {
  if (port.name !== "openai-responses") return;
  let controller = null;
  let timeout = null;
  let keepalive = null;
  let started = false;

  port.onMessage.addListener((message) => {
    if (message?.type === "cancel") {
      controller?.abort();
      return;
    }
    if (message?.type !== "request" || started) return;
    started = true;
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), RESPONSE_TIMEOUT_MS);
    keepalive = startWorkerKeepalive();

    (async () => {
      try {
        const stored = await chrome.storage.local.get(["aiProvider", "dataSharingConsent"]);
        if (stored.aiProvider !== "openai" || stored.dataSharingConsent !== true) {
          throw new Error("Select OpenAI and accept provider processing before sending data.");
        }
        const result = await requestOpenAICompletion(message.body, {
          signal: controller.signal,
          sessionId: String(message.sessionId || ""),
        });
        safePost(port, { type: "result", result });
      } catch (error) {
        const aborted = controller.signal.aborted || error?.name === "AbortError";
        safePost(port, {
          type: "error",
          error: aborted ? "OpenAI response stopped." : error?.message || String(error),
          aborted,
        });
      } finally {
        clearTimeout(timeout);
        clearInterval(keepalive);
        controller = null;
        keepalive = null;
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    clearTimeout(timeout);
    clearInterval(keepalive);
    controller?.abort();
  });
}
