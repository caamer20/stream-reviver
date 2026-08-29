import type { RuntimeMessage } from "./types";

export interface ValidationResult { ok: boolean; error?: string }

const noPayload = new Set<RuntimeMessage["type"]>([
  "GET_PROFILES", "ACKNOWLEDGE_DISCLAIMER", "GET_PRIVACY_STATE", "ACKNOWLEDGE_VISUAL_PRIVACY",
  "CANCEL_AUTO_REFRESH", "REQUEST_PARENT_MAXIMIZE", "CANCEL_SELECTOR_PICKER", "RETRY_MONITORING",
  "PICTURE_IN_PICTURE_NOW", "JUMP_TO_LIVE_NOW", "STOP_ELEMENT_PICKER", "SHUTDOWN_MONITOR"
]);
const knownTypes = new Set<RuntimeMessage["type"]>([
  "GET_CONTEXT", "GET_POPUP_STATE", "GET_HISTORY", "GET_SITE_MODEL", "GET_PROFILES", "SAVE_PROFILE", "DELETE_PROFILE",
  "CLEAR_HISTORY", "CLEAR_DATA", "GET_PRIVACY_STATE", "ACKNOWLEDGE_VISUAL_PRIVACY", "ACKNOWLEDGE_DISCLAIMER",
  "UPDATE_GLOBAL_SETTINGS", "SET_SITE_ENABLED", "SET_SITE_OVERRIDES", "SAVE_SITE_SELECTOR", "REPORT_STATUS", "LOG_HISTORY",
  "VALIDATE_SITE_SELECTOR",
  "REQUEST_AUTO_REFRESH", "RECORD_AUTO_REFRESH", "CANCEL_AUTO_REFRESH", "PLAYBACK_SUCCESS", "RECORD_ACTION_OUTCOME",
  "RECORD_HEALTH_SAMPLE", "RECORD_USER_FEEDBACK", "SAVE_SESSION_SNAPSHOT", "CLEAR_SESSION_SNAPSHOT", "CLAIM_AUTO_MAXIMIZE",
  "SAVE_PLAYER_PREFERENCES", "REQUEST_PARENT_MAXIMIZE", "REQUEST_IFRAME_RECOVERY", "MANUAL_REFRESH", "MANUAL_MAXIMIZE",
  "MANUAL_PICTURE_IN_PICTURE", "MANUAL_JUMP_TO_LIVE", "PIN_PRIMARY_VIDEO", "START_SELECTOR_PICKER", "CANCEL_SELECTOR_PICKER",
  "SNOOZE_TAB", "SET_EVENT_MODE", "RESET_TAB_ATTEMPTS", "REQUEST_VISUAL_SAMPLE", "EXTEND_COUNTDOWN", "CANCEL_TAB_COUNTDOWN",
  "SHUTDOWN_MONITOR", "SETTINGS_CHANGED", "START_COUNTDOWN", "EXTEND_COUNTDOWN_IN_PAGE", "STOP_COUNTDOWN", "SHOW_LOOP_WARNING", "RETRY_MONITORING",
  "SNOOZE_UNTIL", "EVENT_MODE_UNTIL", "MAXIMIZE_NOW", "PICTURE_IN_PICTURE_NOW", "JUMP_TO_LIVE_NOW", "MAXIMIZE_IFRAME",
  "RECOVER_IFRAME", "BEGIN_ELEMENT_PICKER", "VALIDATE_SELECTOR", "STOP_ELEMENT_PICKER"
]);

