// sidepanel/ui/composer.js - Message input: send/stop button modes, chat
// toolbar events, file upload attachments, and the send pipeline entry.

import { settings, chats, currentChatId, uploadedAttachments, setUploadedAttachments, isAgentRunning, agentStopRequested } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { escapeHtml, formatBytes } from "../lib/format.js";
import { showToast } from "../lib/toast.js";
import { SEND_ICON, STOP_ICON } from "./icons.js";
import { appendMessageUI, renderChatHistory } from "./chat-view.js";
import { renderHistoryList } from "./history-drawer.js";
import { runAgentCycle, beginAgentRun, endAgentRun, stopAgent, recordAgentStopped } from "../agent/run-loop.js";
import { validateAttachmentForActiveModel, getAttachmentKind } from "../agent/context.js";
import { makeFallbackChatTitle } from "../features/chat-titles.js";
import { exportCurrentChatForContext } from "../features/chat-export.js";
import { createNewChatSession } from "../features/chats.js";
import { refreshOpenRouterBalance } from "./model-picker.js";
import { switchView } from "./navigation.js";

export function setSendButtonMode(mode) {
  const sendBtn = document.getElementById("send-btn");
  const chatTextarea = document.getElementById("chat-textarea");
  if (!sendBtn) return;

  if (mode === "stop") {
    sendBtn.classList.add("stop-mode", "active");
    sendBtn.disabled = false;
    sendBtn.title = "Stop";
    sendBtn.setAttribute("aria-label", "Stop response");
    sendBtn.innerHTML = STOP_ICON;
    return;
  }

  sendBtn.classList.remove("stop-mode");
  sendBtn.innerHTML = SEND_ICON;
  sendBtn.title = "Send";
  sendBtn.setAttribute("aria-label", "Send message");

  const hasContent = (chatTextarea && chatTextarea.value.trim()) || uploadedAttachments.length > 0;
  sendBtn.classList.toggle("active", hasContent);
  sendBtn.disabled = !settings.apiKey;
}


// ----------------------------------------------------
// CHAT LAYOUTS & EVENT HANDLERS
// ----------------------------------------------------
export function initChatEvents() {
  const sendBtn = document.getElementById("send-btn");
  const chatTextarea = document.getElementById("chat-textarea");
  const headerNewChatBtn = document.getElementById("header-new-chat-btn");
  const headerExportChatBtn = document.getElementById("header-export-chat-btn");
  const headerClearChatBtn = document.getElementById("header-clear-chat-btn");
  const balanceBtn = document.getElementById("openrouter-balance-badge");

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      if (isAgentRunning) {
        stopAgent();
      } else {
        handleSendMessage();
      }
    });
  }

  if (headerNewChatBtn) {
    headerNewChatBtn.addEventListener("click", () => {
      createNewChatSession();
      showToast("Started new chat session");
    });
  }

  if (headerExportChatBtn) {
    headerExportChatBtn.addEventListener("click", () => {
      exportCurrentChatForContext();
    });
  }

  if (headerClearChatBtn) {
    headerClearChatBtn.addEventListener("click", async () => {
      if (currentChatId && chats[currentChatId]) {
        if (confirm("Are you sure you want to clear this chat's messages?")) {
          chats[currentChatId].messages = [];
          chats[currentChatId].title = "New Chat";
          chats[currentChatId].titleMode = "auto";
          chats[currentChatId].titleGeneratedAt = null;
          await saveChats();
          renderChatHistory();
          renderHistoryList();
          showToast("Chat cleared");
        }
      }
    });
  }

  if (balanceBtn) {
    balanceBtn.addEventListener("click", () => {
      refreshOpenRouterBalance();
    });
  }

  if (chatTextarea) {
    chatTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isAgentRunning) return;
        handleSendMessage();
      }
    });

    chatTextarea.addEventListener("input", () => {
      chatTextarea.style.height = "auto";
      chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 120) + "px";
      
      if (sendBtn) {
        if (chatTextarea.value.trim() || uploadedAttachments.length > 0) {
          sendBtn.classList.add("active");
        } else {
          sendBtn.classList.remove("active");
        }
      }
    });
  }
}


