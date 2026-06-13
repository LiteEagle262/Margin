// sidepanel/ui/workspace-strip.js - Chat-scoped file chip strip above the
// composer, plus the full-screen file viewer overlay.

import { escapeHtml } from "../lib/format.js";
import { getWorkspaceFile, getActiveChatFiles } from "../features/workspace.js";

// ----------------------------------------------------
// WORKSPACE STRIP & FILE VIEWER
// ----------------------------------------------------
// The strip above the input is the chat-scoped file index: it shows only the
// files that belong to the currently open chat (extensions, userscripts,
// scrapers, configs — whatever the agent produced in this conversation).
// Re-renders on every workspace mutation and on chat switch.
export function renderWorkspaceStrip() {
  const strip = document.getElementById("workspace-strip");
  const chipsEl = document.getElementById("workspace-strip-chips");
  if (!strip || !chipsEl) return;

  // Always visible — even an empty chat shows the strip with a hint, so the
  // user learns where files will appear once the agent saves them.
  strip.classList.remove("hidden");

  const files = Object.values(getActiveChatFiles())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const countEl = strip.querySelector(".workspace-count");
  if (countEl) {
    countEl.textContent = files.length === 0
      ? "empty"
      : (files.length === 1 ? "1 file" : `${files.length} files`);
  }

  strip.classList.toggle("is-empty", files.length === 0);
  chipsEl.innerHTML = "";

  if (files.length === 0) {
    const hint = document.createElement("div");
    hint.className = "workspace-empty-hint";
    hint.innerHTML = `
      <span class="empty-hint-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14"/><path d="M5 12h14"/>
        </svg>
      </span>
      <span>Ask for a scraper, userscript, or extension — files saved here pop up as chips you can open and copy.</span>
    `;
    chipsEl.appendChild(hint);
    return;
  }

  const recentCutoff = Date.now() - 60 * 1000;

  files.forEach((file) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "workspace-chip";
    if ((file.updatedAt || 0) > recentCutoff) chip.classList.add("recent");

    const name = file.path.split("/").pop() || file.path;
    const lines = file.content.split("\n").length;

    chip.innerHTML = `
      <span class="chip-dot" aria-hidden="true"></span>
      <span class="chip-name">${escapeHtml(name)}</span>
      <span class="chip-meta">${lines}L</span>
    `;
    chip.title = `${file.path}${file.description ? `\n${file.description}` : ""}`;
    chip.addEventListener("click", () => openFileViewer(file.path));
    chipsEl.appendChild(chip);
  });
}

export function openFileViewer(path) {
  const file = getWorkspaceFile(path);
  const overlay = document.getElementById("file-viewer-overlay");
  if (!file || !overlay) return;

  const nameEl = overlay.querySelector(".file-viewer-name");
  const metaEl = overlay.querySelector(".file-viewer-meta");
  const codeEl = overlay.querySelector(".file-viewer-code code");
  const copyBtn = overlay.querySelector(".file-viewer-copy");
  if (!nameEl || !metaEl || !codeEl || !copyBtn) return;

  const lines = file.content.split("\n").length;
  nameEl.textContent = file.path;
  metaEl.textContent = `${file.language} · ${lines} lines${file.description ? ` · ${file.description}` : ""}`;
  codeEl.textContent = file.content;
  codeEl.className = `language-${file.language}`;

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  // Defer focus so the transition can play.
  requestAnimationFrame(() => overlay.classList.add("open"));

  copyBtn.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(file.content).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1300);
    });
  };
}

function closeFileViewer() {
  const overlay = document.getElementById("file-viewer-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  // Wait for fade transition before hiding so visual feels intentional.
  setTimeout(() => overlay.classList.add("hidden"), 160);
}

export function initFileViewer() {
  const overlay = document.getElementById("file-viewer-overlay");
  if (!overlay) return;
  const closeBtn = overlay.querySelector(".file-viewer-close");
  closeBtn?.addEventListener("click", closeFileViewer);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFileViewer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeFileViewer();
  });
}
