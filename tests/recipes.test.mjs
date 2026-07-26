import test from "node:test";
import assert from "node:assert/strict";

// workspace.js -> persistence/ui and network-logs register chrome listeners at
// import time, so the stub has to exist before the module graph loads. The
// document stub lets renderWorkspaceStrip (called on every workspace write)
// no-op instead of throwing.
globalThis.chrome = {
  tabs: {
    onRemoved: { addListener() {} },
    query: async () => [{ id: 1, url: "https://example.com/app", title: "App", windowId: 1 }]
  },
  runtime: {},
  storage: {
    session: { get: async () => ({}) },
    local: { get: async () => ({}), set: async () => ({}) }
  }
};
globalThis.document = { getElementById: () => null };

const { executeRecipeTool, recordStep, resetRecording, RECIPE_TOOL_NAMES } =
  await import("../sidepanel/tools/recipes.js");
const { getWorkspaceFile } = await import("../sidepanel/features/workspace.js");
const { globalWorkspace } = await import("../sidepanel/state/store.js");

// Records what run_recipe steps actually dispatched to the background worker.
function recordBackgroundCalls(reply = () => "ok") {
  const calls = [];
  globalThis.chrome.runtime.sendMessage = (message, callback) => {
    calls.push({ name: message.name, args: message.arguments });
    callback({ ok: true, result: reply(message.name, message.arguments, calls.length) });
  };
  return calls;
}

test("recipe tools exist under their contract names", () => {
  assert.deepEqual([...RECIPE_TOOL_NAMES].sort(), ["find_recipe", "run_recipe", "save_recipe"]);
});

test("save_recipe rejects steps that use non-action tools", async () => {
  const scripted = JSON.parse(await executeRecipeTool("save_recipe", {
    name: "bad",
    steps: [{ tool: "run_js", args: { code: "1" } }]
  }));
  assert.equal(scripted.ok, false);
  assert.equal(scripted.error_code, "invalid_steps");
  assert.match(scripted.message, /run_js/);

  const observing = JSON.parse(await executeRecipeTool("save_recipe", {
    name: "bad2",
    steps: [{ tool: "take_snapshot" }]
  }));
  assert.equal(observing.error_code, "invalid_steps");
  assert.match(observing.message, /take_snapshot/);
});

test("the recorder keeps only successful action steps and strips include_snapshot", async () => {
  resetRecording();
  recordStep("take_snapshot", {}, JSON.stringify({ ok: true }));
  recordStep("click_element", { uid: "sf-a" }, JSON.stringify({ ok: false, error_code: "target_not_found" }));
  const empty = JSON.parse(await executeRecipeTool("save_recipe", { name: "empty" }));
  assert.equal(empty.ok, false);
  assert.equal(empty.error_code, "nothing_recorded");

  recordStep(
    "click_element",
    { uid: "sf-a", include_snapshot: true },
    JSON.stringify({ ok: true, element: { role: "button", name: "Go", tag: "button" } })
  );
  const saved = JSON.parse(await executeRecipeTool("save_recipe", { name: "one step" }));
  assert.equal(saved.ok, true);
  assert.equal(saved.path, "recipes/example.com/one-step.json");
  assert.equal(saved.step_count, 1);

  const file = JSON.parse(getWorkspaceFile(saved.path).content);
  assert.equal(file.host, "example.com");
  assert.deepEqual(file.steps[0], {
    tool: "click_element",
    args: { uid: "sf-a" },
    element: { role: "button", name: "Go", tag: "button" }
  });
  resetRecording();
});

test("recording caps at 40 steps, keeps the earliest, and warns on save", async () => {
  resetRecording();
  for (let i = 0; i < 45; i += 1) {
    recordStep("press_key", { key: `k${i}` }, JSON.stringify({ ok: true }));
  }
  const saved = JSON.parse(await executeRecipeTool("save_recipe", { name: "long flow" }));
  assert.equal(saved.ok, true);
  assert.equal(saved.step_count, 40);
  assert.match(saved.warning, /40 steps/);

  const file = JSON.parse(getWorkspaceFile(saved.path).content);
  assert.equal(file.steps.length, 40);
  assert.equal(file.steps[0].args.key, "k0", "the opening steps survive");
  assert.equal(file.steps[39].args.key, "k39", "the newest overflow is what gets dropped");
  resetRecording();
});

