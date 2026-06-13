// sidepanel/agent/run-loop.js - The agent conversation cycle: request,
// tool execution, and run lifecycle (begin/stop/end).

import { settings, chats, currentChatId, isAgentRunning, agentStopRequested, agentAbortController, beginAgentRunState, endAgentRunState, requestAgentStop, mcpToolRegistry } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { fetchChatCompletion } from "../api/openrouter.js";
import { buildReasoningPreferences } from "../settings/sections/reasoning.js";
import { buildProviderPreferences } from "../settings/sections/provider-routing.js";
import { buildApiMessagesForChat, messagesContainFileParts } from "./context.js";
import { getAllAgentTools, executeTool, evaluateToolLoopGuard, refreshMcpTools } from "../tools/execute.js";
import { appendMessageUI, extractReasoningText, sanitizeToolDisplay } from "../ui/chat-view.js";
import { setSendButtonMode } from "../ui/composer.js";
import { recordUsage } from "../ui/usage-bar.js";
import { refreshOpenRouterBalance } from "../ui/model-picker.js";
import { maybeAutoGenerateChatTitle } from "../features/chat-titles.js";

export function beginAgentRun() {
  beginAgentRunState();
  setSendButtonMode("stop");
}

export function endAgentRun() {
  endAgentRunState();
  setSendButtonMode("send");
}

export function stopAgent() {
  if (!isAgentRunning) return;
  requestAgentStop();
  if (agentAbortController) {
    agentAbortController.abort();
  }
}

export async function recordAgentStopped() {
  if (!currentChatId || !chats[currentChatId]) return;
  const activeChat = chats[currentChatId];
  const lastMsg = activeChat.messages[activeChat.messages.length - 1];
  if (lastMsg?.content === "Response stopped.") return;
  const messageIndex = activeChat.messages.push({ role: "assistant", content: "Response stopped." }) - 1;
  appendMessageUI("assistant", "*Response stopped.*", [], true, { messageIndex });
  await saveChats();
}


