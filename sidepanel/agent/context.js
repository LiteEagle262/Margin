// sidepanel/agent/context.js - Model context assembly: system prompt,
// token budgeting, attachment blocks, and packing stored chat history into
// API messages.

import { settings, chats, currentChatId, openRouterModels } from "../state/store.js";
import { approxTokens, formatTokens } from "../lib/format.js";
import { isWebSearchAvailable } from "../api/tavily.js";
import { getAllAgentTools } from "../tools/execute.js";
import { getFallbackContextWindow } from "../settings/sections/agent-limits.js";

export const DEFAULT_SYSTEM_PROMPT = `You are ScrapeFlow, a professional browser-automation and web scraping AI assistant.
You can execute actions on the current webpage using your built-in tools. For browser interaction, prefer take_snapshot first, then use uid-based click_element, fill_element, fill_form, hover_element, press_key, and wait_for. Use get_dom for raw scraping/debugging when the compact snapshot is insufficient.
If a test login asks for a 2FA/authenticator code, use get_authenticator_code for the active domain when a manual key has been saved in settings.
For debugging API calls and page requests, use get_network_logs first because a settings-enabled hindsight buffer may already exist for the latched tab. If no logs are available, use start_network_capture before interacting with the page, then get_network_logs or get_network_log_detail to inspect URLs, status codes, headers, failures, and redacted bodies.
If MCP servers are configured, you also have additional tools prefixed with mcp__ — use those when they are relevant.

IMPORTANT — File output rules:
- NEVER paste full scripts or multi-line code in chat markdown/code blocks.
- ALWAYS use write_file to save scripts, configs, and other files. The user gets a compact file card they can click to view and copy.
- Files are saved to a persistent workspace shared across chats. Use list_files for an overview, search_files to find files by name or content, get_file_info for metadata, read_file to load contents, rename_file and delete_file to manage files.
- After write_file, give a brief explanation only — do not repeat the file contents.`;

const AUTHENTICATOR_SYSTEM_PROMPT_ADDENDUM =
  "If a test login asks for a 2FA/authenticator code, use get_authenticator_code for the active domain when a manual key has been saved in settings.";

const WEB_SEARCH_SYSTEM_PROMPT_ADDENDUM =
  "When web search tools are available, use search_web for current or external information and fetch_search_result to inspect a specific source before detailed summarization, source-grounded claims, or quotes.";

export const CONTEXT_PACKING = {
  maxWindowShare: 0.86,
  minResponseReserve: 4096,
  maxResponseReserve: 24000,
  recentToolResultsInline: 6,
  archiveToolResultTokens: 2000
};

const TEXT_ATTACHMENT_MAX_BYTES = 320 * 1024;
const BINARY_ATTACHMENT_MAX_BYTES = 12 * 1024 * 1024;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm",
  "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "php", "java",
  "c", "cc", "cpp", "h", "hpp", "cs", "go", "rs", "swift", "kt", "kts",
  "sql", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "sh", "bash",
  "ps1", "bat", "cmd", "dockerfile", "gitignore", "env"
]);


export function getActiveModelInfo() {
  const id = settings.model;
  const match = openRouterModels.find(m => m.id === id);
  const realContext = Number(match?.context_length);
  // We only "know" the window when the model record is loaded AND advertises a
  // usable context_length. Otherwise we surface the configurable fallback and
  // flag it so the UI can show "unknown" instead of a misleading number.
  const contextKnown = Number.isFinite(realContext) && realContext > 0;
  return {
    id,
    name: match?.name || id,
    contextWindow: contextKnown ? realContext : getFallbackContextWindow(),
    contextKnown,
    promptRate: Number(match?.pricing?.prompt) || 0,
    completionRate: Number(match?.pricing?.completion) || 0,
    hasInfo: !!match
  };
}

export function getActiveModelRecord() {
  return openRouterModels.find(m => m.id === settings.model) || null;
}

function getActiveModelInputModalities() {
  const model = getActiveModelRecord();
  const raw = model?.architecture?.input_modalities || model?.input_modalities || [];
  return new Set(Array.isArray(raw) ? raw.map(item => String(item).toLowerCase()) : ["text"]);
}

function getAttachmentExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

