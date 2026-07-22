export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_DEVICE_URL = `${OPENAI_ISSUER}/codex/device`;
export const OPENAI_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const OPENAI_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_AUTH_STORAGE_KEY = "openaiOAuth";
export const OPENAI_ACCESS_STORAGE_KEY = "openaiOAuthAccess";
export const OPENAI_DEVICE_STORAGE_KEY = "openaiOAuthDevice";
export const OPENAI_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

const OPENAI_MODEL_ID_PATTERN = /^gpt-[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const INPUT_MODALITIES = new Set(["text", "image"]);

const FALLBACK_MODEL_CATALOG = Object.freeze({
  models: Object.freeze([
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "low",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      visibility: "list",
      priority: 1,
      context_window: 272000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      description: "Balanced agentic coding model for everyday work.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      visibility: "list",
      priority: 2,
      context_window: 272000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      description: "Fast and affordable agentic coding model.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
      visibility: "list",
      priority: 3,
      context_window: 272000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Frontier model for complex coding, research, and real-world work.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      visibility: "list",
      priority: 7,
      context_window: 272000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      description: "Strong model for everyday coding.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      visibility: "list",
      priority: 16,
      context_window: 272000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.4-mini",
      display_name: "GPT-5.4-Mini",
      description: "Small, fast, and cost-efficient model for simpler coding tasks.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      visibility: "list",
      priority: 23,
      context_window: 272000,
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.3-codex-spark",
      display_name: "GPT-5.3-Codex-Spark",
      description: "Ultra-fast coding model.",
      default_reasoning_level: "high",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      visibility: "list",
      priority: 26,
      context_window: 128000,
      input_modalities: ["text"],
    },
  ]),
});

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeReasoningLevels(value) {
  const output = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const effort = boundedString(typeof entry === "string" ? entry : entry?.effort, 32).toLowerCase();
    if (!REASONING_EFFORT_PATTERN.test(effort) || seen.has(effort)) continue;
    seen.add(effort);
    output.push({
      effort,
      description: boundedString(typeof entry === "object" ? entry?.description : "", 240),
    });
  }
  return output;
}

export function normalizeOpenAIModelsResponse(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.models)) {
    throw new Error("OpenAI returned an invalid model catalog.");
  }

  const seen = new Set();
  const models = [];
  payload.models.forEach((entry, sourceIndex) => {
    if (!entry || typeof entry !== "object" || entry.visibility !== "list") return;
    const id = boundedString(entry.slug, 96);
    if (!OPENAI_MODEL_ID_PATTERN.test(id) || seen.has(id)) return;
    seen.add(id);

    const supportedReasoningLevels = normalizeReasoningLevels(entry.supported_reasoning_levels);
    const requestedDefaultEffort = boundedString(entry.default_reasoning_level, 32).toLowerCase();
    const defaultReasoningLevel = REASONING_EFFORT_PATTERN.test(requestedDefaultEffort)
      ? requestedDefaultEffort
      : supportedReasoningLevels[0]?.effort || "";
    const inputModalities = [...new Set(
      (Array.isArray(entry.input_modalities) ? entry.input_modalities : [])
        .map((value) => boundedString(value, 24).toLowerCase())
        .filter((value) => INPUT_MODALITIES.has(value)),
    )];
    const contextWindow = Number(entry.context_window);
    const priority = Number(entry.priority);

    models.push({
      model: {
        id,
        name: boundedString(entry.display_name, 160) || id,
        description: boundedString(entry.description, 500),
        provider: "openai",
        isDefault: false,
        capabilitiesKnown: true,
        context_length: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 0,
        architecture: { input_modalities: inputModalities.length ? inputModalities : ["text"] },
        supported_parameters: ["tools", "reasoning"],
        default_reasoning_level: defaultReasoningLevel,
        supported_reasoning_levels: supportedReasoningLevels,
      },
      priority: Number.isFinite(priority) ? priority : Number.MAX_SAFE_INTEGER,
      sourceIndex,
    });
  });

  models.sort((left, right) => left.priority - right.priority || left.sourceIndex - right.sourceIndex);
  return models.map(({ model }, index) => ({ ...model, isDefault: index === 0 }));
}

export const OPENAI_SUBSCRIPTION_MODELS = Object.freeze(
  normalizeOpenAIModelsResponse(FALLBACK_MODEL_CATALOG).map((model) => Object.freeze({
    ...model,
    architecture: Object.freeze({
      input_modalities: Object.freeze([...model.architecture.input_modalities]),
    }),
    supported_parameters: Object.freeze([...model.supported_parameters]),
    supported_reasoning_levels: Object.freeze(model.supported_reasoning_levels.map((level) => Object.freeze({ ...level }))),
  })),
);

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseJwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1]));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

