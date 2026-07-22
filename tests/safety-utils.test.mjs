import test from "node:test";
import assert from "node:assert/strict";
import { isSafeRecordKey, isSafeVirtualPath, safeRecord } from "../sidepanel/lib/safe-record.js";
import { truncateUtf8Tail } from "../shared/text.js";

test("record helpers reject prototype and unsafe virtual-path keys", () => {
  assert.equal(isSafeRecordKey("__proto__"), false);
  assert.equal(isSafeRecordKey("constructor"), false);
  assert.equal(isSafeVirtualPath("src/file.js"), true);
  assert.equal(isSafeVirtualPath("src/__proto__/file.js"), false);
  assert.equal(isSafeVirtualPath("../outside.txt"), false);
  assert.equal(isSafeVirtualPath("/absolute.txt"), false);

  const input = JSON.parse('{"safe":{"value":1},"__proto__":{"polluted":true}}');
  const output = safeRecord(input);
  assert.equal(Object.getPrototypeOf(output), null);
  assert.deepEqual(output.safe, { value: 1 });
  assert.equal(Object.hasOwn(output, "__proto__"), false);
  assert.equal({}.polluted, undefined);
});

test("UTF-8 tail truncation respects byte limits and code-point boundaries", () => {
  const value = `old-${"🙂".repeat(10)}-new`;
  const result = truncateUtf8Tail(value, 17);
  assert.ok(new TextEncoder().encode(result).length <= 17);
  assert.ok(result.endsWith("-new"));
  assert.ok(!result.includes("�"));
});
