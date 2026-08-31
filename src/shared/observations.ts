import type { LiveIntent, PlaybackIntent, ProtocolObservation, StreamKind } from "./types";

export interface PlayerObservation {
  timestamp: number;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  networkState: number;
  timeAdvanced: boolean;
  framesAdvanced: boolean | null;
  presentedFrames: number;
  droppedFrameRatio: number | null;
  bufferAheadSeconds: number | null;
  seekableStart: number | null;
  liveEdge: number | null;
  liveEdgeLagSeconds: number | null;
  waitingEvents: number;
  explicitError: string;
  online: boolean;
  hidden: boolean;
  userPaused: boolean;
  playbackIntent: PlaybackIntent;
  playbackIntentDurationMs: number;
  playbackControlError: string;
  recentBackwardSeek: boolean;
  accessInterruption: string;
  adTransition: boolean;
  lifecycleGapMs: number;
  protocol: ProtocolObservation | null;
}

export interface ObservationTrends {
  sampleCount: number;
  windowMs: number;
  bufferDelta: number | null;
  seekableStartDelta: number | null;
  liveEdgeDelta: number | null;
  durationDelta: number | null;
  mediaTimeDelta: number;
  presentedFrameDelta: number;
  consecutiveFrozenSamples: number;
  consecutiveFrameFrozenSamples: number;
  consecutiveStarvedSamples: number;
  frozenDurationMs: number;
  frameFrozenDurationMs: number;
  starvedDurationMs: number;
  averageDroppedFrameRatio: number | null;
  streamKind: StreamKind;
  liveIntent: LiveIntent;
}

/**
 * Sustained failure evidence collected from the isolated-world HTML media
 * element. Protocol bridge messages are deliberately not inputs to this
 * assessment because a page can forge every MAIN-world message we receive.
 */
export interface IsolatedMediaDwell {
  kind: "NONE" | "STARVATION" | "DECODE_FREEZE" | "RENDER_FREEZE";
  durationMs: number;
  sustained: boolean;
}

export function assessIsolatedMediaDwell(
  sample: PlayerObservation,
  trends: ObservationTrends,
  requiredDwellMs: number
): IsolatedMediaDwell {
  const threshold = Math.max(1, requiredDwellMs);
  // A protocol hint must never turn an intentional/ambiguous pause, a normal
  // end, or a never-started player into an actionable failure.
  if (sample.paused || sample.ended || sample.playbackIntent !== "PLAYING") {
    return { kind: "NONE", durationMs: 0, sustained: false };
  }
  if (sample.framesAdvanced === false && sample.timeAdvanced) {
    return {
      kind: "RENDER_FREEZE",
      durationMs: trends.frameFrozenDurationMs,
      sustained: trends.frameFrozenDurationMs >= threshold
    };
  }
  if (sample.readyState < 2 && (sample.bufferAheadSeconds ?? 0) < 0.5 && !sample.timeAdvanced) {
    return {
      kind: "STARVATION",
      durationMs: trends.starvedDurationMs,
      sustained: trends.starvedDurationMs >= threshold
    };
  }
  if (!sample.timeAdvanced && sample.framesAdvanced !== true) {
    return {
      kind: "DECODE_FREEZE",
      durationMs: trends.frozenDurationMs,
      sustained: trends.frozenDurationMs >= threshold
    };
  }
  return { kind: "NONE", durationMs: 0, sustained: false };
}

export interface PlaybackControlFailure {
  kind: "AUTOPLAY_BLOCKED" | "PLAYER_CONTROL_ERROR" | "IGNORED";
  detail: string;
}

/** Classify only an observed play() rejection; never infer policy blocking. */
export function classifyPlaybackControlFailure(error: unknown): PlaybackControlFailure {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name ?? "") : "";
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "") : "";
  if (name === "NotAllowedError") {
    return { kind: "AUTOPLAY_BLOCKED", detail: "The browser blocked playback until the viewer provides a gesture" };
  }
  // AbortError is normally caused by a racing pause(), load(), or source
  // replacement. It is not stable evidence of a broken player.
  if (name === "AbortError") return { kind: "IGNORED", detail: "" };
  const summary = [name, message].filter(Boolean).join(": ").replace(/\s+/g, " ").slice(0, 180);
  return {
    kind: "PLAYER_CONTROL_ERROR",
    detail: summary ? `The player rejected a playback request (${summary})` : "The player rejected a playback request"
  };
}

export class ObservationWindow {
  private samples: PlayerObservation[] = [];

  constructor(private readonly maxAgeMs = 120_000, private readonly maxSamples = 240) {}

  push(sample: PlayerObservation): ObservationTrends {
    this.samples.push(sample);
    const cutoff = sample.timestamp - this.maxAgeMs;
    while (this.samples.length > this.maxSamples || (this.samples[0]?.timestamp ?? sample.timestamp) < cutoff) this.samples.shift();
    return this.trends();
  }

  latest(): PlayerObservation | null { return this.samples.at(-1) ?? null; }
  values(): readonly PlayerObservation[] { return this.samples; }
  clear(): void { this.samples = []; }

