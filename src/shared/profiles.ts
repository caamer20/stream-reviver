import type { RecoveryAction, SelectorField, SiteProfile } from "./types";

const actions = new Set<RecoveryAction>(["WAIT", "USER_PROMPT", "REDISCOVER", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"]);
const selectorFields = new Set<SelectorField>(["selectedVideoSelector", "videoContainerSelector", "fullscreenButtonSelector", "playButtonSelector", "retryButtonSelector", "liveButtonSelector", "errorSelector", "accessInterruptionSelector", "adIndicatorSelector"]);
const playerTypes = new Set(["AUTO", "HTML5", "MSE", "HLS_JS", "DASH_JS", "WEBRTC", "CANVAS"]);

export function normalizeProfile(input: unknown): SiteProfile {
  if (!isRecord(input)) throw new Error("Profile must be an object.");
  const id = clean(input.id, 100) || randomId();
  const name = clean(input.name, 100);
  if (!name) throw new Error("Profile name is required.");
  const selectors: Partial<Record<SelectorField, string>> = {};
  if (isRecord(input.selectors)) for (const [key, value] of Object.entries(input.selectors)) {
    if (selectorFields.has(key as SelectorField) && typeof value === "string") selectors[key as SelectorField] = value.trim().slice(0, 500);
  }
  const recoveryStrategy = Array.isArray(input.recoveryStrategy)
    ? [...new Set(input.recoveryStrategy.filter((value): value is RecoveryAction => typeof value === "string" && actions.has(value as RecoveryAction)))].slice(0, 12)
    : [];
  const now = Date.now();
  return {
    schemaVersion: 1, id, name, version: clamp(input.version, 1, 10_000),
    originPatterns: patterns(input.originPatterns, 20), urlPatterns: patterns(input.urlPatterns, 50),
    declaredPlayerType: playerTypes.has(input.declaredPlayerType) ? input.declaredPlayerType as SiteProfile["declaredPlayerType"] : "AUTO",
    selectors, recoveryStrategy, backupUrls: urls(input.backupUrls), notes: clean(input.notes, 2000),
    createdAt: clamp(input.createdAt, 0, now) || now, updatedAt: now
  };
}

export function profileToSiteOverrides(profile: SiteProfile) {
  return {
    ...profile.selectors, declaredPlayerType: profile.declaredPlayerType,
    recoveryStrategy: profile.recoveryStrategy.length ? profile.recoveryStrategy : undefined,
    backupUrls: profile.backupUrls, includeUrlPatterns: profile.urlPatterns, profileId: profile.id
  };
}

function patterns(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 500)).filter(Boolean))].slice(0, limit);
}
function urls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) if (typeof item === "string") try {
    const url = new URL(item.trim()); if (url.protocol === "https:" || url.protocol === "http:") result.push(url.href.slice(0, 2000));
  } catch { /* invalid */ }
  return [...new Set(result)].slice(0, 10);
}
function clean(value: unknown, limit: number): string { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function clamp(value: unknown, minimum: number, maximum: number): number {
  const number = Number(value); return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : minimum;
}
function randomId(): string { return crypto.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
