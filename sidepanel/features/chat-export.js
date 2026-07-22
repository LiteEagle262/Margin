import { settings, chats, currentChatId, globalWorkspace, setCurrentChatId } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { approxTokens, formatTokens, formatCost, formatBytes, prettyPrint } from "../lib/format.js";
import { downloadTextFile } from "../lib/download.js";
import { showToast } from "../lib/toast.js";
import { buildProviderPreferences } from "../settings/sections/provider-routing.js";
import { buildReasoningPreferences } from "../settings/sections/reasoning.js";
import { fetchProviderChatCompletion, getProviderLabel } from "../api/provider.js";
import { getAttachmentKind, getActiveModelInfo, CONTEXT_PACKING } from "../agent/context.js";
import { computeContextBreakdown, recordUsage } from "../ui/usage-bar.js";
import { renderChatHistory } from "../ui/chat-view.js";
import { renderHistoryList } from "../ui/history-drawer.js";
import { switchView } from "../ui/navigation.js";
import { saveGlobalWorkspace } from "./workspace.js";
import { isSafeRecordKey, isSafeVirtualPath } from "../lib/safe-record.js";

const EXPORT_TOOL_FULL_RESULT_LIMIT = 12000;
const EXPORT_TOOL_SUMMARY_LIMIT = 900;
const EXPORT_SUMMARY_TOOL_RESULT_LIMIT = 24000;
const EXPORT_FULL_TOOL_NAMES = new Set([
  "write_file", "read_file", "get_file_info", "read_context_item",
  "list_files", "search_files"
]);
const EXPORT_NOISY_TOOL_NAMES = new Set([
  "get_dom", "take_snapshot", "take_screenshot", "get_network_logs",
  "get_network_log_detail", "start_network_capture", "stop_network_capture"
]);

function formatExportDate(value) {
  if (!value) return "unknown";
  try {
    return new Date(value).toISOString();
  } catch {
    return "unknown";
  }
}

function escapeMarkdownText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function truncateForExport(value, limit, label = "content") {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Truncated ${label}: ${text.length - limit} more character(s) preserved in raw JSON export.]`;
}

function markdownFence(value, language = "") {
  const text = String(value || "");
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${language}\n${text}\n${fence}`;
}


function describeExportAttachment(attachment, index) {
  const kind = attachment.kind || getAttachmentKind(attachment);
  const parts = [
    attachment.name || `attachment-${index + 1}`,
    kind,
    formatBytes(attachment.size || 0)
  ];
  if (attachment.mimeType) parts.push(attachment.mimeType);
  if (kind === "text" && typeof attachment.text === "string") {
    parts.push(`${formatTokens(approxTokens(attachment.text))} tokens text`);
  }
  return parts.filter(Boolean).join(", ");
}

function describeExportAttachments(msg) {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const legacyImages = Array.isArray(msg.images)
    ? msg.images.map((_, index) => ({ name: `screenshot-${index + 1}`, kind: "image", size: 0, mimeType: "image/*" }))
    : [];
  return [...attachments, ...legacyImages].map(describeExportAttachment);
}

function summarizeForOneLine(value, limit = EXPORT_TOOL_SUMMARY_LIMIT) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function normalizeToolCallArgs(toolCall) {
  try {
    return JSON.parse(toolCall?.function?.arguments || "{}");
  } catch {
    return toolCall?.function?.arguments || "";
  }
}

function buildToolActivityGroups(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const groups = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }

    const resultById = new Map();
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next?.role === "tool-status" || next?.role === "file-artifact") {
        j++;
        continue;
      }
      if (next?.role === "tool") {
        resultById.set(next.tool_call_id, next);
        j++;
        continue;
      }
      break;
    }

    groups.push({
      assistantContent: msg.content || "",
      calls: msg.tool_calls.map((toolCall) => {
        const name = toolCall?.function?.name || "unknown_tool";
        return {
          id: toolCall?.id || "",
          name,
          args: normalizeToolCallArgs(toolCall),
          result: resultById.get(toolCall?.id) || null
        };
      })
    });
  }

  return groups;
}

function shouldExportFullToolResult(toolName, resultText, indexFromEnd) {
  if (!resultText) return false;
  if (EXPORT_FULL_TOOL_NAMES.has(toolName)) return true;
  if (indexFromEnd < CONTEXT_PACKING.recentToolResultsInline && !EXPORT_NOISY_TOOL_NAMES.has(toolName)) return true;
  return resultText.length <= 2400 && !EXPORT_NOISY_TOOL_NAMES.has(toolName);
}

