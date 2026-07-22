import { settings, mcpToolRegistry, mcpConnections, activeToolRunStats } from "../state/store.js";
import { mcpToolName, parseMcpToolName, connectMcpServer, callMcpTool } from "../api/mcp-client.js";
import { WEB_SEARCH_TOOL_NAMES, isWebSearchAvailable, executeWebSearchTool } from "../../shared/tavily.js";
import { BROWSER_TOOLS, WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES, WEB_SEARCH_TOOLS, RECON_TOOLS } from "./schemas.js";
import { BUILT_IN_TOOL_NAMES, isBuiltInToolEnabled } from "../settings/sections/tool-access.js";
import { getMaxToolCalls } from "../settings/sections/agent-limits.js";
import { executeWorkspaceTool } from "../features/workspace.js";

const TOOL_LOOP_LIMITS = {
  sameFailure: 2,
  repeatedReadOnly: 3
};
let mcpRefreshGeneration = 0;

const CONFIRM_EACH_USE_TOOLS = new Set([
  "clear_network_logs",
  "delete_file",
  "evaluate_script",
  "get_authenticator_code",
  "get_cookies",
  "get_network_log_detail",
  "get_network_logs",
  "get_storage",
  "http_request",
  "list_authenticator_domains",
  "list_scripts",
  "rename_file",
  "run_js",
  "search_scripts",
  "start_network_capture",
  "stop_network_capture",
  "take_screenshot",
]);

function confirmSensitiveToolUse(name) {
  if (!CONFIRM_EACH_USE_TOOLS.has(name)) return true;
  return confirm(`Margin wants to run the sensitive tool “${name}”. Allow this one use?`);
}



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
    ...getMcpToolSchemas()
  ];
}


export async function executePageToolViaBackground(name, args = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "page-tool", name, arguments: args }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(`Error: ${chrome.runtime.lastError.message}`);
        return;
      }
      resolve(response?.result ?? "Error: No response from background service worker.");
    });
  });
}

async function executeMcpTool(fullName, args) {
  const entry = mcpToolRegistry.get(fullName);
  if (!entry) return `Error: Unknown MCP tool "${fullName}"`;

  const connection = mcpConnections.get(entry.serverId);
  if (!connection) {
    await refreshMcpTools();
  }
  const activeConnection = mcpConnections.get(entry.serverId);
  if (!activeConnection) {
    return `Error: MCP server for tool "${entry.originalName}" is not connected.`;
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
        return {
          ok: false,
          tool: fullName,
          error_code: "mcp_tool_error",
          recoverable: true,
          message: text || `MCP tool "${entry.originalName}" failed.`,
        };
      }
      return text;
    }

    if (result?.isError === true) {
      return {
        ok: false,
        tool: fullName,
        error_code: "mcp_tool_error",
        recoverable: true,
        message: `MCP tool "${entry.originalName}" failed.`,
      };
    }
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return {
      ok: false,
      tool: fullName,
      error_code: "mcp_request_failed",
      recoverable: true,
      message: `MCP tool "${entry.originalName}" failed: ${err.message}`,
    };
  }
}

export async function executeTool(name, args = {}) {
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
  if (!confirmSensitiveToolUse(name)) {
    return JSON.stringify({
      ok: false,
      tool: name,
      error_code: "user_denied",
      recoverable: false,
      message: `The user declined the sensitive tool "${name}".`,
    }, null, 2);
  }
  if (WORKSPACE_TOOL_NAMES.has(name)) {
    return executeWorkspaceTool(name, args);
  }
  if (WEB_SEARCH_TOOL_NAMES.has(name)) {
    return executeWebSearchTool(name, args, settings.webSearch);
  }
  return executePageToolViaBackground(name, args);
}

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
  const failed = parsed?.ok === false || (typeof result === "string" && result.startsWith("Error:"));

  const readOnly = new Set(["get_dom", "take_snapshot"]);
  if (!readOnly.has(toolName) && !failed) {
    activeToolRunStats.readOnlyCalls = {};
  }
  if (readOnly.has(toolName)) {
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

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "mcp/tool-call") return false;
  executeTool(String(message.name || ""), message.arguments || {})
    .then((result) => {
      if (result && typeof result === "object" && result.screenshot) {
        const data = String(result.screenshot).replace(/^data:image\/[^;]+;base64,/, "");
        sendResponse({
          ok: true,
          result: {
            content: [
              { type: "text", text: result.message || "Screenshot captured." },
              { type: "image", data, mimeType: "image/png" },
            ],
            isError: false,
          },
        });
        return;
      }
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      sendResponse({
        ok: true,
        result: {
          content: [{ type: "text", text }],
          isError: result?.ok === false || text.startsWith("Error:"),
        },
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        result: {
          content: [{ type: "text", text: error.message || String(error) }],
          isError: true,
        },
      });
    });
  return true;
});
