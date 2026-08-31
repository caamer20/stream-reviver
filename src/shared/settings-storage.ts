import type { GlobalSettings, Settings, SiteSettings } from "./types";

export const SETTINGS_STORAGE_LAYOUT_VERSION = 1;
export const SETTINGS_STORAGE_KEYS = {
  global: "streamReviverSettings",
  sites: "streamReviverSiteSettingsV1",
  transaction: "streamReviverSettingsTransactionV1",
  migrationBackup: "streamReviverSettingsMigrationBackupV1"
} as const;

export type SettingsStorageErrorCode =
  | "QUOTA_EXCEEDED"
  | "TRANSACTION_BUSY"
  | "TRANSACTION_CONFLICT"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_VERIFY_FAILED"
  | "ROLLBACK_FAILED";

export class SettingsStorageError extends Error {
  constructor(
    public readonly code: SettingsStorageErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SettingsStorageError";
  }
}

export interface SettingsStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys: string | string[] | null): Promise<number>;
  quotaBytes?: number;
  quotaBytesPerItem?: number;
}

export async function attemptTrustedStorageAccess(
  setAccessLevel?: () => Promise<void>
): Promise<boolean> {
  if (!setAccessLevel) return false;
  try {
    await setAccessLevel();
    return true;
  } catch {
    return false;
  }
}

interface GlobalSettingsRecord {
  storageLayoutVersion: number;
  schemaVersion: number;
  settings: GlobalSettings;
}

interface SiteSettingsRecord {
  storageLayoutVersion: number;
  schemaVersion: number;
  perSite: Record<string, SiteSettings>;
}

interface SettingsTransaction {
  storageLayoutVersion: number;
  id: string;
  startedAt: number;
  expiresAt: number;
  oldSyncExists: boolean;
  oldSyncValue: unknown;
  oldSitesExists: boolean;
  oldSitesValue: unknown;
  oldMigrationBackupExists: boolean;
  oldMigrationBackupValue: unknown;
}

interface MigrationBackup {
  storageLayoutVersion: number;
  migratedAt: number;
  legacySyncValue: unknown;
  previousLocalSiteValue: unknown;
  legacyBytes: number;
}

interface RepositoryOptions {
  sync: SettingsStorageArea;
  local: SettingsStorageArea;
  normalize: (input: unknown) => Settings;
  visualPrivacyAcknowledged: () => Promise<boolean>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const TRANSACTION_LEASE_MS = 2_000;
const TRANSACTION_WAIT_MS = 2_250;
const TRANSACTION_POLL_MS = 25;
const FALLBACK_QUOTAS = {
  sync: { total: 102_400, perItem: 8_192 },
  local: { total: 10 * 1024 * 1024, perItem: Number.POSITIVE_INFINITY }
} as const;

/**
 * Persists the public Settings object in two privacy domains without changing
 * callers: compact global preferences are syncable, while every origin,
 * selector, URL rule, and site override remains device-local.
 */
export class SettingsStorageRepository {
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: RepositoryOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get(): Promise<Settings> {
    return this.serialized(() => this.getUnlocked());
  }

  set(settings: Settings): Promise<Settings> {
    return this.serialized(async () => {
      await this.settlePendingTransaction();
      const normalized = await this.applyPrivacyGate(this.options.normalize(settings));
      const current = await this.readRawRecords();
      await this.writeUnlocked(normalized, current, isLegacySettingsRecord(current.syncValue));
      return normalized;
    });
  }

  private async getUnlocked(): Promise<Settings> {
    await this.settlePendingTransaction();
    const current = await this.readRawRecords();
    const globalSource = isGlobalSettingsRecord(current.syncValue)
      ? current.syncValue.settings
      : isRecord(current.syncValue) ? current.syncValue : {};
    const localSites = isSiteSettingsRecord(current.sitesValue) ? current.sitesValue.perSite : undefined;
    const legacySites = isRecord(current.syncValue) && isRecord(current.syncValue.perSite)
      ? current.syncValue.perSite
      : {};
    const normalized = await this.applyPrivacyGate(this.options.normalize({
      ...globalSource,
      perSite: localSites ?? legacySites
    }));
    const desired = splitSettings(normalized);
    const needsWrite = !deepEqual(current.syncValue, desired.global)
      || !deepEqual(current.sitesValue, desired.sites);
    if (needsWrite) await this.writeUnlocked(normalized, current, isLegacySettingsRecord(current.syncValue));
    return normalized;
  }

