import type { EffectiveSettings, FailureDiagnosis, FailureKind, HealthEvidence } from "./types";
import { assessIsolatedMediaDwell, type IsolatedMediaDwell, type ObservationTrends, type PlayerObservation } from "./observations";

export function diagnoseFailure(
  sample: PlayerObservation,
  trends: ObservationTrends,
  settings: Pick<EffectiveSettings, "stallTimeoutSeconds" | "liveEdgeThresholdSeconds">
): FailureDiagnosis {
  const evidence: HealthEvidence[] = [];
  const now = sample.timestamp;
  const stallTimeoutMs = settings.stallTimeoutSeconds * 1000;
  const isolatedDwell = assessIsolatedMediaDwell(sample, trends, stallTimeoutMs);
  const protocol = assessUntrustedProtocol(sample, stallTimeoutMs);
  if (sample.accessInterruption) return diagnosis("ACCESS_INTERRUPTION", 100, sample.accessInterruption, [], false, true, "critical", now);
  if (!sample.online) return diagnosis("NETWORK_OFFLINE", 100, "The browser reports that the device is offline", [], false, false, "warning", now);
  if (sample.lifecycleGapMs > Math.max(30_000, settings.stallTimeoutSeconds * 2000)) {
    return diagnosis("BROWSER_RESUMED", 90, "Monitoring resumed after the browser or device was suspended", [], false, false, "info", now);
  }
  if (sample.hidden) return diagnosis("TAB_SUSPENDED", 75, "The monitored document is hidden", [], false, false, "info", now);
  if (sample.adTransition) return diagnosis("PLAYER_REPLACED", 55, "The player appears to be in an advertisement or source transition", [], false, false, "info", now);
  // Explicit intent always wins over mutable player state. A page may surface
  // an error after a viewer pauses or after finite playback ends; neither is
  // authority to undo that intentional/normal terminal state.
  if (sample.playbackIntent === "USER_PAUSED") {
    return diagnosis("USER_PAUSED", 100, "Playback was intentionally paused by the viewer", [], false, false, "info", now);
  }
  if (sample.playbackIntent === "ENDED_NORMALLY") {
    return diagnosis("NONE", 0, "Playback reached the normal end of finite media", [], false, false, "none", now);
  }
  if (sample.playbackIntent === "AUTOPLAY_BLOCKED") {
    evidence.push({ signal: "autoplay-policy", detail: sample.playbackControlError || "The browser requires a user gesture before playback", weight: 100 });
    return diagnosis("AUTOPLAY_BLOCKED", 100, evidence[0].detail, evidence, false, true, "warning", now);
  }
  if (sample.playbackControlError) {
    evidence.push({ signal: "playback-control", detail: sample.playbackControlError, weight: 90 });
    return diagnosis("PLAYER_CONTROL_ERROR", 90, sample.playbackControlError, evidence, false, true, "warning", now);
  }
  if (sample.explicitError) {
    evidence.push({ signal: "media-error", detail: sample.explicitError, weight: 100 });
    return diagnosis("MEDIA_SOURCE_ERROR", 100, sample.explicitError, evidence, true, false, "critical", now);
  }
  if (sample.userPaused) return diagnosis("USER_PAUSED", 100, "Playback was intentionally paused by the viewer", [], false, false, "info", now);
  if (sample.paused && !sample.ended) {
    if (sample.playbackIntent === "USER_REQUESTED_PLAY" && sample.playbackIntentDurationMs >= stallTimeoutMs) {
      evidence.push({ signal: "play-request-not-honored", detail: "Playback remained paused after the viewer requested play", weight: 75 });
      return diagnosis("PLAYER_CONTROL_ERROR", 75, evidence[0].detail, evidence, false, true, "warning", now);
    }
    const detail = sample.playbackIntent === "SITE_PAUSED"
      ? "The page paused playback; viewer intent is unknown"
      : "Playback has not started and no viewer play request was observed";
    return diagnosis("NONE", 0, detail, [], false, false, "info", now);
  }
  if (sample.networkState === 3) {
    evidence.push({ signal: "no-source", detail: "The video reports no usable media source", weight: 90 });
    return diagnosis("NO_USABLE_SOURCE", 95, evidence[0].detail, evidence, true, false, "critical", now);
  }
  if (sample.ended && (trends.streamKind === "CONFIRMED_LIVE" || trends.streamKind === "DVR_LIVE")) {
    evidence.push({ signal: "live-ended", detail: "The live player ended unexpectedly", weight: 90 });
    return diagnosis("LIVE_STREAM_ENDED", 90, evidence[0].detail, evidence, true, false, "critical", now);
  }
  if (sample.ended && trends.streamKind !== "VOD") {
    evidence.push({ signal: "ended-unclassified", detail: "Playback ended, but there is not enough evidence to confirm that this was a live stream", weight: 45 });
    return diagnosis("UNKNOWN_FAILURE", 45, evidence[0].detail, evidence, false, true, "warning", now);
  }
  if (
    sample.liveEdgeLagSeconds !== null && sample.liveEdgeLagSeconds >= settings.liveEdgeThresholdSeconds &&
    (trends.liveEdgeDelta ?? 0) > 0.5 && trends.liveIntent === "FOLLOWING_LIVE"
  ) {
    evidence.push({ signal: "live-edge-drift", detail: `Playback is ${Math.round(sample.liveEdgeLagSeconds)} seconds behind live`, weight: 80 });
    return diagnosis("LIVE_EDGE_DRIFT", 85, evidence[0].detail, evidence, true, false, "warning", now);
  }
  if (sample.framesAdvanced === false && sample.timeAdvanced && trends.frameFrozenDurationMs >= stallTimeoutMs) {
    evidence.push({ signal: "render-freeze", detail: "Media time advances but the compositor is not presenting frames", weight: 85 });
    return supplementWithProtocol(
      diagnosis("RENDER_FREEZE", 90, evidence[0].detail, evidence, true, false, "critical", now),
      protocol,
      isolatedDwell
    );
  }
  if (trends.starvedDurationMs >= stallTimeoutMs) {
    evidence.push({ signal: "buffer-empty", detail: "The playback buffer is empty and not supplying future media", weight: 55 });
    if ((trends.bufferDelta ?? 0) <= 0) evidence.push({ signal: "buffer-not-growing", detail: "The buffer is not recovering", weight: 25 });
    if (sample.waitingEvents >= 2) evidence.push({ signal: "repeated-waiting", detail: "The player repeatedly entered a waiting state", weight: 15 });
    const confidence = Math.min(95, evidence.reduce((sum, item) => sum + item.weight, 0));
    const kind: FailureKind = sample.networkState === 2 && (trends.bufferDelta ?? 0) <= 0 && sample.waitingEvents >= 2
      ? "NETWORK_STARVATION" : "BUFFER_UNDERRUN";
    return supplementWithProtocol(
      diagnosis(kind, confidence, evidence[0].detail, evidence, confidence >= 65, false, "warning", now),
      protocol,
      isolatedDwell
    );
  }
  if (!sample.timeAdvanced && sample.framesAdvanced !== true && trends.frozenDurationMs >= stallTimeoutMs) {
    evidence.push({ signal: "decode-freeze", detail: "Playback time and rendered frames have stopped", weight: 70 });
    if (sample.readyState < 2) evidence.push({ signal: "not-ready", detail: "The player has insufficient media data", weight: 20 });
    return supplementWithProtocol(
      diagnosis("DECODE_FREEZE", Math.min(95, evidence.reduce((sum, item) => sum + item.weight, 0)), evidence[0].detail, evidence, true, false, "critical", now),
      protocol,
      isolatedDwell
    );
  }
  if (protocol.fatalDetail) {
    // MAIN-world messages can be forged by the page. Preserve a typed hint for
    // diagnostics, but do not allow it to cross the automatic-mutation gate.
    const kind: FailureKind = protocol.kind === "WEBRTC" ? "WEBRTC_NETWORK_FAILURE" : "MEDIA_SOURCE_ERROR";
    const hint = { signal: "protocol-error", detail: protocol.fatalDetail, weight: protocol.fresh ? 35 : 20 };
    return diagnosis(
      kind,
      protocol.fresh ? 45 : 25,
      `${protocol.fatalDetail}; waiting for sustained isolated media evidence`,
      [hint],
      false,
      false,
      "warning",
      now
    );
  }
  if ((trends.averageDroppedFrameRatio ?? 0) > 0.35) {
    evidence.push({ signal: "dropped-frames", detail: "An unusually high share of frames are being dropped", weight: 45 });
    return diagnosis("RENDER_FREEZE", 55, evidence[0].detail, evidence, false, false, "warning", now);
  }
  return diagnosis("NONE", 0, "Playback observations do not indicate a sustained failure", [], false, false, "none", now);
}

