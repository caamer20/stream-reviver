import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackSessionMetrics } from "../../src/shared/session-metrics";

test("startup measures first progress rather than the later reporting deadline", () => {
  const metrics = new PlaybackSessionMetrics(1_000);
  metrics.progress(2_250);
  assert.deepEqual(metrics.snapshot(122_250), { startupMs: 1_250, rebufferMs: 0, playbackStarted: true });
});

test("rebuffer time sums event intervals without including healthy or paused time", () => {
  const metrics = new PlaybackSessionMetrics(0);
  metrics.progress(500);
  metrics.buffering(2_000);
  metrics.progress(3_250);
  metrics.buffering(8_000);
  metrics.suspend(8_400);
  assert.deepEqual(metrics.snapshot(20_000), { startupMs: 500, rebufferMs: 1_650, playbackStarted: true });
});

test("pre-start waiting and duplicate events cannot inflate metrics", () => {
  const metrics = new PlaybackSessionMetrics(1_000);
  metrics.buffering(1_100);
  metrics.buffering(1_200);
  assert.deepEqual(metrics.snapshot(2_000), { startupMs: 0, rebufferMs: 0, playbackStarted: false });
  metrics.progress(2_500);
  metrics.buffering(3_000);
  metrics.buffering(3_500);
  assert.equal(metrics.snapshot(4_000).rebufferMs, 1_000);
});

test("clock regressions are clamped to zero", () => {
  const metrics = new PlaybackSessionMetrics(5_000);
  metrics.progress(4_000);
  metrics.buffering(8_000);
  metrics.finishBuffering(7_000);
  assert.deepEqual(metrics.snapshot(9_000), { startupMs: 0, rebufferMs: 0, playbackStarted: true });
});
