import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure } from "../src/shared/diagnosis";
import { ObservationWindow, type PlayerObservation } from "../src/shared/observations";
import { planRecovery } from "../src/shared/policy";
import { normalizeProfile, profileToSiteOverrides } from "../src/shared/profiles";
import { addActionOutcome, addHealthSample, addSession, addUserFeedback, emptySiteModel } from "../src/shared/outcomes";
import { effectiveSettings, normalizeSettings } from "../src/shared/settings";
import { isRuntimeMessage } from "../src/shared/validation";

const base: PlayerObservation = {
  timestamp: 1_000, currentTime: 10, duration: Infinity, paused: false, ended: false, readyState: 4, networkState: 2,
  timeAdvanced: true, framesAdvanced: true, presentedFrames: 100, droppedFrameRatio: 0, bufferAheadSeconds: 8,
  liveEdge: 11, liveEdgeLagSeconds: 1, waitingEvents: 0, explicitError: "", online: true, hidden: false,
  userPaused: false, recentBackwardSeek: false, accessInterruption: "", adTransition: false, lifecycleGapMs: 1_000, protocol: null
};
const settings = effectiveSettings(normalizeSettings({ perSite: { "https://example.com": { enabled: true, retryButtonSelector: ".retry", backupUrls: ["https://backup.example/live"] } } }), "https://example.com");

function trends(samples: PlayerObservation[]) {
  const window = new ObservationWindow(); let value = window.trends();
  for (const sample of samples) value = window.push(sample);
  return value;
}

test("moving seekable edge identifies live playback", () => {
  const value = trends([base, { ...base, timestamp: 2_000, currentTime: 11, liveEdge: 12 }, { ...base, timestamp: 3_000, currentTime: 12, liveEdge: 14 }]);
  assert.equal(value.streamKind, "CONFIRMED_LIVE");
});

test("finite stable media identifies VOD", () => {
  const value = trends([{ ...base, duration: 120, liveEdge: 120 }, { ...base, timestamp: 2_000, duration: 120, liveEdge: 120 }]);
  assert.equal(value.streamKind, "VOD");
});

test("access interruption always suppresses recovery", () => {
  const sample = { ...base, accessInterruption: "Login required" };
  const result = diagnoseFailure(sample, trends([sample]), settings);
  assert.equal(result.kind, "ACCESS_INTERRUPTION"); assert.equal(result.recoverySafe, false); assert.equal(result.requiresUser, true);
});

test("browser resume is not mistaken for a stall", () => {
  const sample = { ...base, timeAdvanced: false, framesAdvanced: false, lifecycleGapMs: 90_000 };
  assert.equal(diagnoseFailure(sample, trends([sample]), settings).kind, "BROWSER_RESUMED");
});

test("advancing live edge with excess lag diagnoses drift", () => {
  const samples = [
    { ...base, currentTime: 1, liveEdge: 40, liveEdgeLagSeconds: 39 },
    { ...base, timestamp: 2_000, currentTime: 2, liveEdge: 42, liveEdgeLagSeconds: 40 },
    { ...base, timestamp: 3_000, currentTime: 3, liveEdge: 44, liveEdgeLagSeconds: 41 }
  ];
  assert.equal(diagnoseFailure(samples[2], trends(samples), settings).kind, "LIVE_EDGE_DRIFT");
});

test("intentional rewind suppresses live-edge recovery", () => {
  const samples = [{ ...base, currentTime: 1, liveEdge: 40, liveEdgeLagSeconds: 39 }, { ...base, timestamp: 2_000, currentTime: 2, liveEdge: 42, liveEdgeLagSeconds: 40, recentBackwardSeek: true }];
  assert.notEqual(diagnoseFailure(samples[1], trends(samples), settings).kind, "LIVE_EDGE_DRIFT");
});

test("media-time progress without frames diagnoses render freeze", () => {
  const samples = [{ ...base, framesAdvanced: false }, { ...base, timestamp: 2_000, currentTime: 11, framesAdvanced: false }];
  assert.equal(diagnoseFailure(samples[1], trends(samples), settings).kind, "RENDER_FREEZE");
});

test("empty non-growing buffer diagnoses underrun", () => {
  const samples = [{ ...base, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0 }, { ...base, timestamp: 2_000, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0 }];
  assert.equal(diagnoseFailure(samples[1], trends(samples), settings).kind, "BUFFER_UNDERRUN");
});

test("WebRTC fatal protocol errors get a typed diagnosis", () => {
  const sample = { ...base, protocol: { kind: "WEBRTC" as const, observedAt: Date.now(), fatalError: "connection failed" } };
  assert.equal(diagnoseFailure(sample, trends([sample]), settings).kind, "WEBRTC_NETWORK_FAILURE");
});

