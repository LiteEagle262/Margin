import { chats, currentChatId, globalWorkspace, setChats, setCurrentChatId } from "../state/store.js";
import { saveChats } from "../state/persistence.js";
import { renderChatHistory } from "../ui/chat-view.js";
import { renderHistoryList } from "../ui/history-drawer.js";
import { isSafeVirtualPath, safeRecord } from "../lib/safe-record.js";

export async function loadChats() {
  try {
    const result = await chrome.storage.local.get(["chats", "currentChatId"]);
    setChats(result.chats || {});
    setCurrentChatId(result.currentChatId || null);

    Object.values(chats).forEach(chat => {
      chat.files = safeRecord(chat.files, isSafeVirtualPath);
      if (!chat.titleMode) chat.titleMode = chat.title && chat.title !== "New Chat" ? "legacy" : "auto";
      Object.entries(chat.files).forEach(([path, file]) => {
        if (!globalWorkspace[path] || (file.updatedAt || 0) >= (globalWorkspace[path].updatedAt || 0)) {
          globalWorkspace[path] = { ...file, chatId: chat.id };
        }
      });
    });

    if (Object.keys(chats).length === 0 || !currentChatId) {
      createNewChatSession();
    } else {
      renderChatHistory();
      renderHistoryList();
    }
  } catch (e) {
    console.error("Error loading chats:", e);
  }
}

export function createNewChatSession() {
  const id = Date.now().toString();
  chats[id] = {
    id: id,
    title: "New Chat",
    titleMode: "auto",
    titleGeneratedAt: null,
    messages: [],
    files: Object.create(null),
    timestamp: Date.now()
  };
  setCurrentChatId(id);
  saveChats();
  renderChatHistory();
  renderHistoryList();
}
