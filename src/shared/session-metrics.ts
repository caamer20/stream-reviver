/**
 * Tracks user-visible startup and rebuffer time from playback events rather
 * than from the later success-reset/reporting deadline.
 */
export class PlaybackSessionMetrics {
  private firstProgressAt: number | null = null;
  private bufferingSince: number | null = null;
  private accumulatedRebufferMs = 0;

  constructor(private readonly pageStartedAt: number) {}

  progress(now: number): void {
    if (this.firstProgressAt === null) this.firstProgressAt = now;
    this.finishBuffering(now);
  }

  buffering(now: number): void {
    if (this.firstProgressAt === null || this.bufferingSince !== null) return;
    this.bufferingSince = now;
  }

  finishBuffering(now: number): void {
    if (this.bufferingSince === null) return;
    this.accumulatedRebufferMs += Math.max(0, now - this.bufferingSince);
    this.bufferingSince = null;
  }

  /** Ends an interval caused by a pause/end without counting paused time. */
  suspend(now: number): void { this.finishBuffering(now); }

  snapshot(now: number): { startupMs: number; rebufferMs: number; playbackStarted: boolean } {
    const liveBuffer = this.bufferingSince === null ? 0 : Math.max(0, now - this.bufferingSince);
    return {
      startupMs: this.firstProgressAt === null ? 0 : Math.max(0, this.firstProgressAt - this.pageStartedAt),
      rebufferMs: this.accumulatedRebufferMs + liveBuffer,
      playbackStarted: this.firstProgressAt !== null
    };
  }
}
