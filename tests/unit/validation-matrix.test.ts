import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import { effectiveSettings } from "../../src/shared/settings";
import { validateRuntimeMessage } from "../../src/shared/validation";
import type { FrameStatus, RuntimeMessage, SiteProfile } from "../../src/shared/types";

const now = Date.now();
const origin = "https://example.com";
const pageUrl = `${origin}/live`;
const diagnosis = { kind: "NONE" as const, alternatives: [], confidence: 0, severity: "none" as const, detail: "healthy", evidence: [], recoverySafe: false, requiresUser: false, observedAt: now };
const compatibility = { htmlVideo: true, crossFrame: false, frameCallbacks: true, playbackQuality: true, liveEdge: true, pictureInPicture: true, fullscreen: true, wakeLock: true, protocolBridge: false, visualWatchdog: false, playerType: "HTML5" as const, level: "FULL" as const, limitations: [] };
const status: Omit<FrameStatus, "updatedAt"> = {
  state: "HEALTHY", detail: "healthy", pageUrl, origin, hasVideo: true, score: 100, confidence: 0, evidence: [], selectedVideoLabel: "video",
  diagnosis, streamKind: "CONFIRMED_LIVE", liveIntent: "FOLLOWING_LIVE", liveEdgeLagSeconds: 1, bufferAheadSeconds: 5,
  recoveryCycleId: null, circuitState: "CLOSED", compatibility, recoveryAction: null, nextActionAt: null, online: true, frameToken: "frame"
};
const profile: SiteProfile = { schemaVersion: 1, id: "profile", name: "Profile", version: 1, originPatterns: [`${origin}/*`], urlPatterns: [], declaredPlayerType: "AUTO", selectors: {}, recoveryStrategy: ["WAIT"], backupUrls: [], notes: "", createdAt: now, updatedAt: now };
const effective = effectiveSettings({ ...structuredClone(DEFAULT_SETTINGS), perSite: { [origin]: { enabled: true } } }, origin);

