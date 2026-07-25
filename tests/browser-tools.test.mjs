import test from "node:test";
import assert from "node:assert/strict";

// network-logs.js registers chrome listeners at import time, so the stub has to
// exist before shared/browser-tools.js is loaded.
globalThis.chrome = {
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  debugger: {},
  runtime: {},
  storage: { session: { get: async () => ({}) }, local: { get: async () => ({}) } }
};

const { pageAgentScript, executePageTool } = await import("../shared/browser-tools.js");
const { executeTool } = await import("../sidepanel/tools/execute.js");
const { executeBatchTool, MAX_BATCH_ACTIONS } = await import("../sidepanel/tools/batch.js");
const { settings, beginAgentRunState, endAgentRunState } = await import("../sidepanel/state/store.js");

// Records what the batch actually dispatched to the background worker.
function recordBackgroundCalls(reply = (name) => `ran ${name}`) {
  const calls = [];
  globalThis.chrome.runtime.sendMessage = (message, callback) => {
    calls.push({ name: message.name, args: message.arguments });
    callback({ ok: true, result: reply(message.name) });
  };
  return calls;
}

function element(tag, props = {}) {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: props.id || "",
    classList: props.classes || [],
    children: [],
    parentElement: null,
    innerText: props.innerText || "",
    textContent: props.textContent || "",
    value: props.value,
    checked: props.checked,
    placeholder: props.placeholder,
    disabled: props.disabled === true,
    isContentEditable: props.contentEditable === true,
    hidden: props.hidden === true,
    selector: props.selector || "",
    attrs: props.attrs || {},
    clicks: 0,
    getAttribute(attr) {
      return Object.hasOwn(this.attrs, attr) ? this.attrs[attr] : null;
    },
    getBoundingClientRect() {
      return this.hidden ? { x: 0, y: 0, width: 0, height: 0 } : { x: 1, y: 2, width: 100, height: 20 };
    },
    scrollIntoView() {},
    focus() {},
    click() { this.clicks += 1; },
    dispatchEvent() { return true; }
  };
}

function installDom(nodes) {
  const body = element("body", { innerText: "page body text" });
  body.children = nodes;
  nodes.forEach((node) => { node.parentElement = body; });

  globalThis.document = {
    title: "Test page",
    body,
    getElementById: () => null,
    // The injected code asks for exactly two selectors; only the interactive
    // one has to resolve for these tests.
    querySelectorAll: (selector) => (selector.includes("contenteditable") ? nodes : []),
    querySelector: (selector) => nodes.find((node) => node.selector === selector) || null
  };
  globalThis.getComputedStyle = (el) => ({
    visibility: el.hidden ? "hidden" : "visible",
    display: el.hidden ? "none" : "block"
  });
  globalThis.CSS = { escape: (value) => value };
  globalThis.location = { href: "https://example.com/form" };
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  globalThis.MouseEvent = class extends Event {};
  globalThis.KeyboardEvent = class extends Event {};
  return nodes;
}

function snapshot(nodes) {
  installDom(nodes);
  return pageAgentScript({ op: "snapshot", limit: 80, verbose: false });
}

test("a snapshot uid resolves to the same element when hidden nodes precede it", () => {
  const hiddenInput = element("input", { hidden: true, attrs: { type: "hidden" } });
  const hiddenBox = element("div", { hidden: true, attrs: { role: "button" }, innerText: "Ghost" });
  const submit = element("button", { innerText: "Submit order" });
  const nodes = [hiddenInput, hiddenBox, submit];

  const result = snapshot(nodes);
  assert.equal(result.element_count, 1, "invisible nodes stay out of the snapshot");

  const uid = result.elements[0].uid;
  const clicked = pageAgentScript({ op: "interact", action: "click", uid });

  assert.equal(clicked.ok, true);
  assert.equal(clicked.target.uid, uid);
  assert.equal(submit.clicks, 1);
});

test("a uid does not move when the elements before it change", () => {
  const submit = element("button", { innerText: "Submit order" });
  const withNoise = snapshot([element("input", { hidden: true }), element("select", { hidden: true }), submit]);
  const withoutNoise = snapshot([submit]);

  assert.equal(withNoise.elements[0].uid, withoutNoise.elements[0].uid);
  assert.match(withNoise.elements[0].uid, /^sf-button-/);
});

