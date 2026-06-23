// sidepanel/api/tavily.js - Web search tools (Tavily provider).
// Callers pass the raw settings.webSearch object; normalization happens here.
// No DOM access, no app state.

export const WEB_SEARCH_TOOL_NAMES = new Set(["search_web", "fetch_search_result"]);

export function normalizeWebSearchSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const provider = String(value.provider || "tavily").toLowerCase();
  const depth = value.searchDepth === "advanced" ? "advanced" : "basic";
  const maxResults = Math.min(Math.max(Number(value.maxResults) || 5, 1), 10);
  return {
    enabled: value.enabled === true,
    provider: ["tavily", "brave"].includes(provider) ? provider : "tavily",
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    searchDepth: depth,
    maxResults,
    includeAnswer: value.includeAnswer === true
  };
}

export function isWebSearchAvailable(rawConfig) {
  const config = normalizeWebSearchSettings(rawConfig);
  return config.enabled === true && Boolean(config.apiKey) && Boolean(WEB_SEARCH_PROVIDER_ADAPTERS[config.provider]);
}

function createWebSearchError(message, extra = {}) {
  return {
    ok: false,
    tool: "web_search",
    error_code: "web_search_error",
    recoverable: true,
    message,
    ...extra
  };
}

function clampInteger(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.floor(num), min), max);
}

function normalizeSearchDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/^www\./, "")
      .trim();
  }
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n[Truncated: ${text.length - maxChars} additional characters omitted]`;
}

async function tavilyRequest(endpoint, body, apiKey) {
  const response = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
  }

  if (!response.ok) {
    const detail = payload?.detail || payload?.error || payload?.message || raw || response.statusText;
    throw new Error(`Tavily ${endpoint} failed (${response.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }

  return payload || {};
}

const WEB_SEARCH_PROVIDER_ADAPTERS = {
  tavily: {
    async search(args, config) {
      const query = String(args.query || "").trim();
      if (!query) return createWebSearchError("search_web requires query.", { tool: "search_web" });

      const maxResults = clampInteger(args.limit, config.maxResults, 1, 10);
      const depth = args.search_depth === "advanced" ? "advanced" : config.searchDepth;
      const topic = args.topic === "news" ? "news" : "general";
      const site = normalizeSearchDomain(args.site);
      const includeAnswer = args.include_answer === true || (args.include_answer !== false && config.includeAnswer === true);

      const payload = {
        query,
        topic,
        search_depth: depth,
        max_results: maxResults,
        include_answer: includeAnswer,
        include_raw_content: false,
        include_images: false
      };
      if (site) payload.include_domains = [site];

      const data = await tavilyRequest("search", payload, config.apiKey);
      return {
        ok: true,
        provider: "tavily",
        tool: "search_web",
        query: data.query || query,
        answer: data.answer || "",
        results: (data.results || []).slice(0, maxResults).map((item, index) => ({
          rank: index + 1,
          title: item.title || "",
          url: item.url || "",
          content: item.content || "",
          score: typeof item.score === "number" ? item.score : null,
          published_date: item.published_date || null
        })),
        response_time: data.response_time || null,
        request_id: data.request_id || null,
        next_actions: [
          {
            tool: "fetch_search_result",
            reason: "Extract the full readable source before detailed summarization or quoting."
          }
        ]
      };
    },

    async fetchResult(args, config) {
      const url = String(args.url || "").trim();
      if (!url) return createWebSearchError("fetch_search_result requires url.", { tool: "fetch_search_result" });

      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return createWebSearchError("fetch_search_result requires a valid absolute URL.", { tool: "fetch_search_result" });
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        return createWebSearchError("fetch_search_result only supports http and https URLs.", { tool: "fetch_search_result" });
      }

      const maxChars = clampInteger(args.max_chars, 20000, 1000, 60000);
      const data = await tavilyRequest("extract", {
        urls: url,
        extract_depth: args.extract_depth === "advanced" ? "advanced" : "basic",
        format: args.format === "text" ? "text" : "markdown",
        include_images: false,
        include_favicon: false
      }, config.apiKey);

      const result = Array.isArray(data.results) ? data.results[0] : null;
      const failed = Array.isArray(data.failed_results) ? data.failed_results[0] : null;
      if (!result?.raw_content) {
        return createWebSearchError("Tavily could not extract readable content for this URL.", {
          tool: "fetch_search_result",
          url,
          failed_result: failed || null,
          request_id: data.request_id || null
        });
      }

      return {
        ok: true,
        provider: "tavily",
        tool: "fetch_search_result",
        url: result.url || url,
        title: result.title || "",
        content: truncateText(result.raw_content, maxChars),
        content_chars: String(result.raw_content || "").length,
        truncated: String(result.raw_content || "").length > maxChars,
        response_time: data.response_time || null,
        request_id: data.request_id || null
      };
    }
  }
};

export async function executeWebSearchTool(name, args = {}, rawConfig = {}) {
  const config = normalizeWebSearchSettings(rawConfig);
  if (!config.enabled) {
    return createWebSearchError("Web search is disabled in settings.", { tool: name, recoverable: false });
  }
  if (!config.apiKey) {
    return createWebSearchError("Web search needs a Tavily API key in settings.", { tool: name, recoverable: false });
  }

  const adapter = WEB_SEARCH_PROVIDER_ADAPTERS[config.provider];
  if (!adapter) {
    return createWebSearchError(`Unsupported web search provider "${config.provider}".`, { tool: name, recoverable: false });
  }

  try {
    if (name === "search_web") return await adapter.search(args, config);
    if (name === "fetch_search_result") return await adapter.fetchResult(args, config);
    return createWebSearchError(`Unknown web search tool "${name}".`, { tool: name, recoverable: false });
  } catch (err) {
    return createWebSearchError(err.message || String(err), { tool: name });
  }
}
