import { createHmac, randomBytes } from "node:crypto";

// A stand-in for the browser WebSocket plus the server side of the Margin
// bridge handshake, so bridge clients can be driven without a network.
export function createFakeBridgeNetwork() {
  const servers = new Map();
  const sockets = [];
  const events = [];

  const hmac = (token, payload) => createHmac("sha256", token).update(payload).digest("hex");

  function handleClientFrame(socket, message) {
    const server = socket.server;
    if (!server) return;
    server.frames.push(message);
    if (message.type === "hello") {
      socket.serverNonce = randomBytes(32).toString("hex");
      const proofToken = server.proveWith ?? server.token;
      reply(socket, {
        type: "hello/proof",
        proof: hmac(proofToken, `margin-bridge-server:${message.nonce}`),
        nonce: socket.serverNonce
      });
      return;
    }
    if (message.type === "register") {
      if (message.proof !== hmac(server.token, `margin-bridge-client:${socket.serverNonce}`)) {
        setTimeout(() => socket.serverClose(), 0);
        return;
      }
      server.registered.push(socket);
      reply(socket, { type: "register/ok", maxPayloadBytes: 4 * 1024 * 1024 });
      return;
    }
    if (message.type === "feature-flags/set") server.flags.push(message.flags);
    if (message.type === "tool/result") server.results.push(message);
  }

  function reply(socket, message) {
    setTimeout(() => socket.receive(message), 0);
  }

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.server = null;
      sockets.push(this);
      events.push(`socket ${url}`);
      setTimeout(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        const port = Number(new URL(url).port);
        const server = new URL(url).hostname === "127.0.0.1" ? servers.get(port) : null;
        if (!server) {
          this.readyState = FakeWebSocket.CLOSED;
          this.onerror?.({});
          this.onclose?.({});
          return;
        }
        this.server = server;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.({});
      }, 0);
    }

    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error("WebSocket is not open");
      this.sent.push(data);
      handleClientFrame(this, JSON.parse(data));
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      setTimeout(() => this.onclose?.({}), 0);
    }

    receive(message) {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    // The server dropping the connection.
    serverClose() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({});
    }
  }

  return {
    WebSocket: FakeWebSocket,
    sockets,
    events,
    listen(port, token, options = {}) {
      const server = { token, proveWith: options.proveWith, frames: [], flags: [], results: [], registered: [] };
      servers.set(port, server);
      return server;
    },
    stop(port) {
      servers.delete(port);
    },
    openSockets() {
      return sockets.filter((socket) => socket.readyState === FakeWebSocket.OPEN);
    }
  };
}

// chrome.runtime with connectNative. respond(port, runtime, request) plays the
// host: call port.reply(message) or port.exit(lastErrorMessage), or do nothing.
export function createFakeNativeRuntime(respond) {
  const runtime = {
    lastError: null,
    requests: [],
    hostNames: [],
    connectNative(name) {
      runtime.hostNames.push(name);
      const messageListeners = [];
      const disconnectListeners = [];
      const port = {
        disconnected: false,
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
        postMessage(message) {
          runtime.requests.push(message);
          setTimeout(() => respond(port, runtime, message), 0);
        },
        disconnect() {
          port.disconnected = true;
        },
        reply(message) {
          if (!port.disconnected) messageListeners.forEach((fn) => fn(message));
        },
        exit(errorMessage) {
          if (port.disconnected) return;
          runtime.lastError = errorMessage ? { message: errorMessage } : null;
          disconnectListeners.forEach((fn) => fn(port));
          runtime.lastError = null;
        }
      };
      return port;
    }
  };
  return runtime;
}

export const HOST_NOT_FOUND = "Specified native messaging host not found.";

export async function waitFor(predicate, { timeoutMs = 3000, label = "condition" } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capturingEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => listeners.map((fn) => fn(...args))
  };
}

// Enough of chrome.* for background.js to load and run its bridges.
export function createBackgroundChrome({ local = {}, nativeRuntime }) {
  const store = structuredClone(local);
  const alarmCalls = [];
  const events = {
    onAlarm: capturingEvent(),
    onChanged: capturingEvent(),
    onMessage: capturingEvent()
  };
  const chrome = {
    action: { async setBadgeText() {} },
    alarms: {
      create(name, info) { alarmCalls.push(["create", name, info]); },
      async clear(name) { alarmCalls.push(["clear", name]); return true; },
      onAlarm: events.onAlarm
    },
    permissions: {
      async contains() { return true; },
      onAdded: capturingEvent(),
      onRemoved: capturingEvent()
    },
    runtime: {
      getManifest() { return { version: "1.7.0" }; },
      get lastError() { return nativeRuntime.lastError; },
      connectNative: (name) => nativeRuntime.connectNative(name),
      onInstalled: capturingEvent(),
      onConnect: capturingEvent(),
      onMessage: events.onMessage,
      onStartup: capturingEvent(),
      async sendMessage() {}
    },
    sidePanel: { async setPanelBehavior() {} },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => key in store).map((key) => [key, structuredClone(store[key])]));
        },
        async set(values) {
          Object.assign(store, structuredClone(values));
        },
        async remove() {},
        async setAccessLevel() {}
      },
      onChanged: events.onChanged,
      session: {
        async get() { return {}; },
        async remove() {},
        async set() {}
      }
    },
    tabs: {
      async get() { return {}; },
      onRemoved: capturingEvent(),
      onUpdated: capturingEvent(),
      async query() { return []; },
      async create() {}
    }
  };

  return {
    chrome,
    store,
    alarmCalls,
    // Mirrors chrome.storage.local.set plus its onChanged event.
    changeLocal(values) {
      const changes = {};
      for (const [key, newValue] of Object.entries(values)) {
        changes[key] = { oldValue: store[key], newValue };
        store[key] = structuredClone(newValue);
      }
      events.onChanged.fire(changes, "local");
    },
    fireAlarm(name) {
      events.onAlarm.fire({ name });
    },
    sendMessage(message) {
      return new Promise((resolve) => {
        events.onMessage.fire(message, {}, resolve);
      });
    }
  };
}