export async function runAgentCycle() {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory || !currentChatId || agentStopRequested) return;

  const activeChat = chats[currentChatId];

  // 1. Render Thinking Loader
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "message assistant loading-msg";
  loadingDiv.innerHTML = `
    <div class="message-content">
      <span class="typing-indicator" aria-label="Thinking">
        <span></span><span></span><span></span>
      </span>
    </div>`;
  chatHistory.appendChild(loadingDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;

  try {
    const activeModel = settings.model;
    if (!activeModel) {
      throw new Error("No AI model selected. Open settings and pick a model.");
    }

    if (mcpToolRegistry.size === 0 && settings.mcpServers.some(s => s.enabled !== false && s.url)) {
      await refreshMcpTools();
    }

    // 2. Prepare model transcript from the UI chat history.
    const apiMessages = buildApiMessagesForChat(activeChat);

    const providerPreferences = buildProviderPreferences();
    const reasoningPreferences = buildReasoningPreferences({ includeThinkingOutput: true });
    const requestBody = {
      model: activeModel,
      messages: apiMessages,
      tools: getAllAgentTools(),
      temperature: 0.2,
      // Request token + cost accounting on every completion.
      usage: { include: true }
    };
    if (providerPreferences) {
      requestBody.provider = providerPreferences;
    }
    if (reasoningPreferences) {
      requestBody.reasoning = reasoningPreferences;
    }
    if (settings.reasoning.showThinking) {
      requestBody.include_reasoning = true;
    }
    if (messagesContainFileParts(apiMessages)) {
      requestBody.plugins = [
        {
          id: "file-parser",
          pdf: { engine: "cloudflare-ai" }
        }
      ];
    }

    // 3. OpenRouter fetch request
    const data = await fetchChatCompletion(settings.apiKey, requestBody, {
      signal: agentAbortController?.signal
    });
    loadingDiv.remove(); // Clear Loader

    if (!data.choices || data.choices.length === 0) {
      throw new Error("Empty completion choices returned.");
    }

    // Capture real usage from OpenRouter so the cost meter is grounded in
    // actuals rather than the chars/4 estimate.
    if (data.usage) recordUsage(data.usage);
    refreshOpenRouterBalance();

    const responseMsg = data.choices[0].message;
    const reasoningText = settings.reasoning.showThinking ? extractReasoningText(responseMsg) : "";
    const appendReasoningIfPresent = () => {
      if (!reasoningText) return;
      activeChat.messages.push({ role: "reasoning", content: reasoningText });
      appendMessageUI("reasoning", reasoningText);
    };

    // 4. Handle Tool execution or standard Assistant responses
    if (responseMsg.tool_calls && responseMsg.tool_calls.length > 0) {
      // Save assistant tool call in messages log
      activeChat.messages.push({
        role: "assistant",
        content: responseMsg.content || "",
        tool_calls: responseMsg.tool_calls
      });

      appendReasoningIfPresent();

      // Display text content if assistant returned thoughts along with tool call
      if (responseMsg.content) {
        appendMessageUI("assistant", responseMsg.content);
      }

      // Execute each tool call sequentially
      for (const toolCall of responseMsg.tool_calls) {
        if (agentStopRequested) return;

        const toolName = toolCall.function.name;
        let toolArgs = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch (e) {}

        // Add a structured tool-call card in chat UI
        const callStatus = {
          stage: "call",
          name: toolName,
          args: toolArgs
        };
        if (toolName !== "write_file") {
          appendMessageUI("tool-status", callStatus);
          activeChat.messages.push({ role: "tool-status", content: callStatus });
        }

        // Run the action
        let result = await executeTool(toolName, toolArgs);
        const loopGuardResult = evaluateToolLoopGuard(toolName, toolArgs, result);
        if (loopGuardResult) {
          result = loopGuardResult;
        }

        let finalResultContent = "";
        let screenshotDataUrl = null;

        if (typeof result === "object" && result.screenshot) {
          finalResultContent = result.message;
          screenshotDataUrl = result.screenshot;
        } else if (typeof result === "object" && result.type === "file") {
          finalResultContent = JSON.stringify({
            success: true,
            path: result.path,
            action: result.action,
            lines: result.lines,
            message: result.message
          });

          const artifact = {
            path: result.path,
            action: result.action,
            language: result.language,
            lines: result.lines,
            description: result.description || ""
          };
          appendMessageUI("file-artifact", artifact);
          activeChat.messages.push({ role: "file-artifact", content: artifact });
        } else if (typeof result === "object") {
          finalResultContent = JSON.stringify(result, null, 2);
        } else {
          finalResultContent = String(result);
        }

        // Push tool results message log
        activeChat.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: finalResultContent
        });

        // If screenshot, attach image in subsequent user feedback block to let AI vision models inspect it
        if (screenshotDataUrl) {
          const screenshotStatus = {
            stage: "result",
            name: toolName,
            result: "Screenshot captured and attached to the next model turn."
          };
          appendMessageUI("tool-status", screenshotStatus);
          activeChat.messages.push({ role: "tool-status", content: screenshotStatus });
          activeChat.messages.push({
            role: "user",
            content: "Here is the visual screenshot just captured from the active webpage viewport:",
            images: [screenshotDataUrl]
          });
        } else if (toolName === "write_file") {
          // File card already shown — skip redundant result card
        } else {
          // Truncate display content to keep logs neat
          const sanitized = sanitizeToolDisplay(toolName, toolArgs, result);
          const displaySummary = typeof sanitized.result === "string" && sanitized.result.length > 2000
            ? sanitized.result.slice(0, 2000) + "\n..."
            : sanitized.result;
          const resultStatus = {
            stage: "result",
            name: toolName,
            result: displaySummary
          };
          appendMessageUI("tool-status", resultStatus);
          activeChat.messages.push({ role: "tool-status", content: resultStatus });
        }
      }

      await saveChats();
      // Recurse / continue agent reasoning loop
      if (!agentStopRequested) {
        await runAgentCycle();
      }

    } else {
      // Regular response from assistant
      const aiReply = responseMsg.content || "";
      appendReasoningIfPresent();
      const messageIndex = activeChat.messages.push({ role: "assistant", content: aiReply }) - 1;
      appendMessageUI("assistant", aiReply, [], true, { messageIndex });
      await saveChats();
      await maybeAutoGenerateChatTitle(currentChatId);
    }

  } catch (error) {
    if (loadingDiv) loadingDiv.remove();
    if (error.name === "AbortError" || agentStopRequested) return;
    console.error(error);
    const errorContent = `Error occurred during agent turn: ${error.message}`;
    const messageIndex = activeChat.messages.push({ role: "assistant", content: errorContent }) - 1;
    appendMessageUI("assistant", `**Error:** ${error.message}`, [], true, { messageIndex });
    await saveChats();
  }
}
