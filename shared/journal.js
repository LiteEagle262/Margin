// Compact audit journal for tool executions. Pure module — no chrome globals —
// so it stays unit-testable.

export const MAX_JOURNAL_ENTRIES = 300;

// Only these argument values are safe to record verbatim. Every other field is
// recorded as its length only — fill_element args carry passwords and
// get_authenticator_code results carry codes, so values must never be stored.
const ARG_KEY_ALLOWLIST = new Set([
  "url", "uid", "selector", "method", "direction", "type", "key", "path", "name", "query"
]);

const MAX_ARG_VALUE_CHARS = 200;

function valueLength(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return String(value).length;
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    if (ARG_KEY_ALLOWLIST.has(key) && (value === null || typeof value !== "object")) {
      summary[key] = typeof value === "string" && value.length > MAX_ARG_VALUE_CHARS
        ? value.slice(0, MAX_ARG_VALUE_CHARS)
        : value;
    } else {
      summary[`${key}_len`] = valueLength(value);
    }
  }
  return summary;
}

export function buildJournalEntry({ ts, surface, tool, host, args, outcome }) {
  return {
    ts: Number(ts) || 0,
    surface: String(surface || ""),
    tool: String(tool || ""),
    host: String(host || ""),
    args: summarizeArgs(args),
    outcome: String(outcome || "")
  };
}

export function appendJournalEntry(list, entry) {
  const next = Array.isArray(list) ? [...list, entry] : [entry];
  return next.length > MAX_JOURNAL_ENTRIES
    ? next.slice(next.length - MAX_JOURNAL_ENTRIES)
    : next;
}
