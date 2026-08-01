import { settings, mcpToolRegistry, mcpConnections, activeToolRunStats } from "../state/store.js";
import { mcpToolName, parseMcpToolName, connectMcpServer, callMcpTool } from "../api/mcp-client.js";
import { WEB_SEARCH_TOOL_NAMES, isWebSearchAvailable, executeWebSearchTool } from "../../shared/tavily.js";
import { BROWSER_TOOLS, WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES, WEB_SEARCH_TOOLS, RECON_TOOLS } from "../../shared/tool-schemas.js";
import { BUILT_IN_TOOL_NAMES, isBuiltInToolEnabled } from "../settings/sections/tool-access.js";
import { getMaxToolCalls } from "../settings/sections/agent-limits.js";
import { executeWorkspaceTool } from "../features/workspace.js";
import { BATCH_TOOL_NAME, executeBatchTool } from "./batch.js";
import { RECIPE_TOOL_NAMES, RECIPE_TOOL_SCHEMAS, executeRecipeTool } from "./recipes.js";
import { parseToolResultObject } from "../../shared/batch-core.js";

// Defined in batch-core so the background service worker can parse tool results
// without loading any panel module.
export { parseToolResultObject };

const TOOL_LOOP_LIMITS = {
  sameFailure: 2,
  repeatedReadOnly: 3
};

// Tools that only observe. Any successful tool outside this set is progress and
// clears the repeated-observation counters.
const READ_ONLY_TOOL_NAMES = new Set([
  "take_snapshot", "get_dom", "get_active_tab", "list_tabs", "take_screenshot",
  "get_network_logs", "get_network_log_detail", "get_cookies", "get_storage",
  "list_scripts", "search_scripts", "list_authenticator_domains",
  "read_file", "list_files", "search_files", "get_file_info", "read_context_item"
]);
let mcpRefreshGeneration = 0;

export async function refreshMcpTools() {
  const generation = ++mcpRefreshGeneration;
  mcpToolRegistry.clear();
  mcpConnections.clear();

  const enabledServers = settings.mcpServers.filter(s => s.enabled !== false && s.url);
  const settled = await Promise.allSettled(enabledServers.map(async (server) => {
      const connection = await connectMcpServer(server);
      return { server, connection };
  }));
  if (generation !== mcpRefreshGeneration) return;

  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      const { server, connection } = outcome.value;
      mcpConnections.set(server.id, { ...connection, server });
      connection.tools.forEach((tool) => {
        const fullName = mcpToolName(server.id, tool.name);
        mcpToolRegistry.set(fullName, {
          serverId: server.id,
          serverName: server.name || "MCP Server",
          originalName: tool.name,
          schema: tool
        });
      });
    } else {
      console.warn(`MCP server "${enabledServers[index].name}" failed:`, outcome.reason);
    }
  });
}

