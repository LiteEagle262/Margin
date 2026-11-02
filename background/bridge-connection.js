// One outbound bridge connection: socket, mutual HMAC handshake, ping replies,
// reconnect backoff, the feature-flags push and tool calls. background.js runs
// one per target (the manual MCP bridge and Loom).

const SERVER_PROOF_PREFIX = "margin-bridge-server:";
const CLIENT_PROOF_PREFIX = "margin-bridge-client:";
// Servers older than 2.3.0 enforce 1 MiB and do not advertise it, so that is
// the safe default until a register/ok says otherwise.
const LEGACY_BRIDGE_MAX_PAYLOAD_BYTES = 1024 * 1024;

export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function bridgeProof(token, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bridgeProofsMatch(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  if (expected.length !== provided.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

// getTarget() returns { enabled, port, token } and is read live, so a settings
// change is picked up on the next connect. refreshTarget, when given, runs
// before every reconnect and returns false to stop retrying.
export function createBridgeConnection({
  getTarget,
  handleToolCall,
  buildFeatureFlags,
  fitResult,
  getVersion,
  refreshTarget = null,
  baseDelayMs = 750,
  maxDelayMs = 5000
}) {
  let socket = null;
  let registered = false;
  let reconnectTimer = null;
  let reconnectDelayMs = baseDelayMs;
  let maxPayloadBytes = LEGACY_BRIDGE_MAX_PAYLOAD_BYTES;
  const status = { connected: false, lastError: "" };

  function isOpen() {
    return Boolean(socket) && socket.readyState === WebSocket.OPEN;
  }

  function isActive() {
    return Boolean(socket) &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
  }

  function hasPendingRetry() {
    return reconnectTimer !== null;
  }

  function schedule(force = false) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (force) {
      disconnect();
    }

    if (!getTarget().enabled) {
      disconnect();
      status.connected = false;
      status.lastError = "";
      return;
    }

    connect();
  }

  // For the keepalive alarm: reconnect only when idle with no retry queued.
  function ensureConnected() {
    if (getTarget().enabled && !reconnectTimer && !isOpen()) {
      schedule();
    }
  }

  function disconnect() {
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {}
      socket = null;
    }
    registered = false;
    status.connected = false;
  }

  function sendFeatureFlags() {
    if (!isOpen()) return;
    try {
      socket.send(JSON.stringify({ type: "feature-flags/set", flags: buildFeatureFlags() }));
    } catch {}
  }

  function sendToolResult(ws, id, name, result) {
    ws.send(fitResult({ type: "tool/result", id, result }, maxPayloadBytes, name).json);
  }

  function connect() {
    const target = getTarget();
    if (!target.enabled) return;
    if (isActive()) return;

    const url = `ws://127.0.0.1:${target.port}`;
    let ws;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      status.lastError = err.message;
      queueReconnect();
      return;
    }

    socket = ws;
    registered = false;
    const clientNonce = randomHex(32);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "hello",
        client: "margin-extension",
        version: getVersion(),
        nonce: clientNonce
      }));
    };

    ws.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.type === "hello/proof") {
        const token = getTarget().token || "";
        const [expectedServerProof, clientProof] = await Promise.all([
          bridgeProof(token, `${SERVER_PROOF_PREFIX}${clientNonce}`),
          bridgeProof(token, `${CLIENT_PROOF_PREFIX}${String(message.nonce || "")}`)
        ]);
        if (socket !== ws) return;
        if (!bridgeProofsMatch(expectedServerProof, message.proof)) {
          status.lastError = "Bridge server failed authentication";
          disconnect();
          queueReconnect();
          return;
        }
        ws.send(JSON.stringify({
          type: "register",
          proof: clientProof,
          client: "margin-extension",
          version: getVersion()
        }));
        return;
      }

      if (message.type === "register/ok") {
        registered = true;
        // A reconnect can land on an older copy of the server, so an unadvertised
        // cap falls back rather than keeping the last one seen.
        maxPayloadBytes = Number.isFinite(message.maxPayloadBytes) && message.maxPayloadBytes > 0
          ? message.maxPayloadBytes
          : LEGACY_BRIDGE_MAX_PAYLOAD_BYTES;
        status.connected = true;
        status.lastError = "";
        reconnectDelayMs = baseDelayMs;
        sendFeatureFlags();
        return;
      }

      if (message.type === "register/error") {
        status.connected = false;
        status.lastError = message.error || "Registration failed";
        disconnect();
        queueReconnect();
        return;
      }

      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (message.type === "tool/call" && message.id && message.name) {
        if (!registered) return;
        let result;
        try {
          result = await handleToolCall(message);
        } catch (err) {
          result = { content: [{ type: "text", text: err.message || String(err) }], isError: true };
        }
        sendToolResult(ws, message.id, message.name, result);
      }
    };

    ws.onclose = () => {
      if (socket === ws) {
        socket = null;
      }
      status.connected = false;
      if (getTarget().enabled) {
        queueReconnect();
      }
    };

    ws.onerror = () => {
      status.lastError = "WebSocket connection failed";
    };
  }

  function queueReconnect() {
    if (!getTarget().enabled || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxDelayMs);
    // The timer stays set while refreshTarget runs, so nothing else starts a
    // second retry; a schedule() in that window supersedes this one.
    const timer = setTimeout(async () => {
      const keepGoing = !refreshTarget || await refreshTarget();
      if (reconnectTimer !== timer) return;
      reconnectTimer = null;
      if (keepGoing) connect();
    }, delay);
    reconnectTimer = timer;
  }

  return {
    status,
    schedule,
    ensureConnected,
    disconnect,
    sendFeatureFlags,
    isOpen,
    isActive,
    hasPendingRetry
  };
}
