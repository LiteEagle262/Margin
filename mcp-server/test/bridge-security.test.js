import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import {
  bridgeProofsMatch,
  isAllowedBridgeOrigin,
  isLoopbackAddress,
  requireBridgeAuthToken,
  startBridgeServer
} from "../index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;

function hmac(payload) {
  return crypto.createHmac("sha256", TOKEN).update(payload).digest("hex");
}

async function handshake(socket) {
  const clientNonce = crypto.randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "hello", client: "margin-extension", version: "1.6.0", nonce: clientNonce }));
  const [raw] = await once(socket, "message");
  return { clientNonce, hello: JSON.parse(String(raw)), frame: String(raw) };
}

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

test("compares handshake proofs exactly", () => {
  const proof = hmac("margin-bridge-client:nonce");
  assert.equal(bridgeProofsMatch(proof, proof), true);
  assert.equal(bridgeProofsMatch(proof, `${proof}0`), false);
  assert.equal(bridgeProofsMatch(proof, "x".repeat(proof.length)), false);
  assert.equal(bridgeProofsMatch(proof, undefined), false);
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
    flags: { webSearch: { enabled: true } }
  }));

  const [raw] = await once(socket, "message");
  assert.deepEqual(JSON.parse(String(raw)), {
    type: "register/error",
    error: "Registration required"
  });
  const [code] = await closePromise;
  assert.equal(code, 1008);
});

test("proves the server knows the token without ever sending it", async (t) => {
  const { server, url } = await startTestServer();
  t.after(() => stopTestServer(server));

  const socket = await connect(url, { origin: EXTENSION_ORIGIN });
  const { clientNonce, hello, frame } = await handshake(socket);

  assert.equal(hello.type, "hello/proof");
  assert.equal(hello.proof, hmac(`margin-bridge-server:${clientNonce}`));
  assert.notEqual(hello.proof, hmac(`margin-bridge-client:${clientNonce}`));
  assert.match(hello.nonce, /^[0-9a-f]{64}$/);
  assert.ok(!frame.includes(TOKEN), "the shared token must never be transmitted");

  socket.send(JSON.stringify({
    type: "register",
    proof: hmac(`margin-bridge-client:${hello.nonce}`),
    client: "margin-extension",
    version: "1.6.0"
  }));
  const [okRaw] = await once(socket, "message");
  const response = JSON.parse(String(okRaw));
  assert.equal(response.type, "register/ok");
  assert.equal(response.bridgePort, server.address().port);
  socket.close();
  await once(socket, "close");
});

test("rejects a peer that cannot produce a valid client proof", async (t) => {
  const { server, url } = await startTestServer();
  t.after(() => stopTestServer(server));

  const guessing = await connect(url, { origin: EXTENSION_ORIGIN });
  const guessingClose = once(guessing, "close");
  await handshake(guessing);
  guessing.send(JSON.stringify({ type: "register", proof: "0".repeat(64) }));
  const [guessRaw] = await once(guessing, "message");
  assert.equal(JSON.parse(String(guessRaw)).error, "Authentication failed");
  assert.equal((await guessingClose)[0], 1008);

  // Replaying the server's own proof must not authenticate the client.
  const replaying = await connect(url, { origin: EXTENSION_ORIGIN });
  const replayingClose = once(replaying, "close");
  const replayed = await handshake(replaying);
  replaying.send(JSON.stringify({
    type: "register",
    proof: hmac(`margin-bridge-server:${replayed.hello.nonce}`)
  }));
  const [replayRaw] = await once(replaying, "message");
  assert.equal(JSON.parse(String(replayRaw)).error, "Authentication failed");
  assert.equal((await replayingClose)[0], 1008);

  // A stale client that still sends the plaintext token is refused outright.
  const legacy = await connect(url, { origin: EXTENSION_ORIGIN });
  const legacyClose = once(legacy, "close");
  legacy.send(JSON.stringify({ type: "register", token: TOKEN }));
  const [legacyRaw] = await once(legacy, "message");
  assert.equal(JSON.parse(String(legacyRaw)).error, "Registration required");
  assert.equal((await legacyClose)[0], 1008);
});
