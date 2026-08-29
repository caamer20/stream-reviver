import type { EffectiveSettings, FailureDiagnosis, FailureKind, HealthEvidence } from "./types";
import type { ObservationTrends, PlayerObservation } from "./observations";

export function diagnoseFailure(
  sample: PlayerObservation,
  trends: ObservationTrends,
  settings: Pick<EffectiveSettings, "stallTimeoutSeconds" | "liveEdgeThresholdSeconds">
): FailureDiagnosis {
  const evidence: HealthEvidence[] = [];
  const now = sample.timestamp;
  if (sample.accessInterruption) return diagnosis("ACCESS_INTERRUPTION", 100, sample.accessInterruption, [], false, true, "critical", now);
  if (!sample.online) return diagnosis("NETWORK_OFFLINE", 100, "The browser reports that the device is offline", [], false, false, "warning", now);
  if (sample.lifecycleGapMs > Math.max(30_000, settings.stallTimeoutSeconds * 2000)) {
    return diagnosis("BROWSER_RESUMED", 90, "Monitoring resumed after the browser or device was suspended", [], false, false, "info", now);
  }
  if (sample.hidden) return diagnosis("TAB_SUSPENDED", 75, "The monitored document is hidden", [], false, false, "info", now);
  if (sample.adTransition) return diagnosis("PLAYER_REPLACED", 55, "The player appears to be in an advertisement or source transition", [], false, false, "info", now);
  if (sample.explicitError) {
    evidence.push({ signal: "media-error", detail: sample.explicitError, weight: 100 });
    return diagnosis("MEDIA_SOURCE_ERROR", 100, sample.explicitError, evidence, true, false, "critical", now);
  }
  // An explicit player error is actionable even when the failed player also
  // transitions to paused. Without this ordering, error overlays on a paused
  // element would be mistaken for an intentional user pause.
  if (sample.userPaused || sample.paused && !sample.ended) return diagnosis("USER_PAUSED", 100, "Playback was paused by the user", [], false, false, "info", now);
  if (sample.networkState === 3) {
    evidence.push({ signal: "no-source", detail: "The video reports no usable media source", weight: 90 });
    return diagnosis("NO_USABLE_SOURCE", 95, evidence[0].detail, evidence, true, false, "critical", now);
  }
  if (sample.protocol?.fatalError) {
    evidence.push({ signal: "protocol-error", detail: sample.protocol.fatalError, weight: 90 });
    const kind: FailureKind = sample.protocol.kind === "WEBRTC" ? "WEBRTC_NETWORK_FAILURE" : "MEDIA_SOURCE_ERROR";
    return diagnosis(kind, 95, sample.protocol.fatalError, evidence, true, false, "critical", now);
  }
  if (sample.ended && trends.streamKind !== "VOD") {
    evidence.push({ signal: "live-ended", detail: "The live player ended unexpectedly", weight: 90 });
    return diagnosis("LIVE_STREAM_ENDED", 90, evidence[0].detail, evidence, true, false, "critical", now);
  }
  if (
    sample.liveEdgeLagSeconds !== null && sample.liveEdgeLagSeconds >= settings.liveEdgeThresholdSeconds &&
    (trends.liveEdgeDelta ?? 0) > 0.5 && trends.liveIntent !== "INTENTIONALLY_BEHIND_LIVE"
  ) {
    evidence.push({ signal: "live-edge-drift", detail: `Playback is ${Math.round(sample.liveEdgeLagSeconds)} seconds behind live`, weight: 80 });
    return diagnosis("LIVE_EDGE_DRIFT", 85, evidence[0].detail, evidence, true, false, "warning", now);
  }
  if (sample.framesAdvanced === false && sample.timeAdvanced && trends.consecutiveFrameFrozenSamples >= 2) {
    evidence.push({ signal: "render-freeze", detail: "Media time advances but the compositor is not presenting frames", weight: 85 });
    return diagnosis("RENDER_FREEZE", 90, evidence[0].detail, evidence, true, false, "critical", now);
  }
  if (trends.consecutiveStarvedSamples >= 2) {
    evidence.push({ signal: "buffer-empty", detail: "The playback buffer is empty and not supplying future media", weight: 55 });
    if ((trends.bufferDelta ?? 0) <= 0) evidence.push({ signal: "buffer-not-growing", detail: "The buffer is not recovering", weight: 25 });
    if (sample.waitingEvents >= 2) evidence.push({ signal: "repeated-waiting", detail: "The player repeatedly entered a waiting state", weight: 15 });
    const confidence = Math.min(95, evidence.reduce((sum, item) => sum + item.weight, 0));
    return diagnosis("BUFFER_UNDERRUN", confidence, evidence[0].detail, evidence, confidence >= 65, false, "warning", now);
  }
  if (!sample.timeAdvanced && sample.framesAdvanced !== true && trends.consecutiveFrozenSamples >= 3) {
    evidence.push({ signal: "decode-freeze", detail: "Playback time and rendered frames have stopped", weight: 70 });
    if (sample.readyState < 2) evidence.push({ signal: "not-ready", detail: "The player has insufficient media data", weight: 20 });
    return diagnosis("DECODE_FREEZE", Math.min(95, evidence.reduce((sum, item) => sum + item.weight, 0)), evidence[0].detail, evidence, true, false, "critical", now);
  }
  if ((trends.averageDroppedFrameRatio ?? 0) > 0.35) {
    evidence.push({ signal: "dropped-frames", detail: "An unusually high share of frames are being dropped", weight: 45 });
    return diagnosis("RENDER_FREEZE", 55, evidence[0].detail, evidence, false, false, "warning", now);
  }
  return diagnosis("NONE", 0, "Playback observations do not indicate a sustained failure", [], false, false, "none", now);
}

function diagnosis(
  kind: FailureKind,
  confidence: number,
  detail: string,
  evidence: HealthEvidence[],
  recoverySafe: boolean,
  requiresUser: boolean,
  severity: FailureDiagnosis["severity"],
  observedAt: number
): FailureDiagnosis {
  return { kind, alternatives: [], confidence, detail, evidence, recoverySafe, requiresUser, severity, observedAt };
}

export function healthyDiagnosis(now = Date.now()): FailureDiagnosis {
  return diagnosis("NONE", 0, "No failure detected", [], false, false, "none", now);
}
