import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { sanitizeToolDefinitions, startBridgeServer, visibleTools } from "../index.js";

async function waitFor(predicate, description, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

const tool = (name, overrides = {}) => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  ...overrides
});

test("pushed definitions are validated rather than trusted", () => {
  const sanitized = sanitizeToolDefinitions([
    tool("take_snapshot"),
    tool("take_snapshot"),                                  // duplicate
    tool("Bad-Name"),                                       // illegal characters
    tool("2fast"),                                          // must start with a letter
    tool("no_schema", { inputSchema: undefined }),
    tool("array_schema", { inputSchema: [] }),
    tool("string_schema", { inputSchema: "object" }),
    "not-an-object",
    null,
    tool("navigate", { description: 42 })
  ]);

  assert.deepEqual(sanitized.map((entry) => entry.name), ["take_snapshot", "navigate"]);
  assert.equal(sanitized[1].description, "", "a non-string description degrades to empty");
});

test("pushed definitions cannot shadow tools this process implements", () => {
  const sanitized = sanitizeToolDefinitions([
    tool("create_temp_email"),
    tool("search_web"),
    tool("get_dom")
  ]);
  assert.deepEqual(sanitized.map((entry) => entry.name), ["get_dom"]);
});

test("pushed definitions are capped in count and description length", () => {
  const many = Array.from({ length: 150 }, (_, index) => tool(`tool_${index}`));
  assert.equal(sanitizeToolDefinitions(many).length, 100);

  const [long] = sanitizeToolDefinitions([tool("get_dom", { description: "x".repeat(9000) })]);
  assert.equal(long.description.length, 4000);

  assert.deepEqual(sanitizeToolDefinitions("nope"), []);
  assert.deepEqual(sanitizeToolDefinitions(undefined), []);
});

test("the server serves the extension's pushed tools and forgets them on disconnect", async (t) => {
  const server = startBridgeServer({ bridgeHost: "127.0.0.1", bridgePort: 0, bridgeAuthToken: TOKEN });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });

  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { origin: EXTENSION_ORIGIN });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "register", token: TOKEN, client: "margin-extension", version: "1.4.3" }));
  const [registered] = await once(socket, "message");
  assert.equal(JSON.parse(String(registered)).type, "register/ok");

  assert.deepEqual(visibleTools(), [], "nothing is exposed before the extension pushes anything");

  // A tool is only visible when its definition and its allowlist entry agree.
  socket.send(JSON.stringify({
    type: "feature-flags/set",
    flags: {
      tools: [tool("browser_batch"), tool("run_js")],
      toolAccess: { enabled: { browser_batch: true, run_js: false } }
    }
  }));

  await waitFor(() => visibleTools().length > 0, "the pushed tools to arrive");
  assert.deepEqual(visibleTools().map((entry) => entry.name), ["browser_batch"],
    "run_js has a definition but is disabled in the allowlist");
  assert.deepEqual(visibleTools()[0].inputSchema, { type: "object", properties: {} });

  socket.close();
  await once(socket, "close");
  await waitFor(() => visibleTools().length === 0, "the tools to be forgotten on disconnect");
});
