import "dotenv/config";
import crypto from "node:crypto";
import { openDatabase, deleteExpiredInboxes } from "./db.js";
import { createHttpApp } from "./http.js";
import { createSmtpServer } from "./smtp.js";

const log = (msg) => console.log(`[mail-server] ${msg}`);

const config = {
  domain: required("MAIL_DOMAIN"),
  apiKey: process.env.API_KEY || generateAndWarnApiKey(),
  httpPort: Number(process.env.HTTP_PORT || 8080),
  httpHost: process.env.HTTP_HOST || "0.0.0.0",
  smtpPort: process.env.SMTP_PORT === "" ? null : Number(process.env.SMTP_PORT || 25),
  smtpHost: process.env.SMTP_HOST || "0.0.0.0",
  dbFile: process.env.DB_FILE || "./data/mail.db",
  defaultTtlMs: Number(process.env.DEFAULT_TTL_MS || 1000 * 60 * 60 * 24),
  maxTtlMs: Number(process.env.MAX_TTL_MS || 1000 * 60 * 60 * 24 * 7),
  maxMessageBytes: Number(process.env.MAX_MESSAGE_BYTES || 10 * 1024 * 1024),
  cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 1000 * 60 * 15)
};

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function generateAndWarnApiKey() {
  const key = crypto.randomBytes(24).toString("hex");
  log(`No API_KEY set — generated ephemeral key: ${key}`);
  log(`Set API_KEY=${key} in your env to keep it stable across restarts.`);
  return key;
}

async function main() {
  openDatabase(config.dbFile);
  log(`Database opened at ${config.dbFile}`);

  const app = createHttpApp({
    apiKey: config.apiKey,
    domain: config.domain,
    defaultTtlMs: config.defaultTtlMs,
    maxTtlMs: config.maxTtlMs
  });

  app.listen(config.httpPort, config.httpHost, () => {
    log(`HTTP API listening on http://${config.httpHost}:${config.httpPort}`);
    log(`Catch-all domain: ${config.domain}`);
  });

  if (config.smtpPort) {
    try {
      await createSmtpServer({
        port: config.smtpPort,
        host: config.smtpHost,
        domain: config.domain,
        maxSizeBytes: config.maxMessageBytes,
        log
      });
      log(`SMTP receiver listening on ${config.smtpHost}:${config.smtpPort}`);
    } catch (err) {
      log(`SMTP receiver failed to start: ${err.message}`);
      log(`Continuing with HTTP-only mode. Use POST /api/incoming for inbound mail.`);
    }
  } else {
    log("SMTP receiver disabled (SMTP_PORT empty). Use POST /api/incoming.");
  }

  setInterval(() => {
    try {
      const removed = deleteExpiredInboxes();
      if (removed > 0) log(`Cleaned up ${removed} expired inboxes`);
    } catch (err) {
      log(`Cleanup error: ${err.message}`);
    }
  }, config.cleanupIntervalMs);
}

main().catch((err) => {
  console.error(`[mail-server] Fatal: ${err.message}`);
  process.exit(1);
});
