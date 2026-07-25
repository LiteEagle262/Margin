import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenAIResponsesRequest,
  extractOpenAIIdentity,
  normalizeDeviceAuthorization,
  normalizeOpenAIModelsResponse,
  normalizeOpenAITokens,
  parseOpenAIResponseBody,
  parseSseEvents,
} from "../shared/openai-protocol.js";
import {
  fetchProviderChatCompletion,
  getProviderDefinition,
  normalizeProviderId,
} from "../sidepanel/api/provider.js";

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.`;
}

function sseBody(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("OpenAI OAuth identity uses ChatGPT account claims without exposing tokens", () => {
  const identity = extractOpenAIIdentity({
    id_token: jwt({
      email: "user@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_plan_type: "plus",
      },
    }),
  });
  assert.deepEqual(identity, {
    accountId: "account-123",
    email: "user@example.com",
    planType: "plus",
  });

  const normalized = normalizeOpenAITokens({
    access_token: "access-value",
    id_token: jwt({ chatgpt_account_id: "account-123" }),
    expires_in: 120,
  }, { previousRefreshToken: "refresh-value", now: 1000 });
  assert.equal(normalized.refreshToken, "refresh-value");
  assert.equal(normalized.expiresAt, 121000);
});

test("device authorization is bounded and adds the OpenCode polling margin", () => {
  const pending = normalizeDeviceAuthorization({
    device_auth_id: "device-1",
    user_code: "ABCD-EFGH",
    interval: "5",
  }, 1000);
  assert.equal(pending.intervalMs, 8000);
  assert.equal(pending.userCode, "ABCD-EFGH");
  assert.ok(pending.expiresAt > pending.startedAt);
  assert.equal(pending.nextPollAt, 9000);
});

test("OpenAI model catalogs expose only valid picker models in server priority order", () => {
  const models = normalizeOpenAIModelsResponse({
    models: [{
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6 Terra",
      description: "Balanced coding model",
      visibility: "list",
      priority: 20,
      context_window: 196000,
      input_modalities: ["text"],
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Thorough" },
      ],
    }, {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "Frontier coding model",
      visibility: "list",
      priority: 5,
      context_window: 272000,
      input_modalities: ["text", "image"],
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "medium", description: "Standard" },
        { effort: "xhigh", description: "Extended" },
      ],
    }, {
      slug: "gpt-5.6-sol",
      display_name: "Duplicate Sol",
      visibility: "list",
      priority: 1,
    }, {
      slug: "gpt-5.6-luna",
      display_name: "Hidden Luna",
      visibility: "hide",
      priority: 0,
    }, {
      slug: "../not-a-model",
      display_name: "Invalid",
      visibility: "list",
      priority: 0,
    }],
  });

  assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(models.map((model) => model.isDefault), [true, false]);
  assert.deepEqual(models[0], {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Frontier coding model",
    provider: "openai",
    isDefault: true,
    capabilitiesKnown: true,
    context_length: 272000,
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools", "reasoning"],
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "medium", description: "Standard" },
      { effort: "xhigh", description: "Extended" },
    ],
  });
  assert.equal(models[1].context_length, 196000);
  assert.deepEqual(models[1].architecture.input_modalities, ["text"]);
});

test("chat history and tools convert to a stateless Responses request", () => {
  const continuation = [{
    type: "reasoning",
    id: "reasoning-1",
    status: "completed",
    encrypted_content: "opaque",
    summary: [],
  }, {
    type: "function_call",
    id: "call-item-1",
    status: "completed",
    call_id: "call-1",
    name: "take_snapshot",
    arguments: "{}",
  }];
  const request = buildOpenAIResponsesRequest({
    model: "gpt-5.4",
    messages: [
      { role: "system", content: "Be precise." },
      { role: "user", content: [{ type: "text", text: "Inspect this" }] },
      { role: "assistant", content: "", tool_calls: [], openai_response_items: continuation },
      { role: "tool", tool_call_id: "call-1", content: "snapshot result" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "take_snapshot",
        description: "Inspect the page",
        parameters: { type: "object", properties: {} },
      },
    }],
    reasoning: { effort: "medium" },
  });

  assert.equal(request.instructions, "Be precise.");
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.deepEqual(request.input.slice(1, 3), [{
    type: "reasoning",
    encrypted_content: "opaque",
    summary: [],
  }, {
    type: "function_call",
    call_id: "call-1",
    name: "take_snapshot",
    arguments: "{}",
  }]);
  assert.deepEqual(request.input.at(-1), {
    type: "function_call_output",
    call_id: "call-1",
    output: "snapshot result",
  });
  assert.equal(request.tools[0].name, "take_snapshot");
  assert.equal(request.reasoning.effort, "medium");
  assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
});

test("OpenAI Responses accepts catalog-advertised max and ultra reasoning", () => {
  for (const effort of ["none", "max", "ultra"]) {
    const request = buildOpenAIResponsesRequest({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Solve this" }],
      reasoning: { effort },
    });
    assert.equal(request.reasoning.effort, effort);
  }
});

test("ordinary assistant turns replay as output_text on the next Responses request", () => {
  const request = buildOpenAIResponsesRequest({
    model: "gpt-5.4",
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow-up question" },
    ],
  });

  assert.deepEqual(request.input, [
    { role: "user", content: [{ type: "input_text", text: "First question" }] },
    { role: "assistant", content: [{ type: "output_text", text: "First answer" }] },
    { role: "user", content: [{ type: "input_text", text: "Follow-up question" }] },
  ]);
});

test("stateless replay drops server item ids and unusable reasoning state", () => {
  const request = buildOpenAIResponsesRequest({
    model: "gpt-5.4",
    messages: [{
      role: "assistant",
      content: "Fallback text",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "take_snapshot", arguments: "{}" },
      }],
      openai_response_items: [{
        type: "reasoning",
        id: "missing-encrypted-state",
        summary: [{ type: "summary_text", text: "Do not replay this item" }],
      }, {
        type: "message",
        id: "message-1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Stored answer" }],
      }, {
        type: "function_call",
        id: "function-item-1",
        status: "completed",
        call_id: "call-1",
        name: "take_snapshot",
        arguments: "{}",
      }],
    }],
  });

  assert.deepEqual(request.input, [{
    role: "assistant",
    content: [{ type: "output_text", text: "Stored answer" }],
  }, {
    type: "function_call",
    call_id: "call-1",
    name: "take_snapshot",
    arguments: "{}",
  }]);
  assert.equal(JSON.stringify(request.input).includes("message-1"), false);
  assert.equal(JSON.stringify(request.input).includes("missing-encrypted-state"), false);
});

test("fragmented-style SSE frames normalize text, tools, reasoning, and usage", () => {
  const response = {
    id: "response-1",
    status: "completed",
    output: [{
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "opaque",
      summary: [{ type: "summary_text", text: "Checked the page." }],
    }, {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I need a snapshot." }],
    }, {
      type: "function_call",
      call_id: "call-1",
      name: "take_snapshot",
      arguments: "{\"depth\":2}",
    }],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  };
  const body = [
    "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"I need\"}\r\n\r\n",
    `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response })}\r\n\r\n`,
    "data: [DONE]\r\n\r\n",
  ].join("");

  assert.equal(parseSseEvents(body).length, 2);
  const normalized = parseOpenAIResponseBody(body, "text/event-stream");
  const message = normalized.choices[0].message;
  assert.equal(message.content, "I need a snapshot.");
  assert.equal(message.reasoning, "Checked the page.");
  assert.deepEqual(message.tool_calls[0], {
    id: "call-1",
    type: "function",
    function: { name: "take_snapshot", arguments: "{\"depth\":2}" },
  });
  assert.equal(message.openai_response_items[0].encrypted_content, "opaque");
  assert.equal(Object.hasOwn(message.openai_response_items[0], "id"), false);
  assert.deepEqual(normalized.usage, {
    prompt_tokens: 12,
    completion_tokens: 8,
    total_tokens: 20,
  });
});

test("Codex output_item.done text survives a completed event with null output", () => {
  const normalized = parseOpenAIResponseBody(sseBody([{
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "Recovered from the stream." }],
    },
  }, {
    type: "response.completed",
    response: {
      status: "completed",
      output: null,
      end_turn: false,
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    },
  }]), "text/event-stream");

  const message = normalized.choices[0].message;
  assert.equal(message.content, "Recovered from the stream.");
  assert.equal(message.openai_response_items.length, 1);
  assert.equal(message.openai_response_items[0].phase, "commentary");
  assert.equal(message.openai_continue, true);
  assert.deepEqual(message.openai_output_types, ["message"]);
  assert.equal(message.openai_response_status, "completed");
  assert.equal(normalized.usage.total_tokens, 9);
});

test("typed text and refusal events recover when completed output is empty", () => {
  const textResult = parseOpenAIResponseBody(sseBody([{
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [] },
  }, {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: "Hello ",
  }, {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: "there",
  }, {
    type: "response.output_text.done",
    output_index: 0,
    content_index: 0,
    text: "Hello there",
  }, {
    type: "response.completed",
    response: { status: "completed", output: [] },
  }]), "text/event-stream");
  assert.equal(textResult.choices[0].message.content, "Hello there");

  const refusalResult = parseOpenAIResponseBody(sseBody([{
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [] },
  }, {
    type: "response.refusal.delta",
    output_index: 0,
    content_index: 0,
    delta: "I cannot ",
  }, {
    type: "response.refusal.done",
    output_index: 0,
    content_index: 0,
    refusal: "I cannot help with that.",
  }, {
    type: "response.completed",
    response: { status: "completed", output: null },
  }]), "text/event-stream");
  assert.equal(refusalResult.choices[0].message.content, "I cannot help with that.");
});

test("Codex stream reconstructs tool arguments, reasoning summaries, and end_turn", () => {
  const normalized = parseOpenAIResponseBody(sseBody([{
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "reasoning", encrypted_content: "opaque", summary: [] },
  }, {
    type: "response.reasoning_summary_text.delta",
    output_index: 0,
    summary_index: 0,
    delta: "Inspecting ",
  }, {
    type: "response.reasoning_summary_text.done",
    output_index: 0,
    summary_index: 0,
    text: "Inspecting the page.",
  }, {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", encrypted_content: "opaque", summary: [] },
  }, {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      type: "function_call",
      call_id: "call-1",
      name: "take_snapshot",
      arguments: "",
    },
  }, {
    type: "response.function_call_arguments.delta",
    output_index: 1,
    delta: "{\"depth\":",
  }, {
    type: "response.function_call_arguments.done",
    output_index: 1,
    arguments: "{\"depth\":2}",
  }, {
    type: "response.output_item.done",
    output_index: 1,
    end_turn: false,
    item: {
      type: "function_call",
      call_id: "call-1",
      name: "take_snapshot",
      arguments: "",
    },
  }, {
    type: "response.completed",
    response: {
      status: "completed",
      output: [{
        type: "reasoning",
        encrypted_content: "opaque",
        summary: [{ type: "summary_text", text: "Inspecting the page." }],
      }],
    },
  }]), "text/event-stream");

  const message = normalized.choices[0].message;
  assert.equal(message.reasoning, "Inspecting the page.");
  assert.equal(message.openai_continue, true);
  assert.deepEqual(message.openai_output_types, ["reasoning", "function_call"]);
  assert.deepEqual(message.tool_calls, [{
    id: "call-1",
    type: "function",
    function: { name: "take_snapshot", arguments: "{\"depth\":2}" },
  }]);
  assert.equal(message.openai_response_items[0].encrypted_content, "opaque");
});

test("complete terminal output stays authoritative without duplicate streamed text", () => {
  const output = [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "One answer." }],
  }];
  const normalized = parseOpenAIResponseBody(sseBody([{
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    delta: "One answer.",
  }, {
    type: "response.output_item.done",
    output_index: 0,
    item: output[0],
  }, {
    type: "response.completed",
    end_turn: false,
    response: { status: "completed", output, output_text: "One answer." },
  }]), "text/event-stream");

  const message = normalized.choices[0].message;
  assert.equal(message.content, "One answer.");
  assert.equal(message.openai_response_items.length, 1);
  assert.equal(message.openai_continue, true);
});

test("top-level output_text is a fallback and incomplete streams retain their reason", () => {
  const normalized = parseOpenAIResponseBody(JSON.stringify({
    status: "completed",
    output: [],
    output_text: "Top-level answer.",
  }), "application/json");
  assert.equal(normalized.choices[0].message.content, "Top-level answer.");

  assert.throws(() => parseOpenAIResponseBody(sseBody([{
    type: "response.incomplete",
    response: {
      status: "incomplete",
      output: [],
      incomplete_details: { reason: "max_output_tokens" },
    },
  }]), "text/event-stream"), /incomplete: max_output_tokens/);
});

test("Responses function calls require the external call_id", () => {
  const normalized = parseOpenAIResponseBody(JSON.stringify({
    status: "completed",
    output: [{
      type: "function_call",
      id: "server-item-id",
      name: "take_snapshot",
      arguments: "{}",
    }],
  }), "application/json");

  assert.deepEqual(normalized.choices[0].message.tool_calls, []);
  assert.deepEqual(normalized.choices[0].message.openai_output_types, ["function_call"]);
});

test("OpenAI provider routes through the background port without using an API key", async () => {
  const originalChrome = globalThis.chrome;
  let sent;
  const messageListeners = [];
  const disconnectListeners = [];
  globalThis.chrome = {
    runtime: {
      connect() {
        return {
          onMessage: { addListener(listener) { messageListeners.push(listener); } },
          onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
          postMessage(message) {
            sent = message;
            if (message.type === "request") {
              queueMicrotask(() => messageListeners.forEach((listener) => listener({
                type: "result",
                result: { choices: [{ message: { role: "assistant", content: "ok" } }] },
              })));
            }
          },
          disconnect() { disconnectListeners.forEach((listener) => listener()); },
        };
      },
    },
  };

  try {
    const result = await fetchProviderChatCompletion("openai", "must-not-be-used", {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Hello" }],
    }, { sessionId: "chat-1" });
    assert.equal(result.choices[0].message.content, "ok");
    assert.equal(sent.sessionId, "chat-1");
    assert.equal(JSON.stringify(sent).includes("must-not-be-used"), false);
  } finally {
    globalThis.chrome = originalChrome;
  }

  assert.equal(getProviderDefinition("openai").keyLabel, "");
  assert.equal(getProviderDefinition("openai").keyPlaceholder, "");
});

test("OpenRouter requests never receive OpenAI continuation state", async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { role: "assistant", content: "ok" } }] };
      },
    };
  };

  try {
    await fetchProviderChatCompletion("openrouter", "openrouter-key", {
      model: "example/model",
      messages: [{
        role: "assistant",
        content: "Previous answer",
        openai_response_items: [{ type: "reasoning", encrypted_content: "opaque" }],
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(Object.hasOwn(body.messages[0], "openai_response_items"), false);
  assert.equal(JSON.stringify(body).includes("opaque"), false);
});

test("provider identifiers fall back safely", () => {
  assert.equal(normalizeProviderId("openai"), "openai");
  assert.equal(normalizeProviderId("unexpected"), "openrouter");
  assert.equal(normalizeProviderId("__proto__"), "openrouter");
});
