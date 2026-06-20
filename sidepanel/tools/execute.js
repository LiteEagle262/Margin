// sidepanel/tools/execute.js - Tool dispatch: assembles the declared tool
// list, routes calls to workspace/web-search/page/MCP executors, and guards
// against tool loops.

import { settings, mcpToolRegistry, mcpConnections, activeToolRunStats } from "../state/store.js";
import { mcpToolName, parseMcpToolName, connectMcpServer, callMcpTool } from "../api/mcp-client.js";
import { WEB_SEARCH_TOOL_NAMES, isWebSearchAvailable, executeWebSearchTool } from "../api/tavily.js";
import { BROWSER_TOOLS, WORKSPACE_TOOLS, WORKSPACE_TOOL_NAMES, WEB_SEARCH_TOOLS } from "./schemas.js";
import { DEFAULT_ENABLED_TOOLS, isBuiltInToolEnabled } from "../settings/sections/tool-access.js";
import { getMaxToolCalls } from "../settings/sections/agent-limits.js";
import { executeWorkspaceTool } from "../features/workspace.js";

const TOOL_LOOP_LIMITS = {
  sameFailure: 2,
  repeatedReadOnly: 3
};



export async function refreshMcpTools() {
  mcpToolRegistry.clear();
  mcpConnections.clear();

  const enabledServers = settings.mcpServers.filter(s => s.enabled !== false && s.url);
  for (const server of enabledServers) {
    try {
      const connection = await connectMcpServer(server);
      mcpConnections.set(server.id, { ...connection, server });
      connection.tools.forEach(tool => {
        const fullName = mcpToolName(server.id, tool.name);
        mcpToolRegistry.set(fullName, {
          serverId: server.id,
          serverName: server.name || "MCP Server",
          originalName: tool.name,
          schema: tool
        });
      });
    } catch (err) {
      console.warn(`MCP server "${server.name}" failed:`, err);
    }
  }
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
      return result.content.map(item => {
        if (item.type === "text") return item.text;
        if (item.type === "image") return `[image: ${item.mimeType || "image"}]`;
        return JSON.stringify(item);
      }).join("\n");
    }

    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    return `Error executing MCP tool "${entry.originalName}": ${err.message}`;
  }
}

export async function executeTool(name, args = {}) {
  if (parseMcpToolName(name)) {
    return executeMcpTool(name, args);
  }
  if (DEFAULT_ENABLED_TOOLS.has(name) && !isBuiltInToolEnabled(name)) {
    return JSON.stringify({
      ok: false,
      tool: name,
      error_code: "tool_disabled",
      recoverable: false,
      message: `Tool "${name}" is disabled in ScrapeFlow Tool Access settings.`
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

function stableToolArgsKey(args = {}) {
  try {
    return JSON.stringify(args, Object.keys(args || {}).sort());
  } catch {
    return String(args);
  }
}

export function evaluateToolLoopGuard(toolName, toolArgs, result) {
  if (!activeToolRunStats || !DEFAULT_ENABLED_TOOLS.has(toolName)) return null;
  const parsed = parseToolResultObject(result);
  const failed = parsed?.ok === false || (typeof result === "string" && result.startsWith("Error:"));

  const maxToolCalls = getMaxToolCalls(); // 0 means unlimited
  const browserToolNames = new Set(BROWSER_TOOLS.map((tool) => tool.function.name));
  if (browserToolNames.has(toolName)) {
    activeToolRunStats.browserToolCount += 1;
    if (maxToolCalls > 0 && activeToolRunStats.browserToolCount > maxToolCalls) {
      return {
        ok: false,
        tool: toolName,
        error_code: "tool_loop_limit",
        recoverable: false,
        message: `Stopped tool loop after ${activeToolRunStats.browserToolCount} browser tool calls without an assistant response (limit: ${maxToolCalls}). Summarize progress or ask the user before continuing.`
      };
    }
  }

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