  trends(): ObservationTrends {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last) return emptyTrends();
    const dropped = this.samples.map((sample) => sample.droppedFrameRatio).filter((value): value is number => value !== null);
    const frozen = tailStats(this.samples, (sample) => !sample.timeAdvanced && sample.framesAdvanced !== true && !sample.paused);
    const frameFrozen = tailStats(this.samples, (sample) => sample.framesAdvanced === false && !sample.paused);
    const starved = tailStats(this.samples, (sample) => sample.readyState < 2 && (sample.bufferAheadSeconds ?? 0) < 0.5 && !sample.paused);
    return {
      sampleCount: this.samples.length,
      windowMs: last.timestamp - first.timestamp,
      bufferDelta: delta(first.bufferAheadSeconds, last.bufferAheadSeconds),
      seekableStartDelta: delta(first.seekableStart, last.seekableStart),
      liveEdgeDelta: delta(first.liveEdge, last.liveEdge),
      durationDelta: finiteDelta(first.duration, last.duration),
      mediaTimeDelta: last.currentTime - first.currentTime,
      presentedFrameDelta: last.presentedFrames - first.presentedFrames,
      consecutiveFrozenSamples: frozen.count,
      consecutiveFrameFrozenSamples: frameFrozen.count,
      consecutiveStarvedSamples: starved.count,
      frozenDurationMs: frozen.durationMs,
      frameFrozenDurationMs: frameFrozen.durationMs,
      starvedDurationMs: starved.durationMs,
      averageDroppedFrameRatio: dropped.length ? dropped.reduce((total, value) => total + value, 0) / dropped.length : null,
      streamKind: classifyStreamKind(this.samples),
      liveIntent: classifyLiveIntent(this.samples)
    };
  }
}

export function readBufferAhead(video: HTMLVideoElement): number | null {
  try {
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.currentTime >= video.buffered.start(index) - 0.1 && video.currentTime <= video.buffered.end(index) + 0.1) {
        return Math.max(0, video.buffered.end(index) - video.currentTime);
      }
    }
    return 0;
  } catch { return null; }
}

export function readLiveEdge(video: HTMLVideoElement): number | null {
  try {
    if (!video.seekable.length) return null;
    const value = video.seekable.end(video.seekable.length - 1);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

export function readSeekableStart(video: HTMLVideoElement): number | null {
  try {
    if (!video.seekable.length) return null;
    const value = video.seekable.start(0);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

function classifyStreamKind(samples: readonly PlayerObservation[]): StreamKind {
  const last = samples.at(-1);
  if (!last) return "UNKNOWN";
  if (last.duration === Infinity) return "CONFIRMED_LIVE";
  const usable = samples.filter((sample) => sample.liveEdge !== null);
  if (usable.length >= 4) {
    const first = usable[0];
    const elapsedSeconds = Math.max(0, (last.timestamp - first.timestamp) / 1000);
    const liveEdgeDelta = last.liveEdge! - first.liveEdge!;
    const seekableStartDelta = first.seekableStart === null || last.seekableStart === null
      ? null : last.seekableStart - first.seekableStart;
    // A short burst of appended finite media is common for ordinary MSE VOD.
    // Require a meaningful wall-clock observation and a sliding seekable window
    // before granting the stronger DVR_LIVE classification.
    if (elapsedSeconds >= 15 && liveEdgeDelta >= Math.max(2, elapsedSeconds * 0.4)) {
      if ((seekableStartDelta ?? 0) >= Math.max(1, elapsedSeconds * 0.15)) return "DVR_LIVE";
      return "LIKELY_LIVE";
    }
  }
  if (Number.isFinite(last.duration) && last.duration > 0) return "VOD";
  return "UNKNOWN";
}

function classifyLiveIntent(samples: readonly PlayerObservation[]): LiveIntent {
  const last = samples.at(-1);
  if (!last || last.liveEdgeLagSeconds === null) return "UNKNOWN_LIVE_POSITION";
  if (samples.some((sample) => sample.recentBackwardSeek)) return "INTENTIONALLY_BEHIND_LIVE";
  // Retain confirmed follow-live intent while lag develops. Unknown intent is
  // deliberately not promoted; automatic live-edge seeking requires positive
  // evidence that the viewer had recently been at the live edge.
  return samples.some((sample) => sample.liveEdgeLagSeconds !== null && sample.liveEdgeLagSeconds <= 10)
    ? "FOLLOWING_LIVE" : "UNKNOWN_LIVE_POSITION";
}

function delta(first: number | null, last: number | null): number | null {
  return first === null || last === null ? null : last - first;
}

function finiteDelta(first: number, last: number): number | null {
  return Number.isFinite(first) && Number.isFinite(last) ? last - first : null;
}

function tailStats(samples: readonly PlayerObservation[], matches: (sample: PlayerObservation) => boolean): { count: number; durationMs: number } {
  const last = samples.at(-1);
  if (!last || !matches(last)) return { count: 0, durationMs: 0 };
  let count = 0;
  let earliest = last.timestamp;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (!matches(sample)) break;
    count += 1;
    earliest = sample.timestamp;
  }
  return { count, durationMs: Math.max(0, last.timestamp - earliest) };
}

function emptyTrends(): ObservationTrends {
  return {
    sampleCount: 0, windowMs: 0, bufferDelta: null, seekableStartDelta: null, liveEdgeDelta: null, durationDelta: null, mediaTimeDelta: 0,
    presentedFrameDelta: 0, consecutiveFrozenSamples: 0, consecutiveFrameFrozenSamples: 0, consecutiveStarvedSamples: 0,
    frozenDurationMs: 0, frameFrozenDurationMs: 0, starvedDurationMs: 0,
    averageDroppedFrameRatio: null, streamKind: "UNKNOWN", liveIntent: "UNKNOWN_LIVE_POSITION"
  };
}
