import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderResponse,
  describeEmptyProviderResponse,
  isRetryableProviderError,
  MAX_OPENAI_CONTINUATION_TURNS,
} from "../sidepanel/agent/provider-response.js";
import { buildApiMessagesForChat } from "../sidepanel/agent/context.js";
import { settings, setSettings } from "../sidepanel/state/store.js";

test("provider responses prioritize tool calls and visible messages", () => {
  const toolCalls = [{ id: "call-1", type: "function", function: { name: "take_snapshot", arguments: "{}" } }];
  assert.deepEqual(classifyProviderResponse("openai", { tool_calls: toolCalls }), {
    kind: "tool_calls",
    toolCalls,
  });
  assert.deepEqual(classifyProviderResponse("openai", { content: "  Finished.  " }), {
    kind: "message",
    content: "Finished.",
  });
});

test("provider errors retry only on transient statuses and network failures", () => {
  for (const status of [429, 500, 502, 503, 529]) {
    assert.equal(
      isRetryableProviderError(new Error(`OpenRouter Error (${status}): upstream hiccup`)),
      true,
      `status ${status} is retryable`,
    );
  }
  assert.equal(isRetryableProviderError(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableProviderError(new Error("NetworkError when attempting to fetch resource.")), true);

  for (const status of [400, 401, 403]) {
    assert.equal(
      isRetryableProviderError(new Error(`OpenAI response failed (${status}): rejected`)),
      false,
      `status ${status} is not retryable`,
    );
  }
  const aborted = new Error("The user aborted a request.");
  aborted.name = "AbortError";
  assert.equal(isRetryableProviderError(aborted), false);
  assert.equal(isRetryableProviderError(null), false);
});

test("OpenAI reasoning-only responses continue instead of surfacing an empty-message error", () => {
  const continuationItems = [{
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque",
  }];
  assert.deepEqual(classifyProviderResponse("openai", {
    content: "",
    tool_calls: [],
    openai_response_items: continuationItems,
  }), {
    kind: "continue",
    content: "",
    continuationItems,
  });
  assert.equal(classifyProviderResponse("openrouter", {
    openai_response_items: continuationItems,
  }).kind, "empty");
  assert.equal(MAX_OPENAI_CONTINUATION_TURNS, 4);
});

test("OpenAI end_turn false continues after an intermediate visible message", () => {
  assert.deepEqual(classifyProviderResponse("openai", {
    content: "I have inspected the page.",
    openai_continue: true,
    openai_response_items: [],
  }), {
    kind: "continue",
    content: "I have inspected the page.",
    continuationItems: [],
  });
});

test("empty responses expose only safe structural diagnostics", () => {
  assert.equal(
    describeEmptyProviderResponse("openai", {
      openai_response_status: "completed",
      openai_output_types: ["reasoning", "custom_tool_call"],
    }),
    "OpenAI completed without usable text, a function call, or continuation state (status: completed; output items: reasoning, custom_tool_call).",
  );
  assert.equal(
    describeEmptyProviderResponse("openrouter", {}),
    "The provider completed without returning a message or tool call.",
  );
});

test("OpenAI final turns keep stateless replay state and stored errors stay out of model context", () => {
  const previousSettings = structuredClone(settings);
  const continuationItems = [{
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque",
  }];
  const chat = {
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Recovered answer", openai_response_items: continuationItems },
      { role: "assistant", content: "Error occurred during agent turn: transient", isError: true },
    ],
  };

  try {
    setSettings({ ...previousSettings, aiProvider: "openai" });
    const openAIMessages = buildApiMessagesForChat(chat);
    const answer = openAIMessages.find((message) => message.content === "Recovered answer");
    assert.deepEqual(answer.openai_response_items, continuationItems);
    assert.equal(openAIMessages.some((message) => String(message.content).includes("transient")), false);

    setSettings({ ...previousSettings, aiProvider: "openrouter" });
    const openRouterMessages = buildApiMessagesForChat(chat);
    const openRouterAnswer = openRouterMessages.find((message) => message.content === "Recovered answer");
    assert.equal(Object.hasOwn(openRouterAnswer, "openai_response_items"), false);
  } finally {
    setSettings(previousSettings);
  }
});

test("tool calls left unanswered by an interrupted run are backfilled", () => {
  const previousSettings = structuredClone(settings);
  const chat = {
    messages: [{ role: "user", content: "Scrape the page" }, {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "take_snapshot", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "get_dom", arguments: "{}" } },
      ],
    }, {
      role: "tool",
      tool_call_id: "call-1",
      name: "take_snapshot",
      content: "snapshot result",
    }],
  };

  try {
    setSettings({ ...previousSettings, aiProvider: "openrouter" });
    const messages = buildApiMessagesForChat(chat);
    const results = messages.filter((message) => message.role === "tool");
    assert.deepEqual(results.map((message) => message.tool_call_id), ["call-1", "call-2"]);
    assert.match(results[1].content, /No result recorded/);
  } finally {
    setSettings(previousSettings);
  }
});

test("OpenRouter reasoning details replay unchanged around tool calls", () => {
  const previousSettings = structuredClone(settings);
  const reasoningDetails = [{
    type: "reasoning.text",
    text: "opaque provider reasoning state",
    signature: "signed-state",
  }];
  const chat = {
    messages: [{ role: "user", content: "Inspect the page" }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "take_snapshot", arguments: "{}" },
      }],
      reasoning_details: reasoningDetails,
    }, {
      role: "tool",
      tool_call_id: "call-1",
      name: "take_snapshot",
      content: "snapshot result",
    }],
  };

  try {
    setSettings({ ...previousSettings, aiProvider: "openrouter" });
    const openRouterMessages = buildApiMessagesForChat(chat);
    const assistant = openRouterMessages.find((message) => Array.isArray(message.tool_calls));
    assert.deepEqual(assistant.reasoning_details, reasoningDetails);

    setSettings({ ...previousSettings, aiProvider: "openai" });
    const openAIMessages = buildApiMessagesForChat(chat);
    const openAIAssistant = openAIMessages.find((message) => Array.isArray(message.tool_calls));
    assert.equal(Object.hasOwn(openAIAssistant, "reasoning_details"), false);
  } finally {
    setSettings(previousSettings);
  }
});
