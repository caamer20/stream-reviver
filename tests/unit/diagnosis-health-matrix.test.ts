import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure } from "../../src/shared/diagnosis";
import { assessVideoHealth, type HealthSnapshot } from "../../src/shared/health";
import { ObservationWindow, type PlayerObservation } from "../../src/shared/observations";
import { effectiveSettings, normalizeSettings } from "../../src/shared/settings";

const settings = effectiveSettings(normalizeSettings({}), "https://example.com");
const base: PlayerObservation = {
  timestamp: 10_000, currentTime: 10, duration: Infinity, paused: false, ended: false, readyState: 4, networkState: 2,
  timeAdvanced: true, framesAdvanced: true, presentedFrames: 100, droppedFrameRatio: 0, bufferAheadSeconds: 8,
  seekableStart: 0, liveEdge: 11, liveEdgeLagSeconds: 1, waitingEvents: 0, explicitError: "", online: true, hidden: false,
  userPaused: false, playbackIntent: "PLAYING", playbackIntentDurationMs: 1_000, playbackControlError: "",
  recentBackwardSeek: false, accessInterruption: "", adTransition: false, lifecycleGapMs: 1_000, protocol: null
};
function classify(samples: PlayerObservation[]) {
  const window = new ObservationWindow(); let trends = window.trends();
  for (const sample of samples) trends = window.push(sample);
  return diagnoseFailure(samples.at(-1)!, trends, settings);
}

const diagnosisCases: Array<[string, PlayerObservation[], string, boolean]> = [
  ["manual pause", [{ ...base, paused: true, userPaused: true, playbackIntent: "USER_PAUSED" }], "USER_PAUSED", false],
  ["offline", [{ ...base, online: false }], "NETWORK_OFFLINE", false],
  ["lifecycle resume", [{ ...base, lifecycleGapMs: 60_000 }], "BROWSER_RESUMED", false],
  ["hidden document", [{ ...base, hidden: true }], "TAB_SUSPENDED", false],
  ["ad transition", [{ ...base, adTransition: true }], "PLAYER_REPLACED", false],
  ["explicit error", [{ ...base, explicitError: "fatal" }], "MEDIA_SOURCE_ERROR", true],
  ["no source", [{ ...base, networkState: 3 }], "NO_USABLE_SOURCE", true],
  ["uncorroborated MSE fatal", [{ ...base, protocol: { kind: "MSE", observedAt: 10_000, fatalError: "append failed" } }], "MEDIA_SOURCE_ERROR", false],
  ["uncorroborated WebRTC fatal", [{ ...base, protocol: { kind: "WEBRTC", observedAt: 10_000, fatalError: "connection failed" } }], "WEBRTC_NETWORK_FAILURE", false],
  ["corroborated WebRTC fatal", [
    { ...base, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0, protocol: { kind: "WEBRTC", observedAt: 10_000, fatalError: "connection failed" } },
    { ...base, timestamp: 22_000, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0, protocol: { kind: "WEBRTC", observedAt: 22_000, fatalError: "connection failed" } }
  ], "BUFFER_UNDERRUN", true],
  ["live ended", [{ ...base, ended: true, paused: true }], "LIVE_STREAM_ENDED", true],
  ["render freeze", [{ ...base, framesAdvanced: false }, { ...base, timestamp: 22_000, currentTime: 22, framesAdvanced: false }], "RENDER_FREEZE", true],
  ["buffer underrun", [{ ...base, readyState: 1, bufferAheadSeconds: 0, timeAdvanced: false, framesAdvanced: false }, { ...base, timestamp: 22_000, readyState: 1, bufferAheadSeconds: 0, timeAdvanced: false, framesAdvanced: false }], "BUFFER_UNDERRUN", true],
  ["decode freeze", [0, 12].map((offset) => ({ ...base, timestamp: 10_000 + offset * 1_000, timeAdvanced: false, framesAdvanced: false, bufferAheadSeconds: 3 })) as PlayerObservation[], "DECODE_FREEZE", true],
  ["dropped frames warning", [{ ...base, droppedFrameRatio: .5 }], "RENDER_FREEZE", false],
  ["healthy", [base], "NONE", false]
];
for (const [name, samples, kind, safe] of diagnosisCases) test(`diagnosis classifies ${name}`, () => {
  const result = classify(samples); assert.equal(result.kind, kind); assert.equal(result.recoverySafe, safe);
});

test("a normal finite end overrides stale media errors and never recovers", () => {
  const result = classify([{
    ...base, duration: 60, currentTime: 60, paused: true, ended: true,
    playbackIntent: "ENDED_NORMALLY", explicitError: "stale player error"
  }]);
  assert.equal(result.kind, "NONE");
  assert.equal(result.recoverySafe, false);
  assert.match(result.detail, /normal end/i);
});

test("an ambiguous site pause is monitored without inventing viewer intent", () => {
  const result = classify([{ ...base, paused: true, timeAdvanced: false, playbackIntent: "SITE_PAUSED" }]);
  assert.equal(result.kind, "NONE");
  assert.equal(result.recoverySafe, false);
  assert.match(result.detail, /intent is unknown/i);
});

