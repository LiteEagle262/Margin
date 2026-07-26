// Runs several browser tools in one call. Both callers reach this through
// executeTool — the in-chat agent directly, the MCP bridge via mcp/tool-call —
// so there is exactly one executor and one place where per-action access is
// enforced.

import { executeTool, guardToolCallBeforeExecution, evaluateToolLoopGuard, parseToolResultObject } from "./execute.js";
import { BUILT_IN_TOOL_NAMES, isBuiltInToolEnabled } from "../settings/sections/tool-access.js";

export const BATCH_TOOL_NAME = "browser_batch";
// Every action spends one call from the run's tool budget, so keep batches small
// enough that one batch cannot consume most of a turn's budget on its own.
export const MAX_BATCH_ACTIONS = 10;

// close_tab is deliberately not batchable: destructive mid-batch, rare, low value.
export const BATCHABLE_TOOL_NAMES = new Set([
  "navigate", "open_tab", "select_tab", "click_element", "fill_element", "fill_form",
  "fill_secret", "type_text", "hover_element", "press_key", "scroll_page", "wait_for",
  "take_snapshot", "get_dom", "get_active_tab", "list_tabs", "run_js", "evaluate_script"
]);

// A navigation, tab switch, or click can still be committing when the next
// action runs. Exported because recipe replay (recipes.js) reuses the same
// settle behavior.
export const SETTLE_AFTER_TOOLS = new Set(["navigate", "open_tab", "select_tab", "click_element"]);
export const SETTLE_MS = 400;

// Per-action output is capped so a long batch cannot swallow the context window.
const TOTAL_RESULT_BUDGET = 24000;
const MAX_ACTION_RESULT_CHARS = 4000;
const MIN_ACTION_RESULT_CHARS = 600;

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
function describeActionRejection(tool) {
  if (!tool) return 'Each action needs a "tool" name.';
  if (tool === BATCH_TOOL_NAME) return "browser_batch cannot be nested inside itself.";
  if (tool === "take_screenshot") {
    return "take_screenshot cannot run inside a batch because each screenshot needs its own image attachment. Call it as a standalone tool.";
  }
  if (!BATCHABLE_TOOL_NAMES.has(tool)) {
    return `"${tool}" is not batchable. Batchable tools: ${[...BATCHABLE_TOOL_NAMES].join(", ")}.`;
  }
  // The same gate a standalone call would hit; enabling browser_batch must never
  // re-enable a tool the user switched off. Mirrors executeTool: only tools that
  // appear in the access settings can be disabled there.
  if (BUILT_IN_TOOL_NAMES.has(tool) && !isBuiltInToolEnabled(tool)) {
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

async function runAction(tool, toolArgs, surface) {
  let result;
  try {
    result = await executeTool(tool, toolArgs, surface);
  } catch (err) {
    result = {
      ok: false,
      tool,
      error_code: "tool_threw",
      recoverable: true,
      message: err?.message || String(err)
    };
  }
  return evaluateToolLoopGuard(tool, toolArgs, result) || result;
}

export async function executeBatchTool(args = {}, surface = "panel") {
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

    const rejection = describeActionRejection(tool);
    if (rejection) {
      results.push({ index, tool, status: "error", error: rejection });
      if (stopOnError) halted = `action ${index} (${tool || "unnamed"}) was rejected`;
      continue;
    }

    // Every action spends one call from the run's budget. Counting the batch as
    // a single call would make the user's maxToolCalls limit meaningless.
    const guard = guardToolCallBeforeExecution(tool);
    if (guard) {
      results.push({ index, tool, status: "error", error: guard.message || "Tool call limit reached." });
      halted = "the agent tool-call limit was reached";
      continue;
    }

    const toolArgs = actionArguments(action);
    const result = await runAction(tool, toolArgs, surface);
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
  if (args.include_snapshot === true && succeeded > 0 && isBuiltInToolEnabled("take_snapshot")) {
    const guard = guardToolCallBeforeExecution("take_snapshot");
    snapshot = describeActionResult(guard || await runAction("take_snapshot", {}, surface), MAX_ACTION_RESULT_CHARS);
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