function claimNamespace(claims) {
  const value = claims?.["https://api.openai.com/auth"];
  return value && typeof value === "object" ? value : {};
}

export function extractOpenAIIdentity(tokens) {
  const claims = parseJwtClaims(tokens?.id_token) || parseJwtClaims(tokens?.access_token) || {};
  const authClaims = claimNamespace(claims);
  const organization = Array.isArray(claims.organizations) ? claims.organizations[0] : null;
  const accountId = claims.chatgpt_account_id || authClaims.chatgpt_account_id || organization?.id || "";
  const email = typeof claims.email === "string" ? claims.email : "";
  const planType = claims.chatgpt_plan_type || authClaims.chatgpt_plan_type || claims.plan_type || "";
  return {
    accountId: String(accountId || ""),
    email: String(email || ""),
    planType: String(planType || ""),
  };
}

export function normalizeOpenAITokens(tokens, { previousRefreshToken = "", now = Date.now() } = {}) {
  const accessToken = String(tokens?.access_token || "").trim();
  const refreshToken = String(tokens?.refresh_token || previousRefreshToken || "").trim();
  if (!accessToken || !refreshToken) {
    throw new Error("OpenAI did not return complete OAuth credentials.");
  }
  const expiresIn = Number(tokens?.expires_in);
  const identity = extractOpenAIIdentity(tokens);
  return {
    accessToken,
    refreshToken,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    ...identity,
  };
}

export function getPublicOpenAIAccount(auth) {
  if (!auth?.refreshToken) return null;
  return {
    type: "chatgpt",
    email: String(auth.email || ""),
    planType: String(auth.planType || ""),
  };
}

export function normalizeDeviceAuthorization(data, now = Date.now()) {
  const deviceAuthId = String(data?.device_auth_id || "").trim();
  const userCode = String(data?.user_code || "").trim();
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI returned an invalid device authorization response.");
  }
  const requestedInterval = Number.parseInt(data?.interval, 10);
  const intervalMs = Math.max(Number.isFinite(requestedInterval) ? requestedInterval : 5, 1) * 1000 + 3000;
  return {
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_DEVICE_URL,
    intervalMs,
    startedAt: now,
    expiresAt: now + OPENAI_DEVICE_TIMEOUT_MS,
    nextPollAt: now + intervalMs,
  };
}

export function getPublicDeviceAuthorization(pending, now = Date.now()) {
  if (!pending?.deviceAuthId || !pending?.userCode) return null;
  return {
    userCode: pending.userCode,
    verificationUrl: OPENAI_DEVICE_URL,
    intervalMs: pending.intervalMs,
    expiresAt: pending.expiresAt,
    retryAfterMs: Math.max(0, Number(pending.nextPollAt || 0) - now),
  };
}

function textContentParts(value) {
  if (typeof value === "string") {
    return value ? [{ type: "input_text", text: value }] : [];
  }
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const part of value) {
    if (part?.type === "text" && typeof part.text === "string") {
      output.push({ type: "input_text", text: part.text });
      continue;
    }
    if (part?.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof imageUrl === "string" && imageUrl.startsWith("data:image/")) {
        output.push({ type: "input_image", image_url: imageUrl, detail: "auto" });
        continue;
      }
      throw new Error("OpenAI subscription mode only accepts local image attachments.");
    }
    if (part?.type === "file" || part?.type === "input_audio" || part?.type === "video_url") {
      throw new Error("OpenAI subscription mode currently supports text and images only.");
    }
  }
  return output;
}

function replayOpenAIResponseItems(items) {
  const replay = [];
  const callIds = new Set();
  let hasAssistantText = false;

  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type === "reasoning") {
      if (typeof item.encrypted_content !== "string") continue;
      const summary = [];
      for (const part of Array.isArray(item.summary) ? item.summary : []) {
        if (typeof part?.text === "string") {
          summary.push({ type: "summary_text", text: part.text });
        }
      }
      replay.push({
        type: "reasoning",
        summary,
        encrypted_content: item.encrypted_content,
      });
      continue;
    }

    if (item?.type === "message" || item?.role === "assistant") {
      const content = [];
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "output_text", text: part.text });
        } else if (part?.type === "refusal" && typeof part.refusal === "string") {
          content.push({ type: "output_text", text: part.refusal });
        }
      }
      if (content.length) {
        const phase = ["commentary", "final_answer"].includes(item.phase) ? item.phase : "";
        replay.push({ role: "assistant", content, ...(phase ? { phase } : {}) });
        hasAssistantText = true;
      }
      continue;
    }

    if (item?.type === "function_call") {
      const callId = String(item.call_id || "");
      const name = String(item.name || "");
      if (!callId || !name) continue;
      callIds.add(callId);
      replay.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: String(item.arguments || "{}"),
      });
    }
  }

  return { replay, callIds, hasAssistantText };
}

