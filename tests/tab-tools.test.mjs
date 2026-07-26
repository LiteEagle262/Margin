import test from "node:test";
import assert from "node:assert/strict";

// network-logs.js registers chrome listeners at import time, so the stub has to
// exist before shared/browser-tools.js is loaded.
globalThis.chrome = {
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  debugger: {},
  runtime: {},
  storage: {
    session: { get: async () => ({}), remove: async () => {} },
    local: { get: async () => ({}) }
  }
};

const { executePageTool } = await import("../shared/browser-tools.js");

// Installs a chrome.tabs/windows stub. `tabs` maps id -> tab record;
// `latchedTabId` (when set) points the session latch at one of them;
// `focused` is the state of every tab's window.
function stubTabs({ tabs = {}, latchedTabId = null, focused = true } = {}) {
  const calls = { created: [], updated: [], removed: [], windowUpdates: [] };
  globalThis.chrome.tabs.create = async (options) => {
    calls.created.push(options);
    return { id: 99, ...options };
  };
  globalThis.chrome.tabs.get = async (tabId) => {
    if (!tabs[tabId]) throw new Error(`No tab with id: ${tabId}.`);
    return tabs[tabId];
  };
  globalThis.chrome.tabs.update = async (tabId, props) => { calls.updated.push({ tabId, props }); };
  globalThis.chrome.tabs.remove = async (tabId) => { calls.removed.push(tabId); };
  globalThis.chrome.windows = {
    get: async (windowId) => ({ id: windowId, focused }),
    update: async (windowId, props) => { calls.windowUpdates.push({ windowId, props }); }
  };
  globalThis.chrome.storage.session.get = async () => (
    latchedTabId === null
      ? {}
      : { latchedTab: { tabId: latchedTabId, url: tabs[latchedTabId]?.url, title: tabs[latchedTabId]?.title } }
  );
  return calls;
}

const tabFixture = {
  1: { id: 1, url: "https://latched.example.com/app", title: "Latched", windowId: 10 },
  2: { id: 2, url: "https://other.example.com/", title: "Other", windowId: 10 }
};

test("open_tab opens only http(s) URLs and reports the new tab", async () => {
  const calls = stubTabs();

  const missing = await executePageTool("open_tab", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "missing_url");

  const scheme = await executePageTool("open_tab", { url: "javascript:alert(1)" });
  assert.equal(scheme.ok, false);
  assert.equal(scheme.error_code, "tool_execution_failed");
  assert.match(scheme.message, /limited to http:\/\/ and https:\/\/ URLs/);

  const file = await executePageTool("open_tab", { url: "file:///etc/passwd" });
  assert.equal(file.ok, false);
  assert.match(file.message, /limited to http:\/\/ and https:\/\/ URLs/);

  const junk = await executePageTool("open_tab", { url: "not a url" });
  assert.equal(junk.ok, false);
  assert.match(junk.message, /valid http:\/\/ or https:\/\/ URL/);

  assert.equal(calls.created.length, 0, "no rejected URL reaches chrome.tabs.create");

  const opened = JSON.parse(await executePageTool("open_tab", { url: "https://example.com/page" }));
  assert.deepEqual(opened, { ok: true, tab_id: 99, url: "https://example.com/page" });
  assert.equal(calls.created[0].active, true, "foreground by default");

  await executePageTool("open_tab", { url: "https://example.com/page", background: true });
  assert.equal(calls.created[1].active, false, "background:true opens without focus");
});

test("open_tab under a latch warns that tools keep acting on the latched tab", async () => {
  stubTabs({ tabs: tabFixture, latchedTabId: 1 });

  const opened = JSON.parse(await executePageTool("open_tab", { url: "https://fresh.example.com/" }));
  assert.equal(opened.ok, true);
  assert.equal(opened.tab_id, 99);
  assert.match(opened.warning, /latched to tab 1/);
  assert.match(opened.warning, /not the new one/);
});

test("select_tab activates the tab and warns when a latch targets a different one", async () => {
  const calls = stubTabs({ tabs: tabFixture, latchedTabId: 1, focused: false });

  const result = JSON.parse(await executePageTool("select_tab", { tab_id: 2 }));
  assert.equal(result.ok, true);
  assert.equal(result.tab_id, 2);
  assert.equal(result.url, "https://other.example.com/");
  assert.match(result.warning, /latched to tab 1/);
  assert.deepEqual(calls.updated, [{ tabId: 2, props: { active: true } }]);
  assert.deepEqual(calls.windowUpdates, [{ windowId: 10, props: { focused: true } }], "an unfocused window gets focused");

  const same = JSON.parse(await executePageTool("select_tab", { tab_id: 1 }));
  assert.equal(same.ok, true);
  assert.equal(same.warning, undefined, "selecting the latched tab itself is not warned");
});

test("select_tab rejects bad and unknown tab ids with structured errors", async () => {
  stubTabs({ tabs: tabFixture });

  const invalid = await executePageTool("select_tab", { tab_id: "first" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error_code, "invalid_tab_id");

  const unknown = await executePageTool("select_tab", { tab_id: 777 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error_code, "unknown_tab_id");
  assert.deepEqual(unknown.next_actions.map((action) => action.tool), ["list_tabs"]);
});

test("close_tab refuses the latched tab and closes others", async () => {
  const calls = stubTabs({ tabs: tabFixture, latchedTabId: 1 });

  const refused = await executePageTool("close_tab", { tab_id: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error_code, "tab_latched");
  assert.equal(refused.recoverable, false);
  assert.match(refused.message, /unlatch/);
  assert.equal(calls.removed.length, 0, "the latched tab is never removed");

  const closed = JSON.parse(await executePageTool("close_tab", { tab_id: 2 }));
  assert.deepEqual(closed, { ok: true, tab_id: 2, closed: true });
  assert.deepEqual(calls.removed, [2]);
});

test("close_tab warns when it closes the tab tools were targeting", async (t) => {
  const calls = stubTabs({ tabs: tabFixture });
  // No latch: tools follow the active tab, which is the tab being closed.
  const originalQuery = globalThis.chrome.tabs.query;
  globalThis.chrome.tabs.query = async () => [tabFixture[2]];
  t.after(() => { globalThis.chrome.tabs.query = originalQuery; });

  const closed = JSON.parse(await executePageTool("close_tab", { tab_id: 2 }));
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  assert.match(closed.warning, /tab browser tools were targeting/);
  assert.match(closed.warning, /get_active_tab/);
  assert.deepEqual(calls.removed, [2]);

  // Closing a tab that is not the tool target stays warning-free.
  globalThis.chrome.tabs.query = async () => [tabFixture[1]];
  const other = JSON.parse(await executePageTool("close_tab", { tab_id: 2 }));
  assert.deepEqual(other, { ok: true, tab_id: 2, closed: true });
});

test("close_tab reports unknown and invalid tab ids without touching chrome", async () => {
  const calls = stubTabs({ tabs: tabFixture });

  const unknown = await executePageTool("close_tab", { tab_id: 777 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error_code, "unknown_tab_id");
  assert.match(unknown.message, /No tab with id 777/);
  assert.deepEqual(unknown.next_actions.map((action) => action.tool), ["list_tabs"]);

  const invalid = await executePageTool("close_tab", { tab_id: "current" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error_code, "invalid_tab_id");

  assert.equal(calls.removed.length, 0);
});
