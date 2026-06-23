// sidepanel/api/openrouter.js - OpenRouter HTTP client.
// Pure network functions: take explicit params, throw on HTTP errors,
// no DOM access, no app state.

import { formatUsdBalance } from "../lib/format.js";

const API_BASE = "https://openrouter.ai/api/v1";

function buildHeaders(apiKey, appTitle = "N/A", json = false) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://github.com/NA",
    "X-Title": appTitle,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

// Returns text-output models sorted by display name.
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
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

// Returns "" when the model id has no author/slug form.
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
  const response = await fetch(modelEndpointsUrl(modelId), {
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

// Returns { ok: true, totalCredits, totalUsage, balance } on success or
// { ok: false, status, errorText } when the credits endpoint rejects.
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

// Fallback balance source for keys without credits access.
// Returns { label, title } for the badge, or null when unavailable.
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
  { signal = undefined, appTitle = "N/A" } = {},
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

  return await response.json();
}
