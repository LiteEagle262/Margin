import { SMTPServer } from "smtp-server";
import { ingestRawMail } from "./ingest.js";

export function createSmtpServer({ port, host, domain, maxSizeBytes, log }) {
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH", "STARTTLS"],
    size: maxSizeBytes,
    banner: "ScrapeFlow mail receiver",

    onRcptTo(address, _session, cb) {
      const recipient = String(address.address || "").toLowerCase();
      const at = recipient.lastIndexOf("@");
      if (at === -1) return cb(new Error("invalid recipient"));
      const recipientDomain = recipient.slice(at + 1);
      if (recipientDomain !== domain.toLowerCase()) {
        return cb(new Error(`relay denied for ${recipientDomain}`));
      }
      cb();
    },

    onData(stream, session, cb) {
      const chunks = [];
      let total = 0;
      let truncated = false;

      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxSizeBytes) {
          truncated = true;
          return;
        }
        chunks.push(chunk);
      });

      stream.on("end", async () => {
        if (truncated) return cb(new Error("message too large"));
        const raw = Buffer.concat(chunks);
        const recipients = (session.envelope?.rcptTo || []).map(
          (r) => r.address || ""
        );
        try {
          const result = await ingestRawMail(raw, recipients);
          if (log) log(`SMTP accepted ${raw.length}B for ${recipients.join(",")} matched=${result.matched.length}`);
          cb();
        } catch (err) {
          if (log) log(`SMTP ingest error: ${err.message}`);
          cb(new Error("ingest failed"));
        }
      });

      stream.on("error", (err) => cb(err));
    }
  });

  server.on("error", (err) => {
    if (log) log(`SMTP server error: ${err.message}`);
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, (err) => {
      if (err) return reject(err);
      resolve(server);
    });
  });
}
