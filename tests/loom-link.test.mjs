import test from "node:test";
import assert from "node:assert/strict";
import {
  LOOM_HOST_NAME,
  askLoomHost,
  createLoomLink,
  parseLoomHostReply
} from "../background/loom-link.js";
import {
  HOST_NOT_FOUND,
  createFakeBridgeNetwork,
  createFakeNativeRuntime,
  sleep,
  waitFor
} from "./bridge-fakes.mjs";

test("host reply validation accepts only a well-formed port and token", () => {
  assert.deepEqual(parseLoomHostReply({ v: 1, port: 40123, token: "abc" }), { ok: true, port: 40123, token: "abc" });
  assert.deepEqual(parseLoomHostReply({ v: 1, port: 1024, token: "t".repeat(256) }).ok, true);
  assert.deepEqual(parseLoomHostReply({ v: 1, port: 65535, token: "x" }).ok, true);

  const rejected = [
    null,
    "{\"v\":1}",
    [],
    { port: 40123, token: "abc" },
    { v: 2, port: 40123, token: "abc" },
    { v: "1", port: 40123, token: "abc" },
    { v: 1, port: 1023, token: "abc" },
    { v: 1, port: 65536, token: "abc" },
    { v: 1, port: 0, token: "abc" },
    { v: 1, port: 40123.5, token: "abc" },
    { v: 1, port: "40123", token: "abc" },
    { v: 1, token: "abc" },
    { v: 1, port: 40123 },
    { v: 1, port: 40123, token: "" },
    { v: 1, port: 40123, token: 12345 },
    { v: 1, port: 40123, token: "t".repeat(257) },
    { v: 1, error: 42 },
    { v: 1, error: "   " }
  ];
  for (const reply of rejected) {
    const parsed = parseLoomHostReply(reply);
    assert.equal(parsed.ok, false, `accepted ${JSON.stringify(reply)}`);
    assert.equal(parsed.error, "Loom sent a reply Margin could not read.");
    assert.equal(Object.hasOwn(parsed, "token"), false);
  }
});

test("a host error reply is cleaned and capped for display", () => {
  assert.deepEqual(parseLoomHostReply({ v: 1, error: "Loom is not linked" }), { ok: false, error: "Loom is not linked" });
  // An error wins even when a port and token ride along.
  assert.equal(parseLoomHostReply({ v: 1, error: "stopped", port: 40123, token: "abc" }).ok, false);
  assert.equal(parseLoomHostReply({ v: 1, error: "bad\u0000\nline" }).error, "bad line");
  assert.equal(parseLoomHostReply({ v: 1, error: "e".repeat(500) }).error.length, 200);
});

test("asking the host sends one request and reads the reply", async () => {
  const runtime = createFakeNativeRuntime((port) => port.reply({ v: 1, port: 40123, token: "loom-secret" }));
  const ports = [];
  const connectNative = runtime.connectNative;
  runtime.connectNative = (name) => {
    const port = connectNative(name);
    ports.push(port);
    return port;
  };

  assert.deepEqual(await askLoomHost(runtime), { state: "ok", port: 40123, token: "loom-secret" });
  assert.deepEqual(runtime.hostNames, [LOOM_HOST_NAME]);
  assert.deepEqual(runtime.requests, [{ type: "loom.margin.connect", v: 1 }]);
  assert.equal(ports[0].disconnected, true, "one request per port");
});

