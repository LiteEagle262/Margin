import test from "node:test";
import assert from "node:assert/strict";
import { buildApiMessagesForChat } from "../sidepanel/agent/context.js";
import { settings, setSettings } from "../sidepanel/state/store.js";

// buildApiMessagesForChat is a pure function of the chat plus the settings
// singleton, so every test snapshots and restores settings.
function withSettings(overrides, run) {
  const previousSettings = structuredClone(settings);
  try {
    setSettings({ ...previousSettings, ...overrides });
    return run();
  } finally {
    setSettings(previousSettings);
  }
}

test("packing keeps the newest blocks and reports how many older ones were left out", () => {
  // A 4000-token fallback window forces the floor budget of 2000 message
  // tokens; each 4000-char user message is ~1000 tokens, so only the newest
  // message fits and the other five must be omitted.
  const chat = {
    messages: Array.from({ length: 6 }, (_, i) => ({
      role: "user",
      content: `marker-${i} ${"x".repeat(4000)}`
    }))
  };

  withSettings({ agentLimits: { maxToolCalls: 30, fallbackContextWindow: 4000 } }, () => {
    const messages = buildApiMessagesForChat(chat);

    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /Context note: 5 older conversation block\(s\) were left out/);

    const sentText = messages.slice(1).map((msg) => msg.content[0].text).join("\n");
    assert.ok(sentText.includes("marker-5"), "the newest message stays");
    assert.ok(!sentText.includes("marker-0"), "the oldest message is dropped");
  });
});

test("only the newest snapshot stays inline; older snapshots are superseded stubs", () => {
  const oldSnapshot = JSON.stringify({
    ok: true,
    tool: "take_snapshot",
    message: "Page snapshot captured.",
    data: { snapshot_id: "snap-old", elements: [{ uid: "sf-button-oldold" }] }
  });
  const clickWithSnapshot = JSON.stringify({
    ok: true,
    tool: "click_element",
    message: "Element clicked.",
    data: {
      target: { uid: "sf-button-target" },
      snapshot: { snapshot_id: "snap-mid", elements: [{ uid: "sf-input-midmid" }] }
    }
  });
  const newSnapshot = JSON.stringify({
    ok: true,
    tool: "take_snapshot",
    message: "Page snapshot captured.",
    data: { snapshot_id: "snap-new", elements: [{ uid: "sf-button-newnew" }] }
  });
  const chat = {
    messages: [
      { role: "user", content: "Fill the form" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "take_snapshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", name: "take_snapshot", content: oldSnapshot },
      { role: "assistant", content: "", tool_calls: [{ id: "call-2", type: "function", function: { name: "click_element", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-2", name: "click_element", content: clickWithSnapshot },
      { role: "assistant", content: "", tool_calls: [{ id: "call-3", type: "function", function: { name: "take_snapshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-3", name: "take_snapshot", content: newSnapshot }
    ]
  };

  withSettings({}, () => {
    const messages = buildApiMessagesForChat(chat);
    const tools = messages.filter((msg) => msg.role === "tool");
    const byId = Object.fromEntries(tools.map((msg) => [msg.tool_call_id, msg]));

    // Oldest take_snapshot: fully replaced by an archive stub warning of staleness.
    assert.match(byId["call-1"].content, /Superseded page snapshot/);
    assert.match(byId["call-1"].content, /stale/);
    assert.match(byId["call-1"].content, /read_context_item with context_item_id="tool_call-1"/);
    assert.ok(!byId["call-1"].content.includes("sf-button-oldold"), "stale uids stay out of context");

    // Interaction result: only the embedded snapshot is stripped, the outcome survives.
    assert.ok(!byId["call-2"].content.includes("sf-input-midmid"), "embedded stale snapshot is stripped");
    assert.match(byId["call-2"].content, /Element clicked\./);
    assert.match(byId["call-2"].content, /Superseded page snapshot/);

    // Newest snapshot is the source of truth and stays byte-identical.
    assert.equal(byId["call-3"].content, newSnapshot);
  });
});

test("tool calls with no recorded result are backfilled so the chat stays sendable", () => {
  const chat = {
    messages: [
      { role: "user", content: "Scrape the page" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "get_dom", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "list_tabs", arguments: "{}" } }
        ]
      }
      // Run was interrupted: no tool results were stored at all.
    ]
  };

  withSettings({}, () => {
    const messages = buildApiMessagesForChat(chat);
    const tools = messages.filter((msg) => msg.role === "tool");
    assert.deepEqual(tools.map((msg) => msg.tool_call_id), ["call-1", "call-2"]);
    assert.deepEqual(tools.map((msg) => msg.name), ["get_dom", "list_tabs"]);
    for (const msg of tools) {
      assert.match(msg.content, /No result recorded/);
    }
  });
});

test("oversized old tool results outside the recent window become archive stubs", () => {
  const bigContent = `big-result-start ${"B".repeat(9000)}`;
  const smallIds = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const chat = {
    messages: [
      { role: "user", content: "Audit the page" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-big", type: "function", function: { name: "get_dom", arguments: "{}" } },
          ...smallIds.map((id) => ({ id, type: "function", function: { name: "list_tabs", arguments: "{}" } }))
        ]
      },
      { role: "tool", tool_call_id: "call-big", name: "get_dom", content: bigContent },
      ...smallIds.map((id) => ({ role: "tool", tool_call_id: id, name: "list_tabs", content: "[]" }))
    ]
  };

  withSettings({}, () => {
    const messages = buildApiMessagesForChat(chat);
    const tools = messages.filter((msg) => msg.role === "tool");
    const big = tools.find((msg) => msg.tool_call_id === "call-big");

    assert.match(big.content, /^\[Archived tool result: tool_call-big\]/);
    assert.match(big.content, /Preview: big-result-start/);
    assert.match(big.content, /read_context_item with context_item_id="tool_call-big"/);
    assert.ok(big.content.length < 2000, "the stub replaces the oversized payload");

    // The six most recent tool results stay inline untouched.
    for (const id of smallIds) {
      assert.equal(tools.find((msg) => msg.tool_call_id === id).content, "[]");
    }
  });
});
