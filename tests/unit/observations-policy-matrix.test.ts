import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlaybackControlFailure, ObservationWindow, readBufferAhead, readLiveEdge, readSeekableStart, type PlayerObservation } from "../../src/shared/observations";
import { addActionOutcome, addSession, addUserFeedback, emptySiteModel, preferredAction } from "../../src/shared/outcomes";
import { actionRisk, planRecovery, recoveryActionDefinition, validateAutomaticRecoverySetting, validateRecoveryAction } from "../../src/shared/policy";
import { effectiveSettings, normalizeSettings } from "../../src/shared/settings";
import type { FailureKind, RecoveryAction } from "../../src/shared/types";

const base: PlayerObservation = { timestamp: 1_000, currentTime: 1, duration: Infinity, paused: false, ended: false, readyState: 4, networkState: 2, timeAdvanced: true, framesAdvanced: true, presentedFrames: 1, droppedFrameRatio: null, bufferAheadSeconds: 5, seekableStart: 0, liveEdge: 2, liveEdgeLagSeconds: 1, waitingEvents: 0, explicitError: "", online: true, hidden: false, userPaused: false, playbackIntent: "PLAYING", playbackIntentDurationMs: 1_000, playbackControlError: "", recentBackwardSeek: false, accessInterruption: "", adTransition: false, lifecycleGapMs: 100, protocol: null };

test("observation window starts empty", () => assert.equal(new ObservationWindow().trends().sampleCount, 0));
test("observation window prunes samples by age", () => { const window = new ObservationWindow(1_000, 20); window.push(base); assert.equal(window.push({ ...base, timestamp: 3_000 }).sampleCount, 1); });
test("observation window prunes samples by count", () => { const window = new ObservationWindow(100_000, 2); window.push(base); window.push({ ...base, timestamp: 2_000 }); assert.equal(window.push({ ...base, timestamp: 3_000 }).sampleCount, 2); });
test("observation window tracks frozen tails and elapsed dwell", () => { const window = new ObservationWindow(); window.push({ ...base, timeAdvanced: false, framesAdvanced: false }); const result = window.push({ ...base, timestamp: 4_000, timeAdvanced: false, framesAdvanced: false }); assert.equal(result.consecutiveFrozenSamples, 2); assert.equal(result.consecutiveFrameFrozenSamples, 2); assert.equal(result.frozenDurationMs, 3_000); assert.equal(result.frameFrozenDurationMs, 3_000); });
test("observation window tracks starved tails and elapsed dwell", () => { const window = new ObservationWindow(); window.push({ ...base, readyState: 1, bufferAheadSeconds: 0 }); const result = window.push({ ...base, timestamp: 4_000, readyState: 1, bufferAheadSeconds: 0 }); assert.equal(result.consecutiveStarvedSamples, 2); assert.equal(result.starvedDurationMs, 3_000); });
test("observation window averages dropped-frame ratios", () => { const window = new ObservationWindow(); window.push({ ...base, droppedFrameRatio: .2 }); assert.ok(Math.abs(window.push({ ...base, timestamp: 2_000, droppedFrameRatio: .4 }).averageDroppedFrameRatio! - .3) < 1e-9); });
test("observation window computes media and frame deltas", () => { const window = new ObservationWindow(); window.push(base); const result = window.push({ ...base, timestamp: 2_000, currentTime: 3, presentedFrames: 20, bufferAheadSeconds: 8 }); assert.equal(result.mediaTimeDelta, 2); assert.equal(result.presentedFrameDelta, 19); assert.equal(result.bufferDelta, 3); });
test("observation window can be cleared", () => { const window = new ObservationWindow(); window.push(base); window.clear(); assert.equal(window.latest(), null); });
test("infinite duration is confirmed live", () => { const window = new ObservationWindow(); assert.equal(window.push(base).streamKind, "CONFIRMED_LIVE"); });
test("a sustained sliding finite seekable window is DVR live", () => { const window = new ObservationWindow(); window.push({ ...base, duration: 100, seekableStart: 10, liveEdge: 90 }); window.push({ ...base, timestamp: 6_000, duration: 100, seekableStart: 12, liveEdge: 95 }); window.push({ ...base, timestamp: 11_000, duration: 100, seekableStart: 14, liveEdge: 100 }); assert.equal(window.push({ ...base, timestamp: 16_000, duration: 100, seekableStart: 16, liveEdge: 105 }).streamKind, "DVR_LIVE"); });
test("short finite append bursts remain VOD", () => { const window = new ObservationWindow(); window.push({ ...base, duration: 100, seekableStart: 0, liveEdge: 10 }); window.push({ ...base, timestamp: 2_000, duration: 100, seekableStart: 0, liveEdge: 12 }); window.push({ ...base, timestamp: 3_000, duration: 100, seekableStart: 0, liveEdge: 14 }); assert.equal(window.push({ ...base, timestamp: 4_000, duration: 100, seekableStart: 0, liveEdge: 16 }).streamKind, "VOD"); });
test("intentional rewind is retained", () => { const window = new ObservationWindow(); assert.equal(window.push({ ...base, recentBackwardSeek: true, liveEdgeLagSeconds: 30 }).liveIntent, "INTENTIONALLY_BEHIND_LIVE"); });
test("unknown live position is reported without seekable edge", () => { const window = new ObservationWindow(); assert.equal(window.push({ ...base, liveEdgeLagSeconds: null }).liveIntent, "UNKNOWN_LIVE_POSITION"); });
test("readBufferAhead selects the active buffered range", () => { const video = { currentTime: 5, buffered: { length: 2, start: (i: number) => i ? 10 : 0, end: (i: number) => i ? 20 : 8 } }; assert.equal(readBufferAhead(video as unknown as HTMLVideoElement), 3); });
test("readBufferAhead returns zero outside ranges", () => { const video = { currentTime: 9, buffered: { length: 1, start: () => 0, end: () => 8 } }; assert.equal(readBufferAhead(video as unknown as HTMLVideoElement), 0); });
test("readBufferAhead handles throwing media ranges", () => { const video = { currentTime: 1, buffered: { length: 1, start: () => { throw new Error("detached"); }, end: () => 2 } }; assert.equal(readBufferAhead(video as unknown as HTMLVideoElement), null); });
test("readLiveEdge returns the last seekable end", () => { const video = { seekable: { length: 2, end: (i: number) => i ? 20 : 8 } }; assert.equal(readLiveEdge(video as unknown as HTMLVideoElement), 20); });
test("readLiveEdge rejects non-finite values", () => { const video = { seekable: { length: 1, end: () => Infinity } }; assert.equal(readLiveEdge(video as unknown as HTMLVideoElement), null); });
test("readLiveEdge handles unavailable ranges", () => { const video = { seekable: { length: 1, end: () => { throw new Error("detached"); } } }; assert.equal(readLiveEdge(video as unknown as HTMLVideoElement), null); });
test("readSeekableStart returns the first seekable start", () => { const video = { seekable: { length: 2, start: (i: number) => i ? 10 : 3 } }; assert.equal(readSeekableStart(video as unknown as HTMLVideoElement), 3); });
test("readSeekableStart handles unavailable ranges", () => { const video = { seekable: { length: 1, start: () => { throw new Error("detached"); } } }; assert.equal(readSeekableStart(video as unknown as HTMLVideoElement), null); });

