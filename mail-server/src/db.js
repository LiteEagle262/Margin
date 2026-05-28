import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

let db;

export function openDatabase(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS inboxes (
      id          TEXT PRIMARY KEY,
      address     TEXT NOT NULL UNIQUE,
      label       TEXT,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_inboxes_address ON inboxes(address);
    CREATE INDEX IF NOT EXISTS idx_inboxes_expires ON inboxes(expires_at);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      inbox_id    TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
      from_addr   TEXT,
      to_addr     TEXT,
      subject     TEXT,
      text        TEXT,
      html        TEXT,
      raw_size    INTEGER,
      codes_json  TEXT,
      links_json  TEXT,
      received_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(inbox_id, received_at DESC);
  `);

  return db;
}

export function getDb() {
  if (!db) throw new Error("Database not opened");
  return db;
}

function newId() {
  return crypto.randomBytes(12).toString("hex");
}

export function createInbox({ address, label, ttlMs }) {
  const id = newId();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO inboxes (id, address, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, address.toLowerCase(), label || null, now, now + ttlMs);
  return getInbox(id);
}

export function getInbox(id) {
  return getDb().prepare(`SELECT * FROM inboxes WHERE id = ?`).get(id) || null;
}

export function getInboxByAddress(address) {
  return (
    getDb()
      .prepare(`SELECT * FROM inboxes WHERE address = ?`)
      .get(address.toLowerCase()) || null
  );
}

export function deleteInbox(id) {
  return getDb().prepare(`DELETE FROM inboxes WHERE id = ?`).run(id).changes > 0;
}

export function deleteExpiredInboxes() {
  const now = Date.now();
  return getDb()
    .prepare(`DELETE FROM inboxes WHERE expires_at < ?`)
    .run(now).changes;
}

export function insertMessage(msg) {
  const id = newId();
  getDb()
    .prepare(
      `INSERT INTO messages
         (id, inbox_id, from_addr, to_addr, subject, text, html, raw_size, codes_json, links_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      msg.inboxId,
      msg.from || null,
      msg.to || null,
      msg.subject || null,
      msg.text || null,
      msg.html || null,
      msg.rawSize || 0,
      JSON.stringify(msg.codes || []),
      JSON.stringify(msg.links || []),
      msg.receivedAt || Date.now()
    );
  return getMessage(id);
}

export function listMessages(inboxId, { sinceMs = 0, limit = 100 } = {}) {
  return getDb()
    .prepare(
      `SELECT id, inbox_id, from_addr, to_addr, subject, raw_size, codes_json, links_json, received_at
         FROM messages
        WHERE inbox_id = ? AND received_at > ?
        ORDER BY received_at DESC
        LIMIT ?`
    )
    .all(inboxId, sinceMs, limit)
    .map(rowToMessageSummary);
}

export function getMessage(id) {
  const row = getDb().prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  if (!row) return null;
  return rowToMessageFull(row);
}

function rowToMessageSummary(row) {
  return {
    id: row.id,
    inbox_id: row.inbox_id,
    from: row.from_addr,
    to: row.to_addr,
    subject: row.subject,
    raw_size: row.raw_size,
    codes: safeParse(row.codes_json, []),
    links: safeParse(row.links_json, []),
    received_at: row.received_at
  };
}

function rowToMessageFull(row) {
  return {
    ...rowToMessageSummary(row),
    text: row.text,
    html: row.html
  };
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
