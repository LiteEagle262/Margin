// Runs several browser tools in one call. Both callers reach this through
// executeTool — the in-chat agent directly, the MCP bridge via mcp/tool-call —
// so there is exactly one executor and one place where per-action access is
// enforced. Dependencies are injected to keep this module free of chrome APIs.

export const BATCH_TOOL_NAME = "browser_batch";
export const MAX_BATCH_ACTIONS = 20;

export const BATCHABLE_TOOL_NAMES = new Set([
  "navigate", "click_element", "fill_element", "fill_form", "type_text",
  "hover_element", "press_key", "scroll_page", "wait_for", "take_snapshot",
  "get_dom", "get_active_tab", "list_tabs", "run_js", "evaluate_script"
]);

// A navigation or a click can still be committing when the next action runs.
const SETTLE_AFTER_TOOLS = new Set(["navigate", "click_element"]);
const SETTLE_MS = 400;

// Per-action output is capped so a long batch cannot swallow the context window.
const TOTAL_RESULT_BUDGET = 24000;
const MAX_ACTION_RESULT_CHARS = 4000;
const MIN_ACTION_RESULT_CHARS = 600;

function defaultParseResult(result) {
  if (result && typeof result === "object") return result;
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function defaultSettle(ms) {
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

function isFailure(result, parseResult) {
  if (parseResult(result)?.ok === false) return true;
  return typeof result === "string" && result.startsWith("Error:");
}

export async function executeBatchTool(args = {}, deps = {}) {
  const {
    runTool,
    isToolEnabled = () => true,
    guardCall = () => null,
    evaluateGuard = () => null,
    parseResult = defaultParseResult,
    settle = defaultSettle
  } = deps;

  const actions = Array.isArray(args.actions) ? args.actions : null;
  if (!actions || actions.length === 0) {
    return batchError('browser_batch needs a non-empty "actions" array.');
  }
  if (actions.length > MAX_BATCH_ACTIONS) {
    return batchError(`A batch holds at most ${MAX_BATCH_ACTIONS} actions; received ${actions.length}. Split it into several batches.`);
  }

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

    const rejection = describeActionRejection(tool, isToolEnabled);
    if (rejection) {
      results.push({ index, tool, status: "error", error: rejection });
      if (stopOnError) halted = `action ${index} (${tool || "unnamed"}) was rejected`;
      continue;
    }

    // Every action spends one call from the run's budget. Counting the batch as
    // a single call would make the user's maxToolCalls limit meaningless.
    const guard = guardCall(tool);
    if (guard) {
      results.push({ index, tool, status: "error", error: guard.message || "Tool call limit reached." });
      halted = "the agent tool-call limit was reached";
      continue;
    }

    const toolArgs = actionArguments(action);
    let result;
    try {
      result = await runTool(tool, toolArgs);
    } catch (err) {
      result = `Error: ${err?.message || String(err)}`;
    }
    result = evaluateGuard(tool, toolArgs, result) || result;

    const failed = isFailure(result, parseResult);
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
  if (args.include_snapshot === true && succeeded > 0 && isToolEnabled("take_snapshot")) {
    try {
      snapshot = describeActionResult(await runTool("take_snapshot", {}), MAX_ACTION_RESULT_CHARS);
    } catch (err) {
      snapshot = `Error: ${err?.message || String(err)}`;
    }
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
