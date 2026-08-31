import test from "node:test";
import assert from "node:assert/strict";
import { navigationBindingKey } from "../../src/background/navigation-binding";

test("navigation bindings are deterministic fixed SHA-256 digests", async () => {
  const first = await navigationBindingKey("https://example.com/watch?id=A#player");
  const second = await navigationBindingKey("https://example.com/watch?id=A#player");
  assert.equal(first, second);
  assert.match(first ?? "", /^[0-9a-f]{64}$/);
  assert.equal(first?.includes("example.com"), false);
  assert.equal(first?.includes("id=A"), false);
});

test("origin, path, query, and fragment changes invalidate a navigation binding", async () => {
  const values = await Promise.all([
    "https://example.com/watch?id=A#player",
    "https://other.example/watch?id=A#player",
    "https://example.com/other?id=A#player",
    "https://example.com/watch?id=B#player",
    "https://example.com/watch?id=A#other"
  ].map(navigationBindingKey));
  assert.equal(new Set(values).size, values.length);
});

test("unsupported and malformed navigation URLs fail closed", async () => {
  assert.equal(await navigationBindingKey("not a URL"), null);
  assert.equal(await navigationBindingKey("javascript:alert(1)"), null);
});
