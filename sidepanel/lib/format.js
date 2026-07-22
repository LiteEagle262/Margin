export function approxTokens(text) {
  if (text === undefined || text === null) return 0;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  return Math.ceil(s.length / 4);
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatCost(usd) {
  if (!usd) return "0.0000";
  if (usd < 0.01) return usd.toFixed(4);
  if (usd < 1) return usd.toFixed(3);
  return usd.toFixed(2);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function formatUsdBalance(value) {
  if (!Number.isFinite(value)) return "--";
  const absValue = Math.abs(value);
  const digits = absValue < 1 ? 4 : 2;
  return `${value < 0 ? "-" : ""}$${absValue.toFixed(digits)}`;
}

export function formatModelPrice(pricing) {
  if (!pricing) return "";
  const prompt = pricing.prompt ? `$${(Number(pricing.prompt) * 1_000_000).toFixed(2)}/M in` : "";
  const completion = pricing.completion ? `$${(Number(pricing.completion) * 1_000_000).toFixed(2)}/M out` : "";
  return [prompt, completion].filter(Boolean).join(" · ");
}

export function formatEndpointPrice(pricing) {
  if (!pricing) return "n/a";
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  const inPrice = Number.isFinite(prompt) ? `$${(prompt * 1_000_000).toFixed(2)} in` : "";
  const outPrice = Number.isFinite(completion) ? `$${(completion * 1_000_000).toFixed(2)} out` : "";
  return [inPrice, outPrice].filter(Boolean).join(" / ") || "n/a";
}

export function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number >= 99 ? 1 : 0)}%` : "n/a";
}

export function formatLatency(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(number < 10 ? 2 : 1)}s` : "n/a";
}

export function formatThroughput(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)} tok/s` : "n/a";
}

export function endpointFeatureSummary(endpoint) {
  const parts = [
    endpoint.quantization || "",
    endpoint.context_length ? `${Math.round(Number(endpoint.context_length) / 1000)}k ctx` : "",
    endpoint.max_completion_tokens ? `${Math.round(Number(endpoint.max_completion_tokens) / 1000)}k max out` : "",
    endpoint.supports_implicit_caching ? "cache" : "",
    Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes("tools") ? "tools" : ""
  ].filter(Boolean);
  return parts.join(" / ") || "standard";
}

export function prettyPrint(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value || "");
  return template.content.textContent || "";
}
