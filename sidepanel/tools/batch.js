// Side-panel adapter for the shared batch executor. The in-chat agent reaches
// this through executeTool; the MCP bridge runs the same core in the background
// service worker instead, so no batch call depends on an open side panel.

import { executeTool, guardToolCallBeforeExecution, evaluateToolLoopGuard } from "./execute.js";
import { isBuiltInToolEnabled } from "../settings/sections/tool-access.js";
import { runBatch } from "../../shared/batch-core.js";

// Re-exported so existing panel importers keep their current source.
export {
  BATCH_TOOL_NAME,
  MAX_BATCH_ACTIONS,
  BATCHABLE_TOOL_NAMES,
  SETTLE_AFTER_TOOLS,
  SETTLE_MS
} from "../../shared/batch-core.js";

// Default deny, matching the bridge's direct tool/call path: a tool with no Tool
// Access entry must not become reachable by wrapping it in a batch when a direct
// call would refuse it.
function isToolEnabled(tool) {
  return isBuiltInToolEnabled(tool);
}

export async function executeBatchTool(args = {}, surface = "panel") {
  return runBatch(args, {
    runTool: (tool, toolArgs) => executeTool(tool, toolArgs, surface),
    isToolEnabled,
    guardBeforeExecution: guardToolCallBeforeExecution,
    observeResult: evaluateToolLoopGuard
  });
}