test("failure-specific policy seeks live before reloading", () => {
  const plan = planRecovery("LIVE_EDGE_DRIFT", settings);
  assert.equal(plan[0], "LIVE_EDGE"); assert.ok(plan.indexOf("PAGE_RELOAD") > plan.indexOf("LIVE_EDGE"));
});

test("access interruption has no recovery plan", () => assert.deepEqual(planRecovery("ACCESS_INTERRUPTION", settings), []));

test("backup handoff is unavailable without an explicit URL", () => {
  const noBackup = effectiveSettings(normalizeSettings({ perSite: { "https://example.com": { enabled: true } } }), "https://example.com");
  assert.equal(planRecovery("MEDIA_SOURCE_ERROR", noBackup).includes("BACKUP_HANDOFF"), false);
});

test("local action outcomes use bounded explainable learning", () => {
  let model = emptySiteModel("https://example.com");
  model = addActionOutcome(model, { action: "PLAY", failureKind: "BUFFER_UNDERRUN", success: true, durationMs: 500, timestamp: Date.now() });
  model = addUserFeedback(model, false, "BUFFER_UNDERRUN");
  assert.equal(model.actionOutcomes.PLAY?.successes, 1); assert.equal(model.falseAlarms, 1); assert.equal(model.sampleCount, 2);
});

test("profiles discard executable fields and invalid URLs", () => {
  const profile = normalizeProfile({ name: "Safe", script: "alert(1)", originPatterns: ["https://example.com/*"], selectors: { retryButtonSelector: " .retry ", evil: "*" }, backupUrls: ["javascript:alert(1)", "https://backup.example/"] });
  assert.equal((profile as any).script, undefined); assert.equal(profile.selectors.retryButtonSelector, ".retry"); assert.deepEqual(profile.backupUrls, ["https://backup.example/"]);
});

test("profiles convert to site overrides without enabling access", () => {
  const profile = normalizeProfile({ name: "Safe", selectors: { liveButtonSelector: ".live" }, declaredPlayerType: "HLS_JS", recoveryStrategy: ["LIVE_EDGE", "PAGE_RELOAD"] });
  const override = profileToSiteOverrides(profile);
  assert.equal(override.liveButtonSelector, ".live"); assert.equal((override as any).enabled, undefined);
});

test("explicit player errors outrank the paused state they commonly cause", () => {
  const sample = { ...base, paused: true, explicitError: "fatal manifest error" };
  assert.equal(diagnoseFailure(sample, trends([sample]), settings).kind, "MEDIA_SOURCE_ERROR");
});

test("health samples build local-only rolling site baselines", () => {
  let model = addSession(emptySiteModel("https://example.com"));
  model = addHealthSample(model, { startupMs: 2_000, rebufferMs: 500, liveLagSeconds: 3, timestamp: Date.now() });
  model = addSession(model);
  model = addHealthSample(model, { startupMs: 4_000, rebufferMs: 1_500, liveLagSeconds: 5, timestamp: Date.now() });
  assert.equal(model.sessionCount, 2);
  assert.equal(model.startupAverageMs, 3_000);
  assert.equal(model.rebufferAverageMs, 1_000);
  assert.equal(model.liveLagAverageSeconds, 4);
});

test("runtime message validation accepts whitelisted messages", () => {
  assert.equal(isRuntimeMessage({ type: "GET_HISTORY", limit: 10 }), true);
  assert.equal(isRuntimeMessage({ type: "EVENT_MODE_UNTIL", until: null }), true);
});

test("runtime message validation rejects unknown, oversized, and deeply nested input", () => {
  assert.equal(isRuntimeMessage({ type: "EXECUTE_SCRIPT", source: "alert(1)" }), false);
  assert.equal(isRuntimeMessage({ type: "GET_HISTORY", payload: "x".repeat(130_000) }), false);
  let nested: any = { type: "GET_HISTORY" }; let cursor = nested;
  for (let index = 0; index < 14; index += 1) { cursor.child = {}; cursor = cursor.child; }
  assert.equal(isRuntimeMessage(nested), false);
});

test("adaptive ordering requires enough local evidence", () => {
  let model = emptySiteModel("https://example.com");
  model.sessionCount = 5; model.sampleCount = 30;
  model.actionOutcomes.PLAY = { successes: 0, failures: 10, averageDurationMs: 100 };
  model.actionOutcomes.RETRY_BUTTON = { successes: 10, failures: 0, averageDurationMs: 100 };
  const plan = planRecovery("DECODE_FREEZE", settings, model);
  assert.ok(plan.indexOf("RETRY_BUTTON") < plan.indexOf("PLAY"));
});
