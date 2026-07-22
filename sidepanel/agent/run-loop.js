import {
  activeAgentChatId,
  agentAbortController,
  agentStopRequested,
  beginAgentRunState,
  chats,
  currentChatId,
  endAgentRunState,
  isAgentRunning,
  mcpToolRegistry,
  requestAgentStop,
  settings,
} from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { fetchProviderChatCompletion } from "../api/provider.js";
import { buildReasoningPreferences } from "../settings/sections/reasoning.js";
import { buildProviderPreferences } from "../settings/sections/provider-routing.js";
import {
  buildApiMessagesForChat,
  messagesContainFileParts,
} from "./context.js";
import {
  evaluateToolLoopGuard,
  executeTool,
  getAllAgentTools,
  guardToolCallBeforeExecution,
  refreshMcpTools,
} from "../tools/execute.js";
import { appendMessageUI, extractReasoningText, sanitizeToolDisplay } from "../ui/chat-view.js";
import { setSendButtonMode } from "../ui/composer.js";
import { recordUsageForChat } from "../ui/usage-bar.js";
import { refreshProviderBadge } from "../ui/model-picker.js";
import { maybeAutoGenerateChatTitle } from "../features/chat-titles.js";
import {
  classifyProviderResponse,
  describeEmptyProviderResponse,
  MAX_OPENAI_CONTINUATION_TURNS,
} from "./provider-response.js";

function visibleChat(chatId) {
  return chatId && currentChatId === chatId;
}

function appendForChat(chatId, role, content, attachments = [], options = {}) {
  if (visibleChat(chatId)) appendMessageUI(role, content, attachments, true, options);
}

function addLoadingIndicator(chatId) {
  if (!visibleChat(chatId)) return null;
  const history = document.getElementById("chat-history");
  if (!history) return null;
  const loading = document.createElement("div");
  loading.className = "message assistant loading-msg";
  loading.innerHTML = `<div class="message-content"><span class="typing-indicator" aria-label="Thinking"><span></span><span></span><span></span></span></div>`;
  history.appendChild(loading);
  history.scrollTop = history.scrollHeight;
  return loading;
}

export function beginAgentRun(chatId = currentChatId) {
  beginAgentRunState(chatId);
  setSendButtonMode("stop");
}

export function endAgentRun() {
  endAgentRunState();
  setSendButtonMode("send");
}

export function stopAgent() {
  if (!isAgentRunning) return;
  requestAgentStop();
  agentAbortController?.abort();
}

export async function recordAgentStopped(chatId = activeAgentChatId || currentChatId) {
  const chat = chats[chatId];
  if (!chat) return;
  const lastMessage = chat.messages[chat.messages.length - 1];
  if (lastMessage?.content === "Response stopped.") return;
  const messageIndex = chat.messages.push({ role: "assistant", content: "Response stopped." }) - 1;
  appendForChat(chatId, "assistant", "*Response stopped.*", [], { messageIndex });
  await saveChats();
}

async function ensureMcpRegistry() {
  if (mcpToolRegistry.size === 0 && settings.mcpServers.some((server) => server.enabled !== false && server.url)) {
    await refreshMcpTools();
  }
}

function serializeToolResult(result) {
  if (result && typeof result === "object" && result.screenshot) {
    return { content: String(result.message || "Screenshot captured."), screenshot: result.screenshot };
  }
  if (result && typeof result === "object" && result.type === "file") {
    return {
      content: JSON.stringify({
        success: true,
        path: result.path,
        action: result.action,
        lines: result.lines,
        message: result.message,
      }),
      file: result,
    };
  }
  return {
    content: typeof result === "object" ? JSON.stringify(result, null, 2) : String(result),
  };
}

