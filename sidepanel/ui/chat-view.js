import { settings, chats, currentChatId, isAgentRunning, agentStopRequested } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { escapeHtml, stripHtml, formatBytes, prettyPrint, approxTokens, formatTokens } from "../lib/format.js";
import { formatMarkdown, bindCopyButtons } from "../lib/markdown.js";
import { showToast } from "../lib/toast.js";
import { EDIT_ICON, CHECK_ICON, X_ICON } from "./icons.js";
import { normalizeReasoningSettings } from "../settings/sections/reasoning.js";
import { persistSettings } from "../settings/core.js";
import { getAttachmentKind } from "../agent/context.js";
import { getWorkspaceFile } from "../features/workspace.js";
import { renderWorkspaceStrip } from "./workspace-strip.js";
import { runAgentCycle, beginAgentRun, endAgentRun, recordAgentStopped } from "../agent/run-loop.js";
import { updateUsageBar } from "./usage-bar.js";
import { makeFallbackChatTitle } from "../features/chat-titles.js";
import { renderHistoryList } from "./history-drawer.js";
import { isActiveProviderReady, refreshProviderBadge } from "./model-picker.js";

export async function setThinkingOpenDefault(keepThinkingOpen) {
  await persistSettings({
    ...settings,
    reasoning: {
      ...settings.reasoning,
      keepThinkingOpen
    }
  });
  const keepOpenInput = document.getElementById("reasoning-keep-open");
  if (keepOpenInput) keepOpenInput.checked = keepThinkingOpen;
  renderChatHistory();
}


