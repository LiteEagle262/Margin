import { settings, chats, currentChatId } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { showToast } from "../lib/toast.js";
import { fetchProviderChatCompletion, getProviderLabel } from "../api/provider.js";
import { renderHistoryList } from "../ui/history-drawer.js";
import { recordUsageForChat, updateUsageBar } from "../ui/usage-bar.js";
import { refreshProviderBadge } from "../ui/model-picker.js";
import { getDisplayAttachments } from "../ui/chat-view.js";
import { buildProviderPreferences } from "../settings/sections/provider-routing.js";
import { resolveReasoningEffortForActiveModel } from "../settings/sections/reasoning.js";
import { switchView } from "../ui/navigation.js";

export function makeFallbackChatTitle(input, fallback = "Attachment Chat") {
  const trimmed = String(input || "").replace(/\s+/g, " ").trim();
  return trimmed ? (trimmed.slice(0, 24) + (trimmed.length > 24 ? "..." : "")) : fallback;
}

function makeLocalChatTitle(transcript) {
  const firstUserLine = String(transcript || "")
    .split("\n")
    .find(line => line.startsWith("User:")) || "";
  const source = (firstUserLine || transcript || "")
    .replace(/^User:\s*/i, "")
    .replace(/^Assistant:\s*/i, "")
    .replace(/\[Attachments:[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) return "Attachment Chat";

  const words = source.split(" ").filter(Boolean).slice(0, 10);
  return sanitizeChatTitle(words.join(" ")) || makeFallbackChatTitle(source);
}

export function sanitizeChatTitle(value) {
  return String(value || "")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?:;-]+$/g, "")
    .trim()
    .slice(0, 60);
}

export function extractMessageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractChatTitleFromCompletion(data) {
  const firstChoice = data?.choices?.[0];
  const message = firstChoice?.message || {};
  const returnedText =
    extractMessageContentText(message.content) ||
    extractMessageContentText(firstChoice?.text) ||
    extractMessageContentText(message.title);
  return sanitizeChatTitle(returnedText);
}

function buildTitleTranscript(chat) {
  if (!chat || !Array.isArray(chat.messages)) return "";

  const lines = [];
  for (const msg of chat.messages) {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && !String(msg.content || "").trim()) continue;

    const content = String(msg.content || "").replace(/\s+/g, " ").trim();
    const attachments = getDisplayAttachments(msg)
      .map(att => att.name || att.filename || att.mimeType || att.kind)
      .filter(Boolean);
    const attachmentSuffix = attachments.length ? ` [Attachments: ${attachments.slice(0, 4).join(", ")}]` : "";
    if (content || attachmentSuffix) {
      lines.push(`${msg.role === "user" ? "User" : "Assistant"}: ${content}${attachmentSuffix}`.trim());
    }
    if (lines.join("\n").length > 6000) break;
  }

  return lines.join("\n").slice(0, 6000);
}

function buildChatTitleRequestBody(transcript, options = {}) {
  const requestBody = {
    model: settings.model,
    messages: [
      {
        role: "system",
        content: "Name this chat from the user and assistant messages only. Ignore browser/tool activity because it is not included. Return only a clear descriptive title, preferably 4 to 10 words. Do not return a single-word title unless the conversation truly has no other distinguishing detail. No quotes, no punctuation at the end."
      },
      {
        role: "user",
        content: transcript
      }
    ],
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens || 256,
    usage: { include: true }
  };

  if (options.disableReasoning) {
    const effort = resolveReasoningEffortForActiveModel("none");
    if (effort === "none") requestBody.reasoning = { effort, exclude: true };
  }

  if (options.includeProvider !== false) {
    const providerPreferences = buildProviderPreferences();
    if (providerPreferences) requestBody.provider = providerPreferences;
  }

  return requestBody;
}

async function fetchChatTitleCompletion(requestBody) {
  return fetchProviderChatCompletion(settings.aiProvider, settings.apiKey, requestBody, { appTitle: "Margin Chat Naming" });
}

export async function generateChatTitle(chatId = currentChatId, { silent = false } = {}) {
  const chat = chats[chatId];
  if (!chat) return "";
  if (!settings.dataSharingConsent) {
    if (!silent) {
      showToast("Accept the provider-processing disclosure before generating a chat name");
      switchView("settings");
    }
    return "";
  }
  if (settings.aiProvider === "openrouter" && !settings.apiKey) {
    if (!silent) {
      showToast(`Add a ${getProviderLabel(settings.aiProvider)} key to generate a chat name`);
      switchView("settings");
    }
    return "";
  }
  if (!settings.model) {
    if (!silent) showToast("Pick a model before generating a chat name");
    return "";
  }

  const transcript = buildTitleTranscript(chat);
  if (!transcript) {
    if (!silent) showToast("Add a message before generating a chat name");
    return "";
  }

  if (settings.aiProvider === "openai") {
    const title = makeLocalChatTitle(transcript);
    chat.title = title;
    chat.titleMode = "auto";
    chat.titleGeneratedAt = Date.now();
    await saveChats();
    renderHistoryList();
    if (!silent) showToast("Chat name updated");
    return title;
  }

  try {
    const data = await fetchChatTitleCompletion(buildChatTitleRequestBody(transcript));
    if (data.usage) recordUsageForChat(data.usage, chatId);

    let title = extractChatTitleFromCompletion(data);
    let usedLocalFallback = false;

    if (!title) {
      console.warn("The AI provider returned an empty chat title. Retrying with minimal options.", {
        finish_reason: data.choices?.[0]?.finish_reason,
        native_finish_reason: data.choices?.[0]?.native_finish_reason,
        message: data.choices?.[0]?.message
      });
      const retryData = await fetchChatTitleCompletion(buildChatTitleRequestBody(transcript, {
        includeProvider: false,
        disableReasoning: true,
        temperature: 0,
        maxTokens: 256
      }));
      if (retryData.usage) recordUsageForChat(retryData.usage, chatId);
      title = extractChatTitleFromCompletion(retryData);
    }

    if (!title) {
      title = makeLocalChatTitle(transcript);
      usedLocalFallback = true;
    }

    chat.title = title;
    chat.titleMode = "ai";
    chat.titleGeneratedAt = Date.now();
    await saveChats();
    renderHistoryList();
    updateUsageBar();
    refreshProviderBadge();
    if (!silent) showToast(usedLocalFallback ? "Model returned empty name; used local title" : "Chat name generated");
    return title;
  } catch (error) {
    console.error("Error generating chat title:", error);
    if (!silent) showToast(`Could not generate name: ${error.message}`);
    return "";
  }
}

export async function maybeAutoGenerateChatTitle(chatId = currentChatId) {
  const chat = chats[chatId];
  const providerReady = settings.aiProvider === "openai" || Boolean(settings.apiKey);
  if (!chat || chat.titleMode === "manual" || chat.titleMode === "legacy" || chat.titleGeneratedAt || !settings.dataSharingConsent || !providerReady) return;
  const transcript = buildTitleTranscript(chat);
  if (transcript.length < 20) return;
  await generateChatTitle(chatId, { silent: true });
}

export async function renameChatManually(chatId = currentChatId) {
  const chat = chats[chatId];
  if (!chat) return;
  const nextTitle = prompt("Rename chat", chat.title || "New Chat");
  if (nextTitle === null) return;

  const title = sanitizeChatTitle(nextTitle);
  if (!title) {
    showToast("Chat name cannot be empty");
    return;
  }

  chat.title = title;
  chat.titleMode = "manual";
  chat.titleGeneratedAt = null;
  await saveChats();
  renderHistoryList();
  showToast("Chat renamed");
}
