import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import {
  attemptTrustedStorageAccess,
  SETTINGS_STORAGE_KEYS,
  SettingsStorageError,
  SettingsStorageRepository,
  type SettingsStorageArea
} from "../../src/shared/settings-storage";
import { normalizeSettings } from "../../src/shared/settings";

class MemoryStorageArea implements SettingsStorageArea {
  readonly data: Record<string, unknown>;
  setCalls = 0;
  removeCalls = 0;
  failSetCall: number | null = null;
  failRemoveCall: number | null = null;
  quotaBytes?: number;
  quotaBytesPerItem?: number;
  getBytesInUse?: (keys: string | string[] | null) => Promise<number>;

  constructor(initial: Record<string, unknown> = {}, byteAccounting = true) {
    this.data = structuredClone(initial);
    if (byteAccounting) this.getBytesInUse = async (keys) => byteSize(select(this.data, keys));
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    return structuredClone(select(this.data, keys));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
    if (this.failSetCall === this.setCalls) throw new Error("simulated browser storage write failure");
    Object.assign(this.data, structuredClone(items));
  }

  async remove(keys: string | string[]): Promise<void> {
    this.removeCalls += 1;
    if (this.failRemoveCall === this.removeCalls) throw new Error("simulated browser storage remove failure");
    for (const key of typeof keys === "string" ? [keys] : keys) delete this.data[key];
  }
}

function repository(sync: MemoryStorageArea, local: MemoryStorageArea, visualPrivacyAcknowledged = true) {
  return new SettingsStorageRepository({
    sync,
    local,
    normalize: normalizeSettings,
    visualPrivacyAcknowledged: async () => visualPrivacyAcknowledged
  });
}

test("stores only compact global preferences in sync and site data locally", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.perSite["https://private.example"] = {
    enabled: true,
    selectedVideoSelector: "#private-player",
    includeUrlPatterns: ["https://private.example/event/*"],
    backupUrls: ["https://backup.example/private"]
  };

  await repository(sync, local).set(settings);

  const synced = JSON.stringify(sync.data[SETTINGS_STORAGE_KEYS.global]);
  assert.equal(synced.includes("private.example"), false);
  assert.equal(synced.includes("#private-player"), false);
  assert.equal(synced.includes("backup.example"), false);
  const localSites = JSON.stringify(local.data[SETTINGS_STORAGE_KEYS.sites]);
  assert.equal(localSites.includes("https://private.example"), true);
  assert.equal(localSites.includes("#private-player"), true);
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.transaction], undefined);
});

test("migrates the legacy combined sync record once and keeps a local backup", async () => {
  const legacy = {
    ...structuredClone(DEFAULT_SETTINGS),
    enabled: false,
    perSite: {
      "https://example.com": {
        enabled: true,
        errorSelector: ".offline",
        includeUrlPatterns: ["https://example.com/live/*"]
      }
    }
  };
  const sync = new MemoryStorageArea({ [SETTINGS_STORAGE_KEYS.global]: legacy });
  const local = new MemoryStorageArea();
  const store = repository(sync, local);

  const first = await store.get();
  const writesAfterMigration = sync.setCalls + local.setCalls + local.removeCalls;
  const second = await store.get();

  assert.equal(first.enabled, false);
  assert.equal(first.perSite["https://example.com"].errorSelector, ".offline");
  assert.deepEqual(second, first);
  assert.equal(sync.setCalls + local.setCalls + local.removeCalls, writesAfterMigration);
  assert.equal(JSON.stringify(sync.data[SETTINGS_STORAGE_KEYS.global]).includes("example.com"), false);
  assert.deepEqual(
    (local.data[SETTINGS_STORAGE_KEYS.sites] as any).perSite["https://example.com"].includeUrlPatterns,
    ["https://example.com/live/*"]
  );
  assert.deepEqual(
    (local.data[SETTINGS_STORAGE_KEYS.migrationBackup] as any).legacySyncValue.perSite,
    legacy.perSite
  );
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.transaction], undefined);
});

