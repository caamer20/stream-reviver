import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_FRESHNESS_MS, PRIMARY_CHALLENGER_DWELL_MS, PRIMARY_LEASE_MS, PrimaryLeaseRegistry } from "../../src/background/primary-lease";
import { healthyDiagnosis } from "../../src/shared/diagnosis";
import type { FrameStatus } from "../../src/shared/types";

function status(score: number, updatedAt: number, candidateId: string, navigationId = "navigation", candidateEpoch = 1): FrameStatus {
  return {
    state: "HEALTHY", detail: "healthy", pageUrl: "https://example.com/live", origin: "https://example.com",
    hasVideo: true, score, confidence: 0, evidence: [], selectedVideoLabel: candidateId,
    diagnosis: healthyDiagnosis(updatedAt), streamKind: "CONFIRMED_LIVE", liveIntent: "FOLLOWING_LIVE",
    liveEdgeLagSeconds: 1, bufferAheadSeconds: 5, recoveryCycleId: null, circuitState: "CLOSED",
    compatibility: {
      htmlVideo: true, crossFrame: false, frameCallbacks: true, playbackQuality: true, liveEdge: true,
      pictureInPicture: true, fullscreen: true, wakeLock: true, protocolBridge: false, visualWatchdog: false,
      playerType: "HTML5", level: "FULL", limitations: []
    },
    recoveryAction: null, nextActionAt: null, online: true, pageVisible: true, frameToken: `frame-${candidateId}`,
    navigationId, candidateId, candidateEpoch, updatedAt
  };
}

test("the first eligible player receives the tab recovery lease", () => {
  const registry = new PrimaryLeaseRegistry();
  const result = registry.report(7, 0, status(100, 1_000, "main"), 1_000);
  assert.equal(result.isOwner, true);
  assert.equal(result.lease?.frameId, 0);
  assert.equal(registry.owns(7, 0, "navigation", "main", 1, 1_001), true);
});

test("a challenger cannot steal recovery authority before its dwell period", () => {
  const registry = new PrimaryLeaseRegistry();
  registry.report(7, 0, status(100, 1_000, "main"), 1_000);
  const early = registry.report(7, 4, status(140, 1_100, "ad"), 1_100);
  assert.equal(early.isOwner, false);
  assert.equal(registry.get(7, 1_100)?.frameId, 0);
});

test("a stable decisive challenger can replace a stale-looking primary candidate", () => {
  const registry = new PrimaryLeaseRegistry();
  registry.report(7, 0, status(100, 1_000, "main"), 1_000);
  registry.report(7, 4, status(140, 1_100, "replacement"), 1_100);
  const later = registry.report(7, 4, status(140, 1_100 + PRIMARY_CHALLENGER_DWELL_MS, "replacement"), 1_100 + PRIMARY_CHALLENGER_DWELL_MS);
  assert.equal(later.isOwner, true);
  assert.equal(later.lease?.frameId, 4);
});

test("candidate replacement invalidates the former lease identity", () => {
  const registry = new PrimaryLeaseRegistry();
  registry.report(7, 0, status(100, 1_000, "first", "navigation", 1), 1_000);
  registry.report(7, 0, status(100, 2_000, "second", "navigation", 2), 2_000);
  assert.equal(registry.owns(7, 0, "navigation", "first", 1, 2_000), false);
  assert.equal(registry.owns(7, 0, "navigation", "second", 2, 2_000), true);
});

test("a stale owner report cannot retain recovery authority", () => {
  const registry = new PrimaryLeaseRegistry();
  registry.report(7, 0, status(100, 1_000, "main"), 1_000);
  assert.equal(registry.get(7, 1_000 + FRAME_FRESHNESS_MS + 1), null);
});

test("an unrenewed lease expires before a merely cached frame report", () => {
  const registry = new PrimaryLeaseRegistry();
  registry.report(7, 0, status(100, 1_000, "main"), 1_000);
  assert.ok(PRIMARY_LEASE_MS < FRAME_FRESHNESS_MS);
  assert.equal(registry.get(7, 1_000 + PRIMARY_LEASE_MS + 1), null);
});