const validMessages: RuntimeMessage[] = [
  { type: "GET_CONTEXT", origin, pageUrl }, { type: "GET_POPUP_STATE", tabId: 1, origin }, { type: "GET_HISTORY", tabId: 1, limit: 20 },
  { type: "GET_SITE_MODEL", origin }, { type: "GET_PROFILES" }, { type: "SAVE_PROFILE", profile }, { type: "DELETE_PROFILE", profileId: "profile" },
  { type: "CLEAR_HISTORY", tabId: 1 }, { type: "CLEAR_DATA", target: "models" }, { type: "GET_PRIVACY_STATE" }, { type: "ACKNOWLEDGE_VISUAL_PRIVACY" },
  { type: "ACKNOWLEDGE_DISCLAIMER" }, { type: "UPDATE_GLOBAL_SETTINGS", patch: { enabled: false } },
  { type: "SET_SITE_ENABLED", origin, enabled: true, tabId: 1 }, { type: "SET_SITE_OVERRIDES", origin, overrides: { autoRefresh: false }, replace: false },
  { type: "SAVE_SITE_SELECTOR", origin, field: "retryButtonSelector", selector: ".retry", tabId: 1 }, { type: "REPORT_STATUS", status },
  { type: "VALIDATE_SITE_SELECTOR", origin, field: "retryButtonSelector", selector: ".retry" },
  { type: "LOG_HISTORY", entry: { event: "test", detail: "detail", level: "info", url: pageUrl } },
  { type: "REQUEST_AUTO_REFRESH", origin, pageUrl, reason: "failure", confidence: 90 }, { type: "RECORD_AUTO_REFRESH", origin, pageUrl },
  { type: "CANCEL_AUTO_REFRESH" }, { type: "PLAYBACK_SUCCESS", pageUrl },
  { type: "RECORD_ACTION_OUTCOME", origin, outcome: { action: "PLAY", failureKind: "DECODE_FREEZE", success: true, durationMs: 100, timestamp: now } },
  { type: "RECORD_HEALTH_SAMPLE", origin, sample: { startupMs: 100, rebufferMs: 0, liveLagSeconds: 1, timestamp: now } },
  { type: "RECORD_USER_FEEDBACK", origin, correct: true, failureKind: "DECODE_FREEZE" },
  { type: "SAVE_SESSION_SNAPSHOT", snapshot: { id: "snapshot", origin, pageUrlKey: pageUrl, playerLabel: "video", streamKind: "VOD", wasPlaying: true, mediaPosition: 1, volume: 1, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false, scrollX: 0, scrollY: 0, createdAt: now, expiresAt: now + 60_000, recoveryCycleId: "cycle" } },
  { type: "CLEAR_SESSION_SNAPSHOT", origin }, { type: "CLAIM_AUTO_MAXIMIZE", pageUrl },
  { type: "SAVE_PLAYER_PREFERENCES", origin, preferences: { volume: 1, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false } },
  { type: "REQUEST_PARENT_MAXIMIZE" }, { type: "REQUEST_IFRAME_RECOVERY", frameToken: "frame" },
  { type: "MANUAL_REFRESH", tabId: 1, origin }, { type: "MANUAL_MAXIMIZE", tabId: 1 }, { type: "MANUAL_PICTURE_IN_PICTURE", tabId: 1 },
  { type: "MANUAL_JUMP_TO_LIVE", tabId: 1 }, { type: "PIN_PRIMARY_VIDEO", tabId: 1 },
  { type: "START_SELECTOR_PICKER", origin, field: "errorSelector" }, { type: "CANCEL_SELECTOR_PICKER" },
  { type: "SNOOZE_TAB", tabId: 1, until: null }, { type: "SET_EVENT_MODE", tabId: 1, until: now + 60_000 },
  { type: "RESET_TAB_ATTEMPTS", tabId: 1 }, { type: "REQUEST_VISUAL_SAMPLE", rect: { x: 0, y: 0, width: 100, height: 100 } },
  { type: "EXTEND_COUNTDOWN", tabId: 1, seconds: 30 }, { type: "CANCEL_TAB_COUNTDOWN", tabId: 1 },
  { type: "SHUTDOWN_MONITOR" }, { type: "SETTINGS_CHANGED", settings: effective }, { type: "START_COUNTDOWN", seconds: 5, reason: "failure" },
  { type: "EXTEND_COUNTDOWN_IN_PAGE", seconds: 10 }, { type: "STOP_COUNTDOWN", reason: "healthy" }, { type: "SHOW_LOOP_WARNING", detail: "limit" },
  { type: "RETRY_MONITORING" }, { type: "SNOOZE_UNTIL", until: -1 }, { type: "EVENT_MODE_UNTIL", until: null },
  { type: "MAXIMIZE_NOW", manual: true }, { type: "PICTURE_IN_PICTURE_NOW" }, { type: "JUMP_TO_LIVE_NOW" },
  { type: "MAXIMIZE_IFRAME", manual: false }, { type: "RECOVER_IFRAME", frameToken: "frame" },
  { type: "BEGIN_ELEMENT_PICKER", field: "selectedVideoSelector" }, { type: "VALIDATE_SELECTOR", field: "errorSelector", selector: ".error" },
  { type: "STOP_ELEMENT_PICKER" }
];

for (const message of validMessages) test(`runtime schema accepts ${message.type}`, () => {
  assert.deepEqual(validateRuntimeMessage(message), { ok: true });
});

const invalidMessages: Array<[string, unknown]> = [
  ["null", null], ["array", []], ["missing type", {}], ["unknown type", { type: "EXEC" }],
  ["extra field", { type: "GET_PROFILES", unexpected: true }], ["negative tab", { type: "MANUAL_MAXIMIZE", tabId: -1 }],
  ["fractional tab", { type: "MANUAL_MAXIMIZE", tabId: 1.5 }], ["bad origin", { type: "GET_SITE_MODEL", origin: "javascript:alert(1)" }],
  ["origin path", { type: "GET_SITE_MODEL", origin: "https://example.com/path" }], ["bad URL", { type: "PLAYBACK_SUCCESS", pageUrl: "data:text/plain,test" }],
  ["oversized reason", { type: "START_COUNTDOWN", seconds: 5, reason: "x".repeat(501) }],
  ["oversized message", { type: "UPDATE_GLOBAL_SETTINGS", patch: { value: "x".repeat(130_000) } }],
  ["invalid confidence", { type: "REQUEST_AUTO_REFRESH", origin, pageUrl, reason: "bad", confidence: 101 }],
  ["invalid rectangle", { type: "REQUEST_VISUAL_SAMPLE", rect: { x: 0, y: 0, width: 0, height: 1 } }],
  ["unknown clear target", { type: "CLEAR_DATA", target: "cookies" }], ["invalid selector field", { type: "BEGIN_ELEMENT_PICKER", field: "password" }]
];
for (const [name, message] of invalidMessages) test(`runtime schema rejects ${name}`, () => assert.equal(validateRuntimeMessage(message).ok, false));
