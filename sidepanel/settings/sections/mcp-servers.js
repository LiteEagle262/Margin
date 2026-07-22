import { settings } from "../../state/store.js";
import { escapeHtml } from "../../lib/format.js";
import { createMcpServerId, connectMcpServer } from "../../api/mcp-client.js";

export function normalizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(server => server && typeof server === "object")
    .map(server => ({
      id: String(server.id || createMcpServerId()),
      name: String(server.name || "MCP Server"),
      url: String(server.url || "").trim(),
      enabled: server.enabled !== false
    }));
}

function renderMcpServersList() {
  const list = document.getElementById("mcp-servers-list");
  if (!list) return;

  list.innerHTML = "";
  const servers = settings.mcpServers.length ? settings.mcpServers : [];

  if (servers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mcp-status";
    empty.textContent = "No MCP servers configured.";
    list.appendChild(empty);
    return;
  }

  servers.forEach(server => {
    list.appendChild(createMcpServerCard(server));
  });
}

function createMcpServerCard(server) {
  const card = document.createElement("div");
  card.className = "mcp-server-card";
  card.dataset.serverId = server.id;

  card.innerHTML = `
    <div class="mcp-server-row">
      <input type="text" class="mcp-name-input" placeholder="Server name" value="${escapeHtml(server.name || "")}">
      <label><input type="checkbox" class="mcp-enabled-input" ${server.enabled !== false ? "checked" : ""}> Enabled</label>
      <button type="button" class="mcp-remove-btn">Remove</button>
    </div>
    <div class="mcp-server-row">
      <input type="url" class="mcp-url-input" placeholder="https://example.com/mcp" value="${escapeHtml(server.url || "")}">
    </div>
    <div class="mcp-status mcp-test-status"></div>
  `;

  card.querySelector(".mcp-remove-btn").addEventListener("click", () => {
    settings.mcpServers = settings.mcpServers.filter(s => s.id !== server.id);
    renderMcpServersList();
  });

  card.querySelector(".mcp-url-input").addEventListener("blur", () => {
    testMcpServerConnection(server.id, card);
  });

  return card;
}

function collectMcpServersFromUI() {
  const list = document.getElementById("mcp-servers-list");
  if (!list) return settings.mcpServers;

  return Array.from(list.querySelectorAll(".mcp-server-card")).map(card => ({
    id: card.dataset.serverId,
    name: card.querySelector(".mcp-name-input")?.value.trim() || "MCP Server",
    url: card.querySelector(".mcp-url-input")?.value.trim() || "",
    enabled: card.querySelector(".mcp-enabled-input")?.checked !== false
  }));
}

function initMcpSettings() {
  const addBtn = document.getElementById("add-mcp-server-btn");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => {
    settings.mcpServers.push({
      id: createMcpServerId(),
      name: "MCP Server",
      url: "",
      enabled: true
    });
    renderMcpServersList();
  });
}

async function testMcpServerConnection(serverId, cardEl) {
  const statusEl = cardEl?.querySelector(".mcp-test-status");
  const url = cardEl?.querySelector(".mcp-url-input")?.value.trim();
  if (!statusEl) return;

  if (!url) {
    statusEl.textContent = "";
    statusEl.className = "mcp-status mcp-test-status";
    return;
  }

  statusEl.textContent = "Testing connection...";
  statusEl.className = "mcp-status mcp-test-status";

  try {
    const connection = await connectMcpServer({ url });
    statusEl.textContent = `Connected · ${connection.tools.length} tool(s)`;
    statusEl.className = "mcp-status mcp-test-status connected";
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = "mcp-status mcp-test-status error";
  }
}

export const mcpServersSection = {
  key: "mcpServers",
  normalize: normalizeMcpServers,
  render: renderMcpServersList,
  collect: collectMcpServersFromUI,
  init: initMcpSettings
};
