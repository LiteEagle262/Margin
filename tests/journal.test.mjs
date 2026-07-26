import test from "node:test";
import assert from "node:assert/strict";
import { MAX_JOURNAL_ENTRIES, buildJournalEntry, appendJournalEntry } from "../shared/journal.js";

test("allowlisted argument keys are recorded verbatim", () => {
  const entry = buildJournalEntry({
    ts: 1720000000000,
    surface: "panel",
    tool: "click_element",
    host: "example.com",
    args: { url: "https://example.com/checkout", uid: "sf-button-abc123", selector: "#submit" },
    outcome: "ok"
  });

  assert.equal(entry.ts, 1720000000000);
  assert.equal(entry.surface, "panel");
  assert.equal(entry.tool, "click_element");
  assert.equal(entry.host, "example.com");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.args.url, "https://example.com/checkout");
  assert.equal(entry.args.uid, "sf-button-abc123");
  assert.equal(entry.args.selector, "#submit");
});

test("secret-bearing argument values never appear anywhere in the journal entry", () => {
  // Distinctive values so a substring scan of the serialized entry is meaningful.
  const secrets = {
    value: "hunter2-Sup3rSecretPassword",
    code: "914276",
    body: "card=4111990022334455&cvv=917",
    text: "wire the funds to account 998877",
    content: "totp-seed JBSWY3DPEHPK3PXP",
    token: "tok-live-9f8e7d6c5b4a",
    password: "correct horse battery staple"
  };
  const entry = buildJournalEntry({
    ts: 1,
    surface: "bridge",
    tool: "fill_element",
    host: "bank.example",
    args: { uid: "sf-input-pw", ...secrets },
    outcome: "ok"
  });

  const serialized = JSON.stringify(entry);
  for (const [key, secret] of Object.entries(secrets)) {
    assert.equal(Object.hasOwn(entry.args, key), false, `${key} must not be stored verbatim`);
    assert.equal(entry.args[`${key}_len`], secret.length, `${key} is recorded as its length only`);
    assert.equal(serialized.includes(secret), false, `${key} value leaked into the serialized entry`);
  }
  assert.equal(entry.args.uid, "sf-input-pw", "allowlisted keys still record alongside secrets");
});

test("close_tab records which tab it destroyed", () => {
  const entry = buildJournalEntry({
    ts: 3,
    surface: "bridge",
    tool: "close_tab",
    host: "example.com",
    args: { tab_id: 8371634 },
    outcome: "ok"
  });

  assert.equal(entry.args.tab_id, 8371634, "the audit journal keeps the closed tab's id verbatim");
});

test("long allowlisted values truncate to 200 characters", () => {
  const longUrl = `https://example.com/?q=${"a".repeat(500)}`;
  const entry = buildJournalEntry({
    ts: 2,
    surface: "panel",
    tool: "navigate",
    host: "example.com",
    args: { url: longUrl },
    outcome: "ok"
  });

  assert.equal(entry.args.url.length, 200);
  assert.equal(entry.args.url, longUrl.slice(0, 200));
});

test("appendJournalEntry caps the journal and drops the oldest entries", () => {
  let list = appendJournalEntry("not-an-array", { ts: -1 });
  assert.deepEqual(list, [{ ts: -1 }], "a corrupt stored value starts a fresh journal");

  list = [];
  const extra = 25;
  for (let i = 0; i < MAX_JOURNAL_ENTRIES + extra; i++) {
    list = appendJournalEntry(list, { ts: i });
  }

  assert.equal(list.length, MAX_JOURNAL_ENTRIES);
  assert.equal(list[0].ts, extra, "oldest entries are dropped first");
  assert.equal(list.at(-1).ts, MAX_JOURNAL_ENTRIES + extra - 1, "newest entry is kept");
});
