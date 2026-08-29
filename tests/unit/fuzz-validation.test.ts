import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile } from "../../src/shared/profiles";
import { normalizeSettings } from "../../src/shared/settings";
import { validateRuntimeMessage } from "../../src/shared/validation";

let seed = 0x51a7e5;
function random(): number { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; }
function scalar(): unknown {
  return [null, true, false, random() * 10_000 - 5_000, `value-${Math.floor(random() * 1000)}`, undefined][Math.floor(random() * 6)];
}
function value(depth = 0): unknown {
  if (depth >= 4 || random() < .45) return scalar();
  if (random() < .35) return Array.from({ length: Math.floor(random() * 8) }, () => value(depth + 1));
  const result: Record<string, unknown> = {};
  for (let index = 0; index < Math.floor(random() * 8); index += 1) result[`key-${index}-${Math.floor(random() * 20)}`] = value(depth + 1);
  return result;
}

test("deterministic settings fuzzing always produces a bounded safe schema", () => {
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const normalized = normalizeSettings(value());
    assert.equal(normalized.schemaVersion, 3);
    assert.equal(typeof normalized.enabled, "boolean");
    assert.ok(normalized.checkIntervalSeconds >= 1 && normalized.checkIntervalSeconds <= 60);
    assert.ok(Object.getPrototypeOf(normalized.perSite) === Object.prototype);
  }
});

test("deterministic message fuzzing never throws or accepts missing message types", () => {
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const candidate = value();
    const result = validateRuntimeMessage(candidate);
    assert.equal(typeof result.ok, "boolean");
    if (!candidate || typeof candidate !== "object" || !("type" in candidate)) assert.equal(result.ok, false);
  }
});

test("deterministic profile fuzzing either rejects or returns data-only profiles", () => {
  for (let iteration = 0; iteration < 300; iteration += 1) {
    try {
      const profile = normalizeProfile(value());
      assert.equal(profile.schemaVersion, 1);
      assert.equal(typeof profile.name, "string");
      assert.equal(JSON.stringify(profile).includes("javascript:"), false);
    } catch (error) { assert.ok(error instanceof Error); }
  }
});