export function getMcpToolSchemas() {
  const schemas = [];
  mcpToolRegistry.forEach((entry, fullName) => {
    const tool = entry.schema;
    schemas.push({
      type: "function",
      function: {
        name: fullName,
        description: `[MCP: ${entry.serverName}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} }
      }
    });
  });
  return schemas;
}

export function filterEnabledToolSchemas(tools) {
  return tools.filter((tool) => {
    const name = tool.function?.name;
    if (!isBuiltInToolEnabled(name)) return false;
    if (WEB_SEARCH_TOOL_NAMES.has(name)) return isWebSearchAvailable(settings.webSearch);
    return true;
  });
}

export function getAllAgentTools() {
  return [
    ...filterEnabledToolSchemas(BROWSER_TOOLS),
    ...filterEnabledToolSchemas(WORKSPACE_TOOLS),
    ...filterEnabledToolSchemas(WEB_SEARCH_TOOLS),
    ...filterEnabledToolSchemas(RECON_TOOLS),
    // Recipe tools are panel-only and not in the tool-access groups, so the
    // enablement filter (which drops unknown names) must not apply to them.
    // Recipe steps re-enter executeTool, where per-tool gates do apply.
    ...RECIPE_TOOL_SCHEMAS,
    ...getMcpToolSchemas()
  ];
}


function toolFailure(tool, errorCode, message, recoverable = true) {
  return { ok: false, tool, error_code: errorCode, recoverable, message };
}

// If the service worker dies or the callback is lost, the run must not hang
// forever. 120s matches the MCP bridge's own TOOL_TIMEOUT_MS; wait_for maxes
// out at 60s.
const BACKGROUND_TOOL_TIMEOUT_MS = 120000;

export async function executePageToolViaBackground(name, args = {}, surface = "panel") {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(toolFailure(name, "background_timeout", `No response from the background service worker after ${BACKGROUND_TOOL_TIMEOUT_MS / 1000}s.`));
    }, BACKGROUND_TOOL_TIMEOUT_MS);
    chrome.runtime.sendMessage({ type: "page-tool", name, arguments: args, surface }, (response) => {
      if (chrome.runtime.lastError || !response) {
        finish(toolFailure(name, "background_unreachable", chrome.runtime.lastError?.message || "No response from background service worker."));
        return;
      }
      if (response.ok === false) {
        finish(toolFailure(name, "tool_refused", String(response.result || `The background service worker refused "${name}".`), false));
        return;
      }
      finish(response.result);
    });
  });
}

async function executeMcpTool(fullName, args) {
  const entry = mcpToolRegistry.get(fullName);
  if (!entry) return toolFailure(fullName, "unknown_mcp_tool", `Unknown MCP tool "${fullName}".`, false);

  const connection = mcpConnections.get(entry.serverId);
  if (!connection) {
    await refreshMcpTools();
  }
  const activeConnection = mcpConnections.get(entry.serverId);
  if (!activeConnection) {
    return toolFailure(fullName, "mcp_not_connected", `MCP server for tool "${entry.originalName}" is not connected.`);
  }

  try {
    const result = await callMcpTool(
      activeConnection.server,
      activeConnection.sessionId,
      entry.originalName,
      args
    );

    if (result?.content) {
      const text = result.content.map(item => {
        if (item.type === "text") return item.text;
        if (item.type === "image") return `[image: ${item.mimeType || "image"}]`;
        return JSON.stringify(item);
      }).join("\n");
      if (result.isError === true) {
        return toolFailure(fullName, "mcp_tool_error", text || `MCP tool "${entry.originalName}" failed.`);
      }
      return text;
    }

    if (result?.isError === true) {
      return toolFailure(fullName, "mcp_tool_error", `MCP tool "${entry.originalName}" failed.`);
    }
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return toolFailure(fullName, "mcp_request_failed", `MCP tool "${entry.originalName}" failed: ${err.message}`);
  }
}

export async function executeTool(name, args = {}, surface = "panel") {
  if (parseMcpToolName(name)) {
    return executeMcpTool(name, args);
  }
  if (BUILT_IN_TOOL_NAMES.has(name) && !isBuiltInToolEnabled(name)) {
    return JSON.stringify({
      ok: false,
      tool: name,
      error_code: "tool_disabled",
      recoverable: false,
      message: `Tool "${name}" is disabled in Margin Tool Access settings.`
    }, null, 2);
  }
  if (name === BATCH_TOOL_NAME) {
    // Actions re-enter here, so each one hits the same access gate, loop guards,
    // and dispatch a standalone call would.
    return executeBatchTool(args, surface);
  }
  if (RECIPE_TOOL_NAMES.has(name)) {
    // run_recipe steps re-enter here too, so gates and budget apply per step.
    return executeRecipeTool(name, args, surface);
  }
  if (WORKSPACE_TOOL_NAMES.has(name)) {
    return executeWorkspaceTool(name, args);
  }
  if (WEB_SEARCH_TOOL_NAMES.has(name)) {
    return executeWebSearchTool(name, args, settings.webSearch);
  }
  return executePageToolViaBackground(name, args, surface);
}

export function guardToolCallBeforeExecution(toolName) {
  if (!activeToolRunStats) return null;
  activeToolRunStats.toolCallCount += 1;
  const maxToolCalls = getMaxToolCalls();
  if (maxToolCalls > 0 && activeToolRunStats.toolCallCount > maxToolCalls) {
    return {
      ok: false,
      tool: toolName,
      error_code: "tool_loop_limit",
      recoverable: false,
      message: `Stopped after ${maxToolCalls} tool calls. Summarize progress or ask the user before continuing.`
    };
  }
  return null;
}

function stableToolArgsKey(args = {}) {
  try {
    return JSON.stringify(args, Object.keys(args || {}).sort());
  } catch {
    return String(args);
  }
}

export function evaluateToolLoopGuard(toolName, toolArgs, result) {
  if (!activeToolRunStats || !BUILT_IN_TOOL_NAMES.has(toolName)) return null;
  const parsed = parseToolResultObject(result);
  const failed = parsed?.ok === false;

  if (!READ_ONLY_TOOL_NAMES.has(toolName) && !failed) {
    activeToolRunStats.readOnlyCalls = {};
  }
  if (READ_ONLY_TOOL_NAMES.has(toolName)) {
    const key = toolName;
    activeToolRunStats.readOnlyCalls[key] = (activeToolRunStats.readOnlyCalls[key] || 0) + 1;
    if (activeToolRunStats.readOnlyCalls[key] > TOOL_LOOP_LIMITS.repeatedReadOnly) {
      return {
        ok: false,
        tool: toolName,
        error_code: "repeated_read_only_tool",
        recoverable: true,
        message: `Repeated ${toolName} too many times without acting. Use the latest snapshot, choose a uid, call wait_for, or explain the blocker.`
      };
    }
  }

  if (!failed) return null;

  const failureKey = `${toolName}:${stableToolArgsKey(toolArgs)}`;
  activeToolRunStats.failures[failureKey] = (activeToolRunStats.failures[failureKey] || 0) + 1;
  if (activeToolRunStats.failures[failureKey] >= TOOL_LOOP_LIMITS.sameFailure) {
    return {
      ok: false,
      tool: toolName,
      error_code: "repeated_tool_failure",
      recoverable: true,
      message: `The same ${toolName} call with the same arguments already failed ${activeToolRunStats.failures[failureKey]} times. Do not retry it. Refresh with take_snapshot, use a returned candidate uid, or ask the user for clarification.`,
      data: { previous_result: parsed || String(result).slice(0, 1000) }
    };
  }

  return null;
}