export function renderChatHistory() {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  chatHistory.innerHTML = `
    <div class="message system-msg">
      <div class="message-content">
        <p><strong>Margin is ready.</strong></p>
        <p>Connect OpenRouter or link a ChatGPT account, then ask for page inspection, browser actions, or scripts.</p>
        <p>Files appear as cards you can open and copy. Browser tool calls collapse into a single "Activity" trace — click to expand.</p>
      </div>
    </div>
  `;

  const activeChat = chats[currentChatId];
  if (activeChat && activeChat.messages) {
    activeChat.messages.forEach((msg, index) => {
      try {
        if (msg.role === "user" || msg.role === "assistant") {
          // Tool-call carrier messages with no text render as empty cards that
          // split the trace into separate boxes — skip them like the live run does.
          const attachments = getDisplayAttachments(msg);
          if (msg.role === "assistant" && !String(msg.content || "").trim() && attachments.length === 0) return;
          appendMessageUI(msg.role, msg.content, attachments, false, { messageIndex: index });
        } else if (msg.role === "tool-status") {
          appendMessageUI("tool-status", msg.content, [], false);
        } else if (msg.role === "file-artifact") {
          appendMessageUI("file-artifact", msg.content, [], false);
        } else if (msg.role === "reasoning") {
          // Thinking tabs render only while the setting is enabled; stored
          // reasoning stays in the chat data and reappears if re-enabled.
          if (normalizeReasoningSettings(settings.reasoning).showThinking) {
            appendMessageUI("reasoning", msg.content, [], false);
          }
        }
      } catch (err) {
        // One corrupt message must not blank the rest of the transcript.
        console.error(`Could not render message ${index} (role: ${msg?.role}):`, err, msg);
      }
    });
  }

  renderWorkspaceStrip();
  updateUsageBar();
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

export function getDisplayAttachments(msg) {
  const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
  const legacyImages = Array.isArray(msg?.images)
    ? msg.images.map((dataUrl, index) => ({
        kind: "image",
        name: `image-${index + 1}`,
        mimeType: "image/*",
        dataUrl,
        size: 0
      }))
    : [];
  return [...attachments, ...legacyImages];
}

export function appendMessageUI(role, content, attachments = [], shouldScroll = true, options = {}) {
  const chatHistory = document.getElementById("chat-history");
  if (!chatHistory) return;

  if (role === "tool-status") {
    const group = ensureActivityGroup(chatHistory);
    const body = group.querySelector(".activity-group-body");
    const card = renderToolStatus(content);
    if (content && typeof content === "object") recordActivityTimestamp(group, Number(content.ts));
    // One line per tool, like the design: a result upgrades its call line
    // in place (carrying the arguments over) instead of adding a second row.
    const last = body.lastElementChild;
    if (
      card.classList.contains("stage-result") &&
      last &&
      last.classList.contains("stage-call") &&
      last.dataset.toolName === card.dataset.toolName
    ) {
      const argsField = last.querySelector(".tool-card-body .tool-field");
      if (argsField) {
        let cardBody = card.querySelector(".tool-card-body");
        if (!cardBody) {
          cardBody = document.createElement("div");
          cardBody.className = "tool-card-body hidden";
          card.appendChild(cardBody);
        }
        cardBody.insertBefore(argsField, cardBody.firstChild);
      }
      if (group.classList.contains("all-expanded")) {
        const cardBody = card.querySelector(".tool-card-body");
        if (cardBody) {
          cardBody.classList.remove("hidden");
          card.classList.add("expanded");
        }
      }
      body.replaceChild(card, last);
    } else {
      body.appendChild(card);
    }
    updateActivityTime(group);
    if (shouldScroll) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
      updateUsageBar();
    }
    return;
  }

  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;
  if (Number.isInteger(options.messageIndex)) {
    msgDiv.dataset.messageIndex = String(options.messageIndex);
  }

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  if (role === "file-artifact") {
    msgDiv.className = "message file-artifact-msg";
    msgDiv.appendChild(renderFileArtifact(content));
    chatHistory.appendChild(msgDiv);
    if (shouldScroll) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
      updateUsageBar();
    }
    return;
  }

  if (role === "reasoning") {
    msgDiv.className = "message reasoning-msg";
    msgDiv.appendChild(renderReasoningDisclosure(content));
    chatHistory.appendChild(msgDiv);
    if (shouldScroll) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
      updateUsageBar();
    }
    return;
  }

  if (attachments && attachments.length > 0) {
    const attachmentContainer = document.createElement("div");
    attachmentContainer.className = "msg-attachments-container";
    attachments.forEach(attachment => {
      const kind = attachment.kind || getAttachmentKind(attachment);
      if (kind === "image" && attachment.dataUrl) {
        const img = document.createElement("img");
        img.className = "msg-attached-img";
        img.src = attachment.dataUrl;
        img.alt = attachment.name || "Attached image";
        attachmentContainer.appendChild(img);
        return;
      }

      const chip = document.createElement("div");
      chip.className = "msg-attached-file";
      chip.innerHTML = `
        <span class="attached-file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </span>
        <span class="attached-file-text">
          <span class="attached-file-name">${escapeHtml(attachment.name || "attachment")}</span>
          <span class="attached-file-meta">${escapeHtml(kind)} - ${escapeHtml(formatBytes(attachment.size))}</span>
        </span>
      `;
      attachmentContainer.appendChild(chip);
    });
    contentDiv.appendChild(attachmentContainer);
  }
  
  const textParagraph = document.createElement("div");
  textParagraph.className = "markdown message-text";
  textParagraph.innerHTML = formatMarkdown(content);
  contentDiv.appendChild(textParagraph);

  if (role === "assistant") {
    // Fold the tool trace and file cards produced during this turn into the
    // reply card so trace, text, and files render as one unified block.
    const absorbed = [];
    let prev = chatHistory.lastElementChild;
    while (
      prev &&
      (prev.classList.contains("tool-activity-group") ||
        prev.classList.contains("file-artifact-msg") ||
        prev.classList.contains("reasoning-msg"))
    ) {
      absorbed.unshift(prev);
      prev = prev.previousElementSibling;
    }
    let lastTrace = null;
    for (const el of absorbed) {
      if (el.classList.contains("tool-activity-group")) {
        if (lastTrace) {
          // Adjacent trace boxes collapse into one, like the design.
          const targetBody = lastTrace.querySelector(".activity-group-body");
          const sourceBody = el.querySelector(".activity-group-body");
          while (targetBody && sourceBody && sourceBody.firstElementChild) {
            targetBody.appendChild(sourceBody.firstElementChild);
          }
          recordActivityTimestamp(lastTrace, Number(el.dataset.firstTs));
          recordActivityTimestamp(lastTrace, Number(el.dataset.lastTs));
          updateActivityTime(lastTrace);
          el.remove();
        } else {
          el.classList.remove("message");
          contentDiv.insertBefore(el, textParagraph);
          lastTrace = el;
        }
      } else if (el.classList.contains("reasoning-msg")) {
        const card = el.querySelector(".reasoning-card");
        if (card) contentDiv.insertBefore(card, textParagraph);
        el.remove();
        lastTrace = null;
      } else {
        const card = el.querySelector(".file-artifact");
        if (card) contentDiv.appendChild(card);
        el.remove();
      }
    }

    // "N tools · done" on the blob's tab strip; totals accumulate on the
    // leading segment when a multi-phase turn fuses into one card.
    const toolCount = contentDiv.querySelectorAll(".tool-activity-group .tool-card").length;
    let leaderContent = contentDiv;
    let leader = prev;
    while (
      leader &&
      leader.classList.contains("assistant") &&
      !leader.classList.contains("loading-msg")
    ) {
      const candidate = leader.querySelector(".message-content:not(.reasoning-card)");
      if (candidate) leaderContent = candidate;
      leader = leader.previousElementSibling;
    }
    const totalTools = Number(leaderContent.dataset.toolsTotal || 0) + toolCount;
    if (totalTools > 0) {
      leaderContent.dataset.toolsTotal = String(totalTools);
      leaderContent.dataset.tabMeta = `${totalTools} tool${totalTools === 1 ? "" : "s"} · done`;
    }
  }

  msgDiv.appendChild(contentDiv);
  
  const metaDiv = document.createElement("div");
  metaDiv.className = "message-meta";
  const metaLabel = document.createElement("span");
  metaLabel.className = "message-meta-label";
  metaLabel.textContent = getMessageMetaLabel(role, options.messageIndex);
  metaDiv.appendChild(metaLabel);

  if (canEditStoredMessage(role, options.messageIndex)) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "message-edit-btn";
    editBtn.title = "Edit message";
    editBtn.setAttribute("aria-label", "Edit message");
    editBtn.innerHTML = EDIT_ICON;
    editBtn.addEventListener("click", () => startMessageEdit(msgDiv, options.messageIndex));
    metaDiv.appendChild(editBtn);
  }
  msgDiv.appendChild(metaDiv);
  
  chatHistory.appendChild(msgDiv);
  
  bindCopyButtons(contentDiv);

  if (shouldScroll) {
    chatHistory.scrollTop = chatHistory.scrollHeight;
    updateUsageBar();
  }
}

