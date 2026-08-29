import type { RuntimeMessage } from "./types";

export interface SenderIdentity {
  extensionPage: boolean;
  contentScript: boolean;
  senderUrl: string | null;
  tabId: number | null;
}
export interface AuthorizationResult { ok: boolean; error?: string }

const contentTypes = new Set<RuntimeMessage["type"]>([
  "GET_CONTEXT", "REPORT_STATUS", "LOG_HISTORY", "REQUEST_AUTO_REFRESH", "RECORD_AUTO_REFRESH", "CANCEL_AUTO_REFRESH",
  "PLAYBACK_SUCCESS", "RECORD_ACTION_OUTCOME", "RECORD_HEALTH_SAMPLE", "SAVE_SESSION_SNAPSHOT", "CLEAR_SESSION_SNAPSHOT",
  "CLAIM_AUTO_MAXIMIZE", "SAVE_PLAYER_PREFERENCES", "REQUEST_PARENT_MAXIMIZE", "REQUEST_IFRAME_RECOVERY", "REQUEST_VISUAL_SAMPLE"
]);
const extensionPageTypes = new Set<RuntimeMessage["type"]>([
  "GET_POPUP_STATE", "GET_HISTORY", "GET_SITE_MODEL", "GET_PROFILES", "SAVE_PROFILE", "DELETE_PROFILE", "CLEAR_HISTORY",
  "CLEAR_DATA", "GET_PRIVACY_STATE", "ACKNOWLEDGE_VISUAL_PRIVACY", "ACKNOWLEDGE_DISCLAIMER", "UPDATE_GLOBAL_SETTINGS",
  "SET_SITE_ENABLED", "SET_SITE_OVERRIDES", "SAVE_SITE_SELECTOR", "RECORD_USER_FEEDBACK", "MANUAL_REFRESH", "MANUAL_MAXIMIZE",
  "VALIDATE_SITE_SELECTOR",
  "MANUAL_PICTURE_IN_PICTURE", "MANUAL_JUMP_TO_LIVE", "PIN_PRIMARY_VIDEO", "START_SELECTOR_PICKER", "CANCEL_SELECTOR_PICKER",
  "SNOOZE_TAB", "SET_EVENT_MODE", "RESET_TAB_ATTEMPTS", "EXTEND_COUNTDOWN", "CANCEL_TAB_COUNTDOWN", "LOG_HISTORY"
]);

export function authorizeRuntimeMessage(message: RuntimeMessage, sender: SenderIdentity): AuthorizationResult {
  if (sender.extensionPage && extensionPageTypes.has(message.type)) return { ok: true };
  if (!sender.contentScript || !contentTypes.has(message.type)) return { ok: false, error: "Message is not authorized from this extension context" };
  const senderOrigin = originOf(sender.senderUrl);
  if (!senderOrigin) return { ok: false, error: "Content-script sender has no supported origin" };
  const claimedOrigin = claimedMessageOrigin(message);
  if (claimedOrigin && claimedOrigin !== senderOrigin) return { ok: false, error: "Message origin does not match its sender" };
  const claimedUrl = claimedMessageUrl(message);
  if (claimedUrl && originOf(claimedUrl) !== senderOrigin) return { ok: false, error: "Message URL does not match its sender" };
  return { ok: true };
}

function claimedMessageOrigin(message: RuntimeMessage): string | null {
  if ("origin" in message && typeof message.origin === "string") return message.origin;
  if (message.type === "REPORT_STATUS") return message.status.origin;
  if (message.type === "SAVE_SESSION_SNAPSHOT") return message.snapshot.origin;
  return null;
}
function claimedMessageUrl(message: RuntimeMessage): string | null {
  if ("pageUrl" in message && typeof message.pageUrl === "string") return message.pageUrl;
  if (message.type === "REPORT_STATUS") return message.status.pageUrl;
  if (message.type === "LOG_HISTORY") return message.entry.url;
  return null;
}
function originOf(value: string | null): string | null {
  if (!value) return null;
  try { const parsed = new URL(value); return parsed.protocol === "file:" ? "file://" : ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null; }
  catch { return null; }
}
