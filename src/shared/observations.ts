import type { LiveIntent, ProtocolObservation, StreamKind } from "./types";

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
  liveEdge: number | null;
  liveEdgeLagSeconds: number | null;
  waitingEvents: number;
  explicitError: string;
  online: boolean;
  hidden: boolean;
  userPaused: boolean;
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
  liveEdgeDelta: number | null;
  mediaTimeDelta: number;
  presentedFrameDelta: number;
  consecutiveFrozenSamples: number;
  consecutiveFrameFrozenSamples: number;
  consecutiveStarvedSamples: number;
  averageDroppedFrameRatio: number | null;
  streamKind: StreamKind;
  liveIntent: LiveIntent;
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
    let frozen = 0;
    let frameFrozen = 0;
    let starved = 0;
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      const sample = this.samples[index];
      if (!sample.timeAdvanced && sample.framesAdvanced !== true && !sample.paused) frozen += 1; else break;
    }
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      const sample = this.samples[index];
      if (sample.framesAdvanced === false && !sample.paused) frameFrozen += 1; else break;
    }
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      const sample = this.samples[index];
      if (sample.readyState < 2 && (sample.bufferAheadSeconds ?? 0) < 0.5 && !sample.paused) starved += 1; else break;
    }
    return {
      sampleCount: this.samples.length,
      windowMs: last.timestamp - first.timestamp,
      bufferDelta: delta(first.bufferAheadSeconds, last.bufferAheadSeconds),
      liveEdgeDelta: delta(first.liveEdge, last.liveEdge),
      mediaTimeDelta: last.currentTime - first.currentTime,
      presentedFrameDelta: last.presentedFrames - first.presentedFrames,
      consecutiveFrozenSamples: frozen,
      consecutiveFrameFrozenSamples: frameFrozen,
      consecutiveStarvedSamples: starved,
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

function classifyStreamKind(samples: readonly PlayerObservation[]): StreamKind {
  const last = samples.at(-1);
  if (!last) return "UNKNOWN";
  if (last.duration === Infinity) return "CONFIRMED_LIVE";
  const usable = samples.filter((sample) => sample.liveEdge !== null);
  if (usable.length >= 3) {
    const first = usable[0].liveEdge!;
    const latest = usable.at(-1)!.liveEdge!;
    if (latest - first >= 1) return Number.isFinite(last.duration) && last.duration > 0 ? "DVR_LIVE" : "LIKELY_LIVE";
  }
  if (Number.isFinite(last.duration) && last.duration > 0) return "VOD";
  return "UNKNOWN";
}

function classifyLiveIntent(samples: readonly PlayerObservation[]): LiveIntent {
  const last = samples.at(-1);
  if (!last || last.liveEdgeLagSeconds === null) return "UNKNOWN_LIVE_POSITION";
  if (last.recentBackwardSeek) return "INTENTIONALLY_BEHIND_LIVE";
  return last.liveEdgeLagSeconds <= 10 ? "FOLLOWING_LIVE" : "UNKNOWN_LIVE_POSITION";
}

function delta(first: number | null, last: number | null): number | null {
  return first === null || last === null ? null : last - first;
}

function emptyTrends(): ObservationTrends {
  return {
    sampleCount: 0, windowMs: 0, bufferDelta: null, liveEdgeDelta: null, mediaTimeDelta: 0,
    presentedFrameDelta: 0, consecutiveFrozenSamples: 0, consecutiveFrameFrozenSamples: 0, consecutiveStarvedSamples: 0,
    averageDroppedFrameRatio: null, streamKind: "UNKNOWN", liveIntent: "UNKNOWN_LIVE_POSITION"
  };
}