function getMessageMetaLabel(role, messageIndex) {
  const fallback = role === "user" ? "You" : "Margin";
  const msg = getStoredMessage(messageIndex);
  if (!msg?.editedAt) return fallback;
  return `${fallback} - edited`;
}

function getStoredMessage(messageIndex) {
  if (!Number.isInteger(messageIndex) || !currentChatId || !chats[currentChatId]) return null;
  const messages = chats[currentChatId].messages;
  if (!Array.isArray(messages) || messageIndex < 0 || messageIndex >= messages.length) return null;
  return messages[messageIndex] || null;
}

function canEditStoredMessage(role, messageIndex) {
  const msg = getStoredMessage(messageIndex);
  if (!msg || msg.role !== role) return false;
  if (role === "user") return true;
  return role === "assistant" && !Array.isArray(msg.tool_calls);
}

function startMessageEdit(msgDiv, messageIndex) {
  const msg = getStoredMessage(messageIndex);
  if (!msg || !canEditStoredMessage(msg.role, messageIndex)) return;
  if (isAgentRunning) {
    showToast("Stop the current response before editing a message");
    return;
  }

  const contentDiv = msgDiv.querySelector(".message-content");
  const messageText = contentDiv?.querySelector(":scope > .message-text");
  const metaDiv = msgDiv.querySelector(".message-meta");
  if (!contentDiv || !messageText || !metaDiv) return;

  const originalText = msg.content || "";
  const editor = document.createElement("div");
  editor.className = "message-editor";
  editor.innerHTML = `
    <textarea class="message-edit-textarea" rows="3"></textarea>
    <div class="message-edit-actions">
      <button type="button" class="message-edit-action message-edit-save" title="Save edit" aria-label="Save edit">${CHECK_ICON}</button>
      <button type="button" class="message-edit-action" title="Cancel edit" aria-label="Cancel edit">${X_ICON}</button>
    </div>
  `;

  const textarea = editor.querySelector(".message-edit-textarea");
  const saveBtn = editor.querySelector(".message-edit-save");
  const cancelBtn = editor.querySelector(".message-edit-action:not(.message-edit-save)");

  textarea.value = originalText;
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";

  const finishCancel = () => {
    editor.replaceWith(messageText);
    metaDiv.classList.remove("editing");
  };

  messageText.replaceWith(editor);
  metaDiv.classList.add("editing");
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finishCancel();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      commitMessageEdit(messageIndex, textarea.value);
    }
  });

  saveBtn.addEventListener("click", () => commitMessageEdit(messageIndex, textarea.value));
  cancelBtn.addEventListener("click", finishCancel);
}