export function validateRuntimeMessage(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Message must be an object");
  if (typeof value.type !== "string" || !knownTypes.has(value.type as RuntimeMessage["type"])) return invalid("Unknown message type");
  if (hasUnsafeKey(value, 0)) return invalid("Message contains an unsafe key or exceeds nesting limits");
  try { if (JSON.stringify(value).length > 128_000) return invalid("Message exceeds 128 KB"); }
  catch { return invalid("Message is not serializable"); }

  const type = value.type as RuntimeMessage["type"];
  if (noPayload.has(type)) return exact(value, ["type"]);
  switch (type) {
    case "GET_CONTEXT": return all(exact(value, ["type", "origin", "pageUrl"]), origin(value.origin), url(value.pageUrl));
    case "GET_POPUP_STATE": return all(exact(value, ["type", "tabId", "origin"]), optionalTab(value.tabId), optional(value.origin, origin));
    case "GET_HISTORY": return all(exact(value, ["type", "tabId", "limit"]), optionalTab(value.tabId), optionalNumber(value.limit, 1, 1_000));
    case "GET_SITE_MODEL": case "CLEAR_SESSION_SNAPSHOT": return all(exact(value, ["type", "origin"]), origin(value.origin));
    case "DELETE_PROFILE": return all(exact(value, ["type", "profileId"]), text(value.profileId, 1, 100));
    case "CLEAR_HISTORY": return all(exact(value, ["type", "tabId"]), optionalTab(value.tabId));
    case "CLEAR_DATA": return all(exact(value, ["type", "target"]), oneOf(value.target, ["history", "models", "preferences", "profiles", "runtime", "all"]));
    case "SAVE_PROFILE": return all(exact(value, ["type", "profile"]), record(value.profile));
    case "UPDATE_GLOBAL_SETTINGS": return all(exact(value, ["type", "patch"]), record(value.patch));
    case "SET_SITE_ENABLED": return all(exact(value, ["type", "origin", "enabled", "tabId"]), origin(value.origin), bool(value.enabled), optionalTab(value.tabId));
    case "SET_SITE_OVERRIDES": return all(exact(value, ["type", "origin", "overrides", "replace"]), origin(value.origin), record(value.overrides), optionalBoolean(value.replace));
    case "SAVE_SITE_SELECTOR": return all(exact(value, ["type", "origin", "field", "selector", "tabId"]), origin(value.origin), selectorField(value.field), text(value.selector, 0, 500), optionalTab(value.tabId));
    case "VALIDATE_SITE_SELECTOR": return all(exact(value, ["type", "origin", "field", "selector"]), origin(value.origin), selectorField(value.field), text(value.selector, 0, 500));
    case "REPORT_STATUS": return all(exact(value, ["type", "status"]), status(value.status));
    case "LOG_HISTORY": return all(exact(value, ["type", "entry"]), historyEntry(value.entry));
    case "REQUEST_AUTO_REFRESH": return all(exact(value, ["type", "origin", "pageUrl", "reason", "confidence"]), origin(value.origin), url(value.pageUrl), text(value.reason, 1, 500), number(value.confidence, 0, 100));
    case "RECORD_AUTO_REFRESH": return all(exact(value, ["type", "origin", "pageUrl"]), origin(value.origin), url(value.pageUrl));
    case "PLAYBACK_SUCCESS": case "CLAIM_AUTO_MAXIMIZE": return all(exact(value, ["type", "pageUrl"]), url(value.pageUrl));
    case "RECORD_ACTION_OUTCOME": return all(exact(value, ["type", "origin", "outcome"]), origin(value.origin), actionOutcome(value.outcome));
    case "RECORD_HEALTH_SAMPLE": return all(exact(value, ["type", "origin", "sample"]), origin(value.origin), healthSample(value.sample));
    case "RECORD_USER_FEEDBACK": return all(exact(value, ["type", "origin", "correct", "failureKind"]), origin(value.origin), bool(value.correct), text(value.failureKind, 1, 50));
    case "SAVE_SESSION_SNAPSHOT": return all(exact(value, ["type", "snapshot"]), snapshot(value.snapshot));
    case "SAVE_PLAYER_PREFERENCES": return all(exact(value, ["type", "origin", "preferences"]), origin(value.origin), preferences(value.preferences));
    case "REQUEST_IFRAME_RECOVERY": case "RECOVER_IFRAME": return all(exact(value, ["type", "frameToken"]), text(value.frameToken, 1, 100));
    case "MANUAL_REFRESH": return all(exact(value, ["type", "tabId", "origin"]), tab(value.tabId), origin(value.origin));
    case "MANUAL_MAXIMIZE": case "MANUAL_PICTURE_IN_PICTURE": case "MANUAL_JUMP_TO_LIVE": case "PIN_PRIMARY_VIDEO":
    case "RESET_TAB_ATTEMPTS": case "CANCEL_TAB_COUNTDOWN": return all(exact(value, ["type", "tabId"]), tab(value.tabId));
    case "START_SELECTOR_PICKER": return all(exact(value, ["type", "origin", "field"]), origin(value.origin), selectorField(value.field));
    case "SNOOZE_TAB": case "SET_EVENT_MODE": return all(exact(value, ["type", "tabId", "until"]), tab(value.tabId), nullableNumber(value.until, -1, Date.now() + 366 * 24 * 60 * 60_000));
    case "REQUEST_VISUAL_SAMPLE": return all(exact(value, ["type", "rect"]), rectangle(value.rect));
    case "EXTEND_COUNTDOWN": return all(exact(value, ["type", "tabId", "seconds"]), tab(value.tabId), number(value.seconds, 1, 600));
    case "SETTINGS_CHANGED": return all(exact(value, ["type", "settings"]), record(value.settings));
    case "START_COUNTDOWN": return all(exact(value, ["type", "seconds", "reason"]), number(value.seconds, 1, 600), text(value.reason, 1, 500));
    case "EXTEND_COUNTDOWN_IN_PAGE": return all(exact(value, ["type", "seconds"]), number(value.seconds, 1, 600));
    case "STOP_COUNTDOWN": return all(exact(value, ["type", "reason"]), optional(value.reason, (item) => text(item, 0, 500)));
    case "SHOW_LOOP_WARNING": return all(exact(value, ["type", "detail"]), text(value.detail, 1, 500));
    case "SNOOZE_UNTIL": case "EVENT_MODE_UNTIL": return all(exact(value, ["type", "until"]), nullableNumber(value.until, -1, Date.now() + 366 * 24 * 60 * 60_000));
    case "MAXIMIZE_NOW": case "MAXIMIZE_IFRAME": return all(exact(value, ["type", "manual"]), optionalBoolean(value.manual));
    case "BEGIN_ELEMENT_PICKER": return all(exact(value, ["type", "field"]), selectorField(value.field));
    case "VALIDATE_SELECTOR": return all(exact(value, ["type", "field", "selector"]), selectorField(value.field), text(value.selector, 0, 500));
    default: return invalid("Message schema is not implemented");
  }
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage { return validateRuntimeMessage(value).ok; }

function exact(value: Record<string, unknown>, allowed: string[]): ValidationResult {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key)) ? valid() : invalid("Message contains an unexpected field");
}
function status(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Status must be an object");
  return all(text(value.state, 1, 50), text(value.detail, 0, 1_000), url(value.pageUrl), origin(value.origin), bool(value.hasVideo), number(value.score, -1_000_000_000, 1_000_000_000), number(value.confidence, 0, 100));
}
function historyEntry(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("History entry must be an object");
  return all(text(value.event, 1, 100), text(value.detail, 0, 2_000), oneOf(value.level, ["info", "warning", "error", "success"]), url(value.url));
}
function actionOutcome(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Action outcome must be an object");
  return all(text(value.action, 1, 50), text(value.failureKind, 1, 50), bool(value.success), number(value.durationMs, 0, 24 * 60 * 60_000), number(value.timestamp, 0, Date.now() + 60_000));
}
function healthSample(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Health sample must be an object");
  return all(number(value.startupMs, 0, 24 * 60 * 60_000), number(value.rebufferMs, 0, 24 * 60 * 60_000), nullableNumber(value.liveLagSeconds, 0, 24 * 60 * 60), number(value.timestamp, 0, Date.now() + 60_000));
}
function snapshot(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Session snapshot must be an object");
  return all(text(value.id, 1, 100), origin(value.origin), text(value.pageUrlKey, 1, 2_000), number(value.createdAt, 0, Date.now() + 60_000), number(value.expiresAt, 0, Date.now() + 31 * 24 * 60 * 60_000));
}
function preferences(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Preferences must be an object");
  return all(number(value.volume, 0, 1), bool(value.muted), number(value.playbackRate, 0.1, 16), bool(value.captionsShowing), bool(value.cssMaximized));
}
function rectangle(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Rectangle must be an object");
  return all(number(value.x, -100_000, 100_000), number(value.y, -100_000, 100_000), number(value.width, 1, 100_000), number(value.height, 1, 100_000));
}
function selectorField(value: unknown): ValidationResult { return oneOf(value, ["selectedVideoSelector", "videoContainerSelector", "fullscreenButtonSelector", "playButtonSelector", "retryButtonSelector", "liveButtonSelector", "errorSelector", "accessInterruptionSelector", "adIndicatorSelector"]); }
function origin(value: unknown): ValidationResult {
  if (value === "file://") return valid();
  if (typeof value !== "string" || value.length > 2_000) return invalid("Invalid origin");
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === value ? valid() : invalid("Invalid origin"); }
  catch { return invalid("Invalid origin"); }
}
function url(value: unknown): ValidationResult {
  if (typeof value !== "string" || value.length > 8_000) return invalid("Invalid URL");
  try { return ["http:", "https:", "file:"].includes(new URL(value).protocol) ? valid() : invalid("Unsupported URL scheme"); }
  catch { return invalid("Invalid URL"); }
}
function text(value: unknown, minimum: number, maximum: number): ValidationResult { return typeof value === "string" && value.length >= minimum && value.length <= maximum ? valid() : invalid("Invalid text field"); }
function number(value: unknown, minimum: number, maximum: number): ValidationResult { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? valid() : invalid("Invalid numeric field"); }
function tab(value: unknown): ValidationResult { return Number.isInteger(value) && (value as number) >= 0 ? valid() : invalid("Invalid tab identifier"); }
function optionalTab(value: unknown): ValidationResult { return value === undefined ? valid() : tab(value); }
function bool(value: unknown): ValidationResult { return typeof value === "boolean" ? valid() : invalid("Invalid boolean field"); }
function optionalBoolean(value: unknown): ValidationResult { return value === undefined ? valid() : bool(value); }
function optionalNumber(value: unknown, minimum: number, maximum: number): ValidationResult { return value === undefined ? valid() : number(value, minimum, maximum); }
function nullableNumber(value: unknown, minimum: number, maximum: number): ValidationResult { return value === null ? valid() : number(value, minimum, maximum); }
function record(value: unknown): ValidationResult { return isRecord(value) ? valid() : invalid("Expected an object"); }
function oneOf(value: unknown, values: readonly unknown[]): ValidationResult { return values.includes(value) ? valid() : invalid("Invalid enum value"); }
function optional(value: unknown, validator: (item: unknown) => ValidationResult): ValidationResult { return value === undefined ? valid() : validator(value); }
function all(...results: ValidationResult[]): ValidationResult { return results.find((result) => !result.ok) ?? valid(); }
function valid(): ValidationResult { return { ok: true }; }
function invalid(error: string): ValidationResult { return { ok: false, error }; }
function hasUnsafeKey(value: unknown, depth: number): boolean {
  if (depth > 12 || !value || typeof value !== "object") return depth > 12;
  if (Array.isArray(value)) return value.length > 2_000 || value.some((item) => hasUnsafeKey(item, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 500 || entries.some(([key, item]) => ["__proto__", "prototype", "constructor"].includes(key) || hasUnsafeKey(item, depth + 1));
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
