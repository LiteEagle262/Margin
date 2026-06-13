// sidepanel/lib/markdown.js - Minimal markdown-to-HTML renderer for chat
// messages, plus the click bindings for the code blocks it emits.

import { escapeHtml } from "./format.js";

export function formatMarkdown(text) {
  if (!text) return "";

  const source = String(text).replace(/\r\n/g, "\n");
  const codeBlocks = [];
  const tokenized = source.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const id = `code-${Date.now()}-${codeBlocks.length}`;
    codeBlocks.push({
      id,
      lang: (lang || "text").trim() || "text",
      code: code.replace(/^\n|\n$/g, "")
    });
    return `\n@@CODE_BLOCK_${codeBlocks.length - 1}@@\n`;
  });

  const blocks = tokenized.split(/\n{2,}/);
  const html = blocks.map(block => renderMarkdownBlock(block.trim(), codeBlocks)).filter(Boolean).join("");
  return html || `<p>${formatInlineMarkdown(escapeHtml(source))}</p>`;
}

function renderMarkdownBlock(block, codeBlocks) {
  if (!block) return "";

  const codeMatch = block.match(/^@@CODE_BLOCK_(\d+)@@$/);
  if (codeMatch) {
    const item = codeBlocks[Number(codeMatch[1])];
    if (!item) return "";
    const safeLang = escapeHtml(item.lang);
    const safeCode = escapeHtml(item.code);
    const lineCount = item.code.split("\n").length;
    return `
      <div class="code-container collapsed">
        <div class="code-header code-header-toggle">
          <span>${safeLang} · ${lineCount} lines</span>
          <button type="button" class="copy-code-btn" data-copy-target="${item.id}">Copy</button>
        </div>
        <pre style="display:none"><code id="${item.id}" class="language-${safeLang}">${safeCode}</code></pre>
      </div>
    `;
  }

  const lines = block.split("\n");
  if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
    const items = lines.map(line => `<li>${formatInlineMarkdown(escapeHtml(line.replace(/^\s*[-*]\s+/, "")))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }

  if (lines.every(line => /^\s*\d+\.\s+/.test(line))) {
    const items = lines.map(line => `<li>${formatInlineMarkdown(escapeHtml(line.replace(/^\s*\d+\.\s+/, "")))}</li>`).join("");
    return `<ol>${items}</ol>`;
  }

  if (lines.every(line => /^\s*>\s?/.test(line))) {
    const quote = lines.map(line => line.replace(/^\s*>\s?/, "")).join("<br>");
    return `<blockquote>${formatInlineMarkdown(escapeHtml(quote))}</blockquote>`;
  }

  const heading = block.match(/^(#{1,3})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return `<h${level}>${formatInlineMarkdown(escapeHtml(heading[2]))}</h${level}>`;
  }

  return `<p>${formatInlineMarkdown(escapeHtml(block)).replace(/\n/g, "<br>")}</p>`;
}

function formatInlineMarkdown(html) {
  return html
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function bindCopyButtons(scope) {
  scope.querySelectorAll(".copy-code-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const targetId = btn.getAttribute("data-copy-target");
      const codeBlock = targetId ? scope.querySelector(`#${CSS.escape(targetId)}`) : null;
      if (!codeBlock) return;

      navigator.clipboard.writeText(codeBlock.textContent).then(() => {
        btn.textContent = "Copied";
        setTimeout(() => btn.textContent = "Copy", 1300);
      });
    });
  });

  scope.querySelectorAll(".code-header-toggle").forEach(header => {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".copy-code-btn")) return;
      const container = header.closest(".code-container");
      const pre = container?.querySelector("pre");
      if (!container || !pre) return;
      container.classList.toggle("collapsed");
      pre.style.display = container.classList.contains("collapsed") ? "none" : "";
    });
  });
}
