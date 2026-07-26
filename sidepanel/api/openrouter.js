import { formatUsdBalance } from "../lib/format.js";
import { createSseDataScanner } from "../../shared/openai-protocol.js";

const API_BASE = "https://openrouter.ai/api/v1";
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const OPENROUTER_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeOpenRouterReasoning(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const supportedEfforts = [];
  const seen = new Set();
  const rawEfforts = raw.supported_efforts === null
    ? OPENROUTER_REASONING_EFFORTS
    : Array.isArray(raw.supported_efforts)
      ? raw.supported_efforts
      : [];
  for (const value of rawEfforts) {
    const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (
      !REASONING_EFFORT_PATTERN.test(effort) ||
      (raw.mandatory === true && effort === "none") ||
      seen.has(effort)
    ) continue;
    seen.add(effort);
    supportedEfforts.push(effort);
  }
  if (raw.mandatory === false && !seen.has("none")) supportedEfforts.unshift("none");
  const defaultEffort = typeof raw.default_effort === "string"
    ? raw.default_effort.trim().toLowerCase()
    : "";
  return {
    supported_efforts: supportedEfforts,
    default_effort: supportedEfforts.includes(defaultEffort) ? defaultEffort : "",
    default_enabled: typeof raw.default_enabled === "boolean" ? raw.default_enabled : null,
    mandatory: raw.mandatory === true,
  };
}

function buildHeaders(apiKey, appTitle = "Margin", json = false) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-Title": appTitle,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