test("playback-control classification requires an observed NotAllowedError for autoplay blocking", () => {
  assert.deepEqual(classifyPlaybackControlFailure({ name: "NotAllowedError", message: "gesture required" }), {
    kind: "AUTOPLAY_BLOCKED", detail: "The browser blocked playback until the viewer provides a gesture"
  });
  assert.equal(classifyPlaybackControlFailure({ name: "AbortError", message: "load interrupted play" }).kind, "IGNORED");
  const other = classifyPlaybackControlFailure({ name: "NotSupportedError", message: "codec unavailable" });
  assert.equal(other.kind, "PLAYER_CONTROL_ERROR");
  assert.match(other.detail, /NotSupportedError/);
});

const settings = effectiveSettings(normalizeSettings({ recoveryStrategy: ["WAIT", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"], perSite: { "https://example.com": { retryButtonSelector: ".retry", backupUrls: ["https://backup.example/live"] } } }), "https://example.com");
const failures: FailureKind[] = ["NONE", "STARTUP_DELAY", "USER_PAUSED", "AUTOPLAY_BLOCKED", "NETWORK_OFFLINE", "NETWORK_STARVATION", "BUFFER_UNDERRUN", "LIVE_EDGE_DRIFT", "DECODE_FREEZE", "RENDER_FREEZE", "MEDIA_SOURCE_ERROR", "NO_USABLE_SOURCE", "LIVE_STREAM_ENDED", "PLAYER_REPLACED", "PLAYER_CONTROL_ERROR", "WEBRTC_NETWORK_FAILURE", "ACCESS_INTERRUPTION", "TAB_SUSPENDED", "BROWSER_RESUMED", "UNKNOWN_FAILURE"];
for (const failure of failures) test(`policy returns a bounded unique plan for ${failure}`, () => { const plan = planRecovery(failure, settings); assert.equal(new Set(plan).size, plan.length); assert.ok(plan.length <= settings.maxRecoveryActionsPerCycle); });

const risks: Array<[RecoveryAction, number]> = [["WAIT", 0], ["REDISCOVER", 0], ["USER_PROMPT", 1], ["PLAY", 1], ["LIVE_EDGE", 1], ["RETRY_BUTTON", 2], ["MEDIA_RELOAD", 2], ["IFRAME_RELOAD", 3], ["PAGE_RELOAD", 4], ["BACKUP_HANDOFF", 5]];
for (const [action, risk] of risks) test(`${action} has documented risk ${risk}`, () => assert.equal(actionRisk(action), risk));

test("recovery definitions describe an expected effect and verification", () => {
  for (const [action] of risks) {
    const definition = recoveryActionDefinition(action);
    assert.equal(definition.action, action);
    assert.ok(definition.expectedEffect.length > 10);
    assert.ok(definition.verification.length > 10);
  }
});

test("capability guard prevents media reload on WebRTC", () => {
  const result = validateRecoveryAction("MEDIA_RELOAD", { playerType: "WEBRTC", hasVideo: true, online: true });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /does not expose/i);
});

test("capability guard requires positive follow-live intent", () => {
  assert.equal(validateRecoveryAction("LIVE_EDGE", { hasVideo: true, followingLive: false }).allowed, false);
  assert.equal(validateRecoveryAction("LIVE_EDGE", { hasVideo: true, followingLive: true }).allowed, true);
});

test("capability-aware planning removes unsafe actions", () => {
  const plan = planRecovery("DECODE_FREEZE", settings, null, {
    hasVideo: true, playerType: "MSE", mediaReloadSafe: false, insideIframe: false, online: true, playIntent: "PLAYING"
  });
  assert.equal(plan.includes("MEDIA_RELOAD"), false);
  assert.equal(plan.includes("IFRAME_RELOAD"), false);
  assert.equal(plan.includes("PLAY"), true);
});

test("automatic recovery master switch suppresses the entire recovery plan", () => {
  const disabled = { ...settings, autoRecover: false };
  assert.deepEqual(planRecovery("DECODE_FREEZE", disabled), []);
  assert.equal(validateAutomaticRecoverySetting("PLAY", disabled).allowed, false);
});

test("automatic page refresh is independently gated without disabling soft recovery", () => {
  const softOnly = { ...settings, autoRecover: true, autoRefresh: false };
  const plan = planRecovery("DECODE_FREEZE", softOnly);
  assert.equal(plan.includes("PLAY"), true);
  assert.equal(plan.includes("PAGE_RELOAD"), false);
  assert.equal(validateAutomaticRecoverySetting("PLAY", softOnly).allowed, true);
  assert.equal(validateAutomaticRecoverySetting("PAGE_RELOAD", softOnly).allowed, false);
  assert.match(validateAutomaticRecoverySetting("PAGE_RELOAD", softOnly).reason, /page refresh/i);
});

test("preferred action uses smoothed success rate", () => { let model = emptySiteModel("https://example.com"); model = addActionOutcome(model, { action: "PLAY", failureKind: "DECODE_FREEZE", success: false, durationMs: 10, timestamp: Date.now() }); model = addActionOutcome(model, { action: "RETRY_BUTTON", failureKind: "DECODE_FREEZE", success: true, durationMs: 10, timestamp: Date.now() }); assert.equal(preferredAction(model, ["PLAY", "RETRY_BUTTON"]), "RETRY_BUTTON"); });
test("adaptive outcomes remain scoped to the diagnosed failure", () => {
  let model = emptySiteModel("https://example.com");
  for (let i = 0; i < 3; i += 1) model = addSession(model);
  for (let i = 0; i < 6; i += 1) {
    model = addActionOutcome(model, { action: "PLAY", failureKind: "BUFFER_UNDERRUN", success: true, durationMs: 10, timestamp: Date.now() });
    model = addActionOutcome(model, { action: "PLAY", failureKind: "DECODE_FREEZE", success: false, durationMs: 10, timestamp: Date.now() });
    model = addActionOutcome(model, { action: "RETRY_BUTTON", failureKind: "DECODE_FREEZE", success: true, durationMs: 10, timestamp: Date.now() });
  }
  assert.equal(preferredAction(model, ["PLAY", "RETRY_BUTTON"], "BUFFER_UNDERRUN"), "PLAY");
  assert.equal(preferredAction(model, ["PLAY", "RETRY_BUTTON"], "DECODE_FREEZE"), "RETRY_BUTTON");
  assert.equal(planRecovery("DECODE_FREEZE", settings, model)[0], "RETRY_BUTTON");
});
test("one diagnosis-scoped false alarm immediately removes automatic mutations", () => {
  let model = emptySiteModel("https://example.com");
  model = addUserFeedback(model, false, "DECODE_FREEZE");
  const guarded = planRecovery("DECODE_FREEZE", settings, model);
  assert.ok(guarded.includes("USER_PROMPT"));
  assert.ok(guarded.every((action) => actionRisk(action) === 0 || recoveryActionDefinition(action).requiresUser));
  assert.ok(planRecovery("BUFFER_UNDERRUN", settings, model).includes("PLAY"), "feedback must not affect another diagnosis");
  model = addUserFeedback(model, true, "DECODE_FREEZE");
  assert.ok(planRecovery("DECODE_FREEZE", settings, model).includes("PLAY"), "balanced feedback restores the static policy");
});
test("preferred action returns null for an empty action set", () => assert.equal(preferredAction(emptySiteModel("https://example.com"), []), null));