function appendAssistantToolCalls(input, toolCalls, seenCallIds = new Set()) {
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = String(toolCall?.function?.name || "");
    const callId = String(toolCall?.id || "");
    if (!name || !callId || seenCallIds.has(callId)) continue;
    seenCallIds.add(callId);
    input.push({
      type: "function_call",
      call_id: callId,
      name,
      arguments: String(toolCall.function?.arguments || "{}"),
    });
  }
}

function appendMessageInput(input, message) {
  if (message?.role === "user") {
    const content = textContentParts(message.content);
    if (content.length) input.push({ role: "user", content });
    return;
  }

  if (message?.role === "assistant") {
    const replayed = replayOpenAIResponseItems(message.openai_response_items);
    input.push(...replayed.replay);
    if (!replayed.hasAssistantText && typeof message.content === "string" && message.content) {
      input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
    }
    appendAssistantToolCalls(input, message.tool_calls, replayed.callIds);
    return;
  }

  if (message?.role === "tool" && message.tool_call_id) {
    input.push({
      type: "function_call_output",
      call_id: String(message.tool_call_id),
      output: String(message.content || ""),
    });
  }
}

function normalizeTools(tools) {
  const output = [];
  const seen = new Set();
  for (const entry of Array.isArray(tools) ? tools : []) {
    const fn = entry?.type === "function" ? entry.function : null;
    const name = String(fn?.name || "");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    output.push({
      type: "function",
      name,
      description: String(fn.description || name).slice(0, 1024),
      parameters: fn.parameters && typeof fn.parameters === "object"
        ? fn.parameters
        : { type: "object", properties: {} },
      strict: false,
    });
  }
  return output;
}

export function buildOpenAIResponsesRequest(requestBody) {
  const model = String(requestBody?.model || "").trim();
  if (!/^gpt-[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(model)) {
    throw new Error("Select a valid OpenAI subscription model.");
  }

  const input = [];
  const instructions = [];
  for (const message of Array.isArray(requestBody?.messages) ? requestBody.messages : []) {
    if (message?.role === "system" || message?.role === "developer") {
      if (typeof message.content === "string" && message.content.trim()) instructions.push(message.content.trim());
      continue;
    }
    appendMessageInput(input, message);
  }
  if (!input.length) throw new Error("The OpenAI request has no conversation input.");

  const tools = normalizeTools(requestBody?.tools);
  const request = {
    model,
    input,
    store: false,
    stream: true,
  };
  if (instructions.length) request.instructions = instructions.join("\n\n");
  if (tools.length) {
    request.tools = tools;
    request.tool_choice = "auto";
    request.parallel_tool_calls = true;
  }

  const effort = String(requestBody?.reasoning?.effort || "");
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    request.reasoning = { effort, summary: "auto" };
  }
  request.include = ["reasoning.encrypted_content"];
  return request;
}

export function parseSseEvents(text) {
  const events = [];
  const frames = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n+/);
  for (const frame of frames) {
    let eventName = "";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (eventName && !parsed.type) parsed.type = eventName;
      events.push(parsed);
    } catch {
      throw new Error("OpenAI returned a malformed streaming response.");
    }
  }
  return events;
}

function responseError(payload) {
  return payload?.error?.message || payload?.response?.error?.message || payload?.message || "OpenAI could not complete the response.";
}

function incompleteResponseError(payload) {
  const response = payload?.response || payload;
  const reason = response?.incomplete_details?.reason;
  return reason ? `OpenAI response was incomplete: ${reason}` : responseError(payload);
}

function streamIndex(value) {
  if (value === null || value === undefined || value === "") return null;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < 10000 ? index : null;
}

function streamOutputState(outputs, event) {
  const outputIndex = streamIndex(event?.output_index);
  if (outputIndex === null) return null;
  if (!outputs.has(outputIndex)) {
    outputs.set(outputIndex, {
      item: null,
      text: new Map(),
      refusal: new Map(),
      arguments: "",
      argumentsDone: false,
      summary: new Map(),
      endTurn: null,
    });
  }
  return outputs.get(outputIndex);
}

function appendStreamValue(values, index, value) {
  if (index === null || typeof value !== "string") return;
  values.set(index, `${values.get(index) || ""}${value}`);
}