function formatToolResultForExport(call, indexFromEnd, full = false) {
  const resultText = String(call.result?.content || "");
  if (!resultText) return "No stored result.";
  if (full) {
    return truncateForExport(resultText, EXPORT_SUMMARY_TOOL_RESULT_LIMIT, `${call.name} result`);
  }
  if (shouldExportFullToolResult(call.name, resultText, indexFromEnd)) {
    return truncateForExport(resultText, EXPORT_TOOL_FULL_RESULT_LIMIT, `${call.name} result`);
  }
  return `Summary: ${summarizeForOneLine(resultText)}\nOriginal size: about ${formatTokens(approxTokens(resultText))} tokens. Full result is preserved in raw JSON export.`;
}

function buildCompactTranscriptMarkdown(chat, { full = false } = {}) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const lines = [];
  let visibleIndex = 0;

  messages.forEach((msg) => {
    if (!msg || msg.role === "tool" || msg.role === "tool-status" || msg.role === "file-artifact") return;
    if (msg.role !== "user" && msg.role !== "assistant") return;

    visibleIndex++;
    const label = msg.role === "user" ? "User" : "Assistant";
    lines.push(`### ${visibleIndex}. ${label}`);
    const content = escapeMarkdownText(msg.content || "");
    if (content) {
      lines.push(full ? content : truncateForExport(content, 6000, `${label.toLowerCase()} message`));
    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      lines.push("(assistant requested tool calls)");
    } else {
      lines.push("(empty message)");
    }

    const attachments = describeExportAttachments(msg);
    if (attachments.length > 0) {
      lines.push("");
      lines.push("Attachments:");
      attachments.forEach((attachment) => lines.push(`- ${attachment}`));
    }

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      lines.push("");
      lines.push("Requested tools:");
      msg.tool_calls.forEach((toolCall) => {
        const name = toolCall?.function?.name || "unknown_tool";
        lines.push(`- ${name}`);
      });
    }

    lines.push("");
  });

  return lines.join("\n").trim() || "No user or assistant messages.";
}

function buildToolActivityMarkdown(chat, { full = false } = {}) {
  const groups = buildToolActivityGroups(chat);
  if (groups.length === 0) return "No tool calls were stored for this chat.";

  const allCalls = groups.flatMap(group => group.calls);
  const callOrder = new Map(allCalls.map((call, index) => [call.id, index]));
  const lines = [];

  groups.forEach((group, groupIndex) => {
    lines.push(`### Tool Turn ${groupIndex + 1}`);
    if (group.assistantContent) {
      lines.push(`Assistant context: ${truncateForExport(group.assistantContent, 1200, "assistant tool-call context")}`);
    }

    group.calls.forEach((call) => {
      const order = callOrder.get(call.id) ?? 0;
      const indexFromEnd = allCalls.length - order - 1;
      lines.push("");
      lines.push(`#### ${call.name}`);
      lines.push("Arguments:");
      lines.push(markdownFence(prettyPrint(call.args), "json"));
      lines.push("Result:");
      lines.push(markdownFence(formatToolResultForExport(call, indexFromEnd, full)));
    });

    lines.push("");
  });

  return lines.join("\n").trim();
}

function buildWorkspaceMarkdown(chat) {
  const files = Object.values(chat?.files || {});
  if (files.length === 0) return "No workspace files are attached to this chat.";

  return files
    .sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")))
    .map((file) => {
      const lines = String(file.content || "").split("\n").length;
      const updated = formatExportDate(file.updatedAt);
      const desc = file.description ? ` - ${file.description}` : "";
      return `- ${file.path || "(unknown path)"} (${file.language || "text"}, ${lines} lines, updated ${updated})${desc}`;
    })
    .join("\n");
}

function buildSummaryInputForModel(chat) {
  const sections = [
    `Chat title: ${chat.title || "New Chat"}`,
    `Model: ${settings.model || "unknown"}`,
    "",
    "=== SOURCE MATERIAL TO MINE (numbering is for reference only — do NOT echo it back as turns) ===",
    "",
    "Conversation source:",
    buildCompactTranscriptMarkdown(chat, { full: true }),
    "",
    "Tool activity (arguments and full results):",
    buildToolActivityMarkdown(chat, { full: true }),
    "",
    "Workspace files:",
    buildWorkspaceMarkdown(chat)
  ];
  return sections.join("\n");
}

function computeSummaryMaxTokens(inputText) {
  const model = getActiveModelInfo();
  const window = Number(model.contextWindow) || 0;
  const inputTokens = approxTokens(inputText);
  const SYSTEM_OVERHEAD = 800;
  const SAFETY = 2000;
  const FLOOR = 1024;
  const CEILING = 16000;
  if (!window) return 8000;
  const available = window - inputTokens - SYSTEM_OVERHEAD - SAFETY;
  return Math.max(FLOOR, Math.min(CEILING, available));
}

