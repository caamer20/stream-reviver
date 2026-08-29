import { apiCall, ext } from "./api";
import { DEFAULT_SETTINGS } from "./defaults";
import { SETTINGS_SCHEMA_VERSION, type EffectiveSettings, type GlobalSettings, type RecoveryAction, type Settings, type SiteSettings } from "./types";

const SETTINGS_KEY = "streamReviverSettings";
const ACK_KEY = "streamReviverDisclaimerAcknowledged";

const numericBounds: Record<string, [number, number]> = {
  checkIntervalSeconds: [1, 60], healthyCheckIntervalSeconds: [2, 120], suspectCheckIntervalSeconds: [0.5, 10],
  mutationDebounceMs: [100, 5000], stallTimeoutSeconds: [5, 300], pageLoadGraceSeconds: [0, 300],
  refreshCountdownSeconds: [1, 60], maxAutoRefreshes: [1, 20], refreshWindowMinutes: [1, 1440],
  successResetSeconds: [10, 3600], failureConfidenceThreshold: [40, 100], failureConfirmationChecks: [1, 10],
  historyLimit: [20, 1000], liveEdgeThresholdSeconds: [5, 600], recoveryVerificationSeconds: [3, 120],
  maxRecoveryActionsPerCycle: [1, 30], visualSampleIntervalSeconds: [5, 120]
};

