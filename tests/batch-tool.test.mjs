import test from "node:test";
import assert from "node:assert/strict";
import { executeBatchTool, MAX_BATCH_ACTIONS } from "../sidepanel/tools/batch.js";
import { settings, beginAgentRunState, endAgentRunState } from "../sidepanel/state/store.js";

const parse = (raw) => JSON.parse(raw);

// executeBatchTool reaches the page tools through executeTool, which posts to the
// background service worker. Standing in for that port is the only seam a batch
// test needs.
function stubBackground(t, respond = (name) => `ran ${name}`) {
  const calls = [];
  const originalChrome = globalThis.chrome;
  const originalToolAccess = settings.toolAccess;
  const originalAgentLimits = settings.agentLimits;
  globalThis.chrome = {
    runtime: {
      sendMessage(message, callback) {
        calls.push({ name: message.name, args: message.arguments });
        callback({ ok: true, result: respond(message.name) });
      }
    }
  };
  t.after(() => {
    globalThis.chrome = originalChrome;
    settings.toolAccess = originalToolAccess;
    settings.agentLimits = originalAgentLimits;
    endAgentRunState();
  });
  return calls;
}

test("a batch runs actions in order and reports each one", async (t) => {
  const calls = stubBackground(t);
  const parsed = parse(await executeBatchTool({
    actions: [
      { tool: "navigate", arguments: { url: "https://example.com" } },
      { tool: "wait_for", arguments: { selector: "#main" } },
      { tool: "take_snapshot" }
    ]
  }));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "3/3 ok");
  assert.deepEqual(calls.map((call) => call.name), ["navigate", "wait_for", "take_snapshot"]);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["ok", "ok", "ok"]);
});

test("a disabled tool fails only its own action and keeps earlier results", async (t) => {
  stubBackground(t);
  settings.toolAccess = { enabled: { run_js: false } };
  const parsed = parse(await executeBatchTool({
    actions: [
      { tool: "take_snapshot" },
      { tool: "run_js", arguments: { code: "1" } },
      { tool: "get_dom" }
    ]
  }));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.results[0].status, "ok");
  assert.equal(parsed.results[0].result, "ran take_snapshot");
  assert.equal(parsed.results[1].status, "error");
  assert.match(parsed.results[1].error, /disabled in Margin Tool Access/);
  assert.equal(parsed.results[2].status, "skipped");
});

test("nested batches, screenshots, and non-batchable tools are rejected per action", async (t) => {
  const calls = stubBackground(t);
  const parsed = parse(await executeBatchTool({
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

test("stop_on_error false runs every action and reports them independently", async (t) => {
  const calls = stubBackground(t, (name) => (name === "click_element"
    ? { ok: false, tool: name, error_code: "element_not_found", recoverable: true, message: "no element for uid e12" }
    : `ran ${name}`));
  const parsed = parse(await executeBatchTool({
    stop_on_error: false,
    actions: [{ tool: "click_element" }, { tool: "get_dom" }, { tool: "list_tabs" }]
  }));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary, "2/3 ok, 1 failed");
  assert.equal(parsed.stopped_early, undefined);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["error", "ok", "ok"]);
  assert.deepEqual(calls.map((call) => call.name), ["click_element", "get_dom", "list_tabs"]);
});

test("each action spends one call from the run's tool-call budget", async (t) => {
  const calls = stubBackground(t);
  settings.agentLimits = { maxToolCalls: 2, fallbackContextWindow: 128000 };
  beginAgentRunState("chat-1");
  const parsed = parse(await executeBatchTool({
    actions: [{ tool: "get_dom" }, { tool: "list_tabs" }, { tool: "get_active_tab" }, { tool: "take_snapshot" }]
  }));

  assert.equal(calls.length, 2);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["ok", "ok", "error", "skipped"]);
  assert.match(parsed.stopped_early, /tool-call limit/);
});

test("batch size is capped and empty batches are refused", async (t) => {
  stubBackground(t);
  const tooMany = parse(await executeBatchTool({
    actions: Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ tool: "get_dom" }))
  }));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, new RegExp(`at most ${MAX_BATCH_ACTIONS} actions`));

  const empty = parse(await executeBatchTool({ actions: [] }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error_code, "invalid_arguments");
});

test("per-action include_snapshot is dropped in favour of one batch snapshot", async (t) => {
  const calls = stubBackground(t);
  const parsed = parse(await executeBatchTool({
    include_snapshot: true,
    actions: [{ tool: "click_element", arguments: { uid: "e1", include_snapshot: true } }]
  }));

  assert.deepEqual(calls[0].args, { uid: "e1" });
  assert.deepEqual(calls.map((call) => call.name), ["click_element", "take_snapshot"]);
  assert.equal(parsed.snapshot, "ran take_snapshot");
});

test("long action output is truncated so a batch cannot flood the context", async (t) => {
  stubBackground(t, () => "x".repeat(50000));
  const parsed = parse(await executeBatchTool({
    actions: Array.from({ length: 4 }, () => ({ tool: "get_dom" }))
  }));

  for (const entry of parsed.results) {
    assert.ok(entry.result.length < 5000, "each action result stays bounded");
    assert.match(entry.result, /truncated \(50000 chars total\)/);
  }
});
