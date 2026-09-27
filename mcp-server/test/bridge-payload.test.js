import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { startBridgeServer } from "../index.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

async function startTestServer(t) {
  const server = startBridgeServer({ bridgeHost: "127.0.0.1", bridgePort: 0, bridgeAuthToken: TOKEN });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}`;
}

// The extension's hello/register exchange; `role` is what a mirror adds so it
// joins alongside the extension instead of replacing it.
async function register(url, role) {
  const socket = new WebSocket(url, { origin: EXTENSION_ORIGIN });
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
    role,
    proof: crypto.createHmac("sha256", TOKEN).update(`margin-bridge-client:${hello.nonce}`).digest("hex"),
    client: "margin-extension",
    version: "1.6.0"
  }));
  const [okRaw] = await once(socket, "message");
  return { socket, registered: JSON.parse(String(okRaw)) };
}

test("register/ok tells the peer how large a frame the bridge accepts", async (t) => {
  const url = await startTestServer(t);
  const { registered } = await register(url);

  assert.equal(registered.type, "register/ok");
  assert.equal(registered.maxPayloadBytes, MAX_PAYLOAD_BYTES);
});

test("a tool result far over the old 1 MiB cap resolves the call", async (t) => {
  const url = await startTestServer(t);
  const mirror = await register(url, "mirror");
  const extension = await register(url);
  assert.equal(extension.registered.type, "register/ok");

  // Roughly the base64 of a screenshot of a busy page: enough to have closed
  // the socket with 1009 under the old cap.
  const screenshot = "A".repeat(2 * 1024 * 1024);
  extension.socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "tool/call") return;
    extension.socket.send(JSON.stringify({
      type: "tool/result",
      id: message.id,
      result: { content: [{ type: "image", data: screenshot, mimeType: "image/png" }], isError: false }
    }));
  });

  mirror.socket.send(JSON.stringify({
    type: "tool/call",
    id: "call-1",
    name: "take_screenshot",
    arguments: {}
  }));
  const [resultRaw] = await once(mirror.socket, "message");
  const result = JSON.parse(String(resultRaw));

  assert.equal(result.type, "tool/result");
  assert.equal(result.id, "call-1");
  assert.equal(result.result.isError, false);
  assert.equal(result.result.content[0].data.length, screenshot.length);
  assert.equal(extension.socket.readyState, WebSocket.OPEN, "the oversized frame left the socket open");
});
