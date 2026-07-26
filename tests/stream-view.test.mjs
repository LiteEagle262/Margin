import test from "node:test";
import assert from "node:assert/strict";

// run-loop.js pulls in the whole panel module graph, so chrome has to exist
// before the import.
globalThis.chrome = {
  tabs: { onRemoved: { addListener() {} }, query: async () => [] },
  debugger: {},
  runtime: {
    sendMessage() {},
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} })
  },
  storage: {
    session: { get: async () => ({}) },
    local: { get: async () => ({}) },
    onChanged: { addListener() {} }
  }
};

const { createStreamView } = await import("../sidepanel/agent/run-loop.js");
const { setCurrentChatId } = await import("../sidepanel/state/store.js");

// Minimal DOM: enough for createStreamingMessage to build, detach, and rebuild
// the live bubble. Switching chats re-renders #chat-history, which detaches
// the bubble — modeled by clear().
function installChatHistory() {
  const history = {
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    appendChild(child) {
      this.children.push(child);
      child.isConnected = true;
    },
    clear() {
      for (const child of this.children) child.isConnected = false;
      this.children = [];
    }
  };
  globalThis.document = {
    getElementById: (id) => (id === "chat-history" ? history : null),
    createElement: () => ({
      className: "",
      textContent: "",
      isConnected: false,
      children: [],
      appendChild(child) { this.children.push(child); },
      remove() { this.isConnected = false; }
    })
  };
  return history;
}

function bubbleText(history) {
  // message > message-content > streaming text element
  return history.children[0].children[0].children[0].textContent;
}

test("deltas arriving while another chat is displayed reappear when the user returns", () => {
  const history = installChatHistory();
  setCurrentChatId("chat-a");
  const view = createStreamView("chat-a", null);

  view.append("The capital of France is");
  assert.equal(bubbleText(history), "The capital of France is");

  // User switches to chat B: the history re-renders and mid-stream deltas keep
  // arriving while chat A is not visible.
  setCurrentChatId("chat-b");
  history.clear();
  view.append(" Paris,");
  view.append(" a city");
  assert.equal(history.children.length, 0, "an invisible chat never touches the DOM");

  // Back to chat A: the next delta rebuilds the bubble with no gap.
  setCurrentChatId("chat-a");
  history.clear();
  view.append(" on the Seine.");
  assert.equal(bubbleText(history), "The capital of France is Paris, a city on the Seine.");

  view.finish();
  setCurrentChatId(null);
});

test("reset drops buffered deltas so a retry restarts clean", () => {
  const history = installChatHistory();
  setCurrentChatId("chat-b");
  const view = createStreamView("chat-a", null);

  view.append("half a sen");
  assert.equal(history.children.length, 0);

  view.reset();
  setCurrentChatId("chat-a");
  view.append("Fresh answer.");
  assert.equal(bubbleText(history), "Fresh answer.", "no stale pre-retry text leaks into the retried stream");

  view.finish();
  setCurrentChatId(null);
});
