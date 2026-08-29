import test from "node:test";
import assert from "node:assert/strict";
import { ObservationWindow, readBufferAhead, readLiveEdge, type PlayerObservation } from "../../src/shared/observations";
import { addActionOutcome, emptySiteModel, preferredAction } from "../../src/shared/outcomes";
import { actionRisk, planRecovery } from "../../src/shared/policy";
import { effectiveSettings, normalizeSettings } from "../../src/shared/settings";
import type { FailureKind, RecoveryAction } from "../../src/shared/types";

const base: PlayerObservation = { timestamp: 1_000, currentTime: 1, duration: Infinity, paused: false, ended: false, readyState: 4, networkState: 2, timeAdvanced: true, framesAdvanced: true, presentedFrames: 1, droppedFrameRatio: null, bufferAheadSeconds: 5, liveEdge: 2, liveEdgeLagSeconds: 1, waitingEvents: 0, explicitError: "", online: true, hidden: false, userPaused: false, recentBackwardSeek: false, accessInterruption: "", adTransition: false, lifecycleGapMs: 100, protocol: null };

test("observation window starts empty", () => assert.equal(new ObservationWindow().trends().sampleCount, 0));
test("observation window prunes samples by age", () => { const window = new ObservationWindow(1_000, 20); window.push(base); assert.equal(window.push({ ...base, timestamp: 3_000 }).sampleCount, 1); });
test("observation window prunes samples by count", () => { const window = new ObservationWindow(100_000, 2); window.push(base); window.push({ ...base, timestamp: 2_000 }); assert.equal(window.push({ ...base, timestamp: 3_000 }).sampleCount, 2); });
test("observation window tracks frozen tails", () => { const window = new ObservationWindow(); window.push({ ...base, timeAdvanced: false, framesAdvanced: false }); const result = window.push({ ...base, timestamp: 2_000, timeAdvanced: false, framesAdvanced: false }); assert.equal(result.consecutiveFrozenSamples, 2); assert.equal(result.consecutiveFrameFrozenSamples, 2); });
test("observation window tracks starved tails", () => { const window = new ObservationWindow(); window.push({ ...base, readyState: 1, bufferAheadSeconds: 0 }); assert.equal(window.push({ ...base, timestamp: 2_000, readyState: 1, bufferAheadSeconds: 0 }).consecutiveStarvedSamples, 2); });
test("observation window averages dropped-frame ratios", () => { const window = new ObservationWindow(); window.push({ ...base, droppedFrameRatio: .2 }); assert.ok(Math.abs(window.push({ ...base, timestamp: 2_000, droppedFrameRatio: .4 }).averageDroppedFrameRatio! - .3) < 1e-9); });
test("observation window computes media and frame deltas", () => { const window = new ObservationWindow(); window.push(base); const result = window.push({ ...base, timestamp: 2_000, currentTime: 3, presentedFrames: 20, bufferAheadSeconds: 8 }); assert.equal(result.mediaTimeDelta, 2); assert.equal(result.presentedFrameDelta, 19); assert.equal(result.bufferDelta, 3); });
test("observation window can be cleared", () => { const window = new ObservationWindow(); window.push(base); window.clear(); assert.equal(window.latest(), null); });
test("infinite duration is confirmed live", () => { const window = new ObservationWindow(); assert.equal(window.push(base).streamKind, "CONFIRMED_LIVE"); });
test("moving finite seekable edge is DVR live", () => { const window = new ObservationWindow(); window.push({ ...base, duration: 100, liveEdge: 90 }); window.push({ ...base, timestamp: 2_000, duration: 100, liveEdge: 91 }); assert.equal(window.push({ ...base, timestamp: 3_000, duration: 100, liveEdge: 93 }).streamKind, "DVR_LIVE"); });
test("intentional rewind is retained", () => { const window = new ObservationWindow(); assert.equal(window.push({ ...base, recentBackwardSeek: true, liveEdgeLagSeconds: 30 }).liveIntent, "INTENTIONALLY_BEHIND_LIVE"); });
test("unknown live position is reported without seekable edge", () => { const window = new ObservationWindow(); assert.equal(window.push({ ...base, liveEdgeLagSeconds: null }).liveIntent, "UNKNOWN_LIVE_POSITION"); });
test("readBufferAhead selects the active buffered range", () => { const video = { currentTime: 5, buffered: { length: 2, start: (i: number) => i ? 10 : 0, end: (i: number) => i ? 20 : 8 } }; assert.equal(readBufferAhead(video as unknown as HTMLVideoElement), 3); });
test("readBufferAhead returns zero outside ranges", () => { const video = { currentTime: 9, buffered: { length: 1, start: () => 0, end: () => 8 } }; assert.equal(readBufferAhead(video as unknown as HTMLVideoElement), 0); });
test("readBufferAhead handles throwing media ranges", () => { const video = { currentTime: 1, buffered: { length: 1, start: () => { throw new Error("detached"); }, end: () => 2 } }; assert.equal(readBufferAhead(video as unknown as HTMLVideoElement), null); });
test("readLiveEdge returns the last seekable end", () => { const video = { seekable: { length: 2, end: (i: number) => i ? 20 : 8 } }; assert.equal(readLiveEdge(video as unknown as HTMLVideoElement), 20); });
test("readLiveEdge rejects non-finite values", () => { const video = { seekable: { length: 1, end: () => Infinity } }; assert.equal(readLiveEdge(video as unknown as HTMLVideoElement), null); });
test("readLiveEdge handles unavailable ranges", () => { const video = { seekable: { length: 1, end: () => { throw new Error("detached"); } } }; assert.equal(readLiveEdge(video as unknown as HTMLVideoElement), null); });

