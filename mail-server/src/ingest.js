import { parseRfc822 } from "./parser.js";
import { getInboxByAddress, insertMessage, listMessages } from "./db.js";
import { emitMessageArrived } from "./events.js";

export async function ingestRawMail(rawBuffer, recipients = []) {
  const parsed = await parseRfc822(rawBuffer);

  const candidateAddresses = new Set(
    recipients.map((r) => String(r || "").trim().toLowerCase()).filter(Boolean)
  );
  if (parsed.to) {
    for (const part of String(parsed.to).split(",")) {
      const match = part.match(/<([^>]+)>/) || [null, part.trim()];
      if (match[1]) candidateAddresses.add(match[1].toLowerCase());
    }
  }

  const matched = [];
  for (const addr of candidateAddresses) {
    const inbox = getInboxByAddress(addr);
    if (!inbox) continue;

    const stored = insertMessage({
      inboxId: inbox.id,
      from: parsed.from,
      to: addr,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
      rawSize: parsed.rawSize,
      codes: parsed.codes,
      links: parsed.links,
      receivedAt: Date.now()
    });

    const summary = listMessages(inbox.id, { limit: 1 })[0] || stored;
    emitMessageArrived(inbox.id, summary);
    matched.push({ inbox_id: inbox.id, address: addr, message_id: stored.id });
  }

  return {
    matched,
    parsed: {
      from: parsed.from,
      subject: parsed.subject,
      to: parsed.to,
      size: parsed.rawSize
    }
  };
}