test("a uid survives the field it points at being filled", () => {
  const field = element("input", { placeholder: "Email", selector: "#email", value: "" });
  const before = snapshot([field]).elements[0].uid;

  const filled = pageAgentScript({ op: "interact", action: "fill", uid: before, value: "a@b.com" });
  assert.equal(filled.ok, true);
  assert.equal(field.value, "a@b.com");
  assert.equal(snapshot([field]).elements[0].uid, before);
});

test("a value the page refuses to keep is reported as a failure", () => {
  const rejecting = element("input", { placeholder: "Amount" });
  Object.defineProperty(rejecting, "value", {
    get() { return ""; },
    set() {},
    configurable: true
  });
  const uid = snapshot([rejecting]).elements[0].uid;

  const result = pageAgentScript({ op: "interact", action: "fill", uid, value: "42" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "value_not_applied");
});

test("an unresolved uid returns usable candidates instead of an empty list", () => {
  const nodes = [element("button", { innerText: "Save" }), element("button", { innerText: "Cancel" }), element("a", { innerText: "Help", attrs: { href: "/help" } })];
  installDom(nodes);

  const result = pageAgentScript({ op: "interact", action: "click", uid: "sf-button-zzzzzz" });
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "target_not_found");
  assert.deepEqual(result.candidates.map((item) => item.name), ["Save", "Cancel"]);
  for (const candidate of result.candidates) {
    assert.match(candidate.uid, /^sf-button-/);
  }
});

test("page tools report failure through the ok:false envelope, never a string prefix", async () => {
  const unknown = await executePageTool("no_such_tool", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error_code, "unknown_tool");

  const missingCode = await executePageTool("run_js", {});
  assert.equal(missingCode.ok, false);
  assert.equal(missingCode.error_code, "missing_code");
});

test("get_cookies is bound to the active tab and refuses without the optional permission", async () => {
  const queries = [];
  globalThis.chrome.tabs.query = async () => [{ id: 7, url: "https://shop.example.com/cart", title: "Cart", windowId: 1 }];

  const denied = await executePageTool("get_cookies", { domain: "https://bank.example.com" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error_code, "missing_permission");

  globalThis.chrome.cookies = { getAll: async (query) => { queries.push(query); return []; } };
  const allowed = await executePageTool("get_cookies", { domain: "https://bank.example.com" });
  assert.equal(JSON.parse(allowed).url, "https://shop.example.com/cart");
  assert.deepEqual(queries, [{ url: "https://shop.example.com/cart" }]);
  delete globalThis.chrome.cookies;
});

test("a failing tool is ok:false through executeTool and fails its batch", async () => {
  const failure = { ok: false, tool: "get_dom", error_code: "execution_failed", message: "DOM content could not be extracted." };
  globalThis.chrome.runtime.sendMessage = (message, callback) => {
    callback(message.name === "get_dom" ? { ok: true, result: failure } : { ok: true, result: `ran ${message.name}` });
  };

  const direct = await executeTool("get_dom", {});
  assert.equal(direct.ok, false);

  const batch = JSON.parse(await executeBatchTool({ actions: [{ tool: "get_dom" }, { tool: "list_tabs" }] }));
  assert.equal(batch.ok, false);
  assert.deepEqual(batch.results.map((entry) => entry.status), ["error", "skipped"]);
  assert.match(batch.stopped_early, /action 0 \(get_dom\) failed/);
});

test("a tool the background refuses is a failure, not a successful string", async () => {
  globalThis.chrome.runtime.sendMessage = (message, callback) => {
    callback({ ok: false, result: `Tool "${message.name}" is disabled in Margin settings.` });
  };

  const result = await executeTool("get_dom", {});
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "tool_refused");
  assert.match(result.message, /disabled in Margin settings/);
});

