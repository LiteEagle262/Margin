export function createMcpServerId() {
  return `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const MCP_CONNECT_TIMEOUT_MS = 12_000;
export const MCP_TOOL_TIMEOUT_MS = 60_000;
export const MCP_PROTOCOL_VERSION = "2025-11-25";

const negotiatedProtocolVersions = new Map();

async function fetchWithTimeout(url, init = {}, timeoutMs = MCP_CONNECT_TIMEOUT_MS, consume = null) {
  const controller = new AbortController();
  const boundedTimeout = Math.max(1, Number(timeoutMs) || MCP_CONNECT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), boundedTimeout);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return consume ? await consume(response) : response;
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error(`MCP request timed out after ${boundedTimeout}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseMcpPayloads(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const payloads = [];
    const events = String(raw || "").split(/\r?\n\r?\n/);
    for (const event of events) {
      const candidate = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        payloads.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // Keep looking: an SSE response may contain keepalives or multiple events.
      }
    }
    if (payloads.length === 0) throw new Error("Invalid MCP response format");
    return payloads;
  }
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

export async function mcpJsonRpcRequest(url, method, params = {}, sessionId = null, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (options.protocolVersion) headers["MCP-Protocol-Version"] = options.protocolVersion;

  const requestId = crypto.randomUUID();
  const { response, raw } = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params
    })
  }, options.timeoutMs, async (currentResponse) => ({
    response: currentResponse,
    raw: await currentResponse.text()
  }));

  const newSessionId = response.headers.get("Mcp-Session-Id") || sessionId;

  if (!response.ok) {
    const detail = raw.trim().slice(0, 500);
    throw new Error(`MCP request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  const payloads = parseMcpPayloads(raw);
  const payload = payloads.find((item) => String(item?.id ?? "") === requestId)
    || payloads.find((item) => item?.result !== undefined || item?.error)
    || payloads[0];

  if (payload.error) {
    throw new Error(payload.error.message || "MCP request failed");
  }

  return { result: payload.result, sessionId: newSessionId };
}

export async function connectMcpServer(server) {
  if (!server.url) throw new Error("Missing MCP server URL");

  let sessionId = null;
  const init = await mcpJsonRpcRequest(server.url, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "Margin", version: "1.0.0" }
  }, sessionId);
  sessionId = init.sessionId;
  const protocolVersion = String(init.result?.protocolVersion || MCP_PROTOCOL_VERSION);
  negotiatedProtocolVersions.set(`${server.url}\n${sessionId || ""}`, protocolVersion);

  await fetchWithTimeout(server.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })
  }, MCP_CONNECT_TIMEOUT_MS).catch(() => {});

  const toolsResp = await mcpJsonRpcRequest(server.url, "tools/list", {}, sessionId, { protocolVersion });
  return {
    sessionId,
    protocolVersion,
    tools: toolsResp.result?.tools || []
  };
}

export async function callMcpTool(server, sessionId, toolName, args) {
  const protocolVersion = negotiatedProtocolVersions.get(`${server.url}\n${sessionId || ""}`) || MCP_PROTOCOL_VERSION;
  const resp = await mcpJsonRpcRequest(server.url, "tools/call", {
    name: toolName,
    arguments: args || {}
  }, sessionId, { timeoutMs: MCP_TOOL_TIMEOUT_MS, protocolVersion });
  return resp.result;
}
