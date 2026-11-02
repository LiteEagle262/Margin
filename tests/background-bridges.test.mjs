import test from "node:test";
import assert from "node:assert/strict";
import {
  createBackgroundChrome,
  createFakeBridgeNetwork,
  createFakeNativeRuntime,
  sleep,
  waitFor
} from "./bridge-fakes.mjs";

// One background.js instance runs the whole file: the manual MCP bridge and
// the Loom bridge side by side, with Loom found through its native host.
const network = createFakeBridgeNetwork();
const manualServer = network.listen(9229, "manual-token");
const loomServer = network.listen(40123, "loom-secret");
const nativeRuntime = createFakeNativeRuntime((port) => port.reply({ v: 1, port: 40123, token: "loom-secret" }));
const env = createBackgroundChrome({
  local: { mcpBridge: { enabled: true, port: 9229, token: "manual-token" } },
  nativeRuntime
});
globalThis.chrome = env.chrome;
globalThis.WebSocket = network.WebSocket;

const socketTo = (port) => network.sockets.filter((socket) => socket.url === `ws://127.0.0.1:${port}`);

function callTool(server, socket, id, name, args = {}) {
  const before = server.results.length;
  socket.receive({ type: "tool/call", id, name, arguments: args });
  return waitFor(() => server.results.length > before, { label: `${name} result` })
    .then(() => server.results.at(-1));
}

test("both bridges connect on load, each with its own port and token", async () => {
  await import(`../background.js?bridges=${Date.now()}`);
  await waitFor(() => manualServer.flags.length > 0 && loomServer.flags.length > 0, { label: "both registrations" });

  assert.equal(socketTo(9229).length, 1);
  assert.equal(socketTo(40123).length, 1);
  assert.deepEqual(nativeRuntime.requests, [{ type: "loom.margin.connect", v: 1 }]);
  assert.ok(env.alarmCalls.some(([op, name, info]) => op === "create" && name === "margin-loom-retry" && info.delayInMinutes === 0.5));

  // Same enabled tools on both, default-deny tools absent from both.
  assert.deepEqual(loomServer.flags[0], manualServer.flags[0]);
  const names = manualServer.flags[0].tools.map((tool) => tool.name);
  assert.ok(names.includes("take_snapshot"));
  assert.ok(!names.includes("run_js"));

  // Neither token is ever sent; only proofs are.
  const allFrames = network.sockets.flatMap((socket) => socket.sent).join("\n");
  assert.equal(allFrames.includes("loom-secret"), false);
  assert.equal(allFrames.includes("manual-token"), false);
});

test("status messages report each bridge and never carry the Loom token", async () => {
  const loom = await env.sendMessage({ type: "loom-bridge/get-status" });
  assert.deepEqual(loom, { ok: true, enabled: true, status: { state: "connected", detail: "" } });
  assert.equal(JSON.stringify(loom).includes("loom-secret"), false);

  const manual = await env.sendMessage({ type: "mcp-bridge/get-status" });
  assert.deepEqual(manual.config, { enabled: true, port: 9229, token: "manual-token" });
  assert.equal(manual.status.connected, true);
});

test("Tool Access gates calls on both bridges, including browser_batch steps", async () => {
  for (const [server, port] of [[manualServer, 9229], [loomServer, 40123]]) {
    const socket = socketTo(port)[0];
    const direct = await callTool(server, socket, `direct-${port}`, "run_js", { code: "1" });
    assert.equal(direct.id, `direct-${port}`);
    assert.equal(direct.result.isError, true);
    assert.match(direct.result.content[0].text, /"run_js" is disabled in Margin settings/);

    const batch = await callTool(server, socket, `batch-${port}`, "browser_batch", {
      actions: [{ tool: "run_js", arguments: { code: "1" } }]
    });
    const steps = JSON.parse(batch.result.content[0].text).results;
    assert.deepEqual(steps.map((step) => [step.tool, step.status]), [["run_js", "error"]]);
    assert.match(steps[0].error, /"run_js" is disabled in Margin Tool Access settings/);
  }
});

test("a Tool Access change is pushed to both bridges", async () => {
  const manualPushes = manualServer.flags.length;
  const loomPushes = loomServer.flags.length;
  env.changeLocal({ toolAccess: { enabled: { run_js: true, take_snapshot: false } } });
  await waitFor(() => manualServer.flags.length > manualPushes && loomServer.flags.length > loomPushes, {
    label: "flag pushes"
  });
  const names = manualServer.flags.at(-1).tools.map((tool) => tool.name);
  assert.ok(names.includes("run_js"));
  assert.ok(!names.includes("take_snapshot"));
  assert.deepEqual(loomServer.flags.at(-1), manualServer.flags.at(-1));
});

test("the manual bridge reconnects on its own without asking the Loom host", async () => {
  const asks = nativeRuntime.requests.length;
  socketTo(9229)[0].serverClose();
  await waitFor(() => manualServer.registered.length === 2, { label: "manual reconnect", timeoutMs: 4000 });
  assert.equal(nativeRuntime.requests.length, asks);
  assert.equal(socketTo(40123).filter((socket) => socket.readyState === network.WebSocket.OPEN).length, 1);
});

test("switching Loom off closes only the Loom connection", async () => {
  env.changeLocal({ loomBridge: { enabled: false } });
  await sleep(20);

  assert.equal(socketTo(40123).every((socket) => socket.readyState === network.WebSocket.CLOSED), true);
  assert.equal(socketTo(9229).at(-1).readyState, network.WebSocket.OPEN);
  assert.ok(env.alarmCalls.some(([op, name]) => op === "clear" && name === "margin-loom-retry"));
  const status = await env.sendMessage({ type: "loom-bridge/get-status" });
  assert.deepEqual(status, { ok: true, enabled: false, status: { state: "off", detail: "" } });

  // The retry alarm does nothing while Loom is off.
  const asks = nativeRuntime.requests.length;
  env.fireAlarm("margin-loom-retry");
  await sleep(20);
  assert.equal(nativeRuntime.requests.length, asks);

  // Leave nothing running so the test process can exit.
  env.changeLocal({ mcpBridge: { enabled: false, port: 9229, token: "manual-token" } });
  await sleep(20);
  assert.equal(network.openSockets().length, 0);
});
