// Side-panel adapter for the shared batch executor. The in-chat agent reaches
// this through executeTool; the MCP bridge runs the same core in the background
// service worker instead, so no batch call depends on an open side panel.

import { executeTool, guardToolCallBeforeExecution, evaluateToolLoopGuard } from "./execute.js";
import { BUILT_IN_TOOL_NAMES, isBuiltInToolEnabled } from "../settings/sections/tool-access.js";
import { runBatch } from "../../shared/batch-core.js";

// Re-exported so existing panel importers keep their current source.
export {
  BATCH_TOOL_NAME,
  MAX_BATCH_ACTIONS,
  BATCHABLE_TOOL_NAMES,
  SETTLE_AFTER_TOOLS,
  SETTLE_MS
} from "../../shared/batch-core.js";

// Only tools that appear in the access settings can be disabled there; anything
// outside that set is allowed, mirroring executeTool.
function isToolEnabled(tool) {
  return !BUILT_IN_TOOL_NAMES.has(tool) || isBuiltInToolEnabled(tool);
}

export async function executeBatchTool(args = {}, surface = "panel") {
  return runBatch(args, {
    runTool: (tool, toolArgs) => executeTool(tool, toolArgs, surface),
    isToolEnabled,
    guardBeforeExecution: guardToolCallBeforeExecution,
    observeResult: evaluateToolLoopGuard
  });
}