interface UntrustedProtocolAssessment {
  kind: "MSE" | "HLS_JS" | "DASH_JS" | "WEBRTC" | null;
  fresh: boolean;
  fatalDetail: string;
  evidence: HealthEvidence[];
}

/**
 * Parse page-world telemetry into bounded diagnostic hints. This function does
 * not inspect or decide recovery safety; those hints are attached only after a
 * separate isolated-world media diagnosis has already met its full dwell.
 */
function assessUntrustedProtocol(sample: PlayerObservation, stallTimeoutMs: number): UntrustedProtocolAssessment {
  const value = sample.protocol;
  if (!value) return { kind: null, fresh: false, fatalDetail: "", evidence: [] };
  const fresh = Number.isFinite(value.observedAt) && Math.abs(sample.timestamp - value.observedAt) <= 15_000;
  const fatalDetail = cleanProtocolDetail(value.fatalError);
  if (!fresh) return { kind: value.kind, fresh: false, fatalDetail, evidence: [] };

  const evidence: HealthEvidence[] = [];
  const appendAgeMs = finiteNonNegative(value.appendAgeMs);
  if (fatalDetail) evidence.push({ signal: "protocol-error", detail: fatalDetail, weight: 15 });
  if (
    value.kind === "MSE" && appendAgeMs !== null &&
    appendAgeMs >= Math.max(1, stallTimeoutMs)
  ) {
    evidence.push({
      signal: "protocol-mse-append-stale",
      detail: "The page-world MSE bridge reports no recent SourceBuffer append",
      weight: 8
    });
  }
  if (value.kind === "WEBRTC") {
    const received = finiteNonNegative(value.packetsReceivedDelta);
    const lost = finiteNonNegative(value.packetsLostDelta);
    const decoded = finiteNonNegative(value.framesDecodedDelta);
    const rendered = finiteNonNegative(value.framesRenderedDelta);
    const freezes = finiteNonNegative(value.freezeCountDelta);
    if (received === 0 && (decoded === 0 || rendered === 0)) {
      evidence.push({
        signal: "protocol-webrtc-no-progress",
        detail: "The page-world WebRTC bridge reports no inbound packet/frame progress",
        weight: 8
      });
    }
    if (received === 0 && lost !== null && lost > 0) {
      evidence.push({
        signal: "protocol-webrtc-loss",
        detail: "The page-world WebRTC bridge reports losses without received packets",
        weight: 6
      });
    }
    if (freezes !== null && freezes > 0) {
      evidence.push({
        signal: "protocol-webrtc-freeze",
        detail: "The page-world WebRTC bridge reports an increased decoder freeze count",
        weight: 6
      });
    }
  }
  return { kind: value.kind, fresh, fatalDetail, evidence };
}