test("a missing host, an error, an early exit and silence each resolve without throwing", async () => {
  const missing = createFakeNativeRuntime((port) => port.exit(HOST_NOT_FOUND));
  assert.deepEqual(await askLoomHost(missing), { state: "missing" });

  const notRunning = createFakeNativeRuntime((port) => port.reply({ v: 1, error: "Loom isn't signed in" }));
  assert.deepEqual(await askLoomHost(notRunning), { state: "error", error: "Loom isn't signed in" });

  const invalid = createFakeNativeRuntime((port) => port.reply({ v: 1, port: 80, token: "x" }));
  assert.deepEqual(await askLoomHost(invalid), { state: "error", error: "Loom sent a reply Margin could not read." });

  const exited = createFakeNativeRuntime((port) => port.exit("Native host has exited."));
  assert.deepEqual(await askLoomHost(exited), { state: "error", error: "Native host has exited." });

  const silent = createFakeNativeRuntime(() => {});
  assert.deepEqual(await askLoomHost(silent, 20), { state: "error", error: "Loom did not answer." });

  const broken = { lastError: null, connectNative() { throw new Error(HOST_NOT_FOUND); } };
  assert.deepEqual(await askLoomHost(broken), { state: "missing" });
});

function makeLink(network, replies, { enabled = { value: true }, handleToolCall } = {}) {
  let asks = 0;
  const logs = [];
  const link = createLoomLink({
    askHost: async () => {
      asks += 1;
      network.events.push("ask");
      const reply = typeof replies === "function" ? replies(asks) : replies;
      return reply;
    },
    isEnabled: () => enabled.value,
    connectionOptions: {
      handleToolCall: handleToolCall || (async () => ({ content: [{ type: "text", text: "ok" }] })),
      buildFeatureFlags: () => ({ tools: [{ name: "take_snapshot" }] }),
      fitResult: (envelope) => ({ json: JSON.stringify(envelope) }),
      getVersion: () => "1.7.0"
    },
    log: (text) => logs.push(text),
    baseDelayMs: 5,
    maxDelayMs: 20
  });
  return { link, logs, asks: () => asks };
}

function withFakeWebSocket(network) {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = network.WebSocket;
  return () => {
    globalThis.WebSocket = previous;
  };
}

test("a missing host leaves Loom quiet: no socket, no console errors", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  const noisy = [];
  t.mock.method(console, "error", (...args) => noisy.push(args));
  t.mock.method(console, "warn", (...args) => noisy.push(args));

  const { link, logs, asks } = makeLink(network, { state: "missing" });
  await link.check();
  await sleep(30);

  assert.equal(asks(), 1);
  assert.equal(network.sockets.length, 0);
  assert.deepEqual(link.getStatus(), { state: "missing", detail: "" });
  assert.deepEqual(noisy, []);
  assert.deepEqual(logs, ["Loom host not found"]);
});

test("a host error shows its text and opens no socket", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  const { link } = makeLink(network, { state: "error", error: "Loom is not linked to an account" });

  await link.check();
  assert.equal(network.sockets.length, 0);
  assert.deepEqual(link.getStatus(), { state: "not-running", detail: "Loom is not linked to an account" });
});

test("a host answer connects to 127.0.0.1 on that port and pushes the tools", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  const server = network.listen(40123, "loom-secret");
  const { link } = makeLink(network, { state: "ok", port: 40123, token: "loom-secret" });

  await link.check();
  await waitFor(() => link.isConnected(), { label: "Loom registration" });

  assert.equal(network.sockets[0].url, "ws://127.0.0.1:40123");
  assert.equal(server.registered.length, 1);
  assert.deepEqual(server.flags, [{ tools: [{ name: "take_snapshot" }] }]);
  assert.deepEqual(link.getStatus(), { state: "connected", detail: "" });
  // The token only feeds the HMAC; it never goes over the wire.
  assert.equal(network.sockets[0].sent.some((frame) => frame.includes("loom-secret")), false);

  // A second check while connected does not ask the host again.
  await link.check();
  assert.equal(network.sockets.length, 1);
  link.stop();
});

