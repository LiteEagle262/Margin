// Tools that proxy to the ScrapeFlow mail-server backend so an AI agent can
// generate disposable inboxes and read incoming verification emails.

const DEFAULT_TIMEOUT_MS = 60000;

// Runtime state. Defaults to env vars; the extension's WebSocket message
// `feature-flags/set` overrides these at runtime. `enabled` gates whether the
// tools appear in the MCP tool list at all; without it, the tools are hidden.
const state = {
  enabled: false,
  baseUrl: (process.env.SCRAPEFLOW_MAIL_API_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.SCRAPEFLOW_MAIL_API_KEY || ""
};

export function setTempEmailFlags({ enabled, apiUrl, apiKey } = {}) {
  const prev = state.enabled;
  if (typeof enabled === "boolean") state.enabled = enabled;
  if (typeof apiUrl === "string") state.baseUrl = apiUrl.trim().replace(/\/+$/, "");
  if (typeof apiKey === "string") state.apiKey = apiKey;
  return { changed: prev !== state.enabled };
}

export function isTempEmailEnabled() {
  return state.enabled === true;
}

function getConfig() {
  return { baseUrl: state.baseUrl, apiKey: state.apiKey };
}

function isConfigured() {
  const { baseUrl, apiKey } = getConfig();
  return Boolean(baseUrl && apiKey);
}

async function call(method, path, { body, query, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { baseUrl, apiKey } = getConfig();
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Temp email backend not configured. Set SCRAPEFLOW_MAIL_API_URL and SCRAPEFLOW_MAIL_API_KEY in the MCP server env."
    );
  }

  const url = new URL(baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    const detail = payload?.detail || payload?.error || res.statusText;
    throw new Error(`Mail backend ${res.status}: ${detail}`);
  }
  return payload;
}

export const TEMP_EMAIL_TOOLS = [
  {
    name: "create_temp_email",
    description:
      "Create a disposable email inbox on the ScrapeFlow mail backend. Returns an inbox id and an email address (e.g. r3kf91md@yourdomain.com) that you can paste into signup forms. The inbox receives mail until it expires.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Optional human-friendly label for this inbox (e.g. 'github signup test')." },
        local_part: { type: "string", description: "Optional explicit local part. Defaults to a random one. Must be 3-40 chars of [a-z0-9._-]." },
        ttl_ms: { type: "number", description: "Optional time-to-live in milliseconds. Capped server-side." }
      }
    }
  },
  {
    name: "get_temp_email_inbox",
    description:
      "List messages received by a temp email inbox. Returns metadata, extracted verification codes and links per message. Use `wait_for_email` instead if the inbox is currently empty and you are waiting for a verification mail.",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string", description: "Inbox id returned by create_temp_email." },
        since_ms: { type: "number", description: "Only return messages received after this Unix epoch (ms)." },
        limit: { type: "number", description: "Max number of messages to return (default 50, max 200)." }
      },
      required: ["inbox_id"]
    }
  },
  {
    name: "get_temp_email_message",
    description:
      "Fetch the full body (text and HTML) of a single received email by inbox id and message id.",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string" },
        message_id: { type: "string" }
      },
      required: ["inbox_id", "message_id"]
    }
  },
  {
    name: "wait_for_email",
    description:
      "Long-poll the mail backend until a new message arrives in the inbox or the timeout elapses. Returns the first message received after `since_ms`, plus the extracted verification codes and links. Ideal for waiting on signup verification emails.",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string" },
        since_ms: { type: "number", description: "Only consider messages received after this Unix epoch (ms). Defaults to 0 — i.e. return any existing or future message." },
        timeout_ms: { type: "number", description: "Maximum time to wait in milliseconds. Defaults to 30000, capped at 120000." }
      },
      required: ["inbox_id"]
    }
  },
  {
    name: "delete_temp_email",
    description:
      "Delete a temp inbox and all its messages. Use when a test run is complete to keep the backend clean.",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string" }
      },
      required: ["inbox_id"]
    }
  }
];

export const TEMP_EMAIL_TOOL_NAMES = new Set(TEMP_EMAIL_TOOLS.map((t) => t.name));

export async function callTempEmailTool(name, args = {}) {
  if (!isTempEmailEnabled()) {
    return errorResult(
      "Temp email tools are disabled. Enable them in the ScrapeFlow extension settings (Temp Email Backend section)."
    );
  }
  if (!isConfigured()) {
    return errorResult(
      "Temp email backend not configured. Enter the mail server URL and API key in the ScrapeFlow extension settings, or set SCRAPEFLOW_MAIL_API_URL and SCRAPEFLOW_MAIL_API_KEY env vars on the MCP server."
    );
  }

  try {
    switch (name) {
      case "create_temp_email": {
        const inbox = await call("POST", "/api/inboxes", {
          body: {
            label: args.label,
            local_part: args.local_part,
            ttl_ms: args.ttl_ms
          }
        });
        return textResult({
          inbox_id: inbox.id,
          address: inbox.address,
          label: inbox.label,
          expires_at: inbox.expires_at,
          note: "Use this address in signup forms, then call wait_for_email with this inbox_id."
        });
      }

      case "get_temp_email_inbox": {
        const payload = await call("GET", `/api/inboxes/${encodeURIComponent(args.inbox_id)}/messages`, {
          query: { since_ms: args.since_ms, limit: args.limit }
        });
        return textResult(payload);
      }

      case "get_temp_email_message": {
        const msg = await call(
          "GET",
          `/api/inboxes/${encodeURIComponent(args.inbox_id)}/messages/${encodeURIComponent(args.message_id)}`
        );
        return textResult(msg);
      }

      case "wait_for_email": {
        const timeoutMs = Math.min(Number(args.timeout_ms || 30000) || 30000, 120000);
        const payload = await call(
          "GET",
          `/api/inboxes/${encodeURIComponent(args.inbox_id)}/wait`,
          {
            query: { since_ms: args.since_ms, timeout_ms: timeoutMs },
            timeoutMs: timeoutMs + 5000
          }
        );
        if (!payload.message) {
          return textResult({
            message: null,
            waited_ms: payload.waited_ms,
            note: "No mail arrived before the timeout elapsed. Try waiting again or check the sender side."
          });
        }
        return textResult(payload);
      }

      case "delete_temp_email": {
        await call("DELETE", `/api/inboxes/${encodeURIComponent(args.inbox_id)}`);
        return textResult({ ok: true, inbox_id: args.inbox_id });
      }

      default:
        return errorResult(`Unknown temp email tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message || String(err));
  }
}

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: false
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}