async function commitMessageEdit(messageIndex, nextContent) {
  const msg = getStoredMessage(messageIndex);
  if (!msg || !canEditStoredMessage(msg.role, messageIndex) || isAgentRunning) return;

  const trimmed = String(nextContent || "").trim();
  const hasAttachments = getDisplayAttachments(msg).length > 0;
  if (!trimmed && !hasAttachments) {
    showToast("Message cannot be empty");
    return;
  }

  const runChatId = currentChatId;
  const activeChat = chats[runChatId];
  const originalRole = msg.role;
  const changed = (msg.content || "") !== trimmed;

  if (!changed) {
    renderChatHistory();
    return;
  }

  activeChat.messages[messageIndex] = {
    ...msg,
    content: trimmed,
    editedAt: Date.now()
  };
  activeChat.timestamp = Date.now();

  if (messageIndex === 0 && originalRole === "user") {
    if (activeChat.titleMode !== "manual") {
      activeChat.title = makeFallbackChatTitle(trimmed);
      activeChat.titleMode = "auto";
      activeChat.titleGeneratedAt = null;
    }
  }

  if (originalRole === "user") {
    activeChat.messages = activeChat.messages.slice(0, messageIndex + 1);
  }

  if (originalRole === "user") beginAgentRun(runChatId);
  try {
    await saveChats();
    renderChatHistory();
    renderHistoryList();

    if (originalRole !== "user") {
      showToast("Message edited");
      return;
    }
    if (settings.aiProvider === "openai") await refreshProviderBadge();
    if (!isActiveProviderReady() || !settings.dataSharingConsent) {
      showToast(settings.aiProvider === "openai"
        ? "Message edited. Link OpenAI to regenerate."
        : "Message edited. Add an OpenRouter key to regenerate.");
      return;
    }

    showToast("Message edited. Regenerating...");
    await runAgentCycle(runChatId);
  } finally {
    if (originalRole === "user") {
      if (agentStopRequested) {
        await recordAgentStopped(runChatId);
      }
      endAgentRun();
    }
  }
}

export function sanitizeToolDisplay(name, args, result) {
  if (name === "browser_batch") {
    // One status row for the whole batch: list the actions, not their payloads.
    const actions = Array.isArray(args?.actions) ? args.actions : [];
    let summary = result;
    try {
      const parsed = typeof result === "string" ? JSON.parse(result) : result;
      if (Array.isArray(parsed?.results)) {
        summary = [
          parsed.summary,
          ...(parsed.stopped_early ? [`stopped early: ${parsed.stopped_early}`] : []),
          ...parsed.results.map((entry) =>
            `${entry.index + 1}. ${entry.tool || "?"} — ${entry.status}${entry.error ? `: ${entry.error}` : ""}`)
        ].join("\n");
      }
    } catch {}
    return {
      args: actions.length ? { actions: actions.map((action) => action?.tool || "?") } : undefined,
      result: summary
    };
  }
  if (name === "write_file") {
    const lineCount = args?.content ? String(args.content).split("\n").length : undefined;
    return {
      args: args ? { path: args.path, lines: lineCount } : undefined,
      result: result && typeof result === "object" && result.type === "file"
        ? { path: result.path, action: result.action, lines: result.lines }
        : result
    };
  }
  if (name === "read_file") {
    const summary = typeof result === "string"
      ? `${result.split("\n").length} lines loaded`
      : result;
    return {
      args: args ? { path: args.path } : undefined,
      result: summary
    };
  }
  if (name === "list_files" || name === "search_files") {
    return { args: args?.query || args?.tag ? args : undefined, result: typeof result === "string" ? result.slice(0, 800) : result };
  }
  if (name === "get_file_info" || name === "delete_file" || name === "rename_file") {
    return { args, result: typeof result === "string" ? result.slice(0, 500) : result };
  }
  if (name.startsWith("get_network") || name.startsWith("start_network") || name.startsWith("stop_network") || name === "clear_network_logs") {
    return {
      args: args && Object.keys(args).length > 0 ? args : undefined,
      result: typeof result === "string" ? result.slice(0, 3000) : result
    };
  }
  return { args, result };
}