async function runProviderCycle(chatId, chat, loading, disableTools, continuationTurns) {
  const apiMessages = buildApiMessagesForChat(chat);
  const reasoningPreferences = buildReasoningPreferences();
  const requestBody = {
    model: settings.model,
    messages: apiMessages,
    tools: disableTools ? [] : getAllAgentTools(),
    usage: { include: true },
  };
  if (reasoningPreferences) requestBody.reasoning = reasoningPreferences;
  if (settings.aiProvider === "openrouter") {
    requestBody.temperature = 0.2;
    const providerPreferences = buildProviderPreferences();
    if (providerPreferences) requestBody.provider = providerPreferences;
    if (messagesContainFileParts(apiMessages)) {
      requestBody.plugins = [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }];
    }
  }

  const data = await fetchProviderChatCompletion(settings.aiProvider, settings.apiKey, requestBody, {
    signal: agentAbortController?.signal,
    sessionId: chatId,
  });
  loading?.remove();
  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("The provider returned no completion choices.");
  }
  if (data.usage) recordUsageForChat(data.usage, chatId);
  refreshProviderBadge();

  const response = data.choices[0].message;
  const outcome = classifyProviderResponse(settings.aiProvider, response);
  const reasoning = settings.reasoning.showThinking ? extractReasoningText(response) : "";
  const appendReasoning = () => {
    if (!reasoning) return;
    chat.messages.push({ role: "reasoning", content: reasoning });
    appendForChat(chatId, "reasoning", reasoning);
  };

  if (outcome.kind === "message") {
    appendReasoning();
    const storedMessage = {
      role: "assistant",
      content: outcome.content,
      ...(settings.aiProvider === "openai" && Array.isArray(response.openai_response_items)
        ? { openai_response_items: response.openai_response_items }
        : {}),
      ...(settings.aiProvider === "openrouter" && Array.isArray(response.reasoning_details)
        ? { reasoning_details: response.reasoning_details }
        : {}),
    };
    const messageIndex = chat.messages.push(storedMessage) - 1;
    appendForChat(chatId, "assistant", outcome.content, [], { messageIndex });
    await saveChats();
    await maybeAutoGenerateChatTitle(chatId);
    return;
  }

  if (outcome.kind === "continue") {
    appendReasoning();
    if (continuationTurns >= MAX_OPENAI_CONTINUATION_TURNS) {
      throw new Error("OpenAI returned repeated intermediate responses without a final message.");
    }
    if (outcome.content || outcome.continuationItems.length) {
      const messageIndex = chat.messages.push({
        role: "assistant",
        content: outcome.content,
        tool_calls: [],
        ...(outcome.continuationItems.length
          ? { openai_response_items: outcome.continuationItems }
          : {}),
      }) - 1;
      if (outcome.content) {
        appendForChat(chatId, "assistant", outcome.content, [], { messageIndex });
      }
    }
    await saveChats();
    if (!agentStopRequested) {
      await runAgentCycle(chatId, {
        disableTools,
        continuationTurns: continuationTurns + 1,
      });
    }
    return;
  }

  if (outcome.kind === "empty") {
    throw new Error(describeEmptyProviderResponse(settings.aiProvider, response));
  }

  chat.messages.push({
    role: "assistant",
    content: response.content || "",
    tool_calls: response.tool_calls,
    ...(Array.isArray(response.openai_response_items)
      ? { openai_response_items: response.openai_response_items }
      : {}),
    ...(settings.aiProvider === "openrouter" && Array.isArray(response.reasoning_details)
      ? { reasoning_details: response.reasoning_details }
      : {}),
  });
  appendReasoning();
  if (response.content) appendForChat(chatId, "assistant", response.content);

  const screenshots = [];
  let toolLimitReached = false;
  for (const toolCall of response.tool_calls) {
    if (agentStopRequested) return;
    const name = String(toolCall.function?.name || "");
    let args = {};
    try {
      args = JSON.parse(toolCall.function?.arguments || "{}");
    } catch {}

    const callStatus = { stage: "call", name, args };
    if (name !== "write_file") {
      chat.messages.push({ role: "tool-status", content: callStatus });
      appendForChat(chatId, "tool-status", callStatus);
    }

    let result = guardToolCallBeforeExecution(name);
    if (result) {
      toolLimitReached = true;
    } else {
      result = await executeTool(name, args);
      result = evaluateToolLoopGuard(name, args, result) || result;
    }

    const serialized = serializeToolResult(result);
    chat.messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      name,
      content: serialized.content,
    });

    if (serialized.screenshot) screenshots.push(serialized.screenshot);
    if (serialized.file) {
      const artifact = {
        path: serialized.file.path,
        action: serialized.file.action,
        language: serialized.file.language,
        lines: serialized.file.lines,
        description: serialized.file.description || "",
      };
      chat.messages.push({ role: "file-artifact", content: artifact });
      appendForChat(chatId, "file-artifact", artifact);
    } else {
      const sanitized = sanitizeToolDisplay(name, args, result);
      const rawSummary = typeof sanitized.result === "string" ? sanitized.result : JSON.stringify(sanitized.result, null, 2);
      const resultStatus = {
        stage: "result",
        name,
        result: serialized.screenshot
          ? "Screenshot captured and attached to the next model turn."
          : rawSummary.length > 2000 ? `${rawSummary.slice(0, 2000)}\n...` : rawSummary,
      };
      chat.messages.push({ role: "tool-status", content: resultStatus });
      appendForChat(chatId, "tool-status", resultStatus);
    }
  }

  if (screenshots.length > 0) {
    chat.messages.push({
      role: "user",
      content: "Screenshots captured by the requested browser tools:",
      images: screenshots,
    });
  }
  await saveChats();
  if (!agentStopRequested) {
    await runAgentCycle(chatId, { disableTools: disableTools || toolLimitReached });
  }
}

export async function runAgentCycle(
  chatId = activeAgentChatId || currentChatId,
  { disableTools = false, continuationTurns = 0 } = {},
) {
  if (!chatId || agentStopRequested) return;
  const chat = chats[chatId];
  if (!chat) return;
  const loading = addLoadingIndicator(chatId);

  try {
    if (!settings.dataSharingConsent) {
      throw new Error("Accept the provider-processing disclosure in settings before sending chat or page data.");
    }
    if (!settings.model) throw new Error("No AI model selected. Open settings and pick a model.");
    if (settings.aiProvider === "openrouter" && !settings.apiKey) {
      throw new Error("Add an OpenRouter API key in settings.");
    }
    await ensureMcpRegistry();

    await runProviderCycle(chatId, chat, loading, disableTools, continuationTurns);
  } catch (error) {
    loading?.remove();
    if (error.name === "AbortError" || agentStopRequested) return;
    console.error(error);
    if (!chats[chatId]) return;
    const content = `Error occurred during agent turn: ${error.message}`;
    const messageIndex = chat.messages.push({ role: "assistant", content, isError: true }) - 1;
    appendForChat(chatId, "assistant", `**Error:** ${error.message}`, [], { messageIndex });
    await saveChats();
  }
}
