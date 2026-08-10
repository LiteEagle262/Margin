import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { listTools, startBridgeServer, visibleTools } from "../index.js";

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

const tool = (name) => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} }
});

async function startTestServer(t) {
  const server = startBridgeServer({ bridgeHost: "127.0.0.1", bridgePort: 0, bridgeAuthToken: TOKEN });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

async function registerExtension(server) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { origin: EXTENSION_ORIGIN });
  await once(socket, "open");
  socket.send(JSON.stringify({
    type: "hello",
    client: "margin-extension",
    version: "1.6.0",
    nonce: crypto.randomBytes(32).toString("hex")
  }));
  const [helloRaw] = await once(socket, "message");
  const hello = JSON.parse(String(helloRaw));
  socket.send(JSON.stringify({
    type: "register",
    proof: crypto.createHmac("sha256", TOKEN).update(`margin-bridge-client:${hello.nonce}`).digest("hex"),
    client: "margin-extension",
    version: "1.6.0"
  }));
  const [registered] = await once(socket, "message");
  assert.equal(JSON.parse(String(registered)).type, "register/ok");
  return socket;
}

async function disconnect(socket) {
  socket.close();
  await once(socket, "close");
  await waitFor(() => visibleTools().length === 0, "the disconnect to clear the pushed tools");
}

test("a list with no extension push gives up after the bounded wait", async () => {
  const started = Date.now();
  const { tools } = await listTools(40);
  assert.deepEqual(tools, [], "no extension means no tools, but only after waiting");
  assert.ok(Date.now() - started >= 35, "the list waited for the push instead of answering immediately");
});

test("lists in flight resolve as soon as the extension's first push arrives", async (t) => {
  const server = await startTestServer(t);
  const socket = await registerExtension(server);

  const started = Date.now();
  // Every concurrent waiter has to be released by the single push.
  const lists = Promise.all([listTools(5000), listTools(5000)]);
  setTimeout(() => {
    socket.send(JSON.stringify({
      type: "feature-flags/set",
      flags: {
        tools: [tool("browser_batch"), tool("run_js")],
        toolAccess: { enabled: { browser_batch: true, run_js: false } }
      }
    }));
  }, 20);

  const results = await lists;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `the push released the wait, not the timeout (${elapsed}ms)`);
  for (const { tools } of results) {
    assert.deepEqual(tools.map((entry) => entry.name), ["browser_batch"]);
  }

  await disconnect(socket);
});

test("a push the user has emptied still answers the list", async (t) => {
  const server = await startTestServer(t);
  const socket = await registerExtension(server);

  const pending = listTools(5000);
  socket.send(JSON.stringify({
    type: "feature-flags/set",
    flags: { tools: [tool("browser_batch")], toolAccess: { enabled: { browser_batch: false } } }
  }));

  const { tools } = await pending;
  assert.deepEqual(tools, [], "the wait is for the first push, not for a non-empty list");

  await disconnect(socket);
});

test("a list after the extension disconnects waits again", async (t) => {
  const server = await startTestServer(t);
  const socket = await registerExtension(server);
  socket.send(JSON.stringify({
    type: "feature-flags/set",
    flags: { tools: [tool("browser_batch")], toolAccess: { enabled: { browser_batch: true } } }
  }));
  await waitFor(() => visibleTools().length > 0, "the pushed tools to arrive");
  assert.deepEqual((await listTools(40)).tools.map((entry) => entry.name), ["browser_batch"]);

  await disconnect(socket);

  const started = Date.now();
  const { tools } = await listTools(40);
  assert.deepEqual(tools, []);
  assert.ok(Date.now() - started >= 35, "the disconnect reset the latch, so the next list waits for the reconnect");
});