// Send user message and kick off the response cycle
export async function handleSendMessage() {
  const chatTextarea = document.getElementById("chat-textarea");
  const sendBtn = document.getElementById("send-btn");

  if (!chatTextarea || !currentChatId) return;

  const userInput = chatTextarea.value.trim();
  if (!userInput && uploadedAttachments.length === 0) return;

  if (!settings.apiKey) {
    showToast("Please configure your OpenRouter API Key first!");
    switchView("settings");
    return;
  }

  // Clear inputs
  chatTextarea.value = "";
  chatTextarea.style.height = "auto";
  if (sendBtn) sendBtn.classList.remove("active");

  const attachmentsToSend = [...uploadedAttachments];
  setUploadedAttachments([]);
  renderPreviewArea();

  // Save session state details
  const activeChat = chats[currentChatId];
  activeChat.timestamp = Date.now();
  
  // Set chat title dynamically if first user message
  if (activeChat.messages.length === 0) {
    activeChat.title = makeFallbackChatTitle(userInput);
    activeChat.titleMode = "auto";
    activeChat.titleGeneratedAt = null;
  }

  // Append user message
  const messageIndex = activeChat.messages.push({ role: "user", content: userInput, attachments: attachmentsToSend }) - 1;
  appendMessageUI("user", userInput, attachmentsToSend, true, { messageIndex });
  await saveChats();
  renderHistoryList();

  // Kick off OpenRouter Agent loop
  beginAgentRun();
  try {
    await runAgentCycle();
  } finally {
    if (agentStopRequested) {
      await recordAgentStopped();
    }
    endAgentRun();
  }
}


// ----------------------------------------------------
// FILE UPLOAD ATTACHMENTS
// ----------------------------------------------------
export function initUploadEvents() {
  const attachBtn = document.getElementById("attach-screenshot-btn");
  const fileInput = document.getElementById("screenshot-input");

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      Array.from(files).forEach(file => {
        const validationError = validateAttachmentForActiveModel(file);
        if (validationError) {
          showToast(validationError);
          return;
        }

        const kind = getAttachmentKind(file);
        const reader = new FileReader();
        reader.onload = (event) => {
          const result = event.target.result;
          const attachment = {
            kind,
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size
          };
          if (kind === "text") {
            attachment.text = String(result || "");
          } else {
            attachment.dataUrl = String(result || "");
            if (kind === "audio") {
              attachment.base64 = attachment.dataUrl.split(",")[1] || "";
            }
          }
          uploadedAttachments.push(attachment);
          renderPreviewArea();
          
          const sendBtn = document.getElementById("send-btn");
          if (sendBtn) sendBtn.classList.add("active");
        };
        reader.onerror = () => showToast(`Could not read ${file.name}`);
        if (kind === "text") {
          reader.readAsText(file);
        } else {
          reader.readAsDataURL(file);
        }
      });

      fileInput.value = "";
    });
  }
}

export function renderPreviewArea() {
  const previewArea = document.getElementById("attachments-preview-area");
  if (!previewArea) return;

  previewArea.innerHTML = "";

  if (uploadedAttachments.length === 0) {
    previewArea.classList.add("hidden");
    return;
  }

  previewArea.classList.remove("hidden");

  uploadedAttachments.forEach((attachment, index) => {
    const item = document.createElement("div");
    item.className = "attachment-preview-item";

    if (attachment.kind === "image" && attachment.dataUrl) {
      const img = document.createElement("img");
      img.src = attachment.dataUrl;
      img.alt = attachment.name || "Attached image";
      item.appendChild(img);
    } else {
      const filePreview = document.createElement("div");
      filePreview.className = "attachment-file-preview";
      filePreview.innerHTML = `
        <span class="attachment-file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </span>
        <span class="attachment-file-name">${escapeHtml(attachment.name || "attachment")}</span>
      `;
      item.appendChild(filePreview);
    }
    item.title = `${attachment.name || "attachment"}\n${attachment.mimeType || attachment.kind} - ${formatBytes(attachment.size)}`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-attachment-btn";
    removeBtn.innerHTML = "&times;";
    removeBtn.title = "Remove attachment";
    removeBtn.addEventListener("click", () => {
      uploadedAttachments.splice(index, 1);
      renderPreviewArea();
      
      const chatTextarea = document.getElementById("chat-textarea");
      const sendBtn = document.getElementById("send-btn");
      if (uploadedAttachments.length === 0 && (!chatTextarea || !chatTextarea.value.trim())) {
        if (sendBtn) sendBtn.classList.remove("active");
      }
    });
    item.appendChild(removeBtn);

    previewArea.appendChild(item);
  });
}
