import express from "express";
import crypto from "node:crypto";
import {
  createInbox,
  deleteInbox,
  getInbox,
  getMessage,
  listMessages
} from "./db.js";
import { waitForMessage } from "./events.js";
import { ingestRawMail } from "./ingest.js";

const ADDRESS_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function createHttpApp({ apiKey, domain, defaultTtlMs, maxTtlMs, maxMessageBytes }) {
  const app = express();
  app.disable("x-powered-by");
  const bodyLimit = normalizeMessageLimit(maxMessageBytes);

  app.use(express.json({ limit: bodyLimit }));
  app.use(
    express.raw({
      type: ["message/rfc822", "application/octet-stream", "text/plain"],
      limit: bodyLimit
    })
  );

  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  app.use((req, res, next) => {
    if (req.path === "/healthz") return next();
    if (!isBearerAuthorized(apiKey, req.header("authorization"))) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, domain });
  });

  app.post("/api/inboxes", (req, res) => {
    const body = req.body || {};
    const ttlMs = clampTtl(body.ttl_ms, defaultTtlMs, maxTtlMs);
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : null;

    const localPart =
      typeof body.local_part === "string" && /^[a-z0-9._-]{3,40}$/i.test(body.local_part)
        ? body.local_part.toLowerCase()
        : randomLocalPart();

    const address = `${localPart}@${domain}`;
    try {
      const inbox = createInbox({ address, label, ttlMs });
      res.json(formatInbox(inbox));
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) {
        return res.status(409).json({ error: "address_in_use", address });
      }
      throw err;
    }
  });

  app.get("/api/inboxes/:id", (req, res) => {
    const inbox = getInbox(req.params.id);
    if (!inbox) return res.status(404).json({ error: "not_found" });
    res.json(formatInbox(inbox));
  });

  app.delete("/api/inboxes/:id", (req, res) => {
    const ok = deleteInbox(req.params.id);
    if (!ok) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  });

  app.get("/api/inboxes/:id/messages", (req, res) => {
    const inbox = getInbox(req.params.id);
    if (!inbox) return res.status(404).json({ error: "not_found" });

    const sinceMs = Number(req.query.since_ms || 0) || 0;
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50) || 50, 200));
    res.json({
      inbox: formatInbox(inbox),
      messages: listMessages(inbox.id, { sinceMs, limit })
    });
  });

  app.get("/api/inboxes/:id/messages/:msgId", (req, res) => {
    const inbox = getInbox(req.params.id);
    if (!inbox) return res.status(404).json({ error: "not_found" });
    const msg = getMessage(req.params.msgId);
    if (!msg || msg.inbox_id !== inbox.id) {
      return res.status(404).json({ error: "not_found" });
    }
    res.json(msg);
  });

  app.get("/api/inboxes/:id/wait", async (req, res) => {
    const inbox = getInbox(req.params.id);
    if (!inbox) return res.status(404).json({ error: "not_found" });

    const sinceMs = Number(req.query.since_ms || 0) || 0;
    const timeoutMs = Math.max(0, Math.min(Number(req.query.timeout_ms || 30000) || 30000, 120000));

    const existing = listMessages(inbox.id, { sinceMs, limit: 1 });
    if (existing.length > 0) {
      return res.json({ message: existing[0], waited_ms: 0 });
    }

    const start = Date.now();
    const msg = await waitForMessage(inbox.id, { sinceMs, timeoutMs });
    res.json({ message: msg, waited_ms: Date.now() - start });
  });

  app.post("/api/incoming", async (req, res) => {
    let raw;
    let recipients = [];

    if (Buffer.isBuffer(req.body)) {
      raw = req.body;
      recipients = parseCsvHeader(req.header("x-recipients"));
    } else if (req.body && typeof req.body === "object") {
      if (typeof req.body.raw === "string") {
        raw = Buffer.from(req.body.raw, req.body.raw_encoding === "base64" ? "base64" : "utf8");
      }
      if (Array.isArray(req.body.recipients)) {
        recipients = req.body.recipients;
      } else if (typeof req.body.to === "string") {
        recipients = [req.body.to];
      }
    }

    if (!raw || raw.length === 0) {
      return res.status(400).json({ error: "missing_raw_body" });
    }

    try {
      const result = await ingestRawMail(raw, recipients);
      res.json(result);
    } catch (err) {
      console.error(`[mail-server] Ingest failed: ${err.message}`);
      res.status(500).json({ error: "ingest_failed" });
    }
  });

  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "request_too_large" });
    }
    console.error(`[mail-server] HTTP error: ${err?.message || "unknown error"}`);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

export function tokensMatch(expectedToken, providedToken) {
  const expected = Buffer.from(String(expectedToken || ""));
  const provided = Buffer.from(String(providedToken || ""));
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

export function isBearerAuthorized(expectedToken, authorizationHeader) {
  const match = String(authorizationHeader || "").match(/^Bearer\s+(.+)$/i);
  return Boolean(match && tokensMatch(expectedToken, match[1].trim()));
}

export function normalizeMessageLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10 * 1024 * 1024;
}

function clampTtl(ttl, defaultTtl, maxTtl) {
  const value = Number(ttl);
  if (!value || !Number.isFinite(value) || value <= 0) return defaultTtl;
  return Math.min(value, maxTtl);
}

function randomLocalPart() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const b of bytes) out += ADDRESS_ALPHABET[b % ADDRESS_ALPHABET.length];
  return out;
}

function parseCsvHeader(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatInbox(inbox) {
  return {
    id: inbox.id,
    address: inbox.address,
    label: inbox.label,
    created_at: inbox.created_at,
    expires_at: inbox.expires_at
  };
}