function renderFileArtifact(artifact) {
  const file = getWorkspaceFile(artifact.path);
  const wrapper = document.createElement("div");
  wrapper.className = "message-content";

  if (!file) {
    wrapper.innerHTML = `<div class="file-artifact missing"><span class="file-name">${escapeHtml(artifact.path || "unknown")}</span><span class="file-meta">File no longer in workspace</span></div>`;
    return wrapper;
  }

  const lines = file.content.split("\n").length;
  const actionLabel = artifact.action === "updated" ? "Updated" : "Created";
  const actionClass = artifact.action === "updated" ? "updated" : "created";
  const codeId = `file-code-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const card = document.createElement("div");
  card.className = `file-artifact action-${actionClass}`;
  card.innerHTML = `
    <div class="file-artifact-header">
      <button type="button" class="file-artifact-toggle" aria-expanded="false">
        <span class="file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </span>
        <span class="file-info">
          <span class="file-name">${escapeHtml(file.path)}</span>
          <span class="file-meta">
            <span class="file-action-tag ${actionClass}">${escapeHtml(actionLabel)}</span>
            <span class="file-meta-sep">·</span>
            <span>${escapeHtml(file.language)}</span>
            <span class="file-meta-sep">·</span>
            <span>${lines} lines</span>
            ${file.description ? `<span class="file-meta-sep">·</span><span class="file-desc">${escapeHtml(file.description)}</span>` : ""}
          </span>
        </span>
        <span class="file-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </button>
      <button type="button" class="copy-file-btn">Copy</button>
    </div>
    <div class="file-artifact-body hidden">
      <pre><code id="${codeId}" class="language-${escapeHtml(file.language)}">${escapeHtml(file.content)}</code></pre>
    </div>
  `;

  bindFileArtifact(card, file);
  wrapper.appendChild(card);
  return wrapper;
}

function bindFileArtifact(card, file) {
  const toggle = card.querySelector(".file-artifact-toggle");
  const body = card.querySelector(".file-artifact-body");
  const copyBtn = card.querySelector(".copy-file-btn");

  if (toggle && body) {
    toggle.addEventListener("click", () => {
      const expanded = body.classList.toggle("hidden") === false;
      card.classList.toggle("expanded", expanded);
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(file.content).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1300);
      });
    });
  }
}

function ensureActivityGroup(chatHistory) {
  const last = chatHistory.lastElementChild;
  if (last && last.classList.contains("tool-activity-group")) {
    return last;
  }

  const group = document.createElement("div");
  group.className = "message tool-activity-group";
  group.innerHTML = `
    <div class="activity-group-header">
      <button type="button" class="activity-toggle" aria-expanded="false" title="Show tool details">
        <span class="activity-arrow" aria-hidden="true">&#9656;</span>
        <span class="activity-label">trace</span>
      </button>
      <span class="activity-time"></span>
    </div>
    <div class="activity-group-body"></div>
  `;

  const toggle = group.querySelector(".activity-toggle");
  toggle.addEventListener("click", () => {
    const allExpanded = !group.classList.contains("all-expanded");
    group.classList.toggle("all-expanded", allExpanded);
    toggle.setAttribute("aria-expanded", allExpanded ? "true" : "false");
    group.querySelectorAll(".tool-card").forEach(card => {
      const body = card.querySelector(".tool-card-body");
      if (!body) return;
      body.classList.toggle("hidden", !allExpanded);
      card.classList.toggle("expanded", allExpanded);
    });
  });

  chatHistory.appendChild(group);
  return group;
}

function recordActivityTimestamp(group, ts) {
  if (!Number.isFinite(ts)) return;
  const first = Number(group.dataset.firstTs || 0);
  const last = Number(group.dataset.lastTs || 0);
  if (!first || ts < first) group.dataset.firstTs = String(ts);
  if (!last || ts > last) group.dataset.lastTs = String(ts);
}

function updateActivityTime(group) {
  const timeEl = group.querySelector(".activity-time");
  if (!timeEl) return;
  const first = Number(group.dataset.firstTs || 0);
  const last = Number(group.dataset.lastTs || 0);
  const secs = first && last ? (last - first) / 1000 : 0;
  timeEl.textContent = secs >= 0.1 ? `${secs.toFixed(1)}s` : "";
}

function buildToolSummary(name, args, result, stage) {
  if (stage === "call" && (result === undefined || result === null || result === "")) {
    if (name === "browser_batch") {
      const count = Array.isArray(args?.actions) ? args.actions.length : 0;
      return count ? `${count} actions` : "batching…";
    }
    if (name === "click_element") return args?.selector ? `→ ${args.selector}` : "clicking…";
    if (name === "navigate") return args?.url ? `→ ${args.url}` : "navigating…";
    if (name === "type_text") return args?.selector ? `into ${args.selector}` : "typing…";
    if (name === "run_js") return "running script";
    if (name === "get_dom") return "reading page";
    if (name === "take_screenshot") return "capturing screen";
    if (name === "scroll_page") return args?.direction ? `scroll ${args.direction}` : "scrolling";
    if (name === "read_file") return args?.path ? args.path : "reading file";
    if (name === "write_file") return args?.path ? args.path : "writing file";
    if (name === "list_files") return "listing workspace";
    if (name === "search_files") return args?.query ? `"${args.query}"` : "searching files";
    if (name === "get_active_tab" || name === "list_tabs") return "querying tabs";
    if (name && name.startsWith("start_network")) return "recording requests";
    if (name && name.startsWith("get_network")) return "inspecting requests";
    if (name && name.startsWith("mcp__")) return "calling";
    if (args && typeof args === "object") {
      const firstVal = Object.values(args)[0];
      if (typeof firstVal === "string") return firstVal.length > 60 ? firstVal.slice(0, 60) + "…" : firstVal;
    }
    return "running";
  }

  const SUMMARY_MAX = 44;
  const shorten = (text) => {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    if (!oneLine || oneLine === "undefined") return "done";
    return oneLine.length > SUMMARY_MAX ? oneLine.slice(0, SUMMARY_MAX).trimEnd() + "…" : oneLine;
  };

  if (typeof result === "string") return shorten(result);
  if (result && typeof result === "object") {
    if (typeof result.lines === "number") return `${result.lines} lines`;
    if (typeof result.path === "string") return shorten(result.path);
    if (Array.isArray(result)) return `${result.length} items`;
    const keys = Object.keys(result);
    if (keys.length) return keys.slice(0, 3).join(", ");
  }
  return "done";
}

function renderToolStatus(content) {
  const details = normalizeToolStatus(content);
  const sanitized = sanitizeToolDisplay(details.name, details.args, details.result);
  const stage = details.stage || "status";
  const safeName = escapeHtml(details.name || "browser_tool");

  const hasArgs = sanitized.args !== undefined && sanitized.args !== null
    && (typeof sanitized.args !== "object" || Object.keys(sanitized.args).length > 0);
  const hasResult = sanitized.result !== undefined && sanitized.result !== null && sanitized.result !== "";
  const argsText = hasArgs ? prettyPrint(sanitized.args) : "";
  const resultText = hasResult ? prettyPrint(sanitized.result) : "";
  const hasBody = !!(argsText || resultText);

  const summaryLine = buildToolSummary(details.name, sanitized.args, sanitized.result, stage);

  const card = document.createElement("div");
  card.className = `tool-card stage-${escapeHtml(stage)}${hasBody ? "" : " no-body"}`;
  card.dataset.toolName = details.name || "browser_tool";
  card.innerHTML = `
    <div class="tool-card-summary">
      <span class="tool-status-dot" data-stage="${escapeHtml(stage)}" aria-hidden="true"></span>
      <span class="tool-name-compact">${safeName}</span>
      ${summaryLine ? `<span class="tool-summary-text">${escapeHtml(summaryLine)}</span>` : ""}
    </div>
    ${hasBody ? `
      <div class="tool-card-body hidden">
        ${argsText ? `<div class="tool-field"><span class="tool-label">Arguments</span><pre class="tool-value">${escapeHtml(argsText)}</pre></div>` : ""}
        ${resultText ? `<div class="tool-field"><span class="tool-label">Result</span><pre class="tool-value">${escapeHtml(resultText)}</pre></div>` : ""}
      </div>` : ""}
  `;

  return card;
}

export function extractReasoningText(message) {
  if (!message || typeof message !== "object") return "";
  const candidates = [
    message.reasoning,
    message.reasoning_content,
    message.thinking,
    message.thinking_content
  ];

  if (Array.isArray(message.reasoning_details)) {
    candidates.push(message.reasoning_details);
  }
  if (Array.isArray(message.reasoningDetails)) {
    candidates.push(message.reasoningDetails);
  }

  const parts = [];
  candidates.forEach((candidate) => {
    if (!candidate) return;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => {
        if (!item) return;
        if (typeof item === "string") {
          const trimmed = item.trim();
          if (trimmed) parts.push(trimmed);
          return;
        }
        if (typeof item === "object") {
          const text = item.text || item.content || item.reasoning || item.summary;
          if (typeof text === "string" && text.trim()) {
            parts.push(text.trim());
          }
        }
      });
      return;
    }
    if (typeof candidate === "object") {
      const text = candidate.text || candidate.content || candidate.reasoning || candidate.summary;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
    }
  });

  return [...new Set(parts)].join("\n\n").trim();
}

function renderReasoningDisclosure(content) {
  const text = typeof content === "string" ? content.trim() : prettyPrint(content).trim();
  const expandedByDefault = normalizeReasoningSettings(settings.reasoning).keepThinkingOpen;
  const wrapper = document.createElement("div");
  wrapper.className = `message-content reasoning-card${expandedByDefault ? " expanded" : ""}`;
  wrapper.innerHTML = `
    <div class="reasoning-header">
      <button type="button" class="reasoning-toggle" aria-expanded="${expandedByDefault ? "true" : "false"}">
        <span class="reasoning-arrow" aria-hidden="true">&#9656;</span>
        <span class="reasoning-title">thinking</span>
        <span class="reasoning-meta">${escapeHtml(formatTokens(approxTokens(text)))} tok</span>
      </button>
      <button type="button" class="reasoning-all-action" data-action="${expandedByDefault ? "close" : "open"}">
        ${expandedByDefault ? "close all" : "open all"}
      </button>
    </div>
    <div class="reasoning-body${expandedByDefault ? "" : " hidden"}">
      <div class="markdown message-text">${formatMarkdown(text)}</div>
    </div>
  `;

  const toggle = wrapper.querySelector(".reasoning-toggle");
  const action = wrapper.querySelector(".reasoning-all-action");
  const body = wrapper.querySelector(".reasoning-body");
  if (toggle && body) {
    toggle.addEventListener("click", () => {
      const expanded = body.classList.toggle("hidden") === false;
      wrapper.classList.toggle("expanded", expanded);
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (action) {
        action.dataset.action = expanded ? "close" : "open";
        action.textContent = expanded ? "close all" : "open all";
      }
    });
  }
  if (action) {
    action.addEventListener("click", async () => {
      const shouldOpen = action.dataset.action !== "close";
      await setThinkingOpenDefault(shouldOpen);
      showToast(shouldOpen ? "Thinking tabs opened and will stay open" : "Thinking tabs closed");
    });
  }

  bindCopyButtons(wrapper);
  return wrapper;
}

function normalizeToolStatus(content) {
  if (content && typeof content === "object") {
    return {
      stage: content.stage || "status",
      name: content.name || content.toolName || "browser_tool",
      args: content.args,
      result: content.result
    };
  }

  return { stage: "status", name: "browser_tool", result: stripHtml(String(content || "")) };
}
