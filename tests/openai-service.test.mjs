import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_ACCESS_STORAGE_KEY,
  OPENAI_AUTH_STORAGE_KEY,
  OPENAI_DEVICE_STORAGE_KEY,
  OPENAI_SUBSCRIPTION_MODELS,
} from "../shared/openai-protocol.js";

function storageArea(state) {
  return {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]));
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("device OAuth stores the refresh token only in trusted local storage", async () => {
  const local = {};
  const session = {};
  const openedTabs = [];
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    tabs: { async create(options) { openedTabs.push(options); } },
  };
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).endsWith("/api/accounts/deviceauth/usercode")) {
      return jsonResponse({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "1" });
    }
    if (String(url).endsWith("/api/accounts/deviceauth/token")) {
      return jsonResponse({ authorization_code: "authorization-1", code_verifier: "verifier-1" });
    }
    if (String(url).endsWith("/oauth/token")) {
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: jwt({
          email: "user@example.com",
          chatgpt_account_id: "account-1",
          chatgpt_plan_type: "plus",
        }),
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const service = await import(`../background/openai-service.js?device=${Date.now()}`);
    const firstStart = service.startOpenAIDeviceAuthorization();
    const secondStart = service.startOpenAIDeviceAuthorization();
    assert.equal(firstStart, secondStart);
    const pending = await firstStart;
    assert.equal(pending.userCode, "ABCD-EFGH");
    assert.equal(openedTabs[0].url, "https://auth.openai.com/codex/device");
    assert.equal(openedTabs.length, 1);
    assert.equal(fetchCalls.filter((call) => call.url.endsWith("/api/accounts/deviceauth/usercode")).length, 1);
    assert.equal(session[OPENAI_DEVICE_STORAGE_KEY].deviceAuthId, "device-1");
    assert.ok(session[OPENAI_DEVICE_STORAGE_KEY].nextPollAt > Date.now());

    session[OPENAI_DEVICE_STORAGE_KEY].nextPollAt = 0;
    const status = await service.pollOpenAIDeviceAuthorization();
    assert.equal(status.linked, true);
    assert.deepEqual(status.account, {
      type: "chatgpt",
      email: "user@example.com",
      planType: "plus",
    });
    assert.equal(local[OPENAI_AUTH_STORAGE_KEY].refreshToken, "refresh-1");
    assert.equal(Object.hasOwn(local[OPENAI_AUTH_STORAGE_KEY], "accessToken"), false);
    assert.equal(session[OPENAI_ACCESS_STORAGE_KEY].accessToken, "access-1");
    assert.equal(Object.hasOwn(session, OPENAI_DEVICE_STORAGE_KEY), false);
    assert.equal(fetchCalls[2].options.body.includes("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback"), true);

    await service.logoutOpenAI();
    assert.equal(Object.hasOwn(local, OPENAI_AUTH_STORAGE_KEY), false);
    assert.equal(Object.hasOwn(session, OPENAI_ACCESS_STORAGE_KEY), false);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("concurrent device polls serialize and cancellation prevents stale credential writes", async () => {
  const local = {};
  const session = {
    [OPENAI_DEVICE_STORAGE_KEY]: {
      deviceAuthId: "device-race",
      flowId: "flow-race",
      userCode: "RACE-CODE",
      intervalMs: 8000,
      nextPollAt: 0,
      expiresAt: Date.now() + 60_000,
    },
  };
  const tokenResult = deferred();
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let devicePollCalls = 0;
  let tokenExchangeCalls = 0;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    tabs: { async create() {} },
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/accounts/deviceauth/token")) {
      devicePollCalls += 1;
      return tokenResult.promise;
    }
    if (String(url).endsWith("/oauth/token")) {
      tokenExchangeCalls += 1;
      return jsonResponse({
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const service = await import(`../background/openai-service.js?cancel-race=${Date.now()}`);
    const firstPoll = service.pollOpenAIDeviceAuthorization();
    const secondPoll = service.pollOpenAIDeviceAuthorization();
    assert.equal(firstPoll, secondPoll);
    await nextTask();
    assert.equal(devicePollCalls, 1);

    await service.cancelOpenAIDeviceAuthorization();
    tokenResult.resolve(jsonResponse({
      authorization_code: "stale-code",
      code_verifier: "stale-verifier",
    }));
    const status = await firstPoll;

    assert.equal(status.linked, false);
    assert.equal(tokenExchangeCalls, 0);
    assert.equal(Object.hasOwn(local, OPENAI_AUTH_STORAGE_KEY), false);
    assert.equal(Object.hasOwn(session, OPENAI_DEVICE_STORAGE_KEY), false);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("device polling honors Retry-After and increases its backoff on 429", async () => {
  const local = {};
  const session = {
    [OPENAI_DEVICE_STORAGE_KEY]: {
      deviceAuthId: "device-rate-limit",
      flowId: "flow-rate-limit",
      userCode: "RATE-LIMIT",
      intervalMs: 8000,
      pollBackoffMs: 8000,
      nextPollAt: 0,
      expiresAt: Date.now() + 60_000,
    },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    tabs: { async create() {} },
  };
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith("/api/accounts/deviceauth/token")) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return new Response("", { status: 429, headers: { "Retry-After": "20" } });
  };

  try {
    const service = await import(`../background/openai-service.js?rate-limit=${Date.now()}`);
    const before = Date.now();
    const status = await service.pollOpenAIDeviceAuthorization();
    const stored = session[OPENAI_DEVICE_STORAGE_KEY];
    assert.ok(stored.nextPollAt >= before + 20_000);
    assert.equal(stored.pollBackoffMs, 20_000);
    assert.ok(status.pending.retryAfterMs > 19_000);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("expired access tokens refresh once and Responses calls preserve the account header", async () => {
  const local = {
    [OPENAI_AUTH_STORAGE_KEY]: {
      refreshToken: "refresh-old",
      accountId: "account-old",
      email: "old@example.com",
      planType: "plus",
    },
  };
  const session = {
    [OPENAI_ACCESS_STORAGE_KEY]: { accessToken: "expired", expiresAt: 0 },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    tabs: { async create() {} },
  };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) {
      return jsonResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    }
    if (String(url).endsWith("/backend-api/codex/responses")) {
      const response = {
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      };
      return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const service = await import(`../background/openai-service.js?refresh=${Date.now()}`);
    const result = await service.requestOpenAICompletion({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    }, { sessionId: "chat-1" });
    assert.equal(result.choices[0].message.content, "done");
    assert.equal(calls.filter((call) => call.url.endsWith("/oauth/token")).length, 1);
    const responseCall = calls.find((call) => call.url.endsWith("/backend-api/codex/responses"));
    assert.equal(responseCall.options.headers.Authorization, "Bearer access-new");
    assert.equal(responseCall.options.headers["ChatGPT-Account-Id"], "account-old");
    assert.equal(responseCall.options.headers.originator, "margin");
    assert.equal(responseCall.options.headers["session-id"], "chat-1");
    assert.equal(local[OPENAI_AUTH_STORAGE_KEY].refreshToken, "refresh-new");
    assert.equal(local[OPENAI_AUTH_STORAGE_KEY].email, "old@example.com");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs are fetched for the linked ChatGPT account with the extension version", async () => {
  const local = {
    [OPENAI_AUTH_STORAGE_KEY]: {
      refreshToken: "refresh-current",
      accountId: "account-current",
    },
  };
  const session = {
    [OPENAI_ACCESS_STORAGE_KEY]: {
      accessToken: "access-current",
      expiresAt: Date.now() + 120_000,
    },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    runtime: { getManifest() { return { version: "9.8.7" }; } },
    tabs: { async create() {} },
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        visibility: "list",
        priority: 1,
      }],
    });
  };

  try {
    const service = await import(`../background/openai-service.js?models=${Date.now()}`);
    const models = await service.getOpenAISubscriptionModels();
    assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-sol"]);
    assert.equal(calls.length, 1);
    const requestUrl = new URL(calls[0].url);
    assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, "https://chatgpt.com/backend-api/codex/models");
    assert.equal(requestUrl.searchParams.get("client_version"), "9.8.7");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.headers.Authorization, "Bearer access-current");
    assert.equal(calls[0].options.headers["ChatGPT-Account-Id"], "account-current");
    assert.equal(calls[0].options.headers.version, "9.8.7");
    assert.equal(calls[0].options.cache, "no-store");
    assert.equal(calls[0].options.credentials, "omit");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("model catalog authorization retries once with a refreshed access token", async () => {
  const local = {
    [OPENAI_AUTH_STORAGE_KEY]: {
      refreshToken: "refresh-old",
      accountId: "account-current",
    },
  };
  const session = {
    [OPENAI_ACCESS_STORAGE_KEY]: {
      accessToken: "access-old",
      expiresAt: Date.now() + 120_000,
    },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let modelAttempts = 0;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    runtime: { getManifest() { return { version: "9.8.7" }; } },
    tabs: { async create() {} },
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) {
      return jsonResponse({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    }
    if (String(url).startsWith("https://chatgpt.com/backend-api/codex/models?")) {
      modelAttempts += 1;
      if (modelAttempts === 1) return jsonResponse({ error: "expired" }, 401);
      return jsonResponse({
        models: [{
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          visibility: "list",
          priority: 1,
        }],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const service = await import(`../background/openai-service.js?model-refresh=${Date.now()}`);
    const models = await service.getOpenAISubscriptionModels();
    assert.equal(models[0].id, "gpt-5.6-sol");
    const modelCalls = calls.filter((call) => call.url.startsWith("https://chatgpt.com/backend-api/codex/models?"));
    assert.equal(modelCalls.length, 2);
    assert.equal(calls.filter((call) => call.url.endsWith("/oauth/token")).length, 1);
    assert.equal(modelCalls[0].options.headers.Authorization, "Bearer access-old");
    assert.equal(modelCalls[1].options.headers.Authorization, "Bearer access-new");
    assert.equal(modelCalls[1].options.headers["ChatGPT-Account-Id"], "account-current");
    assert.equal(local[OPENAI_AUTH_STORAGE_KEY].refreshToken, "refresh-new");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("model catalog failures use fallback models without masking auth errors", async () => {
  const local = {
    [OPENAI_AUTH_STORAGE_KEY]: {
      refreshToken: "refresh-current",
      accountId: "account-current",
    },
  };
  const session = {
    [OPENAI_ACCESS_STORAGE_KEY]: {
      accessToken: "access-current",
      expiresAt: Date.now() + 120_000,
    },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    runtime: { getManifest() { return { version: "9.8.7" }; } },
    tabs: { async create() {} },
  };

  try {
    const transientFailures = [
      async () => { throw new TypeError("network unavailable"); },
      async () => jsonResponse({ error: "temporarily unavailable" }, 503),
      async () => new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    for (const [index, fetchFailure] of transientFailures.entries()) {
      globalThis.fetch = fetchFailure;
      const service = await import(`../background/openai-service.js?model-fallback=${Date.now()}-${index}`);
      const models = await service.getOpenAISubscriptionModels();
      assert.deepEqual(models, structuredClone(OPENAI_SUBSCRIPTION_MODELS));
    }

    delete local[OPENAI_AUTH_STORAGE_KEY];
    delete session[OPENAI_ACCESS_STORAGE_KEY];
    let unauthenticatedFetches = 0;
    globalThis.fetch = async () => {
      unauthenticatedFetches += 1;
      throw new Error("The network must not be used without authentication.");
    };
    const unlinkedService = await import(`../background/openai-service.js?model-unlinked=${Date.now()}`);
    await assert.rejects(
      unlinkedService.getOpenAISubscriptionModels(),
      /Link your ChatGPT account/i,
    );
    assert.equal(unauthenticatedFetches, 0);

    local[OPENAI_AUTH_STORAGE_KEY] = {
      refreshToken: "refresh-current",
      accountId: "account-current",
    };
    session[OPENAI_ACCESS_STORAGE_KEY] = {
      accessToken: "access-current",
      expiresAt: Date.now() + 120_000,
    };
    globalThis.fetch = async () => jsonResponse({ error: "plan denied" }, 403);
    const forbiddenService = await import(`../background/openai-service.js?model-forbidden=${Date.now()}`);
    await assert.rejects(
      forbiddenService.getOpenAISubscriptionModels(),
      /authorize|plan denied|permission/i,
    );
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("unlinking during an in-flight refresh prevents credentials from being restored", async () => {
  const local = {
    [OPENAI_AUTH_STORAGE_KEY]: {
      refreshToken: "refresh-old",
      accountId: "account-old",
    },
  };
  const session = {
    [OPENAI_ACCESS_STORAGE_KEY]: { accessToken: "expired", expiresAt: 0 },
  };
  const refreshResult = deferred();
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let responseCalls = 0;
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    tabs: { async create() {} },
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/oauth/token")) return refreshResult.promise;
    if (String(url).endsWith("/backend-api/codex/responses")) {
      responseCalls += 1;
      throw new Error("A response request should not be sent after unlinking.");
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const service = await import(`../background/openai-service.js?unlink-refresh=${Date.now()}`);
    const request = service.requestOpenAICompletion({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    });
    await nextTask();
    await service.logoutOpenAI();
    refreshResult.resolve(jsonResponse({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      expires_in: 3600,
    }));

    await assert.rejects(request, /cleared while refreshing/);
    assert.equal(responseCalls, 0);
    assert.equal(Object.hasOwn(local, OPENAI_AUTH_STORAGE_KEY), false);
    assert.equal(Object.hasOwn(session, OPENAI_ACCESS_STORAGE_KEY), false);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("an active Responses request keeps the MV3 worker alive until the stream finishes", async () => {
  const local = {
    aiProvider: "openai",
    dataSharingConsent: true,
    [OPENAI_AUTH_STORAGE_KEY]: {
      refreshToken: "refresh-current",
      accountId: "account-current",
    },
  };
  const session = {
    [OPENAI_ACCESS_STORAGE_KEY]: {
      accessToken: "access-current",
      expiresAt: Date.now() + 120_000,
    },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let streamController;
  let keepaliveCalls = 0;
  const intervalHandles = [];
  const resultMessage = deferred();
  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay, cleared: false };
    intervalHandles.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    if (handle) handle.cleared = true;
  };
  globalThis.chrome = {
    storage: { local: storageArea(local), session: storageArea(session) },
    runtime: {
      async getPlatformInfo() {
        keepaliveCalls += 1;
        return { os: "mac" };
      },
    },
    tabs: { async create() {} },
  };
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith("/backend-api/codex/responses")) {
      throw new Error(`Unexpected request: ${url}`);
    }
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    name: "openai-responses",
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { resultMessage.resolve(message); },
  };

  try {
    const service = await import(`../background/openai-service.js?keepalive=${Date.now()}`);
    service.handleOpenAIResponsePort(port);
    messageListeners[0]({
      type: "request",
      sessionId: "keepalive-test",
      body: {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    await nextTask();

    assert.equal(intervalHandles.length, 1);
    assert.ok(intervalHandles[0].delay < 30_000);
    intervalHandles[0].callback();
    await nextTask();
    assert.equal(keepaliveCalls, 1);

    const response = {
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      }],
    };
    streamController.enqueue(new TextEncoder().encode(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
    ));
    streamController.close();
    const posted = await resultMessage.promise;
    assert.equal(posted.type, "result");
    assert.equal(posted.result.choices[0].message.content, "done");
    assert.equal(intervalHandles[0].cleared, true);
  } finally {
    disconnectListeners.forEach((listener) => listener());
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