test("rolls the local record back when the sync half of a transaction fails", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  const store = repository(sync, local);
  const initial = structuredClone(DEFAULT_SETTINGS);
  initial.perSite["https://one.example"] = { enabled: true };
  await store.set(initial);
  const oldSync = structuredClone(sync.data);
  const oldLocal = structuredClone(local.data);
  sync.failSetCall = sync.setCalls + 1;
  const update = structuredClone(initial);
  update.enabled = false;
  update.perSite["https://two.example"] = { enabled: true, errorSelector: ".down" };

  await assert.rejects(store.set(update), (error: unknown) => {
    assert.equal(error instanceof SettingsStorageError, true);
    assert.equal((error as SettingsStorageError).code, "STORAGE_WRITE_FAILED");
    return true;
  });
  assert.deepEqual(sync.data, oldSync);
  assert.deepEqual(local.data, oldLocal);
});

test("rolls a failed legacy migration back to the exact combined record", async () => {
  const legacy = {
    ...structuredClone(DEFAULT_SETTINGS),
    perSite: { "https://legacy.example": { enabled: true, errorSelector: ".offline" } }
  };
  const sync = new MemoryStorageArea({ [SETTINGS_STORAGE_KEYS.global]: legacy });
  const local = new MemoryStorageArea();
  sync.failSetCall = 1;

  await assert.rejects(repository(sync, local).get(), (error: unknown) => {
    assert.equal(error instanceof SettingsStorageError, true);
    assert.equal((error as SettingsStorageError).code, "STORAGE_WRITE_FAILED");
    return true;
  });

  assert.deepEqual(sync.data[SETTINGS_STORAGE_KEYS.global], legacy);
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.sites], undefined);
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.migrationBackup], undefined);
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.transaction], undefined);
});

test("reports an explicit rollback error if restoration itself fails", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  const store = repository(sync, local);
  await store.set(structuredClone(DEFAULT_SETTINGS));
  sync.failSetCall = sync.setCalls + 1;
  // The update writes transaction and sites; this is the following local set,
  // used by rollback to restore the old site record.
  local.failSetCall = local.setCalls + 3;

  const update = structuredClone(DEFAULT_SETTINGS);
  update.enabled = false;
  await assert.rejects(store.set(update), (error: unknown) => {
    assert.equal(error instanceof SettingsStorageError, true);
    assert.equal((error as SettingsStorageError).code, "ROLLBACK_FAILED");
    return true;
  });
});

test("recovers a stale interrupted transaction before reading settings", async () => {
  const oldSettings = structuredClone(DEFAULT_SETTINGS);
  oldSettings.enabled = true;
  oldSettings.perSite["https://old.example"] = { enabled: true };
  const oldSyncRecord = globalRecord(oldSettings);
  const oldSiteRecord = siteRecord(oldSettings);
  const newSettings = structuredClone(DEFAULT_SETTINGS);
  newSettings.enabled = false;
  newSettings.perSite["https://new.example"] = { enabled: true };
  const sync = new MemoryStorageArea({ [SETTINGS_STORAGE_KEYS.global]: globalRecord(newSettings) });
  const local = new MemoryStorageArea({
    [SETTINGS_STORAGE_KEYS.sites]: siteRecord(newSettings),
    [SETTINGS_STORAGE_KEYS.transaction]: {
      storageLayoutVersion: 1,
      id: "interrupted",
      startedAt: 1,
      expiresAt: 2,
      oldSyncExists: true,
      oldSyncValue: oldSyncRecord,
      oldSitesExists: true,
      oldSitesValue: oldSiteRecord,
      oldMigrationBackupExists: false,
      oldMigrationBackupValue: null
    }
  });

  const restored = await repository(sync, local).get();

  assert.equal(restored.enabled, true);
  assert.deepEqual(Object.keys(restored.perSite), ["https://old.example"]);
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.transaction], undefined);
});

