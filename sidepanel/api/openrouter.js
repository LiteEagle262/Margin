import { formatUsdBalance } from "../lib/format.js";

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

export async function fetchChatCompletion(
  apiKey,
  requestBody,
  { signal = undefined, appTitle = "Margin" } = {},
) {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(apiKey, appTitle, true),
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  // OpenRouter reports rate limits and moderation refusals in the body of a 200.
  if (data?.error) {
    const detail = typeof data.error === "string"
      ? data.error
      : data.error.message || JSON.stringify(data.error);
    const code = typeof data.error === "object" && data.error.code ? ` (${data.error.code})` : "";
    throw new Error(`OpenRouter Error${code}: ${detail}`);
  }
  return data;
}
