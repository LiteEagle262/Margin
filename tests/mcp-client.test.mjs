import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_PROTOCOL_VERSION,
  callMcpTool,
  connectMcpServer,
  mcpJsonRpcRequest,
} from "../sidepanel/api/mcp-client.js";

test("MCP requests reject non-success HTTP responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("service unavailable", { status: 503 });

  try {
    await assert.rejects(
      mcpJsonRpcRequest("https://mcp.example.test", "tools/list"),
      /HTTP 503: service unavailable/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP request timeout aborts a stalled fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });

  try {
    await assert.rejects(
      mcpJsonRpcRequest(
        "https://mcp.example.test",
        "initialize",
        {},
        null,
        { timeoutMs: 5 },
      ),
      /timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP request timeout also aborts a stalled response body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }),
  });

  try {
    await assert.rejects(
      mcpJsonRpcRequest("https://mcp.example.test", "tools/list", {}, null, { timeoutMs: 5 }),
      /timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP client accepts JSON-RPC payloads delivered as SSE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    ": keepalive",
    "event: message",
    "data: not-json",
    "",
    "event: message",
    'data: {"jsonrpc":"2.0",',
    'data: "result":{"tools":[]}}',
    "",
  ].join("\n"), {
    status: 200,
    headers: { "Mcp-Session-Id": "session-1" },
  });

  try {
    const response = await mcpJsonRpcRequest("https://mcp.example.test", "tools/list");
    assert.deepEqual(response.result, { tools: [] });
    assert.equal(response.sessionId, "session-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP connection negotiates and sends the protocol version header", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, headers: new Headers(init.headers) });
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18" },
      }), { headers: { "Mcp-Session-Id": "session-1" } });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: body.method === "tools/list" ? { tools: [] } : { content: [] },
    }));
  };

  try {
    const server = { url: "https://mcp.example.test" };
    const connection = await connectMcpServer(server);
    await callMcpTool(server, connection.sessionId, "search", {});

    assert.equal(requests[0].body.params.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(requests[0].headers.get("MCP-Protocol-Version"), null);
    for (const request of requests.slice(1)) {
      assert.equal(request.headers.get("MCP-Protocol-Version"), "2025-06-18");
      assert.equal(request.headers.get("Mcp-Session-Id"), "session-1");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
