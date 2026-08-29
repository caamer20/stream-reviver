import type { RuntimeMessage } from "./types";

const messageTypes = new Set<RuntimeMessage["type"]>([
  "GET_CONTEXT", "GET_POPUP_STATE", "GET_HISTORY", "GET_SITE_MODEL", "GET_PROFILES", "SAVE_PROFILE", "DELETE_PROFILE",
  "CLEAR_HISTORY", "ACKNOWLEDGE_DISCLAIMER", "UPDATE_GLOBAL_SETTINGS", "SET_SITE_ENABLED", "SET_SITE_OVERRIDES",
  "SAVE_SITE_SELECTOR", "REPORT_STATUS", "LOG_HISTORY", "REQUEST_AUTO_REFRESH", "RECORD_AUTO_REFRESH", "CANCEL_AUTO_REFRESH",
  "PLAYBACK_SUCCESS", "RECORD_ACTION_OUTCOME", "RECORD_HEALTH_SAMPLE", "RECORD_USER_FEEDBACK", "SAVE_SESSION_SNAPSHOT", "CLEAR_SESSION_SNAPSHOT",
  "CLAIM_AUTO_MAXIMIZE", "SAVE_PLAYER_PREFERENCES", "REQUEST_PARENT_MAXIMIZE", "REQUEST_IFRAME_RECOVERY", "MANUAL_REFRESH",
  "MANUAL_MAXIMIZE", "MANUAL_PICTURE_IN_PICTURE", "MANUAL_JUMP_TO_LIVE", "PIN_PRIMARY_VIDEO", "START_SELECTOR_PICKER",
  "CANCEL_SELECTOR_PICKER", "SNOOZE_TAB", "SET_EVENT_MODE", "RESET_TAB_ATTEMPTS", "REQUEST_VISUAL_SAMPLE", "EXTEND_COUNTDOWN",
  "CANCEL_TAB_COUNTDOWN", "SETTINGS_CHANGED", "START_COUNTDOWN", "EXTEND_COUNTDOWN_IN_PAGE", "STOP_COUNTDOWN",
  "SHOW_LOOP_WARNING", "RETRY_MONITORING", "SNOOZE_UNTIL", "EVENT_MODE_UNTIL", "MAXIMIZE_NOW", "PICTURE_IN_PICTURE_NOW",
  "JUMP_TO_LIVE_NOW", "MAXIMIZE_IFRAME", "RECOVER_IFRAME", "BEGIN_ELEMENT_PICKER", "STOP_ELEMENT_PICKER"
]);

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!isRecord(value) || typeof value.type !== "string" || !messageTypes.has(value.type as RuntimeMessage["type"])) return false;
  if (hasUnsafeKey(value, 0)) return false;
  try { return JSON.stringify(value).length <= 128_000; } catch { return false; }
}

function hasUnsafeKey(value: unknown, depth: number): boolean {
  if (depth > 12 || !value || typeof value !== "object") return depth > 12;
  if (Array.isArray(value)) return value.length > 2_000 || value.some((item) => hasUnsafeKey(item, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 500 || entries.some(([key, item]) => ["__proto__", "prototype", "constructor"].includes(key) || hasUnsafeKey(item, depth + 1));
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
