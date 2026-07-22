import test from "node:test";
import assert from "node:assert/strict";

let debuggerAttachCount = 0;

globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      async get() {
        return {
          networkCapture: {
            autoCaptureLatchedTab: true,
            persistSessionLogs: true,
            captureResponseBodies: true,
            redactSensitiveData: true,
          },
        };
      },
    },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
  debugger: {
    attach(_target, _version, callback) {
      debuggerAttachCount += 1;
      callback();
    },
    detach(_target, callback) { callback(); },
    sendCommand(_target, _method, _params, callback) { callback({}); },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: {
    onRemoved: { addListener() {} },
  },
};

const {
  redactNetworkUrl,
  syncNetworkAutoCapture,
} = await import("../shared/network-logs.js");

test("network URL redaction removes credentials and common query secrets", () => {
  const output = redactNetworkUrl(
    "https://user:password@example.test/callback?access_token=token-value&api_key=key-value&code=oauth-code&q=margin#id_token=jwt-value&state=kept",
  );
  const parsed = new URL(output);

  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.searchParams.get("access_token"), "[redacted]");
  assert.equal(parsed.searchParams.get("api_key"), "[redacted]");
  assert.equal(parsed.searchParams.get("code"), "[redacted]");
  assert.equal(parsed.searchParams.get("q"), "margin");
  assert.match(decodeURIComponent(parsed.hash), /id_token=\[redacted\]/);
  assert.match(parsed.hash, /state=kept/);
  assert.doesNotMatch(output, /token-value|key-value|oauth-code|jwt-value|password/);
});

test("network URL redaction covers signed-cloud query parameters", () => {
  const output = redactNetworkUrl(
    "wss://example.test/socket?X-Amz-Credential=credential&X-Amz-Signature=signature&channel=updates",
  );
  const parsed = new URL(output);

  assert.equal(parsed.searchParams.get("X-Amz-Credential"), "[redacted]");
  assert.equal(parsed.searchParams.get("X-Amz-Signature"), "[redacted]");
  assert.equal(parsed.searchParams.get("channel"), "updates");
});

test("network auto-capture attaches when enabled for the latched tab", async () => {
  const result = await syncNetworkAutoCapture({ tabId: 7 });
  assert.match(result, /active for the latched tab/i);
  assert.equal(debuggerAttachCount, 1);
});
