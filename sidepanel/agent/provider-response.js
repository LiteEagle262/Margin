export const MAX_OPENAI_CONTINUATION_TURNS = 4;

// Both provider layers embed the HTTP status in parentheses, e.g.
// "OpenRouter Error (429): ..." / "OpenAI response failed (503): ...".
// The status code itself is not threaded through, so classify by message.
const RETRYABLE_STATUS_PATTERN = /\((?:429|500|502|503|529)\)/;
const NETWORK_FAILURE_PATTERN = /failed to fetch|networkerror/i;

export function isRetryableProviderError(error) {
  if (!error || error.name === "AbortError") return false;
  const message = String(error.message || "");
  if (RETRYABLE_STATUS_PATTERN.test(message)) return true;
  // fetch rejects with TypeError("Failed to fetch") on network-level failures;
  // the OpenAI background port forwards the same text as a plain Error.
  return error instanceof TypeError || NETWORK_FAILURE_PATTERN.test(message);
}

export function describeEmptyProviderResponse(providerId, message) {
  if (providerId !== "openai") {
    return "The provider completed without returning a message or tool call.";
  }

  const status = String(message?.openai_response_status || "").trim();
  const outputTypes = Array.isArray(message?.openai_output_types)
    ? message.openai_output_types.filter(Boolean).join(", ")
    : "";
  const details = [];
  if (status) details.push(`status: ${status}`);
  if (outputTypes) details.push(`output items: ${outputTypes}`);
  const suffix = details.length ? ` (${details.join("; ")})` : "";
  return `OpenAI completed without usable text, a function call, or continuation state${suffix}.`;
}

export function classifyProviderResponse(providerId, message) {
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length) return { kind: "tool_calls", toolCalls };

  const content = String(message?.content || "").trim();
  const continuationItems = Array.isArray(message?.openai_response_items)
    ? message.openai_response_items
    : [];
  if (providerId === "openai" && (message?.openai_continue === true || (!content && continuationItems.length))) {
    return { kind: "continue", content, continuationItems };
  }

  if (content) return { kind: "message", content };

  return { kind: "empty" };
}