test("run_recipe validates placeholders up front and substitutes recursively", async () => {
  const saved = JSON.parse(await executeRecipeTool("save_recipe", {
    name: "search",
    steps: [
      { tool: "navigate", args: { url: "https://example.com/search?q={{query}}" } },
      { tool: "fill_form", args: { elements: [{ uid: "sf-input-abc", value: "{{query}} in {{region}}" }] } }
    ]
  }));
  assert.equal(saved.ok, true);

  const calls = recordBackgroundCalls();
  const missing = JSON.parse(await executeRecipeTool("run_recipe", {
    path: saved.path,
    values: { query: "tea" }
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "missing_values");
  assert.deepEqual([...missing.required].sort(), ["query", "region"]);
  assert.deepEqual(missing.missing, ["region"]);
  assert.equal(calls.length, 0, "no step runs before every placeholder has a value");

  const run = JSON.parse(await executeRecipeTool("run_recipe", {
    path: saved.path,
    values: { query: "tea", region: "EU" }
  }));
  assert.equal(run.ok, true);
  assert.equal(run.completed, 2);
  assert.equal(calls[0].args.url, "https://example.com/search?q=tea");
  assert.equal(calls[1].args.elements[0].value, "tea in EU", "substitution reaches nested arg objects");
});

test("a stale uid is re-resolved when exactly one candidate matches the recorded element", async () => {
  const saved = JSON.parse(await executeRecipeTool("save_recipe", {
    name: "relogin",
    steps: [{
      tool: "click_element",
      args: { uid: "sf-button-old111" },
      element: { role: "button", name: "Sign in", tag: "button" }
    }]
  }));
  assert.equal(saved.ok, true);

  const calls = recordBackgroundCalls((name, args, count) => count === 1
    ? {
        ok: false, tool: "click_element", error_code: "target_not_found",
        message: "No element matched that uid or selector.",
        data: {
          candidates: [
            { uid: "sf-button-new222", role: "button", name: "Sign in", tag: "button" },
            { uid: "sf-a-help333", role: "link", name: "Help", tag: "a" }
          ]
        }
      }
    : { ok: true, tool: "click_element", message: "Element clicked." });

  const run = JSON.parse(await executeRecipeTool("run_recipe", { path: saved.path }));
  assert.equal(run.ok, true);
  assert.equal(run.completed, 1);
  assert.equal(calls.length, 2, "exactly one deterministic retry");
  assert.equal(calls[1].args.uid, "sf-button-new222");
});

test("an ambiguous candidate match aborts with the remaining plan instead of guessing", async () => {
  const saved = JSON.parse(await executeRecipeTool("save_recipe", {
    name: "ambiguous",
    steps: [
      {
        tool: "click_element",
        args: { uid: "sf-button-old111" },
        element: { role: "button", name: "Sign in", tag: "button" }
      },
      { tool: "press_key", args: { key: "Enter" } }
    ]
  }));
  assert.equal(saved.ok, true);

  const calls = recordBackgroundCalls(() => ({
    ok: false, tool: "click_element", error_code: "target_not_found",
    message: "No element matched that uid or selector.",
    data: {
      candidates: [
        { uid: "sf-button-new222", role: "button", name: "Sign in", tag: "button" },
        { uid: "sf-button-new333", role: "button", name: "Sign in", tag: "button" }
      ]
    }
  }));

  const run = JSON.parse(await executeRecipeTool("run_recipe", { path: saved.path }));
  assert.equal(run.ok, false);
  assert.equal(run.error_code, "recipe_step_failed");
  assert.equal(run.recoverable, true);
  assert.equal(run.completed, 0);
  assert.equal(calls.length, 1, "two equally-matching candidates mean no retry");
  assert.deepEqual(
    { index: run.failed_step.index, tool: run.failed_step.tool },
    { index: 0, tool: "click_element" }
  );
  assert.match(run.message, /step 1/);
  assert.deepEqual(run.remaining_steps.map((step) => step.tool), ["click_element", "press_key"],
    "the failed step and everything after it come back as an executable plan");
});

test("find_recipe matches by host suffix and prefers the most specific recipe", async () => {
  const seeded = [];
  const seed = (host, slug, name, updatedAt) => {
    const path = `recipes/${host}/${slug}.json`;
    globalWorkspace[path] = {
      path,
      language: "json",
      description: "",
      tags: ["recipe", host],
      updatedAt,
      content: JSON.stringify({
        name, host, description: "", created_url: `https://${host}/`,
        steps: [{ tool: "press_key", args: { key: "Enter" }, element: null }],
        version: 1
      })
    };
    seeded.push(path);
  };
  seed("shop.test", "login", "login", 100);
  seed("login.shop.test", "sso", "sso", 50);
  seed("other.test", "login", "other login", 10);
  globalWorkspace["recipes/shop.test/notes.txt"] = { path: "recipes/shop.test/notes.txt", content: "not a recipe" };
  seeded.push("recipes/shop.test/notes.txt");

  try {
    const sub = JSON.parse(await executeRecipeTool("find_recipe", { host: "login.shop.test" }));
    assert.equal(sub.ok, true);
    assert.deepEqual(sub.recipes.map((r) => r.name), ["sso", "login"],
      "the longest matching host sorts first");

    const apex = JSON.parse(await executeRecipeTool("find_recipe", { host: "shop.test" }));
    assert.deepEqual(apex.recipes.map((r) => r.name), ["login"],
      "a subdomain recipe never leaks up to the apex domain");

    const cousin = JSON.parse(await executeRecipeTool("find_recipe", { host: "app.shop.test" }));
    assert.deepEqual(cousin.recipes.map((r) => r.name), ["login"]);

    const lookalike = JSON.parse(await executeRecipeTool("find_recipe", { host: "notshop.test" }));
    assert.deepEqual(lookalike.recipes, [], "suffix matching is per-label, not per-character");

    assert.equal("steps" in sub.recipes[0], false, "find_recipe returns metadata only");
    assert.equal(sub.recipes[0].step_count, 1);
  } finally {
    seeded.forEach((path) => { delete globalWorkspace[path]; });
  }
});
