import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

async function waitFor(predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const SERVER_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

const tool = (name) => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} }
});

// Mirroring only exists between separate processes, so each copy is driven the
// way a real MCP client drives it: JSON-RPC over stdio, with stderr kept so the
// bridge's own logs can be used as sync points.
function startCopy(t, bridgePort) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      MARGIN_MCP_HOST: "127.0.0.1",
      MARGIN_MCP_PORT: String(bridgePort),
      MARGIN_MCP_TOKEN: TOKEN
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const responses = new Map();
  let pendingLine = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const lines = `${pendingLine}${chunk}`.split("\n");
    pendingLine = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let nextId = 0;
  const copy = {
    child,
    log: () => stderr,
    send(message) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    async rpc(method, params) {
      const id = ++nextId;
      copy.send({ id, method, params });
      await waitFor(() => responses.has(id), `a ${method} response from the copy on port ${bridgePort}`);
      return responses.get(id).result;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await once(child, "exit");
    }
  };
  t.after(() => copy.stop());
  return copy;
}

async function initialize(copy) {
  const result = await copy.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mirror-test", version: "1.0.0" }
  });
  assert.equal(result.serverInfo.name, "margin-browser");
  // Deferred-schema clients only see this at the handshake, and every copy is
  // its own process, so each one has to carry it.
  assert.match(result.instructions, /browser_batch/);
  copy.send({ method: "notifications/initialized" });
}

