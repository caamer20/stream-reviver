import { performance } from "node:perf_hooks";
import { diagnoseFailure } from "../src/shared/diagnosis";
import { ObservationWindow, type PlayerObservation } from "../src/shared/observations";
import { effectiveSettings, normalizeSettings } from "../src/shared/settings";

const settings = effectiveSettings(normalizeSettings({}), "https://example.com");
const sample: PlayerObservation = {
  timestamp: 1_000, currentTime: 1, duration: Infinity, paused: false, ended: false, readyState: 4, networkState: 2,
  timeAdvanced: true, framesAdvanced: true, presentedFrames: 30, droppedFrameRatio: .01, bufferAheadSeconds: 5,
  seekableStart: 0, liveEdge: 2, liveEdgeLagSeconds: 1, waitingEvents: 0, explicitError: "", online: true, hidden: false, userPaused: false,
  recentBackwardSeek: false, accessInterruption: "", adTransition: false, lifecycleGapMs: 1_000, protocol: null
};
const observationWindows = Array.from({ length: 64 }, () => new ObservationWindow());

const results = {
  diagnosis: measure(100_000, () => diagnoseFailure(sample, {
    sampleCount: 4, windowMs: 3_000, bufferDelta: 1, seekableStartDelta: 0, liveEdgeDelta: 1, durationDelta: null,
    mediaTimeDelta: 3, presentedFrameDelta: 90,
    consecutiveFrozenSamples: 0, consecutiveFrameFrozenSamples: 0, consecutiveStarvedSamples: 0,
    frozenDurationMs: 0, frameFrozenDurationMs: 0, starvedDurationMs: 0,
    averageDroppedFrameRatio: .01, streamKind: "CONFIRMED_LIVE", liveIntent: "FOLLOWING_LIVE"
  }, settings)),
  observations: measure(50_000, (index) => {
    const window = observationWindows[index % observationWindows.length];
    window.push({ ...sample, timestamp: 1_000 + index * 50, currentTime: index / 20, presentedFrames: index * 2 });
  }),
  settings: measure(10_000, (index) => normalizeSettings({
    checkIntervalSeconds: index % 100, stallTimeoutSeconds: 12, perSite: { "https://example.com": { enabled: true, retryButtonSelector: ".retry" } }
  }))
};
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, results }));

function measure(iterations: number, action: (index: number) => unknown) {
  for (let index = 0; index < Math.min(1_000, iterations); index += 1) action(index);
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) action(index);
  const durationMs = performance.now() - started;
  return { iterations, durationMs, operationsPerSecond: iterations / durationMs * 1_000 };
}