const settings = effectiveSettings(normalizeSettings({ recoveryStrategy: ["WAIT", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"], perSite: { "https://example.com": { retryButtonSelector: ".retry", backupUrls: ["https://backup.example/live"] } } }), "https://example.com");
const failures: FailureKind[] = ["NONE", "STARTUP_DELAY", "USER_PAUSED", "AUTOPLAY_BLOCKED", "NETWORK_OFFLINE", "NETWORK_STARVATION", "BUFFER_UNDERRUN", "LIVE_EDGE_DRIFT", "DECODE_FREEZE", "RENDER_FREEZE", "MEDIA_SOURCE_ERROR", "NO_USABLE_SOURCE", "LIVE_STREAM_ENDED", "PLAYER_REPLACED", "PLAYER_CONTROL_ERROR", "WEBRTC_NETWORK_FAILURE", "ACCESS_INTERRUPTION", "TAB_SUSPENDED", "BROWSER_RESUMED", "UNKNOWN_FAILURE"];
for (const failure of failures) test(`policy returns a bounded unique plan for ${failure}`, () => { const plan = planRecovery(failure, settings); assert.equal(new Set(plan).size, plan.length); assert.ok(plan.length <= settings.maxRecoveryActionsPerCycle); });

const risks: Array<[RecoveryAction, number]> = [["WAIT", 0], ["REDISCOVER", 0], ["USER_PROMPT", 1], ["PLAY", 1], ["LIVE_EDGE", 1], ["RETRY_BUTTON", 2], ["MEDIA_RELOAD", 2], ["IFRAME_RELOAD", 3], ["PAGE_RELOAD", 4], ["BACKUP_HANDOFF", 5]];
for (const [action, risk] of risks) test(`${action} has documented risk ${risk}`, () => assert.equal(actionRisk(action), risk));

test("preferred action uses smoothed success rate", () => { let model = emptySiteModel("https://example.com"); model = addActionOutcome(model, { action: "PLAY", failureKind: "DECODE_FREEZE", success: false, durationMs: 10, timestamp: Date.now() }); model = addActionOutcome(model, { action: "RETRY_BUTTON", failureKind: "DECODE_FREEZE", success: true, durationMs: 10, timestamp: Date.now() }); assert.equal(preferredAction(model, ["PLAY", "RETRY_BUTTON"]), "RETRY_BUTTON"); });
test("preferred action returns null for an empty action set", () => assert.equal(preferredAction(emptySiteModel("https://example.com"), []), null));
