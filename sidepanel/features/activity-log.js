// The tool activity journal is written by the background service worker on
// every tool execution (panel and MCP bridge alike). This module only reads it
// out for the user — it lives with the other exports rather than under network
// capture, which records a different thing for a different reason.

import { downloadTextFile } from "../lib/download.js";
import { showToast } from "../lib/toast.js";

const TOOL_JOURNAL_KEY = "toolJournal";

export async function downloadToolJournal() {
  try {
    const stored = await chrome.storage.local.get(TOOL_JOURNAL_KEY);
    const entries = Array.isArray(stored[TOOL_JOURNAL_KEY]) ? stored[TOOL_JOURNAL_KEY] : [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadTextFile(
      `margin-activity-log-${stamp}.json`,
      JSON.stringify(entries, null, 2),
      "application/json;charset=utf-8"
    );
  } catch (err) {
    console.error("Could not download activity log:", err);
    showToast("Could not download activity log: " + (err.message || "unknown error"));
  }
}

export async function clearToolJournal() {
  try {
    await chrome.storage.local.set({ [TOOL_JOURNAL_KEY]: [] });
    showToast("Activity log cleared.");
  } catch (err) {
    console.error("Could not clear activity log:", err);
    showToast("Could not clear activity log: " + (err.message || "unknown error"));
  }
}
