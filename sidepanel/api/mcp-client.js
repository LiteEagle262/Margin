// sidepanel/api/mcp-client.js - Streamable-HTTP MCP client and tool-name
// helpers. No DOM access, no app state.

export function createMcpServerId() {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mcpToolName(serverId, toolName) {
  return `mcp__${serverId}__${toolName}`;
}

export function parseMcpToolName(fullName) {
  if (!String(fullName || "").startsWith("mcp__")) return null;
  const parts = fullName.slice(5).split("__");
  if (parts.length < 2) return null;
  return { serverId: parts[0], toolName: parts.slice(1).join("__") };
}

export async function mcpJsonRpcRequest(url, method, params = {}, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  const newSessionId = response.headers.get("Mcp-Session-Id") || sessionId;
  const raw = await response.text();

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    const dataLine = raw.split("\n").find(line => line.startsWith("data: "));
    if (dataLine) {
      payload = JSON.parse(dataLine.slice(6));
    } else {
      throw new Error("Invalid MCP response format");
    }
  }

  if (payload.error) {
    throw new Error(payload.error.message || "MCP request failed");
  }

  return { result: payload.result, sessionId: newSessionId };
}

export async function connectMcpServer(server) {
  if (!server.url) throw new Error("Missing MCP server URL");

  let sessionId = null;
  const init = await mcpJsonRpcRequest(server.url, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ScrapeFlow", version: "1.0.0" }
  }, sessionId);
  sessionId = init.sessionId;

  await fetch(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })
  }).catch(() => {});

  const toolsResp = await mcpJsonRpcRequest(server.url, "tools/list", {}, sessionId);
  return {
    sessionId,
    tools: toolsResp.result?.tools || []
  };
}

export async function callMcpTool(server, sessionId, toolName, args) {
  const resp = await mcpJsonRpcRequest(server.url, "tools/call", {
    name: toolName,
    arguments: args || {}
  }, sessionId);
  return resp.result;
}
