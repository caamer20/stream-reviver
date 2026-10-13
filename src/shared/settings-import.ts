import { DEFAULT_SETTINGS } from "./defaults";
import { isSafeOrigin, normalizeSettings } from "./settings";
import { SETTINGS_SCHEMA_VERSION, type Settings } from "./types";

export const MAX_SETTINGS_IMPORT_BYTES = 1_000_000;
const siteStrings = new Set(["selectedVideoSelector", "videoContainerSelector", "fullscreenButtonSelector", "playButtonSelector", "retryButtonSelector", "liveButtonSelector", "errorSelector", "accessInterruptionSelector", "adIndicatorSelector", "profileId", "declaredPlayerType"]);
const siteArrays = new Set(["backupUrls", "includeUrlPatterns", "excludeUrlPatterns"]);
const actions = new Set(["WAIT", "USER_PROMPT", "REDISCOVER", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(message: string): never { throw new Error(`Invalid settings backup: ${message}`); }

export interface SettingsImportReview { settings: Settings; defaultedFields: string[]; sourceVersion: number }
/** Validate backup identity and shape before normalization can silently substitute defaults. */
export function prepareSettingsImport(input: unknown): SettingsImportReview {
  if (!record(input)) fail("expected a settings object.");
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_SETTINGS_IMPORT_BYTES) fail("file is too large (maximum 1 MB).");
  if (input.schemaVersion !== undefined && (!Number.isInteger(input.schemaVersion) || Number(input.schemaVersion) < 1 || Number(input.schemaVersion) > SETTINGS_SCHEMA_VERSION)) fail("unsupported schema version.");
  // Every exported generation includes perSite and at least one global setting.
  if (!record(input.perSite) || !Object.keys(DEFAULT_SETTINGS).some((key) => key !== "schemaVersion" && key !== "perSite" && key in input)) fail("not a recognized settings export.");
  validateValues(input, false);
  if (Object.keys(input.perSite).length > 500) fail("maximum 500 sites.");
  for (const [origin, site] of Object.entries(input.perSite)) {
    if (!isSafeOrigin(origin) || !record(site)) fail(`invalid site ${origin}.`);
    validateValues(site, true);
  }
  const settings = normalizeSettings(input);
  for (const site of Object.values(settings.perSite)) site.enabled = false;
  return { settings, sourceVersion: Number(input.schemaVersion ?? 1), defaultedFields: Object.keys(DEFAULT_SETTINGS).filter((key) => key !== "schemaVersion" && key !== "perSite" && input[key] === undefined) };
}

function validateValues(source: Record<string, unknown>, site: boolean): void {
  for (const [key, value] of Object.entries(source)) {
    if (!site && (key === "schemaVersion" || key === "perSite")) continue;
    const template = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
    if (site && siteStrings.has(key)) {
      if (typeof value !== "string" || value.length > (key === "profileId" ? 100 : 500)) fail(`invalid ${key}.`);
      if (key === "declaredPlayerType" && !["AUTO", "HTML5", "MSE", "HLS_JS", "DASH_JS", "WEBRTC", "CANVAS"].includes(value)) fail("invalid player type.");
    } else if (site && siteArrays.has(key)) {
      if (!Array.isArray(value) || value.length > (key === "backupUrls" ? 10 : 50) || value.some((item) => typeof item !== "string" || item.length > (key === "backupUrls" ? 2000 : 500))) fail(`invalid ${key}.`);
      if (key === "backupUrls") for (const url of value) {
        try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) fail("unsafe backup URL."); } catch { fail("unsafe backup URL."); }
      }
    } else if (typeof template === "boolean") {
      if (typeof value !== "boolean") fail(`${key} must be a boolean.`);
    } else if (typeof template === "number" && key !== "schemaVersion") {
      if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))) fail(`${key} must be a finite number.`);
    } else if (key === "recoveryStrategy") {
      if (!Array.isArray(value) || !value.length || value.length > 30 || value.some((item) => !actions.has(item))) fail("invalid recovery strategy.");
    } else if (key === "recoveryBackoffSeconds") {
      if (!Array.isArray(value) || !value.length || value.length > 10 || value.some((item) => (typeof item !== "number" && typeof item !== "string") || (typeof item === "string" && !item.trim()) || !Number.isFinite(Number(item)))) fail("invalid recovery backoff.");
    } else fail(`unrecognized field ${key}.`);
  }
}

export class SettingsImportError extends Error {
  constructor(message: string, readonly disabledOrigins: string[], readonly phase: "disable" | "write") {
    super(`Import failed: ${message} ${disabledOrigins.length} current site deactivation(s) were confirmed; the failing operation may also have partially changed saved state. ${phase === "disable" ? "Replacement settings were not written; current configurations are preserved." : "Saving replacement settings failed; reload saved settings before retrying."}`);
  }
}
/** Writes only after every current enabled site confirms successful deactivation. */
export async function applySettingsImport(input: unknown, current: Settings, dependencies: {
  disableSite(origin: string): Promise<{ ok: boolean; error?: string }>;
  write(settings: Settings): Promise<Settings>;
}): Promise<Settings> {
  const review = prepareSettingsImport(input);
  const disabled: string[] = [];
  for (const [origin, site] of Object.entries(current.perSite)) {
    if (!site.enabled) continue;
    try {
      const result = await dependencies.disableSite(origin);
      if (result?.ok !== true) throw new Error(result?.error || `Could not disable ${origin}.`);
      disabled.push(origin);
    } catch (error) { throw new SettingsImportError(String(error instanceof Error ? error.message : error), disabled, "disable"); }
  }
  try { return await dependencies.write(review.settings); }
  catch (error) { throw new SettingsImportError(String(error instanceof Error ? error.message : error), disabled, "write"); }
}