function supplementWithProtocol(
  trusted: FailureDiagnosis,
  protocol: UntrustedProtocolAssessment,
  isolatedDwell: IsolatedMediaDwell
): FailureDiagnosis {
  if (!trusted.recoverySafe || !isolatedDwell.sustained || !protocol.fresh || !protocol.evidence.length) return trusted;
  const mediaEvidence: HealthEvidence = {
    signal: "isolated-media-dwell",
    detail: `Isolated media observations independently showed ${isolatedDwell.kind.toLowerCase().replace("_", " ")} for ${Math.round(isolatedDwell.durationMs / 1000)} seconds`,
    weight: 0
  };
  const result = {
    ...trusted,
    evidence: [...trusted.evidence, mediaEvidence, ...protocol.evidence]
  };
  // A fresh fatal hint can appear as an alternative only after recovery was
  // independently safe. It never changes the primary kind used by policy,
  // raises confidence, or flips recoverySafe.
  if (protocol.fatalDetail) {
    const alternative: FailureKind = protocol.kind === "WEBRTC" ? "WEBRTC_NETWORK_FAILURE" : "MEDIA_SOURCE_ERROR";
    result.alternatives = alternative === trusted.kind
      ? trusted.alternatives
      : [...new Set([...trusted.alternatives, alternative])];
  }
  return result;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function cleanProtocolDetail(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 160) : "";
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
