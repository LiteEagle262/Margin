import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import {
  bridgeTokensMatch,
  isAllowedBridgeOrigin,
  isLoopbackAddress,
  requireBridgeAuthToken,
  startBridgeServer
} from "../index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

async function startTestServer() {
  const server = startBridgeServer({
    bridgeHost: "127.0.0.1",
    bridgePort: 0,
    bridgeAuthToken: TOKEN
  });
  await once(server, "listening");
  return {
    server,
    url: `ws://127.0.0.1:${server.address().port}`
  };
}

async function stopTestServer(server) {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
}

function connect(url, options) {
  const socket = new WebSocket(url, options);
  return Promise.race([
    once(socket, "open").then(() => socket),
    once(socket, "error").then(([error]) => Promise.reject(error))
  ]);
}

test("requires a non-empty 32-byte authentication token", () => {
  assert.throws(() => requireBridgeAuthToken(""), /required/);
  assert.throws(() => requireBridgeAuthToken("too-short"), /32 bytes/);
  assert.equal(requireBridgeAuthToken(`  ${TOKEN}  `), TOKEN);
});

test("compares authentication tokens exactly", () => {
  assert.equal(bridgeTokensMatch(TOKEN, TOKEN), true);
  assert.equal(bridgeTokensMatch(TOKEN, `${TOKEN}0`), false);
  assert.equal(bridgeTokensMatch(TOKEN, "x".repeat(TOKEN.length)), false);
  assert.equal(bridgeTokensMatch(TOKEN, undefined), false);
});

test("accepts only loopback peers and Chrome extension browser origins", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.10"), false);

  assert.equal(isAllowedBridgeOrigin(undefined), true, "native clients may omit Origin");
  assert.equal(isAllowedBridgeOrigin(EXTENSION_ORIGIN), true);
  assert.equal(isAllowedBridgeOrigin("https://evil.example"), false);
  assert.equal(isAllowedBridgeOrigin("http://127.0.0.1:3000"), false);
  assert.equal(isAllowedBridgeOrigin("null"), false);
});

test("rejects a normal website during the WebSocket handshake", async (t) => {
  const { server, url } = await startTestServer();
  t.after(() => stopTestServer(server));

  const socket = new WebSocket(url, { origin: "https://evil.example" });
  const [error] = await once(socket, "error");
  assert.match(error.message, /403/);
});

test("closes a client that sends privileged messages before registration", async (t) => {
  const { server, url } = await startTestServer();
  t.after(() => stopTestServer(server));

  const socket = await connect(url);
  const closePromise = once(socket, "close");
  socket.send(JSON.stringify({
    type: "feature-flags/set",
    flags: { tempEmail: { enabled: true } }
  }));

  const [raw] = await once(socket, "message");
  assert.deepEqual(JSON.parse(String(raw)), {
    type: "register/error",
    error: "Registration required"
  });
  const [code] = await closePromise;
  assert.equal(code, 1008);
});

test("rejects a wrong token and accepts the generated extension token", async (t) => {
  const { server, url } = await startTestServer();
  t.after(() => stopTestServer(server));

  const rejected = await connect(url, { origin: EXTENSION_ORIGIN });
  const rejectedClose = once(rejected, "close");
  rejected.send(JSON.stringify({ type: "register", token: "x".repeat(32) }));
  const [errorRaw] = await once(rejected, "message");
  assert.equal(JSON.parse(String(errorRaw)).error, "Authentication failed");
  assert.equal((await rejectedClose)[0], 1008);

  const accepted = await connect(url, { origin: EXTENSION_ORIGIN });
  accepted.send(JSON.stringify({
    type: "register",
    token: TOKEN,
    client: "margin-extension",
    version: "1.4.0"
  }));
  const [okRaw] = await once(accepted, "message");
  const response = JSON.parse(String(okRaw));
  assert.equal(response.type, "register/ok");
  assert.equal(response.bridgePort, server.address().port);
  accepted.close();
  await once(accepted, "close");
});
