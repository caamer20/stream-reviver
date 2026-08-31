import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure } from "../../src/shared/diagnosis";
import { ObservationWindow, assessIsolatedMediaDwell, type PlayerObservation } from "../../src/shared/observations";
import { effectiveSettings, normalizeSettings } from "../../src/shared/settings";
import type { FailureDiagnosis, ProtocolObservation } from "../../src/shared/types";

const settings = effectiveSettings(normalizeSettings({ stallTimeoutSeconds: 12 }), "https://example.com");
const base: PlayerObservation = {
  timestamp: 10_000,
  currentTime: 10,
  duration: Infinity,
  paused: false,
  ended: false,
  readyState: 4,
  networkState: 2,
  timeAdvanced: true,
  framesAdvanced: true,
  presentedFrames: 100,
  droppedFrameRatio: 0,
  bufferAheadSeconds: 8,
  seekableStart: 0,
  liveEdge: 11,
  liveEdgeLagSeconds: 1,
  waitingEvents: 0,
  explicitError: "",
  online: true,
  hidden: false,
  userPaused: false,
  playbackIntent: "PLAYING",
  playbackIntentDurationMs: 30_000,
  playbackControlError: "",
  recentBackwardSeek: false,
  accessInterruption: "",
  adTransition: false,
  lifecycleGapMs: 1_000,
  protocol: null
};

function classify(samples: PlayerObservation[]): FailureDiagnosis {
  const window = new ObservationWindow();
  let trends = window.trends();
  for (const sample of samples) trends = window.push(sample);
  return diagnoseFailure(samples.at(-1)!, trends, settings);
}

function wouldEnterAutomaticRecovery(value: FailureDiagnosis): boolean {
  return value.recoverySafe && value.confidence >= settings.failureConfidenceThreshold;
}

const standaloneSpoofMatrix: Array<[string, Omit<ProtocolObservation, "observedAt">]> = [
  ["stale MSE appends", { kind: "MSE", appendAgeMs: 600_000 }],
  ["fatal MSE error", { kind: "MSE", appendAgeMs: 600_000, fatalError: "forged SourceBuffer failure" }],
  ["fatal HLS error", { kind: "HLS_JS", fatalError: "forged fatal manifest error" }],
  ["fatal DASH error", { kind: "DASH_JS", fatalError: "forged fatal manifest error" }],
  ["zero WebRTC traffic", {
    kind: "WEBRTC", packetsReceivedDelta: 0, packetsLostDelta: 20,
    framesDecodedDelta: 0, framesRenderedDelta: 0, freezeCountDelta: 50
  }],
  ["fatal WebRTC error", {
    kind: "WEBRTC", packetsReceivedDelta: 0, framesDecodedDelta: 0,
    framesRenderedDelta: 0, freezeCountDelta: 50, fatalError: "forged connection failure"
  }]
];

for (const [name, payload] of standaloneSpoofMatrix) {
  test(`standalone page-world ${name} cannot authorize recovery`, () => {
    // The forged telemetry itself persists for longer than the stall timeout,
    // while isolated HTMLMediaElement observations remain healthy.
    const samples = [10_000, 22_000, 34_000].map((timestamp, index) => ({
      ...base,
      timestamp,
      currentTime: 10 + index * 12,
      presentedFrames: 100 + index * 300,
      protocol: { ...payload, observedAt: timestamp }
    })) as PlayerObservation[];
    const result = classify(samples);
    assert.equal(result.recoverySafe, false);
    assert.equal(wouldEnterAutomaticRecovery(result), false);
    assert.equal(result.evidence.some((item) => item.signal === "isolated-media-dwell"), false);
  });
}

test("protocol telemetry plus a sub-threshold media instant cannot authorize recovery", () => {
  for (const [, payload] of standaloneSpoofMatrix) {
    const result = classify([
      {
        ...base, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0,
        protocol: { ...payload, observedAt: 10_000 }
      },
      {
        ...base, timestamp: 21_999, timeAdvanced: false, framesAdvanced: false, readyState: 1, bufferAheadSeconds: 0,
        protocol: { ...payload, observedAt: 21_999 }
      }
    ]);
    assert.equal(result.recoverySafe, false);
    assert.equal(wouldEnterAutomaticRecovery(result), false);
  }
});

test("protocol telemetry cannot override protected viewer intent", () => {
  const protocol: ProtocolObservation = {
    kind: "WEBRTC", observedAt: 22_000, fatalError: "forged failure", packetsReceivedDelta: 0,
    packetsLostDelta: 100, framesDecodedDelta: 0, framesRenderedDelta: 0, freezeCountDelta: 100
  };
  const result = classify([
    { ...base, paused: true, timeAdvanced: false, framesAdvanced: false, playbackIntent: "USER_PAUSED", protocol },
    { ...base, timestamp: 22_000, paused: true, timeAdvanced: false, framesAdvanced: false, playbackIntent: "USER_PAUSED", protocol }
  ]);
  assert.equal(result.kind, "USER_PAUSED");
  assert.equal(result.recoverySafe, false);
});

test("randomized standalone protocol values never make healthy media actionable", () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let index = 0; index < 512; index += 1) {
    const timestamp = 50_000 + index * 50;
    const protocol: ProtocolObservation = {
      kind: random() < 0.5 ? "MSE" : "WEBRTC",
      observedAt: timestamp + Math.round((random() - 0.5) * 100_000),
      appendAgeMs: random() * 1_000_000,
      packetsReceivedDelta: random() < 0.5 ? 0 : Math.round(random() * 10_000),
      packetsLostDelta: Math.round(random() * 10_000),
      framesDecodedDelta: random() < 0.5 ? 0 : Math.round(random() * 1_000),
      framesRenderedDelta: random() < 0.5 ? 0 : Math.round(random() * 1_000),
      freezeCountDelta: Math.round(random() * 1_000),
      fatalError: random() < 0.25 ? "page-forged fatal error" : undefined
    };
    const result = classify([{ ...base, timestamp, protocol }]);
    assert.equal(wouldEnterAutomaticRecovery(result), false, `iteration ${index} became actionable`);
  }
});