test("a never-started player is not treated as broken", () => {
  const result = classify([{ ...base, paused: true, currentTime: 0, timeAdvanced: false, playbackIntent: "NEVER_PLAYED" }]);
  assert.equal(result.kind, "NONE");
  assert.equal(result.recoverySafe, false);
});

test("a viewer play request must remain unfulfilled for the full timeout", () => {
  const early = classify([{
    ...base, paused: true, timeAdvanced: false, playbackIntent: "USER_REQUESTED_PLAY", playbackIntentDurationMs: 11_999
  }]);
  const sustained = classify([{
    ...base, paused: true, timeAdvanced: false, playbackIntent: "USER_REQUESTED_PLAY", playbackIntentDurationMs: 12_000
  }]);
  assert.equal(early.kind, "NONE");
  assert.equal(sustained.kind, "PLAYER_CONTROL_ERROR");
  assert.equal(sustained.recoverySafe, false);
  assert.equal(sustained.requiresUser, true);
});

test("an observed autoplay policy rejection requires a user gesture", () => {
  const result = classify([{
    ...base, paused: true, timeAdvanced: false, playbackIntent: "AUTOPLAY_BLOCKED",
    playbackControlError: "The browser blocked playback until the viewer provides a gesture"
  }]);
  assert.equal(result.kind, "AUTOPLAY_BLOCKED");
  assert.equal(result.confidence, 100);
  assert.equal(result.recoverySafe, false);
  assert.equal(result.requiresUser, true);
});

test("an observed non-policy play rejection is reported without automatic mutation", () => {
  const result = classify([{
    ...base, paused: true, timeAdvanced: false, playbackIntent: "USER_REQUESTED_PLAY",
    playbackControlError: "The player rejected a playback request (NotSupportedError)"
  }]);
  assert.equal(result.kind, "PLAYER_CONTROL_ERROR");
  assert.equal(result.recoverySafe, false);
  assert.equal(result.requiresUser, true);
});

test("live drift provides weighted evidence", () => {
  const samples = [
    { ...base, currentTime: 39, liveEdge: 40, liveEdgeLagSeconds: 1 },
    { ...base, timestamp: 11_000, currentTime: 2, liveEdge: 42, liveEdgeLagSeconds: 40 },
    { ...base, timestamp: 12_000, currentTime: 3, liveEdge: 44, liveEdgeLagSeconds: 41 }
  ];
  const result = classify(samples); assert.equal(result.kind, "LIVE_EDGE_DRIFT"); assert.equal(result.confidence, 85); assert.equal(result.evidence[0].signal, "live-edge-drift");
});

test("typed failures wait for the configured elapsed stall timeout", () => {
  const samples = [
    { ...base, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0 },
    { ...base, timestamp: 21_999, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0, waitingEvents: 4 }
  ];
  const result = classify(samples);
  assert.equal(result.kind, "NONE");
  assert.equal(result.recoverySafe, false);
});

test("unknown DVR intent never authorizes an automatic live-edge jump", () => {
  const samples = [
    { ...base, currentTime: 1, liveEdge: 40, liveEdgeLagSeconds: 39 },
    { ...base, timestamp: 12_000, currentTime: 2, liveEdge: 43, liveEdgeLagSeconds: 41 }
  ];
  assert.notEqual(classify(samples).kind, "LIVE_EDGE_DRIFT");
});

const healthBase: HealthSnapshot = {
  explicitError: false, withinGrace: false, online: true, hidden: false, paused: false, userPaused: false, ended: false,
  timeAdvanced: true, framesAdvanced: true, readyState: 4, networkState: 2, stalledForMs: 0, frameStalledForMs: 0,
  stallTimeoutMs: 12_000, waitingEvents: 0, liveEdgeLagSeconds: 0, droppedFrameRatio: 0
};
const healthCases: Array<[string, Partial<HealthSnapshot>, string]> = [
  ["grace", { withinGrace: true }, "monitoring"], ["offline", { online: false }, "offline"], ["hidden", { hidden: true }, "monitoring"],
  ["explicit error", { explicitError: true, errorDetail: "fatal" }, "suspected"], ["user pause", { userPaused: true }, "paused"],
  ["element pause", { paused: true }, "paused"], ["ended", { ended: true, timeAdvanced: false, framesAdvanced: false }, "suspected"],
  ["no source", { networkState: 3, timeAdvanced: false, framesAdvanced: false }, "suspected"],
  ["healthy", {}, "healthy"], ["inconclusive", { timeAdvanced: false, framesAdvanced: null }, "monitoring"],
  ["time stall plus readiness", { timeAdvanced: false, framesAdvanced: null, stalledForMs: 12_000, readyState: 1 }, "suspected"],
  ["frame freeze while time advances", { framesAdvanced: false, frameStalledForMs: 12_000 }, "suspected"],
  ["waiting and live lag warning", { timeAdvanced: false, framesAdvanced: null, waitingEvents: 2, liveEdgeLagSeconds: 60, stalledForMs: 8_000, readyState: 1 }, "monitoring"],
  ["high dropped frames but progress", { droppedFrameRatio: .5 }, "healthy"]
];
for (const [name, patch, state] of healthCases) test(`legacy health assesses ${name}`, () => assert.equal(assessVideoHealth({ ...healthBase, ...patch }).state, state));