function setStreamValue(values, index, value) {
  if (index === null || typeof value !== "string") return;
  values.set(index, value);
}

function collectOpenAIStreamOutput(events) {
  const outputs = new Map();
  for (const event of events) {
    const state = streamOutputState(outputs, event);
    if (!state) continue;
    const contentIndex = streamIndex(event.content_index);
    const summaryIndex = streamIndex(event.summary_index);

    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      if (event.item && typeof event.item === "object") state.item = structuredClone(event.item);
      if (typeof event.end_turn === "boolean") state.endTurn = event.end_turn;
      if (typeof event.item?.end_turn === "boolean") state.endTurn = event.item.end_turn;
      continue;
    }
    if (event.type === "response.content_part.added" || event.type === "response.content_part.done") {
      const part = event.part;
      if (part?.type === "output_text") setStreamValue(state.text, contentIndex, part.text);
      if (part?.type === "refusal") setStreamValue(state.refusal, contentIndex, part.refusal);
      continue;
    }
    if (event.type === "response.output_text.delta") {
      appendStreamValue(state.text, contentIndex, event.delta);
      continue;
    }
    if (event.type === "response.output_text.done") {
      setStreamValue(state.text, contentIndex, event.text);
      continue;
    }
    if (event.type === "response.refusal.delta") {
      appendStreamValue(state.refusal, contentIndex, event.delta);
      continue;
    }
    if (event.type === "response.refusal.done") {
      setStreamValue(state.refusal, contentIndex, event.refusal);
      continue;
    }
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      state.arguments += event.delta;
      continue;
    }
    if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
      state.arguments = event.arguments;
      state.argumentsDone = true;
      continue;
    }
    if (event.type === "response.reasoning_summary_part.added" || event.type === "response.reasoning_summary_part.done") {
      setStreamValue(state.summary, summaryIndex, event.part?.text);
      continue;
    }
    if (event.type === "response.reasoning_summary_text.delta") {
      appendStreamValue(state.summary, summaryIndex, event.delta);
      continue;
    }
    if (event.type === "response.reasoning_summary_text.done") {
      setStreamValue(state.summary, summaryIndex, event.text);
    }
  }
  return outputs;
}

function mergeIndexedParts(primary, fallback) {
  const merged = [];
  const primaryParts = Array.isArray(primary) ? primary : [];
  const fallbackParts = Array.isArray(fallback) ? fallback : [];
  const length = Math.max(primaryParts.length, fallbackParts.length);
  for (let index = 0; index < length; index += 1) {
    merged[index] = primaryParts[index] || fallbackParts[index] || null;
  }
  return merged.map((part) => part ? structuredClone(part) : null);
}

function setMessageStreamPart(content, index, type, field, value) {
  if (typeof value !== "string") return;
  const existing = content[index];
  if (existing?.type === type && typeof existing[field] === "string" && existing[field]) return;
  if (!existing || existing.type === type) {
    content[index] = { ...(existing || {}), type, [field]: value };
    return;
  }
  content.push({ type, [field]: value });
}

function mergeStreamItem(terminalItem, state) {
  const streamedItem = state?.item && typeof state.item === "object" ? state.item : null;
  let item = terminalItem && typeof terminalItem === "object"
    ? { ...(streamedItem ? structuredClone(streamedItem) : {}), ...structuredClone(terminalItem) }
    : streamedItem ? structuredClone(streamedItem) : null;

  if (!item && (state?.text.size || state?.refusal.size)) {
    item = { type: "message", role: "assistant", content: [] };
  } else if (!item && state?.summary.size) {
    item = { type: "reasoning", summary: [] };
  }
  if (!item) return null;
  if (typeof item.end_turn !== "boolean" && typeof state?.endTurn === "boolean") {
    item.end_turn = state.endTurn;
  }

  if (item.type === "message") {
    const terminalContent = Array.isArray(terminalItem?.content) ? terminalItem.content : [];
    const streamedContent = Array.isArray(streamedItem?.content) ? streamedItem.content : [];
    const content = mergeIndexedParts(terminalContent, streamedContent);
    for (const [index, value] of state?.text || []) {
      setMessageStreamPart(content, index, "output_text", "text", value);
    }
    for (const [index, value] of state?.refusal || []) {
      setMessageStreamPart(content, index, "refusal", "refusal", value);
    }
    item.content = content.filter(Boolean);
  }

  if (item.type === "function_call") {
    const terminalArguments = typeof terminalItem?.arguments === "string" ? terminalItem.arguments : "";
    const streamedArguments = typeof streamedItem?.arguments === "string" ? streamedItem.arguments : "";
    if (terminalArguments) item.arguments = terminalArguments;
    else if (state?.argumentsDone) item.arguments = state.arguments;
    else if (streamedArguments) item.arguments = streamedArguments;
    else if (state?.arguments) item.arguments = state.arguments;
  }

  if (item.type === "reasoning") {
    const terminalSummary = Array.isArray(terminalItem?.summary) ? terminalItem.summary : [];
    const streamedSummary = Array.isArray(streamedItem?.summary) ? streamedItem.summary : [];
    const summary = mergeIndexedParts(terminalSummary, streamedSummary);
    for (const [index, value] of state?.summary || []) {
      const existing = summary[index];
      if (!existing?.text) summary[index] = { ...(existing || {}), type: "summary_text", text: value };
    }
    item.summary = summary.filter(Boolean);
  }

  return item;
}