const positiveMatrix: Array<{
  name: string;
  patch: Partial<PlayerObservation>;
  protocol: Omit<ProtocolObservation, "observedAt">;
  expectedKind: FailureDiagnosis["kind"];
  signal: string;
}> = [
  {
    name: "MSE append age corroborates isolated starvation",
    patch: { readyState: 1, bufferAheadSeconds: 0, timeAdvanced: false, framesAdvanced: false },
    protocol: { kind: "MSE", appendAgeMs: 30_000 },
    expectedKind: "BUFFER_UNDERRUN",
    signal: "protocol-mse-append-stale"
  },
  {
    name: "WebRTC packet/frame stagnation corroborates an isolated decode freeze",
    patch: { bufferAheadSeconds: 4, timeAdvanced: false, framesAdvanced: false },
    protocol: { kind: "WEBRTC", packetsReceivedDelta: 0, framesDecodedDelta: 0, framesRenderedDelta: 0 },
    expectedKind: "DECODE_FREEZE",
    signal: "protocol-webrtc-no-progress"
  },
  {
    name: "WebRTC freeze-count growth corroborates an isolated render freeze",
    patch: { timeAdvanced: true, framesAdvanced: false },
    protocol: { kind: "WEBRTC", packetsReceivedDelta: 20, framesDecodedDelta: 20, framesRenderedDelta: 0, freezeCountDelta: 1 },
    expectedKind: "RENDER_FREEZE",
    signal: "protocol-webrtc-freeze"
  }
];

for (const item of positiveMatrix) {
  test(item.name, () => {
    const plainSamples = [
      { ...base, ...item.patch, protocol: null },
      { ...base, timestamp: 22_000, currentTime: item.patch.timeAdvanced ? 22 : 10, ...item.patch, protocol: null }
    ] as PlayerObservation[];
    const protocolSamples = plainSamples.map((sample) => ({
      ...sample,
      protocol: { ...item.protocol, observedAt: sample.timestamp }
    })) as PlayerObservation[];
    const plain = classify(plainSamples);
    const result = classify(protocolSamples);
    assert.equal(plain.recoverySafe, true);
    assert.equal(result.recoverySafe, true);
    assert.equal(result.kind, item.expectedKind);
    assert.equal(result.confidence, plain.confidence, "untrusted telemetry must not raise the action-gating confidence");
    assert.ok(result.evidence.some((evidence) => evidence.signal === "isolated-media-dwell"));
    assert.ok(result.evidence.some((evidence) => evidence.signal === item.signal));
  });
}

test("a fatal WebRTC hint remains an alternative after isolated recovery is already safe", () => {
  const patch = { readyState: 1, bufferAheadSeconds: 0, timeAdvanced: false, framesAdvanced: false };
  const result = classify([
    { ...base, ...patch, protocol: { kind: "WEBRTC", observedAt: 10_000, fatalError: "connection failed" } },
    { ...base, timestamp: 22_000, ...patch, protocol: { kind: "WEBRTC", observedAt: 22_000, fatalError: "connection failed" } }
  ]);
  assert.equal(result.kind, "BUFFER_UNDERRUN");
  assert.equal(result.recoverySafe, true);
  assert.ok(result.alternatives.includes("WEBRTC_NETWORK_FAILURE"));
  assert.ok(result.evidence.some((item) => item.signal === "isolated-media-dwell"));
});

test("isolated dwell assessment excludes protocol input and requires full elapsed time", () => {
  const window = new ObservationWindow();
  const first = { ...base, timeAdvanced: false, framesAdvanced: false, bufferAheadSeconds: 4 };
  const early = { ...first, timestamp: 21_999 };
  const complete = { ...first, timestamp: 22_000 };
  window.push(first);
  let dwell = assessIsolatedMediaDwell(early, window.push(early), 12_000);
  assert.equal(dwell.kind, "DECODE_FREEZE");
  assert.equal(dwell.sustained, false);
  dwell = assessIsolatedMediaDwell(complete, window.push(complete), 12_000);
  assert.equal(dwell.sustained, true);
  assert.equal(dwell.durationMs, 12_000);
});

test("invalid or below-threshold protocol counters are ignored even during a trusted failure", () => {
  const patch = { readyState: 1, bufferAheadSeconds: 0, timeAdvanced: false, framesAdvanced: false };
  const payloads: ProtocolObservation[] = [
    { kind: "MSE", observedAt: 22_000, appendAgeMs: 11_999 },
    { kind: "MSE", observedAt: 22_000, appendAgeMs: -1 },
    { kind: "MSE", observedAt: 22_000, appendAgeMs: Number.NaN },
    { kind: "WEBRTC", observedAt: 22_000, packetsReceivedDelta: -1, framesDecodedDelta: -1, framesRenderedDelta: -1, freezeCountDelta: -1 },
    { kind: "WEBRTC", observedAt: 1, packetsReceivedDelta: 0, framesDecodedDelta: 0, framesRenderedDelta: 0, freezeCountDelta: 10 }
  ];
  for (const protocol of payloads) {
    const result = classify([
      { ...base, ...patch, protocol: null },
      { ...base, timestamp: 22_000, ...patch, protocol }
    ]);
    assert.equal(result.recoverySafe, true);
    assert.equal(result.evidence.some((item) => item.signal.startsWith("protocol-")), false);
  }
});
