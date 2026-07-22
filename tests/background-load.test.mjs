import test from "node:test";
import assert from "node:assert/strict";

function extensionEvent() {
  return { addListener() {} };
}

test("background service worker loads defensively when chrome.debugger is unavailable", async () => {
  let keepaliveCreated = false;
  globalThis.chrome = {
    alarms: {
      create(name) {
        if (name === "margin-bridge-keepalive") keepaliveCreated = true;
      },
      onAlarm: extensionEvent(),
    },
    permissions: {
      async contains() { return true; },
      onAdded: extensionEvent(),
      onRemoved: extensionEvent(),
    },
    runtime: {
      getManifest() { return { version: "1.4.3" }; },
      lastError: null,
      onInstalled: extensionEvent(),
      onConnect: extensionEvent(),
      onMessage: extensionEvent(),
      onStartup: extensionEvent(),
      async sendMessage() {},
    },
    sidePanel: {
      async setPanelBehavior() {},
    },
    storage: {
      local: {
        async get() { return {}; },
        async set() {},
        async remove() {},
        async setAccessLevel() {},
      },
      onChanged: extensionEvent(),
      session: {
        async get() { return {}; },
        async remove() {},
        async set() {},
      },
    },
    tabs: {
      async get() {},
      onRemoved: extensionEvent(),
      onUpdated: extensionEvent(),
      async query() { return []; },
      async create() {},
    },
  };

  await assert.doesNotReject(import(`../background.js?load-test=${Date.now()}`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keepaliveCreated, true);
});