export async function fetchModels(apiKey) {
  const response = await fetch(`${API_BASE}/models?output_modalities=text`, {
    headers: buildHeaders(apiKey),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to load models (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return (data.data || [])
    .filter((model) => model.id)
    .map((model) => ({
      ...model,
      reasoning: normalizeOpenRouterReasoning(model.reasoning),
    }))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

export function modelEndpointsUrl(modelId) {
  const parts = String(modelId || "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return "";
  const author = encodeURIComponent(parts.shift());
  const slug = parts.map(encodeURIComponent).join("/");
  return `${API_BASE}/models/${author}/${slug}/endpoints`;
}

export async function fetchModelEndpoints(apiKey, modelId) {
  const url = modelEndpointsUrl(modelId);
  if (!url) throw new Error(`"${modelId}" is not an OpenRouter model id.`);

  const response = await fetch(url, {
    headers: buildHeaders(apiKey),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Failed to load providers (${response.status}): ${errText}`,
    );
  }

  const data = await response.json();
  return data.data?.endpoints || [];
}

export async function fetchCredits(apiKey) {
  const response = await fetch(`${API_BASE}/credits`, {
    headers: buildHeaders(apiKey),
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      errorText: await response.text(),
    };
  }

  const payload = await response.json();
  const totalCredits = Number(payload?.data?.total_credits);
  const totalUsage = Number(payload?.data?.total_usage);
  return {
    ok: true,
    totalCredits,
    totalUsage,
    balance: totalCredits - totalUsage,
  };
}

export async function fetchKeyBalance(apiKey) {
  const response = await fetch(`${API_BASE}/key`, {
    headers: buildHeaders(apiKey),
  });

  if (!response.ok) return null;

  const payload = await response.json();
  const data = payload?.data || {};
  const remaining = Number(data.limit_remaining);
  const usage = Number(data.usage);
  const limit = Number(data.limit);

  if (Number.isFinite(remaining)) {
    const limitText = Number.isFinite(limit)
      ? ` of ${formatUsdBalance(limit)}`
      : "";
    return {
      label: `Balance ${formatUsdBalance(remaining)}`,
      title: `OpenRouter key remaining: ${formatUsdBalance(remaining)}${limitText}`,
    };
  }

  if (Number.isFinite(usage)) {
    return {
      label: `Balance --`,
      title: `OpenRouter key usage: ${formatUsdBalance(usage)}`,
    };
  }

  return null;
}

// OpenRouter reports rate limits and moderation refusals in the body of a 200:
// as the whole JSON body when not streaming, or as an SSE event mid-stream.
// Both paths throw the same error shape so retry classification is unchanged.
function throwOpenRouterBodyError(data) {
  if (!data?.error) return;
  const detail = typeof data.error === "string"
    ? data.error
    : data.error.message || JSON.stringify(data.error);
  const code = typeof data.error === "object" && data.error.code ? ` (${data.error.code})` : "";
  throw new Error(`OpenRouter Error${code}: ${detail}`);
}

function mergeReasoningDetailFragments(details, fragments) {
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    if (!fragment || typeof fragment !== "object") continue;
    // Deltas for one logical reasoning block share an index: string payloads
    // (text/summary/data) accumulate, other fields keep the latest value.
    const key = Number.isInteger(fragment.index) ? fragment.index : null;
    const existing = key === null ? null : details.find((entry) => entry.index === key);
    if (!existing) {
      details.push({ ...fragment });
      continue;
    }
    for (const [field, value] of Object.entries(fragment)) {
      if (
        (field === "text" || field === "summary" || field === "data") &&
        typeof value === "string" && typeof existing[field] === "string"
      ) {
        existing[field] += value;
      } else {
        existing[field] = value;
      }
    }
  }
}

function mergeToolCallFragments(toolCalls, fragments) {
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    if (!fragment || typeof fragment !== "object") continue;
    // Streamed tool calls arrive as fragments keyed by index: id and name on
    // the first fragment, argument text spread across the rest.
    const index = Number.isInteger(fragment.index) ? fragment.index : toolCalls.size;
    if (!toolCalls.has(index)) {
      toolCalls.set(index, { id: "", type: "function", name: "", arguments: "" });
    }
    const call = toolCalls.get(index);
    if (typeof fragment.id === "string" && fragment.id && !call.id) call.id = fragment.id;
    if (typeof fragment.type === "string" && fragment.type) call.type = fragment.type;
    if (typeof fragment.function?.name === "string") call.name += fragment.function.name;
    if (typeof fragment.function?.arguments === "string") call.arguments += fragment.function.arguments;
  }
}

// Pure reassembly of parsed streaming chunks into the exact response shape the
// non-streaming /chat/completions call used to return: choices[n].message with
// content, tool_calls, reasoning, reasoning_details; finish_reason from the
// last chunk that set one; usage from the final usage-bearing chunk.
export function assembleOpenRouterStreamResponse(chunks) {
  const response = { object: "chat.completion", choices: [] };
  const choices = new Map();
  const choiceState = (index) => {
    if (!choices.has(index)) {
      choices.set(index, {
        index,
        content: "",
        reasoning: "",
        reasoningDetails: [],
        toolCalls: new Map(),
        finishReason: null,
      });
    }
    return choices.get(index);
  };

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.id) response.id = chunk.id;
    if (chunk.model) response.model = chunk.model;
    if (chunk.provider) response.provider = chunk.provider;
    if (Number.isFinite(chunk.created)) response.created = chunk.created;
    if (chunk.usage && typeof chunk.usage === "object") response.usage = chunk.usage;

    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      if (!choice || typeof choice !== "object") continue;
      const state = choiceState(Number.isInteger(choice.index) ? choice.index : 0);
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
      if (typeof delta.content === "string") state.content += delta.content;
      if (typeof delta.reasoning === "string") state.reasoning += delta.reasoning;
      mergeReasoningDetailFragments(state.reasoningDetails, delta.reasoning_details);
      mergeToolCallFragments(state.toolCalls, delta.tool_calls);
    }
  }

  response.choices = [...choices.values()]
    .sort((left, right) => left.index - right.index)
    .map((state) => {
      const message = { role: "assistant", content: state.content };
      if (state.reasoning) message.reasoning = state.reasoning;
      if (state.reasoningDetails.length) message.reasoning_details = state.reasoningDetails;
      const toolCalls = [...state.toolCalls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, call]) => ({
          id: call.id,
          type: call.type || "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      if (toolCalls.length) message.tool_calls = toolCalls;
      return { index: state.index, message, finish_reason: state.finishReason };
    });
  return response;
}

export async function fetchChatCompletion(
  apiKey,
  requestBody,
  { signal = undefined, appTitle = "Margin", onDelta = undefined } = {},
) {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(apiKey, appTitle, true),
    body: JSON.stringify({
      ...requestBody,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter Error (${response.status}): ${errText}`);
  }

  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream") || !response.body?.getReader) {
    // A 200 that is not SSE is the old-style JSON body; handle it as before.
    const data = await response.json();
    throwOpenRouterBodyError(data);
    return data;
  }

  const chunks = [];
  // A clean EOF before [DONE] or any finish_reason is a truncated generation
  // (proxy or upstream dropped the connection); the non-streaming path
  // surfaced that as an error, so the stream path must too.
  let sawDone = false;
  let sawFinishReason = false;
  const scan = createSseDataScanner();
  const consumeFrames = (text) => {
    for (const frame of scan(text)) {
      if (frame.data === "[DONE]") {
        sawDone = true;
        continue;
      }
      let chunk;
      try {
        chunk = JSON.parse(frame.data);
      } catch {
        throw new Error("OpenRouter Error: malformed streaming response");
      }
      throwOpenRouterBodyError(chunk);
      if (Array.isArray(chunk.choices) && chunk.choices.some((choice) => choice?.finish_reason)) {
        sawFinishReason = true;
      }
      chunks.push(chunk);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta && typeof onDelta === "function") {
        try {
          onDelta(delta);
        } catch {}
      }
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeFrames(decoder.decode(value, { stream: true }));
    }
    // The extra blank line flushes a final frame the server did not terminate.
    consumeFrames(`${decoder.decode()}\n\n`);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!sawDone && !sawFinishReason) {
    throw new Error("OpenRouter Error: the stream ended before the response completed (connection closed mid-generation).");
  }

  return assembleOpenRouterStreamResponse(chunks);
}
