// Runs several browser tools in one call. Both surfaces reach this through a
// thin adapter — the side panel's in-chat agent via executeTool, the MCP bridge
// via the background service worker via executePageTool — so there is exactly
// one batch executor and one place where per-action access is enforced.
//
// Nothing here imports a panel or background module, so either side can load it
// and recipes.js can take the shared constants without an import cycle.

export const BATCH_TOOL_NAME = "browser_batch";
// Every action spends one call from the run's tool budget, so keep batches small
// enough that one batch cannot consume most of a turn's budget on its own.
export const MAX_BATCH_ACTIONS = 10;

export const BATCHABLE_TOOL_NAMES = new Set([
  "navigate", "click_element", "fill_element", "fill_form", "fill_secret", "type_text",
  "hover_element", "press_key", "scroll_page", "wait_for", "take_snapshot",
  "get_dom", "get_active_tab", "list_tabs", "run_js", "evaluate_script"
]);

// A navigation or a click can still be committing when the next action runs.
// Exported because recipe replay (recipes.js) reuses the same settle behavior.
export const SETTLE_AFTER_TOOLS = new Set(["navigate", "click_element"]);
export const SETTLE_MS = 400;

// Per-action output is capped so a long batch cannot swallow the context window.
const TOTAL_RESULT_BUDGET = 24000;
const MAX_ACTION_RESULT_CHARS = 4000;
const MIN_ACTION_RESULT_CHARS = 600;

export function parseToolResultObject(result) {
  if (result && typeof result === "object" && !result.screenshot && result.type !== "file") return result;
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function batchError(message, errorCode = "invalid_arguments") {
  return JSON.stringify({
    ok: false,
    tool: BATCH_TOOL_NAME,
    error_code: errorCode,
    recoverable: true,
    message
  }, null, 2);
}

function perActionCharLimit(actionCount) {
  const share = Math.floor(TOTAL_RESULT_BUDGET / Math.max(1, actionCount));
  return Math.min(MAX_ACTION_RESULT_CHARS, Math.max(MIN_ACTION_RESULT_CHARS, share));
}

// Returns "" when the action may run, otherwise the reason it may not.
function describeActionRejection(tool, isToolEnabled) {
  if (!tool) return 'Each action needs a "tool" name.';
  if (tool === BATCH_TOOL_NAME) return "browser_batch cannot be nested inside itself.";
  if (tool === "take_screenshot") {
    return "take_screenshot cannot run inside a batch because each screenshot needs its own image attachment. Call it as a standalone tool.";
  }
  if (!BATCHABLE_TOOL_NAMES.has(tool)) {
    return `"${tool}" is not batchable. Batchable tools: ${[...BATCHABLE_TOOL_NAMES].join(", ")}.`;
  }
  // The same gate a standalone call would hit; enabling browser_batch must never
  // re-enable a tool the user switched off.
  if (!isToolEnabled(tool)) {
    return `Tool "${tool}" is disabled in Margin Tool Access settings.`;
  }
  return "";
}

function actionArguments(action) {
  const raw = action.arguments && typeof action.arguments === "object" ? action.arguments : {};
  const copy = { ...raw };
  // One snapshot for the whole batch, not one per action.
  delete copy.include_snapshot;
  return copy;
}

function describeActionResult(result, limit) {
  if (result && typeof result === "object" && result.screenshot) {
    return "Screenshots are not returned inside a batch. Call take_screenshot on its own.";
  }
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const safe = typeof text === "string" ? text : String(text);
  return safe.length > limit
    ? `${safe.slice(0, limit)}\n…truncated (${safe.length} chars total)`
    : safe;
}

async function runAction(deps, tool, toolArgs) {
  let result;
  try {
    result = await deps.runTool(tool, toolArgs);
  } catch (err) {
    result = {
      ok: false,
      tool,
      error_code: "tool_threw",
      recoverable: true,
      message: err?.message || String(err)
    };
  }
  return deps.observeResult ? (deps.observeResult(tool, toolArgs, result) || result) : result;
}

/**
 * deps.runTool(tool, args)        — required; executes one action.
 * deps.isToolEnabled(tool)        — required; per-action access gate.
 * deps.guardBeforeExecution(tool) — optional; the in-chat agent's tool budget.
 *                                   The bridge has no agent run, so it omits this.
 * deps.observeResult(t, a, r)     — optional; loop-guard hook, may replace a result.
 */
export async function runBatch(args = {}, deps = {}) {
  const actions = Array.isArray(args.actions) ? args.actions : null;
  if (!actions || actions.length === 0) {
    return batchError('browser_batch needs a non-empty "actions" array.');
  }
  if (actions.length > MAX_BATCH_ACTIONS) {
    return batchError(`A batch holds at most ${MAX_BATCH_ACTIONS} actions; received ${actions.length}. Split it into several batches.`);
  }

  const guardBeforeExecution = deps.guardBeforeExecution || (() => null);
  const stopOnError = args.stop_on_error !== false;
  const limit = perActionCharLimit(actions.length);
  const results = [];
  let halted = "";

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] && typeof actions[index] === "object" ? actions[index] : {};
    const tool = String(action.tool || "");

    if (halted) {
      results.push({ index, tool, status: "skipped" });
      continue;
    }

    const rejection = describeActionRejection(tool, deps.isToolEnabled);
    if (rejection) {
      results.push({ index, tool, status: "error", error: rejection });
      if (stopOnError) halted = `action ${index} (${tool || "unnamed"}) was rejected`;
      continue;
    }

    // Every action spends one call from the run's budget. Counting the batch as
    // a single call would make the user's maxToolCalls limit meaningless.
    const guard = guardBeforeExecution(tool);
    if (guard) {
      results.push({ index, tool, status: "error", error: guard.message || "Tool call limit reached." });
      halted = "the agent tool-call limit was reached";
      continue;
    }

    const toolArgs = actionArguments(action);
    const result = await runAction(deps, tool, toolArgs);
    const failed = parseToolResultObject(result)?.ok === false;
    results.push({
      index,
      tool,
      status: failed ? "error" : "ok",
      result: describeActionResult(result, limit)
    });

    if (failed) {
      if (stopOnError) halted = `action ${index} (${tool}) failed`;
      continue;
    }
    if (SETTLE_AFTER_TOOLS.has(tool) && index < actions.length - 1) {
      await settle(SETTLE_MS);
    }
  }

  const succeeded = results.filter((entry) => entry.status === "ok").length;
  const failed = results.filter((entry) => entry.status === "error").length;
  const skipped = results.filter((entry) => entry.status === "skipped").length;

  let snapshot;
  if (args.include_snapshot === true && succeeded > 0 && deps.isToolEnabled("take_snapshot")) {
    const guard = guardBeforeExecution("take_snapshot");
    snapshot = describeActionResult(guard || await runAction(deps, "take_snapshot", {}), MAX_ACTION_RESULT_CHARS);
  }

  return JSON.stringify({
    ok: failed === 0,
    tool: BATCH_TOOL_NAME,
    summary: `${succeeded}/${results.length} ok`
      + (failed ? `, ${failed} failed` : "")
      + (skipped ? `, ${skipped} skipped` : ""),
    ...(halted ? { stopped_early: halted } : {}),
    results,
    ...(snapshot === undefined ? {} : { snapshot })
  }, null, 2);
}
