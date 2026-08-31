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
  , pageVisible: true, navigationId: "navigation", candidateId: "candidate", candidateEpoch: 1
};
const profile: SiteProfile = { schemaVersion: 1, id: "profile", name: "Profile", version: 1, originPatterns: [`${origin}/*`], urlPatterns: [], declaredPlayerType: "AUTO", selectors: {}, recoveryStrategy: ["WAIT"], backupUrls: [], notes: "", createdAt: now, updatedAt: now };
const effective = effectiveSettings({ ...structuredClone(DEFAULT_SETTINGS), perSite: { [origin]: { enabled: true } } }, origin);

const validMessages: RuntimeMessage[] = [
  { type: "GET_CONTEXT", origin, pageUrl, navigationId: "navigation" }, { type: "GET_POPUP_STATE", tabId: 1, origin },
  { type: "GET_DASHBOARD_STATE" }, { type: "FOCUS_DASHBOARD_TAB", tabId: 1 }, { type: "GET_HISTORY", tabId: 1, limit: 20 },
  { type: "GET_SITE_MODEL", origin }, { type: "GET_PROFILES" }, { type: "SAVE_PROFILE", profile }, { type: "DELETE_PROFILE", profileId: "profile" },
  { type: "CLEAR_HISTORY", tabId: 1 }, { type: "CLEAR_DATA", target: "models" }, { type: "GET_PRIVACY_STATE" }, { type: "ACKNOWLEDGE_VISUAL_PRIVACY" },
  { type: "ACKNOWLEDGE_DISCLAIMER" }, { type: "UPDATE_GLOBAL_SETTINGS", patch: { enabled: false } },
  { type: "SET_SITE_ENABLED", origin, enabled: true, tabId: 1 }, { type: "SET_SITE_OVERRIDES", origin, overrides: { autoRefresh: false }, replace: false },
  { type: "SAVE_SITE_SELECTOR", origin, field: "retryButtonSelector", selector: ".retry", tabId: 1 }, { type: "REPORT_STATUS", status },
  { type: "VALIDATE_SITE_SELECTOR", origin, field: "retryButtonSelector", selector: ".retry" },
  { type: "LOG_HISTORY", entry: { event: "test", detail: "detail", level: "info", url: pageUrl, metadata: {
    action: "PLAY", actionId: "action", recoveryCycleId: "cycle", failureKind: "DECODE_FREEZE", diagnosis,
    confidence: 90, evidence: [{ signal: "decode-freeze", detail: "Playback stopped", weight: 70 }], risk: 1, score: 10,
    state: "RECOVERING", recoveryAction: "PLAY", streamKind: "CONFIRMED_LIVE", liveIntent: "FOLLOWING_LIVE",
    liveEdgeLagSeconds: 1, bufferAheadSeconds: 5, circuitState: "VERIFYING", compatibility
  } } },
  { type: "REQUEST_AUTO_REFRESH", origin, pageUrl, reason: "failure", confidence: 90 }, { type: "RECORD_AUTO_REFRESH", origin, pageUrl },
  { type: "AUTHORIZE_RECOVERY_ACTION", origin, pageUrl, recoveryCycleId: "cycle", action: "PLAY", reason: "failure", confidence: 90 },
  { type: "COMMIT_RECOVERY_ACTION", pageUrl, recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce" },
  { type: "COMPLETE_RECOVERY_ACTION", origin, pageUrl, recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce", success: true, durationMs: 100, failureKind: "DECODE_FREEZE" },
  { type: "EXTEND_AUTO_REFRESH", recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce", seconds: 30 },
  { type: "CANCEL_AUTO_REFRESH" }, { type: "PLAYBACK_SUCCESS", pageUrl },
  { type: "RECORD_ACTION_OUTCOME", origin, outcome: { action: "PLAY", failureKind: "DECODE_FREEZE", success: true, durationMs: 100, timestamp: now } },
  { type: "RECORD_HEALTH_SAMPLE", origin, sample: { startupMs: 100, rebufferMs: 0, liveLagSeconds: 1, timestamp: now } },
  { type: "RECORD_USER_FEEDBACK", origin, correct: true, failureKind: "DECODE_FREEZE" },
  { type: "SAVE_SESSION_SNAPSHOT", snapshot: { id: "snapshot", origin, pageUrlKey: pageUrl, playerLabel: "video", streamKind: "VOD", wasPlaying: true, mediaPosition: 1, volume: 1, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false, scrollX: 0, scrollY: 0, createdAt: now, expiresAt: now + 60_000, recoveryCycleId: "cycle", navigationId: "navigation" } },
  { type: "RESTORE_SESSION_SNAPSHOT", snapshot: { id: "snapshot", origin, pageUrlKey: pageUrl, playerLabel: "video", streamKind: "VOD", wasPlaying: true, mediaPosition: 1, volume: 1, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false, scrollX: 0, scrollY: 0, createdAt: now, expiresAt: now + 60_000, recoveryCycleId: "cycle", navigationId: "navigation" } },
  { type: "CLEAR_SESSION_SNAPSHOT", origin }, { type: "CLAIM_AUTO_MAXIMIZE", pageUrl, recoveryCycleId: "cycle" },
  { type: "SAVE_PLAYER_PREFERENCES", origin, preferences: { volume: 1, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false } },
  { type: "REQUEST_PARENT_MAXIMIZE" }, { type: "REQUEST_IFRAME_RECOVERY", frameToken: "frame" },
  { type: "MANUAL_REFRESH", tabId: 1, origin }, { type: "MANUAL_MAXIMIZE", tabId: 1 }, { type: "MANUAL_PICTURE_IN_PICTURE", tabId: 1 },
  { type: "MANUAL_JUMP_TO_LIVE", tabId: 1 }, { type: "PIN_PRIMARY_VIDEO", tabId: 1 },
  { type: "START_SELECTOR_PICKER", origin, field: "errorSelector" }, { type: "CANCEL_SELECTOR_PICKER" },
  { type: "SNOOZE_TAB", tabId: 1, until: null }, { type: "SET_EVENT_MODE", tabId: 1, until: now + 60_000 },
  { type: "RESET_TAB_ATTEMPTS", tabId: 1 }, { type: "REQUEST_VISUAL_SAMPLE", origin, pageUrl, navigationId: "navigation", candidateId: "candidate", candidateEpoch: 1, rect: { x: 0, y: 0, width: 100, height: 100 }, viewport: { width: 1280, height: 720 } },
  { type: "EXTEND_COUNTDOWN", tabId: 1, seconds: 30 }, { type: "CANCEL_TAB_COUNTDOWN", tabId: 1 },
  { type: "SHUTDOWN_MONITOR" }, { type: "RESET_RUNTIME_STATE" }, { type: "SETTINGS_CHANGED", settings: effective }, { type: "START_COUNTDOWN", reason: "failure", deadline: now + 5_000, recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce" },
  { type: "EXTEND_COUNTDOWN_IN_PAGE", deadline: now + 10_000, recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce" },
  { type: "STOP_COUNTDOWN", recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce", reason: "healthy" },
  { type: "SHOW_LOOP_WARNING", detail: "limit" },
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
  ["oversized reason", { type: "START_COUNTDOWN", reason: "x".repeat(501) }],
  ["oversized message", { type: "UPDATE_GLOBAL_SETTINGS", patch: { value: "x".repeat(130_000) } }],
  ["invalid confidence", { type: "REQUEST_AUTO_REFRESH", origin, pageUrl, reason: "bad", confidence: 101 }],
  ["invalid rectangle", { type: "REQUEST_VISUAL_SAMPLE", origin, pageUrl, navigationId: "navigation", candidateId: "candidate", candidateEpoch: 1, rect: { x: 0, y: 0, width: 0, height: 1 }, viewport: { width: 1280, height: 720 } }],
  ["claim auto-maximize without a recovery cycle", { type: "CLAIM_AUTO_MAXIMIZE", pageUrl }],
  ["claim auto-maximize with an empty recovery cycle", { type: "CLAIM_AUTO_MAXIMIZE", pageUrl, recoveryCycleId: "" }],
  ["unknown clear target", { type: "CLEAR_DATA", target: "cookies" }], ["invalid selector field", { type: "BEGIN_ELEMENT_PICKER", field: "password" }]
];
for (const [name, message] of invalidMessages) test(`runtime schema rejects ${name}`, () => assert.equal(validateRuntimeMessage(message).ok, false));

function changed<T>(input: T, mutate: (value: any) => void): unknown {
  const output = structuredClone(input);
  mutate(output);
  return output;
}

const strictNestedMessages: Array<[string, unknown]> = [
  ["an unexpected global setting", { type: "UPDATE_GLOBAL_SETTINGS", patch: { enabled: true, typoSetting: false } }],
  ["a non-boolean global setting", { type: "UPDATE_GLOBAL_SETTINGS", patch: { autoRefresh: "yes" } }],
  ["a global number below its boundary", { type: "UPDATE_GLOBAL_SETTINGS", patch: { checkIntervalSeconds: 0.999 } }],
  ["a non-finite global number", { type: "UPDATE_GLOBAL_SETTINGS", patch: { stallTimeoutSeconds: Number.POSITIVE_INFINITY } }],
  ["an invalid recovery action", { type: "UPDATE_GLOBAL_SETTINGS", patch: { recoveryStrategy: ["RUN_SCRIPT"] } }],
  ["an oversized recovery strategy", { type: "UPDATE_GLOBAL_SETTINGS", patch: { recoveryStrategy: Array.from({ length: 11 }, () => "WAIT") } }],
  ["an invalid recovery backoff", { type: "UPDATE_GLOBAL_SETTINGS", patch: { recoveryBackoffSeconds: [Number.NaN] } }],
  ["an unexpected site override", { type: "SET_SITE_OVERRIDES", origin, overrides: { mysterySelector: "video" } }],
  ["an oversized site selector", { type: "SET_SITE_OVERRIDES", origin, overrides: { selectedVideoSelector: "x".repeat(501) } }],
  ["an unsafe backup URL", { type: "SET_SITE_OVERRIDES", origin, overrides: { backupUrls: ["javascript:alert(1)"] } }],
  ["too many URL patterns", { type: "SET_SITE_OVERRIDES", origin, overrides: { includeUrlPatterns: Array.from({ length: 51 }, (_, index) => `https://example.com/${index}`) } }],
  ["an unexpected profile field", changed({ type: "SAVE_PROFILE", profile }, (message) => { message.profile.executable = "alert(1)"; })],
  ["an unexpected profile selector", changed({ type: "SAVE_PROFILE", profile }, (message) => { message.profile.selectors.password = "#password"; })],
  ["an invalid profile player enum", changed({ type: "SAVE_PROFILE", profile }, (message) => { message.profile.declaredPlayerType = "PLUGIN"; })],
  ["too many profile patterns", changed({ type: "SAVE_PROFILE", profile }, (message) => { message.profile.originPatterns = Array.from({ length: 21 }, () => "https://example.com/*"); })],
  ["non-finite profile metadata", changed({ type: "SAVE_PROFILE", profile }, (message) => { message.profile.version = Number.NaN; })],
  ["an unexpected status field", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.secret = true; })],
  ["an invalid monitor state", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.state = "PLAYING"; })],
  ["non-finite status telemetry", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.score = Number.POSITIVE_INFINITY; })],
  ["an unexpected evidence field", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.evidence = [{ signal: "stall", detail: "stalled", weight: 50, payload: true }]; })],
  ["too many evidence entries", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.evidence = Array.from({ length: 21 }, () => ({ signal: "stall", detail: "stalled", weight: 50 })); })],
  ["an invalid evidence weight", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.evidence = [{ signal: "stall", detail: "stalled", weight: Number.NaN }]; })],
  ["an unexpected diagnosis field", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.diagnosis.rawPageData = {}; })],
  ["an invalid diagnosis alternative", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.diagnosis.alternatives = ["MAYBE_DOWN"]; })],
  ["an invalid diagnosis severity", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.diagnosis.severity = "fatal"; })],
  ["an unexpected compatibility field", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.compatibility.pluginData = true; })],
  ["an invalid compatibility level", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.compatibility.level = "COMPLETE"; })],
  ["oversized compatibility limitations", changed({ type: "REPORT_STATUS", status }, (message) => { message.status.compatibility.limitations = Array.from({ length: 21 }, () => "limited"); })],
  ["an unexpected history entry field", { type: "LOG_HISTORY", entry: { event: "test", detail: "detail", level: "info", url: pageUrl, hidden: true } }],
  ["an unknown history metadata key", { type: "LOG_HISTORY", entry: { event: "test", detail: "detail", level: "info", url: pageUrl, metadata: { rawSelector: "#private" } } }],
  ["malformed history diagnosis metadata", { type: "LOG_HISTORY", entry: { event: "test", detail: "detail", level: "info", url: pageUrl, metadata: { diagnosis: { ...diagnosis, confidence: Number.NaN } } } }],
  ["an unexpected action outcome field", { type: "RECORD_ACTION_OUTCOME", origin, outcome: { action: "PLAY", failureKind: "DECODE_FREEZE", success: true, durationMs: 100, timestamp: now, raw: true } }],
  ["an invalid action outcome enum", { type: "RECORD_ACTION_OUTCOME", origin, outcome: { action: "EXECUTE", failureKind: "DECODE_FREEZE", success: true, durationMs: 100, timestamp: now } }],
  ["an unexpected health sample field", { type: "RECORD_HEALTH_SAMPLE", origin, sample: { startupMs: 100, rebufferMs: 0, liveLagSeconds: 1, timestamp: now, path: "/private" } }],
  ["non-finite health telemetry", { type: "RECORD_HEALTH_SAMPLE", origin, sample: { startupMs: 100, rebufferMs: Number.POSITIVE_INFINITY, liveLagSeconds: 1, timestamp: now } }],
  ["an unexpected preference field", { type: "SAVE_PLAYER_PREFERENCES", origin, preferences: { volume: 1, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false, sourceUrl: pageUrl } }],
  ["non-finite player preferences", { type: "SAVE_PLAYER_PREFERENCES", origin, preferences: { volume: Number.NaN, muted: false, playbackRate: 1, captionsShowing: false, cssMaximized: false } }],
  ["an unexpected snapshot field", changed(validMessages.find((message) => message.type === "SAVE_SESSION_SNAPSHOT")!, (message) => { message.snapshot.cookies = []; })],
  ["an invalid snapshot stream enum", changed(validMessages.find((message) => message.type === "SAVE_SESSION_SNAPSHOT")!, (message) => { message.snapshot.streamKind = "LIVEISH"; })],
  ["non-finite snapshot position", changed(validMessages.find((message) => message.type === "SAVE_SESSION_SNAPSHOT")!, (message) => { message.snapshot.mediaPosition = Number.POSITIVE_INFINITY; })],
  ["a snapshot expiring before creation", changed(validMessages.find((message) => message.type === "SAVE_SESSION_SNAPSHOT")!, (message) => { message.snapshot.expiresAt = message.snapshot.createdAt - 1; })],
  ["an incomplete effective settings object", changed({ type: "SETTINGS_CHANGED", settings: effective }, (message) => { delete message.settings.autoRecover; })],
  ["an unexpected effective setting", changed({ type: "SETTINGS_CHANGED", settings: effective }, (message) => { message.settings.perSite = {}; })],
  ["an invalid effective player enum", changed({ type: "SETTINGS_CHANGED", settings: effective }, (message) => { message.settings.declaredPlayerType = "FLASH"; })],
  ["an unexpected visual viewport field", changed(validMessages.find((message) => message.type === "REQUEST_VISUAL_SAMPLE")!, (message) => { message.viewport.scale = 2; })],
  ["a non-finite visual coordinate", changed(validMessages.find((message) => message.type === "REQUEST_VISUAL_SAMPLE")!, (message) => { message.rect.x = Number.NaN; })],
  ["an invalid visual candidate epoch", changed(validMessages.find((message) => message.type === "REQUEST_VISUAL_SAMPLE")!, (message) => { message.candidateEpoch = 1.5; })],
  ["a nested prototype key", JSON.parse(`{"type":"UPDATE_GLOBAL_SETTINGS","patch":{"__proto__":{"polluted":true}}}`)],
  ["a nested constructor key", JSON.parse(`{"type":"LOG_HISTORY","entry":{"event":"test","detail":"detail","level":"info","url":"${pageUrl}","metadata":{"constructor":{"polluted":true}}}}`)],
  ["a custom object prototype", { type: "UPDATE_GLOBAL_SETTINGS", patch: Object.assign(Object.create({ polluted: true }), { enabled: true }) }]
];