  private async applyPrivacyGate(settings: Settings): Promise<Settings> {
    if (await this.options.visualPrivacyAcknowledged()) return settings;
    settings.enableVisualWatchdog = false;
    for (const site of Object.values(settings.perSite)) {
      if (site.enableVisualWatchdog === true) site.enableVisualWatchdog = false;
    }
    return settings;
  }

  private async readRawRecords(): Promise<{
    syncExists: boolean;
    syncValue: unknown;
    sitesExists: boolean;
    sitesValue: unknown;
    migrationBackupExists: boolean;
    migrationBackupValue: unknown;
  }> {
    const [syncStored, localStored] = await Promise.all([
      this.options.sync.get(SETTINGS_STORAGE_KEYS.global),
      this.options.local.get([SETTINGS_STORAGE_KEYS.sites, SETTINGS_STORAGE_KEYS.migrationBackup])
    ]);
    return {
      syncExists: hasOwn(syncStored, SETTINGS_STORAGE_KEYS.global),
      syncValue: syncStored[SETTINGS_STORAGE_KEYS.global],
      sitesExists: hasOwn(localStored, SETTINGS_STORAGE_KEYS.sites),
      sitesValue: localStored[SETTINGS_STORAGE_KEYS.sites],
      migrationBackupExists: hasOwn(localStored, SETTINGS_STORAGE_KEYS.migrationBackup),
      migrationBackupValue: localStored[SETTINGS_STORAGE_KEYS.migrationBackup]
    };
  }

  private async writeUnlocked(
    settings: Settings,
    current: Awaited<ReturnType<SettingsStorageRepository["readRawRecords"]>>,
    migration: boolean
  ): Promise<void> {
    const desired = splitSettings(settings);
    const id = createTransactionId(this.now());
    const transaction: SettingsTransaction = {
      storageLayoutVersion: SETTINGS_STORAGE_LAYOUT_VERSION,
      id,
      startedAt: this.now(),
      expiresAt: this.now() + TRANSACTION_LEASE_MS,
      oldSyncExists: current.syncExists,
      oldSyncValue: current.syncValue ?? null,
      oldSitesExists: current.sitesExists,
      oldSitesValue: current.sitesValue ?? null,
      oldMigrationBackupExists: current.migrationBackupExists,
      oldMigrationBackupValue: current.migrationBackupValue ?? null
    };
    const migrationBackup: MigrationBackup | undefined = migration ? {
      storageLayoutVersion: SETTINGS_STORAGE_LAYOUT_VERSION,
      migratedAt: this.now(),
      legacySyncValue: current.syncValue ?? null,
      previousLocalSiteValue: current.sitesValue ?? null,
      legacyBytes: serializedBytes(current.syncValue)
    } : undefined;

    const projectedLocal: Record<string, unknown> = {
      [SETTINGS_STORAGE_KEYS.transaction]: transaction,
      [SETTINGS_STORAGE_KEYS.sites]: desired.sites
    };
    if (migrationBackup) projectedLocal[SETTINGS_STORAGE_KEYS.migrationBackup] = migrationBackup;
    await Promise.all([
      preflightStorageWrite("sync", this.options.sync, { [SETTINGS_STORAGE_KEYS.global]: desired.global }),
      preflightStorageWrite("local", this.options.local, projectedLocal)
    ]);

    let ownsTransaction = false;
    try {
      await this.options.local.set({ [SETTINGS_STORAGE_KEYS.transaction]: transaction });
      ownsTransaction = await this.ownsTransaction(id);
      if (!ownsTransaction) throw new SettingsStorageError(
        "TRANSACTION_CONFLICT",
        "Another settings update started at the same time. Please retry."
      );
      if (migrationBackup) {
        await this.options.local.set({ [SETTINGS_STORAGE_KEYS.migrationBackup]: migrationBackup });
      }
      await this.options.local.set({ [SETTINGS_STORAGE_KEYS.sites]: desired.sites });
      if (!await this.ownsTransaction(id)) throw new SettingsStorageError(
        "TRANSACTION_CONFLICT",
        "Settings transaction ownership changed before the sync update. Please retry."
      );
      await this.options.sync.set({ [SETTINGS_STORAGE_KEYS.global]: desired.global });
      if (!await this.ownsTransaction(id)) throw new SettingsStorageError(
        "TRANSACTION_CONFLICT",
        "Settings transaction ownership changed before verification. Please retry."
      );
      const verify = await this.readRawRecords();
      if (!deepEqual(verify.syncValue, desired.global) || !deepEqual(verify.sitesValue, desired.sites)) {
        throw new SettingsStorageError("STORAGE_VERIFY_FAILED", "The browser did not persist the complete settings update.");
      }
      await this.options.local.remove(SETTINGS_STORAGE_KEYS.transaction);
      ownsTransaction = false;
    } catch (error) {
      if (ownsTransaction && await this.ownsTransaction(id).catch(() => false)) {
        try {
          await this.restoreTransaction(transaction);
        } catch (rollbackError) {
          throw new SettingsStorageError(
            "ROLLBACK_FAILED",
            "The settings update failed and its previous value could not be fully restored.",
            { cause: rollbackError }
          );
        }
      }
      if (error instanceof SettingsStorageError) throw error;
      throw storageWriteError(error);
    }
  }

