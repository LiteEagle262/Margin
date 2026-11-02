import test from "node:test";
import assert from "node:assert/strict";
import {
  HOST_NOT_FOUND,
  createBackgroundChrome,
  createFakeBridgeNetwork,
  createFakeNativeRuntime,
  sleep,
  waitFor
} from "./bridge-fakes.mjs";

// Loom is not installed when the worker starts, then appears later.
const network = createFakeBridgeNetwork();
let hostInstalled = false;
const nativeRuntime = createFakeNativeRuntime((port) => {
  if (!hostInstalled) port.exit(HOST_NOT_FOUND);
  else port.reply({ v: 1, port: 41000, token: "loom-secret" });
});
const env = createBackgroundChrome({ local: {}, nativeRuntime });
const debugLines = [];
console.debug = (...args) => debugLines.push(args.join(" "));
globalThis.chrome = env.chrome;
globalThis.WebSocket = network.WebSocket;

test("with no Loom host the worker stays silent and opens no socket", async (t) => {
  const noise = [];
  for (const level of ["error", "warn", "log", "info"]) {
    t.mock.method(console, level, (...args) => noise.push([level, ...args]));
  }

  await import(`../background.js?loom-missing=${Date.now()}`);
  await waitFor(() => nativeRuntime.requests.length === 1, { label: "first host ask" });
  await sleep(20);

  assert.deepEqual(noise, []);
  assert.deepEqual(debugLines, ["Margin: Loom host not found"]);
  assert.equal(network.sockets.length, 0);
  // Loom is on by default; the manual bridge stays off until the user enables it.
  assert.equal(env.store.loomBridge, undefined);
  assert.equal(env.store.mcpBridge.enabled, false);

  const status = await env.sendMessage({ type: "loom-bridge/get-status" });
  assert.deepEqual(status, { ok: true, enabled: true, status: { state: "missing", detail: "" } });
});

test("the retry alarm asks again and connects once Loom is installed", async () => {
  env.fireAlarm("margin-loom-retry");
  await waitFor(() => nativeRuntime.requests.length === 2, { label: "second host ask" });
  await sleep(10);
  assert.equal(network.sockets.length, 0);

  const server = network.listen(41000, "loom-secret");
  hostInstalled = true;
  env.fireAlarm("margin-loom-retry");
  await waitFor(() => server.flags.length === 1, { label: "Loom registration" });

  assert.equal(network.sockets[0].url, "ws://127.0.0.1:41000");
  const status = await env.sendMessage({ type: "loom-bridge/get-status" });
  assert.equal(status.status.state, "connected");

  // Each alarm schedules the next one.
  const retries = env.alarmCalls.filter(([op, name]) => op === "create" && name === "margin-loom-retry");
  assert.ok(retries.length >= 3);

  env.changeLocal({ loomBridge: { enabled: false } });
  await sleep(20);
  assert.equal(network.openSockets().length, 0);
});