test("a batch runs actions in order and reports each one", async () => {
  const calls = recordBackgroundCalls();
  const parsed = JSON.parse(await executeBatchTool({
    actions: [
      { tool: "wait_for", arguments: { selector: "#main" } },
      { tool: "take_snapshot" },
      { tool: "get_active_tab" }
    ]
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "3/3 ok");
  assert.deepEqual(calls.map((call) => call.name), ["wait_for", "take_snapshot", "get_active_tab"]);
});

test("a disabled tool fails only its own action and keeps earlier results", async () => {
  recordBackgroundCalls();
  settings.toolAccess = { enabled: { get_dom: false } };
  const parsed = JSON.parse(await executeBatchTool({
    actions: [{ tool: "take_snapshot" }, { tool: "get_dom" }, { tool: "list_tabs" }]
  }));
  settings.toolAccess = {};

  assert.equal(parsed.ok, false);
  assert.equal(parsed.results[0].status, "ok");
  assert.equal(parsed.results[1].status, "error");
  assert.match(parsed.results[1].error, /disabled in Margin Tool Access/);
  assert.equal(parsed.results[2].status, "skipped");
});

test("nested batches, screenshots, and non-batchable tools are rejected per action", async () => {
  const calls = recordBackgroundCalls();
  const parsed = JSON.parse(await executeBatchTool({
    stop_on_error: false,
    actions: [
      { tool: "browser_batch", arguments: { actions: [] } },
      { tool: "take_screenshot" },
      { tool: "write_file", arguments: { path: "a.js", content: "" } },
      { tool: "" }
    ]
  }));

  assert.equal(calls.length, 0);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["error", "error", "error", "error"]);
  assert.match(parsed.results[0].error, /cannot be nested/);
  assert.match(parsed.results[1].error, /standalone/);
  assert.match(parsed.results[2].error, /not batchable/);
  assert.match(parsed.results[3].error, /needs a "tool" name/);
});

test("stop_on_error false runs every action and reports them independently", async () => {
  recordBackgroundCalls((name) => (name === "get_dom" ? { ok: false, tool: name, message: "no dom" } : `ran ${name}`));
  const parsed = JSON.parse(await executeBatchTool({
    stop_on_error: false,
    actions: [{ tool: "get_dom" }, { tool: "list_tabs" }, { tool: "get_active_tab" }]
  }));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary, "2/3 ok, 1 failed");
  assert.equal(parsed.stopped_early, undefined);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["error", "ok", "ok"]);
});

test("each action spends one call from the run's tool-call budget", async () => {
  const calls = recordBackgroundCalls();
  settings.agentLimits = { maxToolCalls: 2, fallbackContextWindow: 128000 };
  beginAgentRunState("test-chat");
  const parsed = JSON.parse(await executeBatchTool({
    actions: [{ tool: "get_dom" }, { tool: "list_tabs" }, { tool: "get_active_tab" }, { tool: "take_snapshot" }]
  }));
  endAgentRunState();
  settings.agentLimits = { maxToolCalls: 14, fallbackContextWindow: 128000 };

  assert.equal(calls.length, 2);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["ok", "ok", "error", "skipped"]);
  assert.match(parsed.stopped_early, /tool-call limit/);
});

test("batch size is capped at what the tool-call budget can pay for", async () => {
  recordBackgroundCalls();
  const tooMany = JSON.parse(await executeBatchTool({
    actions: Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ tool: "get_dom" }))
  }));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, new RegExp(`at most ${MAX_BATCH_ACTIONS} actions`));

  const empty = JSON.parse(await executeBatchTool({ actions: [] }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error_code, "invalid_arguments");
});

test("per-action include_snapshot is dropped in favour of one batch snapshot", async () => {
  const calls = recordBackgroundCalls();
  const parsed = JSON.parse(await executeBatchTool({
    include_snapshot: true,
    actions: [{ tool: "hover_element", arguments: { uid: "sf-button-abc123", include_snapshot: true } }]
  }));

  assert.deepEqual(calls[0].args, { uid: "sf-button-abc123" });
  assert.deepEqual(calls.map((call) => call.name), ["hover_element", "take_snapshot"]);
  assert.equal(parsed.snapshot, "ran take_snapshot");
});

test("long action output is truncated so a batch cannot flood the context", async () => {
  recordBackgroundCalls(() => "x".repeat(50000));
  const parsed = JSON.parse(await executeBatchTool({
    actions: Array.from({ length: 4 }, () => ({ tool: "get_dom" }))
  }));

  for (const entry of parsed.results) {
    assert.ok(entry.result.length < 5000, "each action result stays bounded");
    assert.match(entry.result, /truncated \(50000 chars total\)/);
  }
});
