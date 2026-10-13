import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import { applySettingsImport, prepareSettingsImport, SettingsImportError } from "../../src/shared/settings-import";

const backup = () => structuredClone(DEFAULT_SETTINGS);
const current = () => ({ ...backup(), perSite: {
  "https://one.test": { enabled: true, retryButtonSelector: ".retry" },
  "https://two.test": { enabled: true, stallTimeoutSeconds: 30 },
  "https://off.test": { enabled: false }
} });

test("settings exports roundtrip normalized, with imported monitoring disabled and input immutable", () => {
  const input = current();
  const before = structuredClone(input);
  const review = prepareSettingsImport(input);
  assert.deepEqual(input, before);
  assert.equal(review.settings.perSite["https://one.test"].enabled, false);
  assert.equal(review.settings.perSite["https://one.test"].retryButtonSelector, ".retry");
  assert.equal(review.defaultedFields.length, 0);
  const normalized = prepareSettingsImport(review.settings);
  assert.deepEqual(normalized.settings, review.settings);
});

test("legitimate older exports migrate and explicitly report missing defaults", () => {
  for (const schemaVersion of [undefined, 1, 2, 3, 4]) {
    const review = prepareSettingsImport({ schemaVersion, autoRefresh: false, stallTimeoutSeconds: "999", perSite: {} });
    assert.equal(review.settings.schemaVersion, 4);
    assert.equal(review.settings.autoRecover, true);
    assert.equal(review.settings.autoRefresh, false);
    assert.equal(review.settings.stallTimeoutSeconds, 300);
    assert.ok(review.defaultedFields.includes("autoRecover"));
  }
});

test("arbitrary objects, future schemas, unsafe sites and malformed fields reject before any mutation", async () => {
  const invalid: unknown[] = [null, [], {}, { hello: "world" }, { perSite: {} },
    { ...backup(), schemaVersion: 5 }, { ...backup(), schemaVersion: 0 }, { ...backup(), schemaVersion: "4" },
    { ...backup(), autoRecover: "true" }, { ...backup(), stallTimeoutSeconds: {} },
    { ...backup(), stallTimeoutSeconds: "   " }, { ...backup(), recoveryStrategy: ["RUN_SCRIPT"] }, { ...backup(), recoveryBackoffSeconds: [] },
    { ...backup(), perSite: [] }, { ...backup(), arbitrary: true },
    { ...backup(), perSite: { "javascript:alert(1)": {} } },
    { ...backup(), perSite: { "https://one.test/path": {} } },
    { ...backup(), perSite: { "https://one.test": [] } },
    { ...backup(), perSite: { "https://one.test": { backupUrls: ["javascript:alert(1)"] } } },
    { ...backup(), perSite: { "https://one.test": { backupUrls: ["https://user:password@one.test/"] } } },
    { ...backup(), perSite: { "https://one.test": { includeUrlPatterns: [42] } } },
    { ...backup(), perSite: { "https://one.test": { selectedVideoSelector: 42 } } },
    { ...backup(), perSite: { "https://one.test": { declaredPlayerType: "UNKNOWN" } } },
    { ...backup(), perSite: { "https://one.test": { profileId: "a".repeat(101) } } }
  ];
  for (const input of invalid) {
    let mutations = 0;
    await assert.rejects(applySettingsImport(input, current(), {
      disableSite: async () => { mutations++; return { ok: true }; },
      write: async (settings) => { mutations++; return settings; }
    }), /Invalid settings backup/);
    assert.equal(mutations, 0);
  }
});

test("backup bounds reject oversized site sets, arrays and files", () => {
  assert.throws(() => prepareSettingsImport({ ...backup(), perSite: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`https://site${index}.test`, {}])) }), /500 sites/);
  assert.throws(() => prepareSettingsImport({ ...backup(), perSite: { "https://one.test": { backupUrls: Array(11).fill("https://one.test") } } }), /backupUrls/);
  assert.throws(() => prepareSettingsImport({ ...backup(), arbitrary: "x".repeat(1_000_000) }), /too large/);
});

test("replacement writes only after sequential confirmed disables; disabled sites never receive activation", async () => {
  const calls: string[] = [];
  const input = current();
  const result = await applySettingsImport(input, current(), {
    disableSite: async (origin) => { calls.push(origin); return { ok: true }; },
    write: async (settings) => { calls.push("write"); assert.ok(Object.values(settings.perSite).every((site) => site.enabled === false)); return settings; }
  });
  assert.deepEqual(calls, ["https://one.test", "https://two.test", "write"]);
  assert.equal(result.perSite["https://one.test"].enabled, false);
  assert.equal(input.perSite["https://one.test"].enabled, true);
});

test("negative and thrown disable responses stop replacement and preserve current configurations", async () => {
  for (const thrown of [false, true]) {
    const original = current();
    const calls: string[] = [];
    await assert.rejects(applySettingsImport(backup(), original, {
      disableSite: async (origin) => {
        calls.push(origin);
        if (origin === "https://two.test") { if (thrown) throw new Error("browser failure"); return { ok: false, error: "refused" }; }
        return { ok: true };
      },
      write: async (settings) => { calls.push("write"); return settings; }
    }), (error: unknown) => {
      assert.ok(error instanceof SettingsImportError);
      assert.deepEqual(error.disabledOrigins, ["https://one.test"]);
      assert.equal(error.phase, "disable");
      assert.match(error.message, /Replacement settings were not written/);
      return true;
    });
    assert.deepEqual(calls, ["https://one.test", "https://two.test"]);
    assert.equal(original.perSite["https://one.test"].retryButtonSelector, ".retry");
  }
});

test("write failures report confirmed partial deactivation without claiming rollback", async () => {
  await assert.rejects(applySettingsImport(backup(), current(), {
    disableSite: async () => ({ ok: true }),
    write: async () => { throw new Error("storage quota"); }
  }), (error: unknown) => {
    assert.ok(error instanceof SettingsImportError);
    assert.equal(error.phase, "write");
    assert.equal(error.disabledOrigins.length, 2);
    assert.match(error.message, /storage quota/);
    assert.match(error.message, /reload saved settings/);
    return true;
  });
});