for (const [name, message] of strictNestedMessages) test(`runtime schema rejects ${name}`, () => {
  assert.equal(validateRuntimeMessage(message).ok, false);
});

test("runtime schema accepts exact boundary values", () => {
  const actions = ["WAIT", "USER_PROMPT", "REDISCOVER", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"];
  const boundaries = [
    { type: "UPDATE_GLOBAL_SETTINGS", patch: { checkIntervalSeconds: 1, historyLimit: 1_000, recoveryStrategy: actions, recoveryBackoffSeconds: Array(10).fill(3_600) } },
    { type: "SET_SITE_OVERRIDES", origin, overrides: {
      selectedVideoSelector: "x".repeat(500), includeUrlPatterns: Array.from({ length: 50 }, (_, index) => `${origin}/${index}*`),
      backupUrls: Array.from({ length: 10 }, (_, index) => `${origin}/backup/${index}`)
    } },
    { type: "SAVE_PLAYER_PREFERENCES", origin, preferences: { volume: 0, muted: true, playbackRate: 16, captionsShowing: true, cssMaximized: true, followingLive: true, pictureInPicture: false } },
    changed({ type: "REPORT_STATUS", status }, (message) => {
      message.status.evidence = Array.from({ length: 20 }, () => ({ signal: "x".repeat(100), detail: "x".repeat(1_000), weight: 100 }));
      message.status.score = Number.MAX_SAFE_INTEGER;
    })
  ];
  for (const message of boundaries) assert.deepEqual(validateRuntimeMessage(message), { ok: true });
});