test("a failed handshake asks the host again before reconnecting", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  network.listen(40123, "rotated-token");
  const { link, asks } = makeLink(network, (n) => ({
    state: "ok",
    port: 40123,
    token: n === 1 ? "stale-token" : "rotated-token"
  }));

  await link.check();
  await waitFor(() => link.isConnected(), { label: "reconnect with the rotated token" });

  assert.equal(asks(), 2);
  assert.deepEqual(network.events, [
    "ask",
    "socket ws://127.0.0.1:40123",
    "ask",
    "socket ws://127.0.0.1:40123"
  ]);
  link.stop();
});

test("an impostor that cannot prove the token never registers", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  const server = network.listen(40123, "loom-secret", { proveWith: "wrong-token" });
  const { link } = makeLink(network, { state: "ok", port: 40123, token: "loom-secret" });

  await link.check();
  await waitFor(() => network.sockets.length >= 2, { label: "a retry" });
  link.stop();

  assert.equal(server.registered.length, 0);
  assert.equal(server.frames.some((frame) => frame.type === "register"), false);
});

test("a dropped connection re-asks the host and follows a new port", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  network.listen(40123, "first");
  const { link, asks } = makeLink(network, (n) => (n === 1
    ? { state: "ok", port: 40123, token: "first" }
    : { state: "ok", port: 40200, token: "second" }));

  await link.check();
  await waitFor(() => link.isConnected(), { label: "first connection" });

  network.stop(40123);
  network.listen(40200, "second");
  network.sockets[0].serverClose();
  assert.equal(link.getStatus().state, "connecting");

  await waitFor(() => link.isConnected(), { label: "connection on the new port" });
  assert.equal(asks(), 2);
  assert.equal(network.sockets.at(-1).url, "ws://127.0.0.1:40200");
  link.stop();
});

test("when the host stops answering after a drop, retries stop until the next check", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  network.listen(40123, "loom-secret");
  const { link, asks } = makeLink(network, (n) => (n === 1
    ? { state: "ok", port: 40123, token: "loom-secret" }
    : { state: "error", error: "Loom isn't running" }));

  await link.check();
  await waitFor(() => link.isConnected(), { label: "connection" });
  network.sockets[0].serverClose();

  await waitFor(() => link.getStatus().state === "not-running", { label: "host error status" });
  await sleep(60);
  assert.equal(asks(), 2);
  assert.equal(network.sockets.length, 1);
  assert.equal(link.getStatus().detail, "Loom isn't running");
});

test("switching Loom off closes its socket and stops asking", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  network.listen(40123, "loom-secret");
  const enabled = { value: true };
  const { link, asks } = makeLink(network, { state: "ok", port: 40123, token: "loom-secret" }, { enabled });

  await link.check();
  await waitFor(() => link.isConnected(), { label: "connection" });

  enabled.value = false;
  link.stop();
  await sleep(40);

  assert.equal(network.openSockets().length, 0);
  assert.equal(network.sockets.length, 1, "no reconnect after switching off");
  assert.deepEqual(link.getStatus(), { state: "off", detail: "" });

  await link.check();
  assert.equal(asks(), 1, "a check while off does not ask the host");
});

test("a tool call runs through the handler and answers with its call id", async (t) => {
  const network = createFakeBridgeNetwork();
  t.after(withFakeWebSocket(network));
  const server = network.listen(40123, "loom-secret");
  const calls = [];
  const { link } = makeLink(network, { state: "ok", port: 40123, token: "loom-secret" }, {
    handleToolCall: async (message) => {
      calls.push(message.name);
      return { content: [{ type: "text", text: `ran ${message.name}` }] };
    }
  });

  await link.check();
  await waitFor(() => link.isConnected(), { label: "connection" });
  network.sockets[0].receive({ type: "tool/call", id: "call-1", name: "take_snapshot", arguments: {} });
  await waitFor(() => server.results.length === 1, { label: "tool result" });

  assert.deepEqual(calls, ["take_snapshot"]);
  assert.deepEqual(server.results[0], {
    type: "tool/result",
    id: "call-1",
    result: { content: [{ type: "text", text: "ran take_snapshot" }] }
  });
  link.stop();
});
