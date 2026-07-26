import test from "node:test";
import assert from "node:assert/strict";
import { assembleOpenRouterStreamResponse, fetchChatCompletion } from "../sidepanel/api/openrouter.js";

// assembleOpenRouterStreamResponse is pure: feed it parsed SSE chunk objects and
// it must rebuild the exact shape the non-streaming /chat/completions call
// returned, so downstream consumers (run loop, chat titles, export) see no
// difference between the two transports.

test("content deltas and split tool_call fragments reassemble into the non-streaming shape", () => {
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  const chunks = [
    {
      id: "gen-1", model: "openai/gpt-4o", provider: "OpenAI", created: 1720000000,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "Clicking" }, finish_reason: null }]
    },
    { id: "gen-1", choices: [{ index: 0, delta: { content: " the button now." }, finish_reason: null }] },
    // First tool-call fragment carries id/type/name; arguments arrive split
    // across the following chunks and must be concatenated in order.
    {
      id: "gen-1",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "click_element", arguments: "" } }] }, finish_reason: null }]
    },
    { id: "gen-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"uid":' } }] }, finish_reason: null }] },
    { id: "gen-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"sf-button-abc123"}' } }] }, finish_reason: null }] },
    { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    // stream_options.include_usage delivers usage on a final chunk with no choices.
    { id: "gen-1", choices: [], usage }
  ];

  assert.deepEqual(assembleOpenRouterStreamResponse(chunks), {
    object: "chat.completion",
    id: "gen-1",
    model: "openai/gpt-4o",
    provider: "OpenAI",
    created: 1720000000,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "Clicking the button now.",
        tool_calls: [{
          id: "call_a",
          type: "function",
          function: { name: "click_element", arguments: '{"uid":"sf-button-abc123"}' }
        }]
      },
      finish_reason: "tool_calls"
    }],
    usage
  });
});

test("a text-free stream with interleaved tool calls keeps them ordered by index", () => {
  const usage = { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 };
  const chunks = [
    {
      id: "gen-2", model: "openai/gpt-4o",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "open_tab", arguments: '{"ur' } }] }, finish_reason: null }]
    },
    // The second call opens before the first finishes streaming its arguments.
    {
      id: "gen-2",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "take_snapshot", arguments: "" } }] }, finish_reason: null }]
    },
    {
      id: "gen-2",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: "{}" } },
            { index: 0, function: { arguments: 'l":"https://example.com"}' } }
          ]
        },
        finish_reason: null
      }]
    },
    { id: "gen-2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "gen-2", choices: [], usage }
  ];

  const response = assembleOpenRouterStreamResponse(chunks);
  const message = response.choices[0].message;

  assert.equal(message.content, "", "no content deltas leaves empty text, not undefined");
  assert.equal(message.reasoning, undefined);
  assert.deepEqual(message.tool_calls, [
    { id: "call_a", type: "function", function: { name: "open_tab", arguments: '{"url":"https://example.com"}' } },
    { id: "call_b", type: "function", function: { name: "take_snapshot", arguments: "{}" } }
  ]);
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(response.usage, usage);
});

// Stubs fetch with an SSE body delivered as one read per string in `frames`,
// then a clean EOF — the transport shape a proxy produces when it drops the
// connection without an error event.
function stubSseFetch(t, frames) {
  const encoder = new TextEncoder();
  let index = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: async () => (index < frames.length
          ? { done: false, value: encoder.encode(frames[index++]) }
          : { done: true, value: undefined }),
        cancel: async () => {}
      })
    }
  });
  t.after(() => { globalThis.fetch = originalFetch; });
}

test("a clean EOF before [DONE] or a finish_reason is an error, not a truncated answer", async (t) => {
  stubSseFetch(t, [
    'data: {"id":"gen-9","choices":[{"index":0,"delta":{"content":"The capital of France is"},"finish_reason":null}]}\n\n'
  ]);

  await assert.rejects(
    fetchChatCompletion("key", { model: "openai/gpt-4o", messages: [] }),
    /stream ended before the response completed/
  );
});

test("a stream that delivered a finish_reason survives losing its [DONE] frame", async (t) => {
  stubSseFetch(t, [
    'data: {"id":"gen-10","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\n',
    'data: {"id":"gen-10","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  ]);

  const response = await fetchChatCompletion("key", { model: "openai/gpt-4o", messages: [] });
  assert.equal(response.choices[0].message.content, "Done.");
  assert.equal(response.choices[0].finish_reason, "stop");
});

test("a complete [DONE]-terminated stream assembles and reports deltas", async (t) => {
  stubSseFetch(t, [
    'data: {"id":"gen-11","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    'data: {"id":"gen-11","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ]);

  const deltas = [];
  const response = await fetchChatCompletion("key", { model: "openai/gpt-4o", messages: [] }, { onDelta: (text) => deltas.push(text) });
  assert.equal(response.choices[0].message.content, "Hi there");
  assert.deepEqual(deltas, ["Hi", " there"]);
});

test("finish_reason comes from the last chunk that set one and usage from the last usage chunk", () => {
  const chunks = [
    { id: "gen-3", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }], usage: { total_tokens: 1 } },
    { id: "gen-3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "gen-3", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
  ];

  const response = assembleOpenRouterStreamResponse(chunks);
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.equal(response.choices[0].message.content, "Done.");
  assert.deepEqual(response.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
});
