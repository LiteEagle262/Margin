import { chats, currentChatId, globalWorkspace, isAgentRunning, setCurrentChatId } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { EDIT_ICON, SPARKLES_ICON } from "./icons.js";
import { renderChatHistory } from "./chat-view.js";
import { createNewChatSession } from "../features/chats.js";
import { removeGlobalFile, saveGlobalWorkspace } from "../features/workspace.js";
import { renameChatManually, generateChatTitle } from "../features/chat-titles.js";
import { showToast } from "../lib/toast.js";

let backdropHideTimer = null;

function closeDrawer() {
  const backdrop = document.getElementById("drawer-backdrop");
  const drawer = document.getElementById("history-drawer");
  if (!drawer || !backdrop) return;

  drawer.classList.remove("active");
  backdrop.classList.remove("active");
  clearTimeout(backdropHideTimer);
  backdropHideTimer = setTimeout(() => backdrop.classList.add("hidden"), 250);
}

export function initHistoryDrawer() {
  const hamburgerBtn = document.getElementById("hamburger-menu-btn");
  const backdrop = document.getElementById("drawer-backdrop");
  const drawer = document.getElementById("history-drawer");
  const newChatBtn = document.getElementById("new-chat-btn");

  if (hamburgerBtn && drawer && backdrop) {
    hamburgerBtn.addEventListener("click", () => {
      clearTimeout(backdropHideTimer);
      drawer.classList.add("active");
      backdrop.classList.remove("hidden");
      setTimeout(() => backdrop.classList.add("active"), 10);
    });

    backdrop.addEventListener("click", closeDrawer);

    if (newChatBtn) {
      newChatBtn.addEventListener("click", () => {
        if (isAgentRunning) {
          showToast("Stop the current response before starting another chat");
          return;
        }
        createNewChatSession();
        closeDrawer();
      });
    }
  }
}

function getChatSortTime(chat) {
  const timestamp = Number(chat?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;

  const idTimestamp = Number(chat?.id);
  if (Number.isFinite(idTimestamp) && idTimestamp > 0) return idTimestamp;

  return 0;
}

export function renderHistoryList() {
  const historyList = document.getElementById("history-list");
  if (!historyList) return;

  historyList.innerHTML = "";

  const sortedSessions = Object.values(chats).sort((a, b) => getChatSortTime(b) - getChatSortTime(a));

  sortedSessions.forEach(session => {
    const item = document.createElement("div");
    item.className = `history-item ${session.id === currentChatId ? "active" : ""}`;
    
    const textSpan = document.createElement("span");
    textSpan.className = "history-item-title";
    textSpan.textContent = session.title || "New Chat";
    item.appendChild(textSpan);

    // The whole row switches chats — a listener only on the title span left
    // dead zones above/below the text where clicks did nothing.
    item.addEventListener("click", () => {
      if (isAgentRunning && session.id !== currentChatId) {
        showToast("Stop the current response before switching chats");
        return;
      }
      setCurrentChatId(session.id);
      saveChats();
      renderChatHistory();
      renderHistoryList();
      closeDrawer();
    });

    const actions = document.createElement("div");
    actions.className = "history-item-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "history-item-action";
    renameBtn.title = "Rename Chat";
    renameBtn.setAttribute("aria-label", "Rename chat");
    renameBtn.innerHTML = EDIT_ICON;
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameChatManually(session.id);
    });
    actions.appendChild(renameBtn);

    const aiRenameBtn = document.createElement("button");
    aiRenameBtn.className = "history-item-action";
    aiRenameBtn.title = "Generate Chat Name";
    aiRenameBtn.setAttribute("aria-label", "Generate chat name");
    aiRenameBtn.innerHTML = SPARKLES_ICON;
    aiRenameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await generateChatTitle(session.id);
    });
    actions.appendChild(aiRenameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "history-item-action history-item-delete";
    deleteBtn.title = "Delete Chat";
    deleteBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
      </svg>
    `;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChatSession(session.id);
    });
    actions.appendChild(deleteBtn);
    item.appendChild(actions);

    historyList.appendChild(item);
  });
}

function deleteChatSession(id) {
  if (isAgentRunning) {
    showToast("Stop the current response before deleting a chat");
    return;
  }
  if (confirm("Are you sure you want to delete this chat session?")) {
    Object.keys(chats[id]?.files || {}).forEach((path) => {
      if (globalWorkspace[path]?.chatId === id) removeGlobalFile(path);
    });
    delete chats[id];
    saveGlobalWorkspace();
    if (currentChatId === id) {
      const keys = Object.keys(chats);
      if (keys.length > 0) {
        setCurrentChatId(keys[0]);
      } else {
        createNewChatSession();
        return;
      }
    }
    saveChats();
    renderChatHistory();
    renderHistoryList();
  }
}
