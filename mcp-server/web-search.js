// Web search (Tavily) tool definitions for the MCP server.
//
// Unlike temp-email, these tools are NOT executed here: the calls are forwarded
// over the bridge to the extension, which runs the search with the Tavily API
// key it already holds. This module only owns the tool schemas and a visibility
// gate driven by the extension's `feature-flags/set` message — so the tools
// appear to MCP clients only when web search is enabled and keyed in settings.

const state = {
  enabled: false
};

export function setWebSearchEnabled(enabled) {
  const prev = state.enabled;
  state.enabled = enabled === true;
  return { changed: prev !== state.enabled };
}

export function isWebSearchEnabled() {
  return state.enabled === true;
}

export const WEB_SEARCH_TOOLS = [
  {
    name: "search_web",
    description:
      "Search the live web using the extension's configured Tavily account. Returns compact cited results with titles, URLs, snippets, scores, and optional answer text. Use this when current or external information is needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "number", description: "Maximum results to return. Defaults to the configured setting." },
        topic: { type: "string", enum: ["general", "news"], description: "Search topic. Use news for current events; defaults to general." },
        search_depth: { type: "string", enum: ["basic", "advanced"], description: "Provider search depth. Advanced may cost more credits." },
        site: { type: "string", description: "Optional domain to restrict results to, e.g. irs.gov." },
        include_answer: { type: "boolean", description: "Ask the provider for a concise generated answer when supported." }
      },
      required: ["query"]
    }
  },
  {
    name: "fetch_search_result",
    description:
      "Extract clean readable content from a specific URL returned by search_web or supplied by the user. Returns title/URL/content when available and should be used before summarizing a source in detail.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to extract." },
        extract_depth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth. Advanced may cost more credits." },
        format: { type: "string", enum: ["markdown", "text"], description: "Preferred content format. Defaults to markdown." },
        max_chars: { type: "number", description: "Maximum content characters to return. Defaults to 20000." }
      },
      required: ["url"]
    }
  }
];

export const WEB_SEARCH_TOOL_NAMES = new Set(WEB_SEARCH_TOOLS.map((t) => t.name));