async function connectExtension(t, bridgePort) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`, { origin: EXTENSION_ORIGIN });
  t.after(() => socket.terminate());
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

  const calls = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "tool/call") return;
    calls.push(message);
    socket.send(JSON.stringify({
      type: "tool/result",
      id: message.id,
      result: { content: [{ type: "text", text: `ran ${message.name}` }], isError: false }
    }));
  });

  return {
    socket,
    calls,
    push(flags) {
      socket.send(JSON.stringify({ type: "feature-flags/set", flags }));
    }
  };
}

test("every copy serves the tools the extension pushed to the one holding the port", async (t) => {
  const PORT = 9311;
  const owner = startCopy(t, PORT);
  await waitFor(() => owner.log().includes("Bridge listening"), "the first copy to bind the port");
  const mirror = startCopy(t, PORT);
  await waitFor(() => mirror.log().includes(`Mirroring the copy that owns port ${PORT}`),
    "the copy that lost the port to mirror the winner");

  await initialize(owner);
  await initialize(mirror);

  const extension = await connectExtension(t, PORT);
  extension.push({
    tools: [tool("browser_batch"), tool("run_js")],
    toolAccess: { enabled: { browser_batch: true, run_js: false } }
  });
  await waitFor(() => mirror.log().includes("Feature flags updated"), "the push to be forwarded to the mirror");

  assert.deepEqual((await mirror.rpc("tools/list", {})).tools.map((entry) => entry.name), ["browser_batch"],
    "the copy with no extension of its own still lists the pushed tools");
  assert.deepEqual((await owner.rpc("tools/list", {})).tools.map((entry) => entry.name), ["browser_batch"],
    "both copies report the same catalog");

  const result = await mirror.rpc("tools/call", { name: "browser_batch", arguments: { steps: 2 } });
  assert.deepEqual(result.content, [{ type: "text", text: "ran browser_batch" }]);
  assert.equal(result.isError, false);
  assert.deepEqual(extension.calls.map((call) => call.name), ["browser_batch"]);
  assert.deepEqual(extension.calls[0].arguments, { steps: 2 }, "the relay preserved the arguments");
});

test("a mirror takes the bridge over when the copy that owned it dies", async (t) => {
  const PORT = 9312;
  const owner = startCopy(t, PORT);
  await waitFor(() => owner.log().includes("Bridge listening"), "the first copy to bind the port");
  const mirror = startCopy(t, PORT);
  await waitFor(() => mirror.log().includes(`Mirroring the copy that owns port ${PORT}`),
    "the copy that lost the port to mirror the winner");
  await initialize(mirror);

  await owner.stop();
  await waitFor(() => mirror.log().includes("Mirror uplink closed"), "the mirror to notice the owner died");
  await waitFor(() => mirror.log().includes("Bridge listening"), "the mirror to win the freed port", 10000);

  const extension = await connectExtension(t, PORT);
  extension.push({ tools: [tool("run_js")], toolAccess: { enabled: { run_js: true } } });
  await waitFor(() => mirror.log().includes("Feature flags updated"), "the extension's push to reach the new owner");

  assert.deepEqual((await mirror.rpc("tools/list", {})).tools.map((entry) => entry.name), ["run_js"]);
});

test("a relayed tool call fails cleanly when the owner has no extension", async (t) => {
  const PORT = 9313;
  const owner = startCopy(t, PORT);
  await waitFor(() => owner.log().includes("Bridge listening"), "the first copy to bind the port");
  const mirror = startCopy(t, PORT);
  await waitFor(() => mirror.log().includes(`Mirroring the copy that owns port ${PORT}`),
    "the copy that lost the port to mirror the winner");
  await initialize(mirror);

  const extension = await connectExtension(t, PORT);
  extension.push({ tools: [tool("browser_batch")], toolAccess: { enabled: { browser_batch: true } } });
  await waitFor(() => mirror.log().includes("Feature flags updated"), "the push to be forwarded to the mirror");

  extension.socket.close();
  await once(extension.socket, "close");
  await waitFor(() => owner.log().includes("Extension disconnected"), "the owner to notice the extension left");

  // The mirror still offers the last catalog it was pushed, so the call reaches
  // the relay and comes back as the bridge's own not-connected error.
  const result = await mirror.rpc("tools/call", { name: "browser_batch", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Margin extension is not connected/);
});

test("a list issued while a mirror is between bind attempts waits for the takeover", async (t) => {
  const PORT = 9315;
  const owner = startCopy(t, PORT);
  await waitFor(() => owner.log().includes("Bridge listening"), "the first copy to bind the port");
  const mirror = startCopy(t, PORT);
  await waitFor(() => mirror.log().includes(`Mirroring the copy that owns port ${PORT}`),
    "the copy that lost the port to mirror the winner");
  await initialize(mirror);

  const first = await connectExtension(t, PORT);
  first.push({ tools: [tool("browser_batch")], toolAccess: { enabled: { browser_batch: true } } });
  await waitFor(() => mirror.log().includes("Feature flags updated"), "the push to be forwarded to the mirror");

  await owner.stop();
  await waitFor(() => mirror.log().includes("Mirror uplink closed"), "the mirror to lose its uplink");

  // Losing the uplink also drops the catalog, so this list has nothing to answer
  // with until the retry wins the port and the extension pushes again. A client
  // that lists once at startup only gets one shot, so the wait has to cover it.
  const listed = mirror.rpc("tools/list", {});
  await waitFor(() => mirror.log().includes("Bridge listening"), "the mirror to win the freed port", 10000);
  const second = await connectExtension(t, PORT);
  second.push({ tools: [tool("run_js")], toolAccess: { enabled: { run_js: true } } });

  assert.deepEqual((await listed).tools.map((entry) => entry.name), ["run_js"]);
});

test("an extension that reconnects to the owner re-syncs the mirror", async (t) => {
  const PORT = 9314;
  const owner = startCopy(t, PORT);
  await waitFor(() => owner.log().includes("Bridge listening"), "the first copy to bind the port");
  const mirror = startCopy(t, PORT);
  await waitFor(() => mirror.log().includes(`Mirroring the copy that owns port ${PORT}`),
    "the copy that lost the port to mirror the winner");
  await initialize(mirror);

  const pushesSeen = () => mirror.log().split("Feature flags updated").length - 1;
  const first = await connectExtension(t, PORT);
  first.push({ tools: [tool("browser_batch")], toolAccess: { enabled: { browser_batch: true } } });
  await waitFor(() => pushesSeen() === 1, "the first push to be forwarded to the mirror");
  first.socket.close();
  await once(first.socket, "close");

  const second = await connectExtension(t, PORT);
  second.push({ tools: [tool("run_js")], toolAccess: { enabled: { run_js: true } } });
  await waitFor(() => pushesSeen() === 2, "the reconnecting extension's push to reach the mirror");

  assert.deepEqual((await mirror.rpc("tools/list", {})).tools.map((entry) => entry.name), ["run_js"]);
});
