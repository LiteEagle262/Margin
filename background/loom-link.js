import { createBridgeConnection } from "./bridge-connection.js";

// Loom for Windows registers this native-messaging host. It answers one
// request per port with the port and token of Loom's local bridge server.
export const LOOM_HOST_NAME = "com.exodusbot.loom.margin";
export const LOOM_HOST_REQUEST = Object.freeze({ type: "loom.margin.connect", v: 1 });

const HOST_TIMEOUT_MS = 10000;
const MAX_TOKEN_LENGTH = 256;
const MAX_ERROR_LENGTH = 200;
const INVALID_REPLY = "Loom sent a reply Margin could not read.";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The token never leaves this module except as the HMAC key, so only shape is
// checked here. Error text is shown in Settings, so it is cleaned and capped.
export function parseLoomHostReply(reply) {
  if (!isPlainObject(reply) || reply.v !== 1) {
    return { ok: false, error: INVALID_REPLY };
  }
  if (Object.hasOwn(reply, "error")) {
    const text = typeof reply.error === "string"
      ? reply.error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_ERROR_LENGTH)
      : "";
    return { ok: false, error: text || INVALID_REPLY };
  }
  const { port, token } = reply;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, error: INVALID_REPLY };
  }
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: INVALID_REPLY };
  }
  return { ok: true, port, token };
}

function describeHostFailure(message) {
  const text = String(message || "");
  if (/native messaging host not found/i.test(text)) return { state: "missing" };
  return { state: "error", error: text || "Loom closed without answering." };
}

// Resolves to { state: "ok", port, token }, { state: "missing" } or
// { state: "error", error }. Never rejects.
export function askLoomHost(runtime, timeoutMs = HOST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let hostPort = null;
    let timer = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        hostPort?.disconnect();
      } catch {}
      resolve(result);
    };

    try {
      hostPort = runtime.connectNative(LOOM_HOST_NAME);
    } catch (err) {
      finish(describeHostFailure(err?.message));
      return;
    }

    timer = setTimeout(() => finish({ state: "error", error: "Loom did not answer." }), timeoutMs);

    hostPort.onMessage.addListener((reply) => {
      const parsed = parseLoomHostReply(reply);
      finish(parsed.ok
        ? { state: "ok", port: parsed.port, token: parsed.token }
        : { state: "error", error: parsed.error });
    });

    // Reading lastError here also keeps Chrome from logging it as unchecked.
    hostPort.onDisconnect.addListener(() => {
      finish(describeHostFailure(runtime.lastError?.message));
    });

    try {
      hostPort.postMessage(LOOM_HOST_REQUEST);
    } catch (err) {
      finish(describeHostFailure(err?.message));
    }
  });
}

// Owns the Loom bridge connection. The port and token live only in this
// closure; a service-worker restart asks the host again.
export function createLoomLink({
  askHost,
  isEnabled,
  connectionOptions,
  log = () => {},
  baseDelayMs = 2000,
  maxDelayMs = 60000
}) {
  let target = null;
  let hostState = "unknown";
  let hostError = "";
  let asking = null;

  const connection = createBridgeConnection({
    ...connectionOptions,
    getTarget: () => ({
      enabled: isEnabled() && target !== null,
      port: target?.port,
      token: target?.token || ""
    }),
    // A dropped or failed connection asks again first: the token may have
    // rotated, or Loom may have moved to another port.
    refreshTarget: refresh,
    baseDelayMs,
    maxDelayMs
  });

  function refresh() {
    if (!isEnabled()) return Promise.resolve(false);
    if (asking) return asking;
    asking = (async () => {
      const reply = await askHost();
      if (!isEnabled()) {
        target = null;
        return false;
      }
      if (reply.state === "ok") {
        target = { port: reply.port, token: reply.token };
        hostState = "ok";
        hostError = "";
        return true;
      }
      target = null;
      hostState = reply.state === "missing" ? "missing" : "error";
      hostError = reply.state === "missing" ? "" : String(reply.error || "");
      log(reply.state === "missing" ? "Loom host not found" : `Loom host error: ${hostError}`);
      return false;
    })().finally(() => {
      asking = null;
    });
    return asking;
  }

  // Safe to call often: it does nothing while a connection is up or a retry
  // is already queued.
  async function check() {
    if (!isEnabled()) {
      stop();
      return;
    }
    if (connection.isActive() || connection.hasPendingRetry()) return;
    if (await refresh()) connection.schedule();
  }

  function stop() {
    target = null;
    hostState = "unknown";
    hostError = "";
    connection.schedule();
  }

  function getStatus() {
    if (!isEnabled()) return { state: "off", detail: "" };
    if (connection.status.connected) return { state: "connected", detail: "" };
    if (hostState === "missing") return { state: "missing", detail: "" };
    if (hostState === "error") return { state: "not-running", detail: hostError };
    if (hostState === "ok") return { state: "connecting", detail: connection.status.lastError };
    return { state: "checking", detail: "" };
  }

  return {
    check,
    stop,
    getStatus,
    sendFeatureFlags: connection.sendFeatureFlags,
    isConnected: () => connection.status.connected
  };
}