async function generateAiHandoffSummary(chat) {
  if (settings.aiProvider === "openrouter" && !settings.apiKey) {
    throw new Error(`${getProviderLabel(settings.aiProvider)} key is not configured.`);
  }
  const activeModel = settings.model;
  if (!activeModel) {
    throw new Error("No AI model selected.");
  }

  const summaryInput = buildSummaryInputForModel(chat);
  const summaryInstructions = [
    "You write a COMPREHENSIVE handoff document so a fresh AI chat can continue this work seamlessly, with no access to the original conversation.",
    "CRITICAL: This is NOT a chat recap. Never narrate the conversation turn by turn. The input is numbered source material to mine for facts — do not echo those turns back. Organize your output by TOPIC under the required sections, never by message order. Skip pleasantries, retries, and back-and-forth.",
    "Do not attribute facts to turns or speakers. State each fact directly as standalone knowledge.",
    "Capture every essential realization and detail. Prefer completeness over brevity.",
    "Preserve verbatim any supplied or executed code, the user's explicit constraints, and concrete technical details such as URLs, payloads, IDs, selectors, and file paths.",
    "Organize as Markdown with these sections: ## Goal & Scope, ## User Requirements, ## Current State, ## Everything Learned, ## Code & Commands, ## Decisions & Rationale, ## Artifacts & Files, ## Dead Ends & What Failed, ## Blockers & Open Questions, ## Exact Next Steps.",
    "Do not invent facts. State uncertainty explicitly. Write so someone can resume from this document alone.",
  ].join(" ");

  const requestBody = {
    model: activeModel,
    messages: [
      {
        role: "system",
        content: summaryInstructions
      },
      {
        role: "user",
        content: summaryInput
      }
    ],
    temperature: 0.1,
    max_tokens: computeSummaryMaxTokens(summaryInput),
    usage: { include: true }
  };

  const providerPreferences = buildProviderPreferences();
  const reasoningPreferences = buildReasoningPreferences();
  if (providerPreferences) requestBody.provider = providerPreferences;
  if (reasoningPreferences) requestBody.reasoning = reasoningPreferences;

  const data = await fetchProviderChatCompletion(
    settings.aiProvider,
    settings.apiKey,
    requestBody,
    { appTitle: "Margin Chat Export", sessionId: `margin-export-${crypto.randomUUID()}` },
  );
  if (data.usage) {
    recordUsage(data.usage);
    await saveChats();
  }
  return data.choices?.[0]?.message?.content?.trim() || "No summary was returned.";
}

function buildRawChatExport(chat) {
  return {
    exportType: "margin-chat-raw",
    exportedAt: new Date().toISOString(),
    currentChatId,
    model: settings.model || "",
    chat
  };
}

function buildGlobalWorkspaceExport() {
  const files = Object.values(globalWorkspace || {});
  return {
    exportType: "margin-global-workspace",
    exportedAt: new Date().toISOString(),
    fileCount: files.length,
    files: globalWorkspace || {}
  };
}

export function exportGlobalWorkspace() {
  const files = Object.values(globalWorkspace || {});
  if (files.length === 0) {
    showToast("Global workspace is empty.");
    return;
  }

  const rawJson = JSON.stringify(buildGlobalWorkspaceExport(), null, 2);
  downloadTextFile("margin-global-workspace.json", rawJson, "application/json;charset=utf-8");
  showToast(`Exported ${files.length} workspace file${files.length === 1 ? "" : "s"}.`);
}

function makeUniqueImportedChatId(originalId) {
  const base = String(originalId || Date.now());
  if (isSafeRecordKey(base) && !chats[base]) return base;

  let candidate = `${Date.now()}`;
  while (chats[candidate]) {
    candidate = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }
  return candidate;
}

function normalizeImportedChat(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Import file is not a JSON object.");
  }
  if (raw.exportType !== "margin-chat-raw") {
    throw new Error("This is not a Margin raw chat export.");
  }
  const sourceChat = raw.chat;
  if (!sourceChat || typeof sourceChat !== "object") {
    throw new Error("Raw chat export is missing its chat payload.");
  }
  if (!Array.isArray(sourceChat.messages)) {
    throw new Error("Imported chat is missing a messages array.");
  }

  const id = makeUniqueImportedChatId(sourceChat.id);
  const title = String(sourceChat.title || "Imported Chat").trim() || "Imported Chat";
  const rawFiles = sourceChat.files && typeof sourceChat.files === "object" && !Array.isArray(sourceChat.files)
    ? sourceChat.files
    : {};
  const files = Object.fromEntries(
    Object.entries(rawFiles)
      .filter(([path, fileRecord]) => isSafeVirtualPath(path) && fileRecord && typeof fileRecord === "object")
      .map(([path, fileRecord]) => [path, { ...fileRecord, path: fileRecord.path || path, chatId: id }])
  );

  return {
    ...sourceChat,
    id,
    title,
    messages: sourceChat.messages,
    files,
    timestamp: Date.now(),
    importedAt: Date.now(),
    importedFrom: {
      exportedAt: raw.exportedAt || null,
      originalChatId: sourceChat.id || raw.currentChatId || null,
      model: raw.model || null
    }
  };
}