const booleanKeys: (keyof GlobalSettings)[] = [
  "enabled", "autoRefresh", "autoMaximize", "onlyWhenTabVisible", "waitWhileOffline", "lockPrimaryVideo",
  "detectFrozenFrames", "restorePlayerPreferences", "useCssMaximizeFallback", "attemptNativeFullscreenClick",
  "enablePictureInPicture", "showBadge", "showNotifications", "localHistoryEnabled", "enableAdaptiveTuning",
  "enableAdvancedPlayerBridge", "enableVisualWatchdog", "keepScreenAwake", "protectTabFromDiscard"
];
const selectorKeys = ["selectedVideoSelector", "videoContainerSelector", "fullscreenButtonSelector", "playButtonSelector", "retryButtonSelector", "liveButtonSelector", "errorSelector", "accessInterruptionSelector", "adIndicatorSelector"] as const;
const recoveryActions = new Set<RecoveryAction>(["WAIT", "USER_PROMPT", "REDISCOVER", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"]);

export function normalizeSettings(input: unknown): Settings {
  const migrated = migrateSettings(isRecord(input) ? input : {});
  const normalized: Settings = structuredClone(DEFAULT_SETTINGS);
  normalized.schemaVersion = SETTINGS_SCHEMA_VERSION;
  copyGlobalValues(migrated, normalized);
  if (isRecord(migrated.perSite)) {
    for (const [origin, value] of Object.entries(migrated.perSite)) {
      if (isSafeOrigin(origin) && isRecord(value)) normalized.perSite[origin] = normalizeSiteSettings(value);
    }
  }
  return normalized;
}

export function normalizeSiteSettings(input: unknown): SiteSettings {
  const source = isRecord(input) ? input : {};
  const output: SiteSettings = {};
  copyGlobalValues(source, output);
  for (const key of selectorKeys) if (typeof source[key] === "string") output[key] = source[key].trim().slice(0, 500);
  if (["AUTO", "HTML5", "MSE", "HLS_JS", "DASH_JS", "WEBRTC", "CANVAS"].includes(source.declaredPlayerType)) output.declaredPlayerType = source.declaredPlayerType;
  if (typeof source.profileId === "string") output.profileId = source.profileId.trim().slice(0, 100);
  output.backupUrls = normalizeUrls(source.backupUrls);
  output.includeUrlPatterns = normalizePatterns(source.includeUrlPatterns);
  output.excludeUrlPatterns = normalizePatterns(source.excludeUrlPatterns);
  return output;
}

export function effectiveSettings(settings: Settings, origin: string): EffectiveSettings {
  const site = settings.perSite[origin] ?? {};
  const globalOnly = { ...settings } as Settings;
  delete (globalOnly as Partial<Settings>).perSite;
  return {
    ...(globalOnly as GlobalSettings & { schemaVersion: number }), ...site,
    siteEnabled: site.enabled === true,
    selectedVideoSelector: site.selectedVideoSelector ?? "", videoContainerSelector: site.videoContainerSelector ?? "",
    fullscreenButtonSelector: site.fullscreenButtonSelector ?? "", playButtonSelector: site.playButtonSelector ?? "",
    retryButtonSelector: site.retryButtonSelector ?? "", liveButtonSelector: site.liveButtonSelector ?? "", errorSelector: site.errorSelector ?? "",
    accessInterruptionSelector: site.accessInterruptionSelector ?? "", adIndicatorSelector: site.adIndicatorSelector ?? "",
    declaredPlayerType: site.declaredPlayerType ?? "AUTO", backupUrls: site.backupUrls ?? [], profileId: site.profileId ?? "",
    includeUrlPatterns: site.includeUrlPatterns ?? [], excludeUrlPatterns: site.excludeUrlPatterns ?? []
  };
}

export function isUrlEnabled(url: string, settings: Pick<EffectiveSettings, "includeUrlPatterns" | "excludeUrlPatterns">): boolean {
  if (settings.excludeUrlPatterns.some((pattern) => matchUrlPattern(url, pattern))) return false;
  return settings.includeUrlPatterns.length === 0 || settings.includeUrlPatterns.some((pattern) => matchUrlPattern(url, pattern));
}

export function matchUrlPattern(url: string, pattern: string): boolean {
  if (!pattern.trim()) return false;
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try { return new RegExp(`^${escaped}$`, "i").test(url); } catch { return false; }
}

export async function getSettings(): Promise<Settings> {
  const stored = await apiCall<Record<string, unknown>>(ext.storage.sync.get, ext.storage.sync, SETTINGS_KEY);
  const normalized = normalizeSettings(stored[SETTINGS_KEY]);
  if (!stored[SETTINGS_KEY] || (stored[SETTINGS_KEY] as any)?.schemaVersion !== SETTINGS_SCHEMA_VERSION) await setSettings(normalized);
  return normalized;
}

export async function setSettings(settings: Settings): Promise<Settings> {
  const normalized = normalizeSettings(settings);
  await apiCall<void>(ext.storage.sync.set, ext.storage.sync, { [SETTINGS_KEY]: normalized });
  return normalized;
}

export async function getDisclaimerAcknowledged(): Promise<boolean> {
  const stored = await apiCall<Record<string, unknown>>(ext.storage.local.get, ext.storage.local, ACK_KEY);
  return stored[ACK_KEY] === true;
}
export async function setDisclaimerAcknowledged(value: boolean): Promise<void> {
  await apiCall<void>(ext.storage.local.set, ext.storage.local, { [ACK_KEY]: value });
}
export function isSafeOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try { const parsed = new URL(origin); return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin; }
  catch { return false; }
}

function copyGlobalValues(source: Record<string, any>, output: Record<string, any>): void {
  for (const key of booleanKeys) if (typeof source[key] === "boolean") output[key] = source[key];
  for (const [key, [minimum, maximum]] of Object.entries(numericBounds)) {
    if (source[key] === undefined || source[key] === null || source[key] === "") continue;
    const value = Number(source[key]);
    if (Number.isFinite(value)) output[key] = Math.min(maximum, Math.max(minimum, value));
  }
  if (Array.isArray(source.recoveryStrategy)) {
    const actions = source.recoveryStrategy.filter((value: unknown): value is RecoveryAction => typeof value === "string" && recoveryActions.has(value as RecoveryAction));
    if (actions.length) output.recoveryStrategy = [...new Set(actions)];
  }
  if (Array.isArray(source.recoveryBackoffSeconds)) {
    const backoff = source.recoveryBackoffSeconds.map(Number).filter(Number.isFinite).map((value: number) => Math.min(3600, Math.max(1, value)));
    if (backoff.length) output.recoveryBackoffSeconds = backoff.slice(0, 10);
  }
}
function normalizePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, 500)))].slice(0, 50);
}
function normalizeUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const parsed = new URL(item.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") urls.push(parsed.href.slice(0, 2000));
    } catch { /* invalid URL */ }
  }
  return [...new Set(urls)].slice(0, 10);
}
function migrateSettings(source: Record<string, any>): Record<string, any> {
  const migrated = structuredClone(source);
  if ((Number(migrated.schemaVersion) || 1) < 2) {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) if (key !== "perSite" && migrated[key] === undefined) migrated[key] = value;
  }
  if ((Number(migrated.schemaVersion) || 1) < 3) {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) if (key !== "perSite" && migrated[key] === undefined) migrated[key] = value;
  }
  migrated.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return migrated;
}
function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