  private async settlePendingTransaction(): Promise<void> {
    const waitDeadline = this.now() + TRANSACTION_WAIT_MS;
    while (true) {
      const stored = await this.options.local.get(SETTINGS_STORAGE_KEYS.transaction);
      const candidate = stored[SETTINGS_STORAGE_KEYS.transaction];
      if (candidate === undefined) return;
      if (!isSettingsTransaction(candidate)) {
        await this.options.local.remove(SETTINGS_STORAGE_KEYS.transaction);
        return;
      }
      if (candidate.expiresAt <= this.now()) {
        try {
          await this.restoreTransaction(candidate);
          return;
        } catch (error) {
          throw new SettingsStorageError(
            "ROLLBACK_FAILED",
            "An interrupted settings update could not be restored.",
            { cause: error }
          );
        }
      }
      if (this.now() >= waitDeadline) {
        throw new SettingsStorageError("TRANSACTION_BUSY", "Another settings update is still in progress. Please retry.");
      }
      await this.sleep(TRANSACTION_POLL_MS);
    }
  }

  private async ownsTransaction(id: string): Promise<boolean> {
    const stored = await this.options.local.get(SETTINGS_STORAGE_KEYS.transaction);
    const transaction = stored[SETTINGS_STORAGE_KEYS.transaction];
    return isSettingsTransaction(transaction) && transaction.id === id;
  }

