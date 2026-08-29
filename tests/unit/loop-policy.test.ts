import test from "node:test";
import assert from "node:assert/strict";
import { loopUrlKey, normalizeLoopEntry, type LoopEntry } from "../../src/shared/loop-policy";

const entry: LoopEntry = {
  urlKey: "https://example.com/live", attempts: [9_000], actionAttempts: { PAGE_RELOAD: [9_000] }, pausedUntil: null,
  pendingMaximizeAt: 9_000, snoozedUntil: -1, eventModeUntil: 50_000
};

test("loop key ignores query strings and fragments", () => {
  assert.equal(loopUrlKey("https://example.com/live?token=secret#player"), "https://example.com/live");
});
test("same page reuses its loop entry", () => { assert.equal(normalizeLoopEntry(entry, "https://example.com/live?x=1", 10_000), entry); });
test("recent reload attempts survive a redirect", () => {
  const redirected = normalizeLoopEntry(entry, "https://cdn.example.net/watch", 10_000);
  assert.deepEqual(redirected.attempts, [9_000]); assert.deepEqual(redirected.actionAttempts.PAGE_RELOAD, [9_000]);
  assert.equal(redirected.urlKey, "https://cdn.example.net/watch");
});
test("stale navigation starts a new circuit but preserves explicit tab modes", () => {
  const reset = normalizeLoopEntry(entry, "https://elsewhere.example/watch", 500_000);
  assert.deepEqual(reset.attempts, []); assert.deepEqual(reset.actionAttempts, {}); assert.equal(reset.snoozedUntil, -1); assert.equal(reset.eventModeUntil, 50_000);
});
test("malformed URLs still receive stable query-free keys", () => { assert.equal(loopUrlKey("not a url?x=1#y"), "not a url"); });