test("rejects an over-quota site configuration before mutating either area", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  local.quotaBytes = 1_000;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.perSite["https://large.example"] = {
    enabled: true,
    selectedVideoSelector: `#${"x".repeat(500)}`,
    videoContainerSelector: `.${"y".repeat(500)}`
  };

  await assert.rejects(repository(sync, local).set(settings), (error: unknown) => {
    assert.equal(error instanceof SettingsStorageError, true);
    assert.equal((error as SettingsStorageError).code, "QUOTA_EXCEEDED");
    return true;
  });
  assert.deepEqual(sync.data, {});
  assert.deepEqual(local.data, {});
});

test("round-trips a large valid local configuration without sync quota pressure", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (let index = 0; index < 500; index += 1) {
    settings.perSite[`https://site-${index}.example`] = {
      enabled: index % 2 === 0,
      selectedVideoSelector: `#player-${index}-${"x".repeat(450)}`,
      errorSelector: `.offline-${index}-${"y".repeat(450)}`,
      includeUrlPatterns: [`https://site-${index}.example/live/*`],
      excludeUrlPatterns: [`https://site-${index}.example/account/*`]
    };
  }
  const store = repository(sync, local);

  await store.set(settings);
  const loaded = await store.get();

  assert.equal(Object.keys(loaded.perSite).length, 500);
  assert.equal(JSON.stringify(sync.data).length < 8_192, true);
  assert.equal(JSON.stringify(sync.data).includes("site-499.example"), false);
});

test("falls back safely when getBytesInUse is unavailable", async () => {
  const sync = new MemoryStorageArea({}, false);
  const local = new MemoryStorageArea({}, false);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.perSite["https://firefox.example"] = { enabled: true };

  const stored = await repository(sync, local).set(settings);

  assert.equal(stored.perSite["https://firefox.example"].enabled, true);
});

test("trusted-context storage hardening feature-detects cross-browser support", async () => {
  let calls = 0;
  assert.equal(await attemptTrustedStorageAccess(), false);
  assert.equal(await attemptTrustedStorageAccess(async () => { calls += 1; }), true);
  assert.equal(await attemptTrustedStorageAccess(async () => { throw new Error("unsupported"); }), false);
  assert.equal(calls, 1);
});

test("serializes overlapping mutations within an extension context", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  const store = repository(sync, local);
  const first = structuredClone(DEFAULT_SETTINGS);
  first.enabled = false;
  const second = structuredClone(DEFAULT_SETTINGS);
  second.enabled = true;
  second.perSite["https://last.example"] = { enabled: true };

  await Promise.all([store.set(first), store.set(second)]);
  const final = await store.get();

  assert.equal(final.enabled, true);
  assert.equal(final.perSite["https://last.example"].enabled, true);
  assert.equal(local.data[SETTINGS_STORAGE_KEYS.transaction], undefined);
});

test("visual watchdog remains disabled without its separate privacy acknowledgement", async () => {
  const sync = new MemoryStorageArea();
  const local = new MemoryStorageArea();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.enableVisualWatchdog = true;
  settings.perSite["https://visual.example"] = { enabled: true, enableVisualWatchdog: true };

  const stored = await repository(sync, local, false).set(settings);

  assert.equal(stored.enableVisualWatchdog, false);
  assert.equal(stored.perSite["https://visual.example"].enableVisualWatchdog, false);
});

function globalRecord(settings: typeof DEFAULT_SETTINGS) {
  const { schemaVersion, perSite: _perSite, ...global } = settings;
  return { storageLayoutVersion: 1, schemaVersion, settings: global };
}

function siteRecord(settings: typeof DEFAULT_SETTINGS) {
  return { storageLayoutVersion: 1, schemaVersion: settings.schemaVersion, perSite: settings.perSite };
}

function select(data: Record<string, unknown>, keys: string | string[] | null): Record<string, unknown> {
  if (keys === null) return data;
  const selected: Record<string, unknown> = {};
  for (const key of typeof keys === "string" ? [keys] : keys) {
    if (Object.prototype.hasOwnProperty.call(data, key)) selected[key] = data[key];
  }
  return selected;
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength;
}