export async function importRawChatFile(file) {
  if (!file) return;

  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const importedChat = normalizeImportedChat(raw);

    chats[importedChat.id] = importedChat;
    setCurrentChatId(importedChat.id);

    Object.entries(importedChat.files || {}).forEach(([path, fileRecord]) => {
      if (!isSafeVirtualPath(path) || !fileRecord || typeof fileRecord !== "object") return;
      if (!globalWorkspace[path] || (fileRecord.updatedAt || 0) >= (globalWorkspace[path].updatedAt || 0)) {
        globalWorkspace[path] = { ...fileRecord, chatId: importedChat.id };
      }
    });

    await saveChats();
    await saveGlobalWorkspace();
    renderChatHistory();
    renderHistoryList();
    switchView("chat");
    showToast(`Imported "${importedChat.title}".`);
  } catch (err) {
    console.error("Could not import raw chat:", err);
    showToast("Could not import chat: " + (err.message || "invalid file"));
  }
}

function buildContextMarkdownExport(chat, handoffSummary, summaryError = "") {
  const exportedAt = new Date().toISOString();
  const model = getActiveModelInfo();
  const cost = chat.cost || {};
  const metadata = [
    `- Chat title: ${chat.title || "New Chat"}`,
    `- Chat ID: ${chat.id || currentChatId || "unknown"}`,
    `- Exported at: ${exportedAt}`,
    `- Active model: ${model.name || settings.model || "unknown"}`,
    `- Chat updated: ${formatExportDate(chat.timestamp)}`,
    `- Approx next-turn context: ${formatTokens(computeContextBreakdown().total)} tokens`,
    `- Recorded spend: $${formatCost(cost.totalUsd || 0)} (${formatTokens(cost.promptTokens || 0)} prompt tokens, ${formatTokens(cost.completionTokens || 0)} completion tokens)`
  ];

  const summary = handoffSummary
    ? handoffSummary
    : [
        "AI-generated summary unavailable.",
        summaryError ? `Reason: ${summaryError}` : "",
        "Use the paired raw JSON export for the full chat, tool calls, and provenance."
      ].filter(Boolean).join("\n");

  return [
    "# Margin Chat Context Export",
    "",
    "## Metadata",
    metadata.join("\n"),
    "",
    "## AI Handoff Summary",
    summary,
    "",
    "## Workspace Files",
    buildWorkspaceMarkdown(chat),
    "",
    "## Raw Export Note",
    "This document is an AI-generated handoff. The paired JSON export preserves the complete stored chat object, full transcript, tool calls and results, attachments, and files attached to this chat. Export the global workspace separately from Settings."
  ].join("\n");
}

export async function exportCurrentChatForContext() {
  const exportBtn = document.getElementById("header-export-chat-btn");
  const chat = chats[currentChatId];
  if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) {
    showToast("No chat messages to export yet.");
    return;
  }

  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.classList.add("is-busy");
  }

  let summary = "";
  let summaryError = "";
  try {
    if (!settings.dataSharingConsent) {
      summaryError = "Provider-processing consent is not enabled.";
      showToast("Exporting without AI summary. Accept provider processing to generate summaries.");
    } else if (settings.aiProvider === "openrouter" && !settings.apiKey) {
      summaryError = `${getProviderLabel(settings.aiProvider)} key is not configured.`;
      showToast("Exporting without AI summary. Add a provider key for summaries.");
    } else {
      showToast("Generating chat handoff summary...");
      summary = await generateAiHandoffSummary(chat);
    }
  } catch (err) {
    summaryError = err.message || String(err);
    console.error("Could not generate chat export summary:", err);
    showToast("AI summary failed. Exporting compact context and raw JSON.");
  }

  try {
    const markdown = buildContextMarkdownExport(chat, summary, summaryError);
    const rawJson = JSON.stringify(buildRawChatExport(chat), null, 2);
    downloadTextFile("margin-chat-context.md", markdown, "text/markdown;charset=utf-8");
    downloadTextFile("margin-chat-raw.json", rawJson, "application/json;charset=utf-8");
    showToast("Chat context exported.");
  } catch (err) {
    console.error("Could not export chat:", err);
    showToast("Could not export chat: " + (err.message || "unknown error"));
  } finally {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.classList.remove("is-busy");
    }
  }
}