export function getAttachmentKind(fileOrAttachment) {
  const type = String(fileOrAttachment.type || fileOrAttachment.mimeType || "").toLowerCase();
  const ext = getAttachmentExtension(fileOrAttachment.name);
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || TEXT_ATTACHMENT_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

export function getReadableAttachmentSupport() {
  const modalities = getActiveModelInputModalities();
  const modelKnown = !!getActiveModelRecord();
  return {
    modelKnown,
    modalities,
    supportsText: !modelKnown || modalities.has("text"),
    supportsImage: modelKnown ? modalities.has("image") : true,
    supportsFile: modelKnown ? modalities.has("file") : true,
    supportsAudio: modelKnown ? modalities.has("audio") : false,
    supportsVideo: modelKnown ? modalities.has("video") : false
  };
}

export function validateAttachmentForActiveModel(file) {
  const support = getReadableAttachmentSupport();
  const kind = getAttachmentKind(file);

  if ((kind === "image" || kind === "pdf" || kind === "audio" || kind === "video" || kind === "binary") &&
      file.size > BINARY_ATTACHMENT_MAX_BYTES) {
    return `${file.name} is too large. Keep binary attachments under ${Math.round(BINARY_ATTACHMENT_MAX_BYTES / 1024 / 1024)} MB.`;
  }
  if (kind === "text" && file.size > TEXT_ATTACHMENT_MAX_BYTES) {
    return `${file.name} is too large to inline. Keep text attachments under ${Math.round(TEXT_ATTACHMENT_MAX_BYTES / 1024)} KB.`;
  }
  if (kind === "image" && !support.supportsImage) {
    return `${settings.model} does not advertise image input on OpenRouter.`;
  }
  if (kind === "audio" && !support.supportsAudio) {
    return `${settings.model} does not advertise audio input on OpenRouter.`;
  }
  if (kind === "video" && !support.supportsVideo) {
    return `${settings.model} does not advertise video input on OpenRouter.`;
  }
  if (kind === "binary" && !support.supportsFile) {
    return `${settings.model} does not advertise generic file input on OpenRouter.`;
  }
  return "";
}

function getResponseReserveTokens(contextWindow) {
  const reserve = Math.round(contextWindow * 0.12);
  return Math.max(
    CONTEXT_PACKING.minResponseReserve,
    Math.min(CONTEXT_PACKING.maxResponseReserve, reserve)
  );
}

function getModelMessageBudget() {
  const model = getActiveModelInfo();
  const contextWindow = model.contextWindow || getFallbackContextWindow();
  const toolsTokens = approxTokens(getAllAgentTools());
  const systemTokens = approxTokens(getEffectiveSystemPrompt());
  const reserveTokens = getResponseReserveTokens(contextWindow);
  const maxPromptTokens = Math.floor(contextWindow * CONTEXT_PACKING.maxWindowShare);
  return Math.max(2000, maxPromptTokens - reserveTokens - toolsTokens - systemTokens);
}

export function countApiMessageTokens(message) {
  let total = approxTokens(message.role || "");
  if (typeof message.content === "string") {
    total += approxTokens(message.content);
  } else if (Array.isArray(message.content)) {
    message.content.forEach(part => {
      if (part.type === "text") total += approxTokens(part.text || "");
      if (part.type === "image_url") total += 1024;
      if (part.type === "video_url") total += 4096;
      if (part.type === "file") total += 2048;
      if (part.type === "input_audio") total += 2048;
    });
  }
  if (Array.isArray(message.tool_calls)) total += approxTokens(message.tool_calls);
  if (message.tool_call_id) total += approxTokens(message.tool_call_id);
  if (message.name) total += approxTokens(message.name);
  return total;
}

export function buildTextAttachmentBlock(attachment) {
  return [
    "",
    `Attached file: ${attachment.name}`,
    `MIME type: ${attachment.mimeType || "text/plain"}`,
    `Size: ${attachment.size} bytes`,
    "Contents:",
    "```",
    attachment.text || "",
    "```"
  ].join("\n");
}

function getAudioAttachmentFormat(attachment) {
  const ext = getAttachmentExtension(attachment.name);
  const mimeFormat = String(attachment.mimeType || "").split("/")[1] || "";
  return (ext || mimeFormat || "wav").replace(/^x-/, "");
}

function buildAttachmentPartsForModel(msg) {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const legacyImages = Array.isArray(msg.images)
    ? msg.images.map((dataUrl, index) => ({
        kind: "image",
        name: `image-${index + 1}`,
        mimeType: "image/*",
        dataUrl,
        size: 0
      }))
    : [];
  const all = [...attachments, ...legacyImages];
  const parts = [];
  let textSuffix = "";

  all.forEach(attachment => {
    const kind = attachment.kind || getAttachmentKind(attachment);
    if (kind === "image" && attachment.dataUrl) {
      parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
      return;
    }
    if (kind === "pdf" && attachment.dataUrl) {
      parts.push({
        type: "file",
        file: {
          filename: attachment.name || "document.pdf",
          file_data: attachment.dataUrl
        }
      });
      return;
    }
    if (kind === "audio" && attachment.base64) {
      parts.push({
        type: "input_audio",
        inputAudio: {
          data: attachment.base64,
          format: getAudioAttachmentFormat(attachment)
        }
      });
      return;
    }
    if (kind === "video" && attachment.dataUrl) {
      parts.push({ type: "video_url", video_url: { url: attachment.dataUrl } });
      return;
    }
    if (kind === "text" && typeof attachment.text === "string") {
      textSuffix += buildTextAttachmentBlock(attachment);
      return;
    }
    if (kind === "binary" && attachment.dataUrl) {
      parts.push({
        type: "file",
        file: {
          filename: attachment.name || "attachment",
          file_data: attachment.dataUrl
        }
      });
    }
  });

  return { parts, textSuffix };
}

function blockTokenCount(block) {
  return block.messages.reduce((sum, message) => sum + countApiMessageTokens(message), 0);
}

export function getRecentInlineToolCallIds(messages) {
  const ids = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "tool" || !msg.tool_call_id) continue;
    ids.add(msg.tool_call_id);
    if (ids.size >= CONTEXT_PACKING.recentToolResultsInline) break;
  }
  return ids;
}

