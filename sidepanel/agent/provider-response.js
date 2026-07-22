export const MAX_OPENAI_CONTINUATION_TURNS = 4;

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
