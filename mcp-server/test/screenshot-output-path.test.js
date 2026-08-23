import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { saveScreenshotContent } from "../index.js";

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
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tool = (name) => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} }
});

// output_path is handled between the MCP client and the extension, so the copy
// is driven the way a real client drives it: JSON-RPC over stdio.
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
  await copy.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "screenshot-test", version: "1.0.0" }
  });
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
      result: {
        content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
        isError: false
      }
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

test("output_path saves the screenshot here and never reaches the extension", async (t) => {
  const PORT = 9316;
  const copy = startCopy(t, PORT);
  await waitFor(() => copy.log().includes("Bridge listening"), "the copy to bind the port");
  await initialize(copy);

  const extension = await connectExtension(t, PORT);
  extension.push({ tools: [tool("take_screenshot")], toolAccess: { enabled: { take_screenshot: true } } });
  await waitFor(() => copy.log().includes("Feature flags updated"), "the extension's push to arrive");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "margin-shot-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "shot.png");

  const saved = await copy.rpc("tools/call", {
    name: "take_screenshot",
    arguments: { fullPage: true, output_path: outputPath }
  });
  const bytes = Buffer.from(PNG_BASE64, "base64");
  assert.equal(saved.isError, false);
  assert.deepEqual(saved.content.map((entry) => entry.type), ["text"],
    "the image does not come back inline once it is on disk");
  assert.match(saved.content[0].text, new RegExp(String(bytes.length)));
  assert.ok(saved.content[0].text.includes(outputPath));
  assert.deepEqual(fs.readFileSync(outputPath), bytes);
  assert.deepEqual(extension.calls[0].arguments, { fullPage: true },
    "output_path is stripped before the call is forwarded");

  const inline = await copy.rpc("tools/call", { name: "take_screenshot", arguments: {} });
  assert.deepEqual(inline.content, [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
    "a call without output_path still returns the image");
});

test("a missing parent directory is reported instead of a file that does not exist", () => {
  const outputPath = path.join(os.tmpdir(), `margin-shot-${crypto.randomUUID()}`, "shot.png");
  const result = saveScreenshotContent([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }], outputPath);

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes(path.dirname(outputPath)));
  assert.equal(fs.existsSync(outputPath), false);
});

test("a result carrying no image is not reported as a saved file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "margin-shot-"));
  const outputPath = path.join(directory, "shot.png");
  const result = saveScreenshotContent([{ type: "text", text: "no tab" }], outputPath);

  assert.equal(result.isError, true);
  assert.equal(fs.existsSync(outputPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
