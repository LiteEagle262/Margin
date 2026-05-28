import { EventEmitter } from "node:events";

export const mailbox = new EventEmitter();
mailbox.setMaxListeners(0);

export function emitMessageArrived(inboxId, message) {
  mailbox.emit(`message:${inboxId}`, message);
  mailbox.emit("message:any", { inboxId, message });
}

export function waitForMessage(inboxId, { sinceMs = 0, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;

    const onMsg = (msg) => {
      if (settled) return;
      if (msg.received_at <= sinceMs) return;
      settled = true;
      cleanup();
      resolve(msg);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      mailbox.off(`message:${inboxId}`, onMsg);
    };

    mailbox.on(`message:${inboxId}`, onMsg);
  });
}