  private async restoreTransaction(transaction: SettingsTransaction): Promise<void> {
    await restoreEntry(
      this.options.sync,
      SETTINGS_STORAGE_KEYS.global,
      transaction.oldSyncExists,
      transaction.oldSyncValue
    );
    await restoreEntry(
      this.options.local,
      SETTINGS_STORAGE_KEYS.sites,
      transaction.oldSitesExists,
      transaction.oldSitesValue
    );
    await restoreEntry(
      this.options.local,
      SETTINGS_STORAGE_KEYS.migrationBackup,
      transaction.oldMigrationBackupExists,
      transaction.oldMigrationBackupValue
    );
    await this.options.local.remove(SETTINGS_STORAGE_KEYS.transaction);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = () => withCrossContextSettingsLock(operation);
    const task = this.queue.then(run, run);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}

/** Repository instances exist in the background, options, popup, and welcome
 * documents. A per-instance promise queue is insufficient when two extension
 * contexts start at once, so use the origin-scoped Web Locks API where the
 * browser exposes it. The durable transaction marker remains the crash-safe
 * fallback and recovery journal. */
async function withCrossContextSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
  const manager = (globalThis.navigator as Navigator & { locks?: LockManager } | undefined)?.locks;
  if (!manager?.request) return operation();
  return manager.request("stream-reviver-settings-storage-v1", { mode: "exclusive" }, operation);
}

export async function preflightStorageWrite(
  areaName: "sync" | "local",
  area: SettingsStorageArea,
  items: Record<string, unknown>
): Promise<void> {
  const defaults = FALLBACK_QUOTAS[areaName];
  const totalQuota = finitePositive(area.quotaBytes) ?? defaults.total;
  const perItemQuota = finitePositive(area.quotaBytesPerItem) ?? defaults.perItem;
  for (const [key, value] of Object.entries(items)) {
    const bytes = serializedBytes({ [key]: value });
    if (bytes > perItemQuota) throw new SettingsStorageError(
      "QUOTA_EXCEEDED",
      `${areaName} settings item “${key}” requires approximately ${bytes} bytes; the browser limit is ${perItemQuota} bytes.`
    );
  }
  const replacementBytes = serializedBytes(items);
  let projectedBytes = replacementBytes;
  if (area.getBytesInUse) {
    try {
      const [used, replaced] = await Promise.all([
        area.getBytesInUse(null),
        area.getBytesInUse(Object.keys(items))
      ]);
      projectedBytes = Math.max(0, used - replaced) + replacementBytes;
    } catch {
      // Firefox and test environments may not expose byte accounting. The
      // conservative serialized-size check and the browser write remain gates.
    }
  }
  if (projectedBytes > totalQuota) throw new SettingsStorageError(
    "QUOTA_EXCEEDED",
    `${areaName} settings would use approximately ${projectedBytes} bytes; the browser limit is ${totalQuota} bytes.`
  );
}

function splitSettings(settings: Settings): { global: GlobalSettingsRecord; sites: SiteSettingsRecord } {
  const { schemaVersion, perSite, ...global } = settings;
  return {
    global: {
      storageLayoutVersion: SETTINGS_STORAGE_LAYOUT_VERSION,
      schemaVersion,
      settings: global
    },
    sites: {
      storageLayoutVersion: SETTINGS_STORAGE_LAYOUT_VERSION,
      schemaVersion,
      perSite
    }
  };
}

function isGlobalSettingsRecord(value: unknown): value is GlobalSettingsRecord {
  return isRecord(value)
    && value.storageLayoutVersion === SETTINGS_STORAGE_LAYOUT_VERSION
    && typeof value.schemaVersion === "number"
    && isRecord(value.settings);
}

function isSiteSettingsRecord(value: unknown): value is SiteSettingsRecord {
  return isRecord(value)
    && value.storageLayoutVersion === SETTINGS_STORAGE_LAYOUT_VERSION
    && typeof value.schemaVersion === "number"
    && isRecord(value.perSite);
}

function isLegacySettingsRecord(value: unknown): boolean {
  return value !== undefined && !isGlobalSettingsRecord(value);
}

function isSettingsTransaction(value: unknown): value is SettingsTransaction {
  return isRecord(value)
    && value.storageLayoutVersion === SETTINGS_STORAGE_LAYOUT_VERSION
    && typeof value.id === "string"
    && Number.isFinite(value.startedAt)
    && Number.isFinite(value.expiresAt)
    && typeof value.oldSyncExists === "boolean"
    && typeof value.oldSitesExists === "boolean"
    && typeof value.oldMigrationBackupExists === "boolean";
}

function storageWriteError(error: unknown): SettingsStorageError {
  const detail = error instanceof Error ? error.message : String(error);
  if (/quota|QUOTA_BYTES|MAX_WRITE/i.test(detail)) return new SettingsStorageError(
    "QUOTA_EXCEEDED",
    `The browser rejected the settings update because its storage quota was exceeded: ${detail}`,
    { cause: error }
  );
  return new SettingsStorageError(
    "STORAGE_WRITE_FAILED",
    `The browser could not persist the settings update: ${detail}`,
    { cause: error }
  );
}

async function restoreEntry(area: SettingsStorageArea, key: string, existed: boolean, value: unknown): Promise<void> {
  if (existed) await area.set({ [key]: value });
  else await area.remove(key);
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value) ?? "null";
  return new TextEncoder().encode(serialized).byteLength;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function createTransactionId(now: number): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return randomUUID ? `${now}:${randomUUID()}` : `${now}:${Math.random().toString(36).slice(2)}`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
