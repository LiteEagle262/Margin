// Browser-only Chrome API mock used by the local visual QA server. This file
// is excluded from the extension release ZIP.
(() => {
  const localState = {};
  const sessionState = {};
  const storageListeners = [];
  let openAIPending = null;

  const area = (state) => ({
    async get(keys) {
      if (keys == null) return { ...state };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in state).map((key) => [key, state[key]]));
    },
    async set(values) {
      const changes = {};
      Object.entries(values || {}).forEach(([key, value]) => {
        changes[key] = { oldValue: state[key], newValue: value };
        state[key] = value;
      });
      storageListeners.forEach((listener) => listener(changes, state === localState ? "local" : "session"));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete state[key]);
    },
    async clear() {
      Object.keys(state).forEach((key) => delete state[key]);
    },
  });

  globalThis.chrome = {
    runtime: {
      lastError: null,
      async sendMessage(message) {
        if (message?.type === "mcp-bridge/get-status") {
          return { ok: true, config: { enabled: false, port: 9229, token: "" }, status: { connected: false } };
        }
        if (message?.type === "openai-oauth/status") {
          return { ok: true, result: { linked: false, account: null, pending: openAIPending } };
        }
        if (message?.type === "openai-oauth/start") {
          openAIPending = {
            userCode: "MARGIN-42",
            verificationUrl: "https://auth.openai.com/codex/device",
            intervalMs: 8000,
            expiresAt: Date.now() + 15 * 60 * 1000,
          };
          return { ok: true, result: openAIPending };
        }
        if (message?.type === "openai-oauth/poll") {
          return { ok: true, result: { linked: false, account: null, pending: openAIPending } };
        }
        if (message?.type === "openai-oauth/cancel" || message?.type === "openai-oauth/logout") {
          openAIPending = null;
          return { ok: true, result: { linked: false, account: null, pending: null } };
        }
        if (message?.type === "openai-oauth/open-device") return { ok: true, result: { opened: true } };
        if (message?.type === "openai-oauth/models") {
          return { ok: true, result: [] };
        }
        if (message?.type === "latch-tab/get") return { ok: true, tab: null };
        return { ok: true };
      },
    },
    storage: {
      local: area(localState),
      session: area(sessionState),
      onChanged: { addListener(listener) { storageListeners.push(listener); } },
    },
    permissions: {
      async contains() { return false; },
      async request() { return false; },
    },
    tabs: {
      async query() { return []; },
      async update() {},
    },
    windows: { async update() {} },
  };
})();