export function getContextItemId(msg) {
  return `tool_${msg.tool_call_id || ""}`;
}

export function getContextItem(contextItemId) {
  const activeChat = chats[currentChatId];
  if (!activeChat || !Array.isArray(activeChat.messages)) return null;
  return activeChat.messages.find(msg =>
    msg.role === "tool" && getContextItemId(msg) === contextItemId
  ) || null;
}

export function summarizeToolContent(content) {
  const text = String(content || "");
  const oneLine = text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
  return oneLine || "(empty result)";
}

function formatToolContentForModel(msg, inlineToolCallIds) {
  const content = String(msg.content || "");
  const shouldArchive =
    msg.tool_call_id &&
    !inlineToolCallIds.has(msg.tool_call_id) &&
    approxTokens(content) > CONTEXT_PACKING.archiveToolResultTokens;

  if (!shouldArchive) return content;

  const contextItemId = getContextItemId(msg);
  return [
    `[Archived tool result: ${contextItemId}]`,
    `Tool: ${msg.name || "unknown"}`,
    `Original size: about ${formatTokens(approxTokens(content))} tokens.`,
    `Preview: ${summarizeToolContent(content)}`,
    `Use read_context_item with context_item_id="${contextItemId}" if you need the full original result.`
  ].join("\n");
}

function formatStoredMessageForModel(msg, inlineToolCallIds) {
  if (msg.role === "user") {
    const attachmentParts = buildAttachmentPartsForModel(msg);
    const contents = [];
    contents.push({
      type: "text",
      text: `${msg.content || "Analyze the attached file(s)."}` + attachmentParts.textSuffix
    });
    contents.push(...attachmentParts.parts);
    return { role: "user", content: contents };
  }

  if (msg.role === "assistant") {
    if (msg.tool_calls) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls
      };
    }
    return { role: "assistant", content: msg.content || "" };
  }

  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: msg.tool_call_id,
      name: msg.name,
      content: formatToolContentForModel(msg, inlineToolCallIds)
    };
  }

  return null;
}

function buildModelMessageBlocks(activeChat) {
  if (!activeChat || !Array.isArray(activeChat.messages)) return [];
  const inlineToolCallIds = getRecentInlineToolCallIds(activeChat.messages);
  const blocks = [];

  for (let i = 0; i < activeChat.messages.length; i++) {
    const msg = activeChat.messages[i];
    if (!msg || msg.role === "tool-status" || msg.role === "file-artifact" || msg.role === "reasoning") continue;

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const blockMessages = [formatStoredMessageForModel(msg, inlineToolCallIds)];
      const expectedToolIds = new Set(msg.tool_calls.map(tc => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < activeChat.messages.length) {
        const next = activeChat.messages[j];
        if (next?.role === "tool-status" || next?.role === "file-artifact" || next?.role === "reasoning") {
          j++;
          continue;
        }
        if (next?.role === "tool" && expectedToolIds.has(next.tool_call_id)) {
          blockMessages.push(formatStoredMessageForModel(next, inlineToolCallIds));
          j++;
          continue;
        }
        break;
      }
      blocks.push({ messages: blockMessages });
      i = j - 1;
      continue;
    }

    if (msg.role === "tool") continue;

    const formatted = formatStoredMessageForModel(msg, inlineToolCallIds);
    if (formatted) blocks.push({ messages: [formatted] });
  }

  return blocks;
}

export function buildApiMessagesForChat(activeChat) {
  const systemMessage = { role: "system", content: getEffectiveSystemPrompt() };
  const budget = getModelMessageBudget();
  const blocks = buildModelMessageBlocks(activeChat);
  const selected = [];
  let used = 0;
  let omitted = 0;

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const blockTokens = blockTokenCount(block);
    if (selected.length > 0 && used + blockTokens > budget) {
      omitted = i + 1;
      break;
    }
    selected.unshift(block);
    used += blockTokens;
  }

  if (omitted > 0) {
    systemMessage.content += `\n\nContext note: ${omitted} older conversation block(s) were left out to fit the active model context window. Older large tool results may be available through read_context_item when referenced by id.`;
  }

  return [
    systemMessage,
    ...selected.flatMap(block => block.messages)
  ];
}

export function messagesContainFileParts(messages) {
  return messages.some(message =>
    Array.isArray(message.content) &&
    message.content.some(part => part?.type === "file")
  );
}


export function getEffectiveSystemPrompt() {
  let prompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (!prompt.includes("get_authenticator_code")) {
    prompt = `${prompt}\n\n${AUTHENTICATOR_SYSTEM_PROMPT_ADDENDUM}`;
  }
  if (isWebSearchAvailable() && !prompt.includes("search_web")) {
    prompt = `${prompt}\n\n${WEB_SEARCH_SYSTEM_PROMPT_ADDENDUM}`;
  }
  return prompt;
}