function mergeOpenAIStreamResponse(response, events) {
  const terminalOutput = Array.isArray(response?.output) ? response.output : [];
  const streamedOutput = collectOpenAIStreamOutput(events);
  const indices = new Set(terminalOutput.map((_, index) => index));
  for (const index of streamedOutput.keys()) indices.add(index);
  const output = [];
  for (const index of [...indices].sort((left, right) => left - right)) {
    const item = mergeStreamItem(terminalOutput[index], streamedOutput.get(index));
    if (item) output.push(item);
  }
  return { ...response, output };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.total_tokens) || promptTokens + completionTokens,
  };
}

export function normalizeOpenAIResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("OpenAI returned an empty response.");
  }
  if (response.status === "failed" || response.error) throw new Error(responseError(response));
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    throw new Error(reason ? `OpenAI response was incomplete: ${reason}` : "OpenAI response was incomplete.");
  }

  const outputItems = Array.isArray(response.output) ? response.output : [];
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  for (const item of outputItems) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && typeof part.text === "string") textParts.push(part.text);
        if ((part?.type === "refusal" || part?.type === "output_text") && typeof part.refusal === "string") {
          textParts.push(part.refusal);
        }
      }
    }
    if (item?.type === "reasoning") {
      for (const summary of Array.isArray(item.summary) ? item.summary : []) {
        if (typeof summary?.text === "string") reasoningParts.push(summary.text);
      }
    }
    if (item?.type === "function_call") {
      const callId = String(item.call_id || "");
      const name = String(item.name || "");
      if (callId && name) {
        toolCalls.push({
          id: callId,
          type: "function",
          function: { name, arguments: String(item.arguments || "{}") },
        });
      }
    }
  }

  if (!textParts.length && typeof response.output_text === "string" && response.output_text) {
    textParts.push(response.output_text);
  }

  const openAIContinue = response.end_turn === false || outputItems.some((item) => item?.end_turn === false);
  const outputTypes = [...new Set(outputItems.map((item) => String(item?.type || "")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 64))
    .filter(Boolean))]
    .slice(0, 32);
  const responseStatus = String(response.status || "")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 64);

  return {
    choices: [{
      message: {
        role: "assistant",
        content: textParts.join(""),
        tool_calls: toolCalls,
        reasoning: reasoningParts.join("\n\n"),
        openai_response_items: replayOpenAIResponseItems(outputItems).replay,
        openai_continue: openAIContinue,
        openai_output_types: outputTypes,
        openai_response_status: responseStatus,
      },
    }],
    usage: normalizeUsage(response.usage),
  };
}

export function parseOpenAIResponseBody(body, contentType = "") {
  const text = String(body || "");
  if (String(contentType).toLowerCase().includes("text/event-stream") || /^\s*(?:event:|data:)/.test(text)) {
    const events = parseSseEvents(text);
    let completed = null;
    let completedEvent = null;
    for (const event of events) {
      if (event.type === "response.failed" || event.type === "error") throw new Error(responseError(event));
      if (event.type === "response.incomplete") throw new Error(incompleteResponseError(event));
      if (event.type === "response.completed") {
        completed = event.response || event;
        completedEvent = event;
      }
    }
    if (!completed) throw new Error("OpenAI closed the response stream before completion.");
    const merged = mergeOpenAIStreamResponse(completed, events);
    if (typeof merged.end_turn !== "boolean" && typeof completedEvent?.end_turn === "boolean") {
      merged.end_turn = completedEvent.end_turn;
    }
    return normalizeOpenAIResponse(merged);
  }

  try {
    return normalizeOpenAIResponse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("OpenAI returned an unreadable response.");
    throw error;
  }
}

export function sanitizeOpenAIErrorBody(body) {
  const text = String(body || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.message || "").slice(0, 500);
  } catch {
    return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").slice(0, 500);
  }
}
