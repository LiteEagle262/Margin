import test from "node:test";
import assert from "node:assert/strict";
import { executeBatchTool, MAX_BATCH_ACTIONS } from "../sidepanel/tools/batch.js";

function harness(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      runTool: async (name, args) => {
        calls.push({ name, args });
        return `ran ${name}`;
      },
      isToolEnabled: () => true,
      settle: async () => {},
      ...overrides
    }
  };
}

const parse = (raw) => JSON.parse(raw);

test("a batch runs actions in order and reports each one", async () => {
  const { calls, deps } = harness();
  const parsed = parse(await executeBatchTool({
    actions: [
      { tool: "navigate", arguments: { url: "https://example.com" } },
      { tool: "wait_for", arguments: { selector: "#main" } },
      { tool: "take_snapshot" }
    ]
  }, deps));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, "3/3 ok");
  assert.deepEqual(calls.map((call) => call.name), ["navigate", "wait_for", "take_snapshot"]);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["ok", "ok", "ok"]);
});

test("a disabled tool fails only its own action and keeps earlier results", async () => {
  const { deps } = harness({ isToolEnabled: (name) => name !== "run_js" });
  const parsed = parse(await executeBatchTool({
    actions: [
      { tool: "take_snapshot" },
      { tool: "run_js", arguments: { code: "1" } },
      { tool: "get_dom" }
    ]
  }, deps));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.results[0].status, "ok");
  assert.equal(parsed.results[0].result, "ran take_snapshot");
  assert.equal(parsed.results[1].status, "error");
  assert.match(parsed.results[1].error, /disabled in Margin Tool Access/);
  assert.equal(parsed.results[2].status, "skipped");
});

test("nested batches, screenshots, and non-batchable tools are rejected per action", async () => {
  const { calls, deps } = harness();
  const parsed = parse(await executeBatchTool({
    stop_on_error: false,
    actions: [
      { tool: "browser_batch", arguments: { actions: [] } },
      { tool: "take_screenshot" },
      { tool: "write_file", arguments: { path: "a.js", content: "" } },
      { tool: "" }
    ]
  }, deps));

  assert.equal(calls.length, 0);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["error", "error", "error", "error"]);
  assert.match(parsed.results[0].error, /cannot be nested/);
  assert.match(parsed.results[1].error, /standalone/);
  assert.match(parsed.results[2].error, /not batchable/);
  assert.match(parsed.results[3].error, /needs a "tool" name/);
});

test("stop_on_error false runs every action and reports them independently", async () => {
  const { calls, deps } = harness({
    runTool: async (name) => (name === "click_element" ? "Error: no element for uid e12" : `ran ${name}`)
  });
  const parsed = parse(await executeBatchTool({
    stop_on_error: false,
    actions: [{ tool: "click_element" }, { tool: "get_dom" }, { tool: "list_tabs" }]
  }, deps));

  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary, "2/3 ok, 1 failed");
  assert.equal(parsed.stopped_early, undefined);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["error", "ok", "ok"]);
  assert.equal(calls.length, 0);
});

test("each action spends one call from the run's tool-call budget", async () => {
  let budget = 2;
  const { calls, deps } = harness({
    guardCall: (tool) => {
      budget -= 1;
      return budget < 0 ? { tool, message: "Stopped after 2 tool calls." } : null;
    }
  });
  const parsed = parse(await executeBatchTool({
    actions: [{ tool: "get_dom" }, { tool: "list_tabs" }, { tool: "get_active_tab" }, { tool: "take_snapshot" }]
  }, deps));

  assert.equal(calls.length, 2);
  assert.deepEqual(parsed.results.map((entry) => entry.status), ["ok", "ok", "error", "skipped"]);
  assert.match(parsed.stopped_early, /tool-call limit/);
});

test("batch size is capped and empty batches are refused", async () => {
  const { deps } = harness();
  const tooMany = parse(await executeBatchTool({
    actions: Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => ({ tool: "get_dom" }))
  }, deps));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /at most 20 actions/);

  const empty = parse(await executeBatchTool({ actions: [] }, deps));
  assert.equal(empty.ok, false);
  assert.equal(empty.error_code, "invalid_arguments");
});

test("per-action include_snapshot is dropped in favour of one batch snapshot", async () => {
  const { calls, deps } = harness();
  const parsed = parse(await executeBatchTool({
    include_snapshot: true,
    actions: [{ tool: "click_element", arguments: { uid: "e1", include_snapshot: true } }]
  }, deps));

  assert.deepEqual(calls[0].args, { uid: "e1" });
  assert.deepEqual(calls.map((call) => call.name), ["click_element", "take_snapshot"]);
  assert.equal(parsed.snapshot, "ran take_snapshot");
});

test("long action output is truncated so a batch cannot flood the context", async () => {
  const { deps } = harness({ runTool: async () => "x".repeat(50000) });
  const parsed = parse(await executeBatchTool({
    actions: Array.from({ length: 4 }, () => ({ tool: "get_dom" }))
  }, deps));

  for (const entry of parsed.results) {
    assert.ok(entry.result.length < 5000, "each action result stays bounded");
    assert.match(entry.result, /truncated \(50000 chars total\)/);
  }
});
