import { chats, currentChatId, globalWorkspace } from "../state/store.js";
import { saveChats, persistGlobalWorkspace } from "../state/persistence.js";
import { renderWorkspaceStrip } from "../ui/workspace-strip.js";
import { getContextItem } from "../agent/context.js";
import { isSafeVirtualPath, safeRecord } from "../lib/safe-record.js";

function workspacePath(value) {
  const path = String(value || "").trim().replaceAll("\\", "/");
  return isSafeVirtualPath(path) ? path : "";
}

export async function saveGlobalWorkspace() {
  await persistGlobalWorkspace();
  renderWorkspaceStrip();
}


export function syncChatFileToGlobal(path, fileRecord) {
  if (!isSafeVirtualPath(path)) return;
  globalWorkspace[path] = { ...fileRecord };
}

export function removeGlobalFile(path) {
  if (!isSafeVirtualPath(path)) return;
  delete globalWorkspace[path];
}

export function getWorkspaceFile(path) {
  if (!isSafeVirtualPath(path)) return null;
  const chatFiles = getActiveChatFiles();
  return chatFiles[path] || globalWorkspace[path] || null;
}

export function getAllWorkspaceFiles() {
  const merged = safeRecord(globalWorkspace, isSafeVirtualPath);
  const chatFiles = getActiveChatFiles();
  Object.assign(merged, chatFiles);
  return merged;
}

export function formatFileListing(file) {
  const lines = file.content.split("\n").length;
  const tags = Array.isArray(file.tags) && file.tags.length > 0
    ? ` [${file.tags.join(", ")}]`
    : "";
  const desc = file.description ? `: ${file.description}` : "";
  return `- ${file.path} (${file.language}, ${lines} lines)${tags}${desc}`;
}


export function inferLanguageFromPath(path, fallback = "text") {
  const ext = String(path || "").split(".").pop()?.toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    json: "json", html: "html", css: "css", sh: "shell",
    md: "markdown", yaml: "yaml", yml: "yaml", sql: "sql"
  };
  return map[ext] || fallback;
}

export function getActiveChatFiles() {
  const chat = chats[currentChatId];
  if (!chat) return Object.create(null);
  chat.files = safeRecord(chat.files, isSafeVirtualPath);
  return chat.files;
}

export async function executeWorkspaceTool(name, args = {}) {
  const files = getActiveChatFiles();

  switch (name) {
    case "write_file": {
      if (!args.path || args.content === undefined || args.content === null) {
        return "Error: write_file requires path and content.";
      }
      const path = workspacePath(args.path);
      if (!path) return "Error: write_file requires a safe relative path.";
      const existing = getWorkspaceFile(path);
      const language = args.language || inferLanguageFromPath(path);
      const tags = Array.isArray(args.tags)
        ? args.tags.map(String).filter(Boolean)
        : (existing?.tags || []);
      const record = {
        path,
        content: String(args.content),
        language,
        description: args.description ? String(args.description) : (existing?.description || ""),
        tags,
        updatedAt: Date.now(),
        chatId: currentChatId
      };
      files[path] = record;
      syncChatFileToGlobal(path, record);
      await saveChats();
      await saveGlobalWorkspace();
      const lines = String(args.content).split("\n").length;
      return {
        type: "file",
        action: existing ? "updated" : "created",
        path,
        language,
        lines,
        description: record.description,
        message: `Saved ${path} (${lines} lines).`
      };
    }

    case "read_file": {
      const path = workspacePath(args.path);
      if (!path) return "Error: read_file requires a safe relative path.";
      const file = getWorkspaceFile(path);
      if (!file) {
        return `Error: File "${path}" not found in workspace. Use list_files or search_files to find available files.`;
      }
      return file.content;
    }

    case "read_context_item": {
      const contextItemId = String(args.context_item_id || "").trim();
      if (!contextItemId) return "Error: read_context_item requires context_item_id.";
      const item = getContextItem(contextItemId);
      if (!item) {
        return `Error: Context item "${contextItemId}" was not found in the current chat.`;
      }
      return item.content || "";
    }

    case "list_files": {
      const allFiles = Object.values(getAllWorkspaceFiles());
      const tagFilter = args.tag ? String(args.tag).trim().toLowerCase() : "";
      const entries = allFiles.filter((file) => {
        if (!tagFilter) return true;
        return Array.isArray(file.tags) && file.tags.some((tag) => String(tag).toLowerCase() === tagFilter);
      });
      if (entries.length === 0) {
        return tagFilter
          ? `No files found with tag "${args.tag}".`
          : "Workspace is empty — no files saved yet.";
      }
      return entries
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(formatFileListing)
        .join("\n");
    }

    case "search_files": {
      const query = String(args.query || "").trim().toLowerCase();
      if (!query) return "Error: search_files requires query.";
      const searchIn = args.search_in || "all";
      const limit = Math.min(Number(args.limit) || 20, 50);
      const matches = Object.values(getAllWorkspaceFiles()).filter((file) => {
        const pathMatch = file.path.toLowerCase().includes(query);
        const descMatch = String(file.description || "").toLowerCase().includes(query);
        const contentMatch = file.content.toLowerCase().includes(query);
        const tagMatch = Array.isArray(file.tags) && file.tags.some((tag) => String(tag).toLowerCase().includes(query));
        if (searchIn === "path") return pathMatch;
        if (searchIn === "description") return descMatch;
        if (searchIn === "content") return contentMatch;
        if (searchIn === "tags") return tagMatch;
        return pathMatch || descMatch || contentMatch || tagMatch;
      });
      if (matches.length === 0) return `No files matched "${args.query}".`;
      return matches
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit)
        .map(formatFileListing)
        .join("\n");
    }

    case "get_file_info": {
      const path = workspacePath(args.path);
      if (!path) return "Error: get_file_info requires a safe relative path.";
      const file = getWorkspaceFile(path);
      if (!file) return `Error: File "${path}" not found in workspace.`;
      return JSON.stringify({
        path: file.path,
        language: file.language,
        lines: file.content.split("\n").length,
        description: file.description || "",
        tags: file.tags || [],
        updatedAt: file.updatedAt || null,
        chatId: file.chatId || null
      }, null, 2);
    }

    case "rename_file": {
      const oldPath = workspacePath(args.old_path);
      const newPath = workspacePath(args.new_path);
      if (!oldPath || !newPath) return "Error: rename_file requires old_path and new_path.";
      const file = getWorkspaceFile(oldPath);
      if (!file) return `Error: File "${oldPath}" not found in workspace.`;
      if (getWorkspaceFile(newPath) && newPath !== oldPath) {
        return `Error: Destination path "${newPath}" already exists.`;
      }
      const renamed = { ...file, path: newPath, updatedAt: Date.now() };
      delete files[oldPath];
      files[newPath] = renamed;
      removeGlobalFile(oldPath);
      syncChatFileToGlobal(newPath, renamed);
      await saveChats();
      await saveGlobalWorkspace();
      return `Renamed ${oldPath} -> ${newPath}.`;
    }

    case "delete_file": {
      const path = workspacePath(args.path);
      if (!path) return "Error: delete_file requires a safe relative path.";
      const file = getWorkspaceFile(path);
      if (!file) return `Error: File "${path}" not found in workspace.`;
      delete files[path];
      removeGlobalFile(path);
      await saveChats();
      await saveGlobalWorkspace();
      return `Deleted ${path}.`;
    }

    default:
      return `Error: Unknown workspace tool "${name}"`;
  }
}
