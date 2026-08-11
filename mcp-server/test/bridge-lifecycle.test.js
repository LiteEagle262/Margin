import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startBridgeServer } from "../index.js";

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const TOKEN = "0123456789abcdef0123456789abcdef";
const SERVER_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

test("a second server retries the busy port instead of exiting, and binds once it frees up", async (t) => {
  const PORT = 9281;
  const holder = startBridgeServer({ bridgeHost: "127.0.0.1", bridgePort: PORT, bridgeAuthToken: TOKEN });
  await once(holder, "listening");

  let rebound = null;
  // exitOnError is what main() uses; EADDRINUSE has to bypass it.
  const loser = startBridgeServer({
    bridgeHost: "127.0.0.1",
    bridgePort: PORT,
    bridgeAuthToken: TOKEN,
    exitOnError: true,
    retryDelayMs: 50,
    onListening: (wss) => {
      rebound = wss;
    }
  });
  t.after(async () => {
    await new Promise((resolve) => holder.close(resolve));
    if (rebound) await new Promise((resolve) => rebound.close(resolve));
  });

  const [err] = await once(loser, "error");
  assert.equal(err.code, "EADDRINUSE");
  // Reaching this line at all proves the losing server left the process alive.
  assert.equal(rebound, null, "the losing server never bound the port");

  await new Promise((resolve) => holder.close(resolve));
  await waitFor(() => rebound !== null, "the retry to win the freed port");
  assert.equal(rebound.address().port, PORT);
});

test("the server exits when its stdio client goes away", async () => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, MARGIN_MCP_HOST: "127.0.0.1", MARGIN_MCP_PORT: "9282", MARGIN_MCP_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const exited = once(child, "exit");

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lifecycle-test", version: "1.0.0" }
    }
  })}\n`);

  await waitFor(() => stdout.includes("\"serverInfo\""), "the initialize response");

  child.stdin.end();
  const [code] = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(["timeout"]), 5000))
  ]);
  assert.equal(code, 0, "stdin EOF ended the process instead of orphaning it on the port");
});
