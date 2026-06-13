// sidepanel/features/chats.js - Chat session lifecycle: load from storage
// and create new sessions.

import { chats, currentChatId, globalWorkspace, setChats, setCurrentChatId } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { renderChatHistory } from "../ui/chat-view.js";
import { renderHistoryList } from "../ui/history-drawer.js";

// Load multiple chats history
export async function loadChats() {
  try {
    const result = await chrome.storage.local.get(["chats", "currentChatId"]);
    setChats(result.chats || {});
    setCurrentChatId(result.currentChatId || null);

    Object.values(chats).forEach(chat => {
      if (!chat.files) chat.files = {};
      if (!chat.titleMode) chat.titleMode = chat.title && chat.title !== "New Chat" ? "legacy" : "auto";
      Object.entries(chat.files).forEach(([path, file]) => {
        if (!globalWorkspace[path] || (file.updatedAt || 0) >= (globalWorkspace[path].updatedAt || 0)) {
          globalWorkspace[path] = { ...file, chatId: chat.id };
        }
      });
    });

    if (Object.keys(chats).length === 0 || !currentChatId) {
      // Create fresh chat session if empty
      createNewChatSession();
    } else {
      renderChatHistory();
      renderHistoryList();
    }
  } catch (e) {
    console.error("Error loading chats:", e);
  }
}

// Create a new chat session
export function createNewChatSession() {
  const id = Date.now().toString();
  chats[id] = {
    id: id,
    title: "New Chat",
    titleMode: "auto",
    titleGeneratedAt: null,
    messages: [],
    files: {},
    timestamp: Date.now()
  };
  setCurrentChatId(id);
  saveChats();
  renderChatHistory();
  renderHistoryList();
}
