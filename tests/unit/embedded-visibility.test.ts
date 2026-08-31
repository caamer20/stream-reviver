import test from "node:test";
import assert from "node:assert/strict";
import { PrimaryLeaseRegistry } from "../../src/background/primary-lease";
import {
  diagnoseEmbeddedVisibility,
  type EmbeddedFrameObservation
} from "../../src/content/embedded-visibility";
import { healthyDiagnosis } from "../../src/shared/diagnosis";
import type { FrameStatus } from "../../src/shared/types";

function frame(
  source: string | null,
  overrides: Partial<EmbeddedFrameObservation> = {}
): EmbeddedFrameObservation {
  return {
    source,
    identity: "main embed",
    rendered: true,
    visibleWidth: 640,
    visibleHeight: 360,
    opaque: false,
    sensitive: false,
    ...overrides
  };
}

test("reports one possible embedded player using only its origin", () => {
  const diagnostic = diagnoseEmbeddedVisibility("https://host.example", [
    frame("https://player.example/watch/private-stream?token=secret#viewer")
  ]);

  assert.equal(diagnostic?.origin, "https://player.example");
  assert.equal(diagnostic?.originCount, 1);
  assert.match(diagnostic?.detail ?? "", /may contain a player/i);
  assert.match(diagnostic?.detail ?? "", /separately in Settings/i);
  assert.doesNotMatch(diagnostic?.detail ?? "", /watch|private-stream|token|secret|viewer/i);
});

test("does not choose or reveal an origin when multiple plausible origins exist", () => {
  const diagnostic = diagnoseEmbeddedVisibility("https://host.example", [
    frame("https://one.example/live/alpha?viewer=one"),
    frame("https://two.example/live/beta?viewer=two")
  ]);

  assert.equal(diagnostic?.origin, null);
  assert.equal(diagnostic?.originCount, 2);
  assert.match(diagnostic?.detail ?? "", /Multiple .* embedded frames are inaccessible/i);
  assert.doesNotMatch(diagnostic?.detail ?? "", /one\.example|two\.example|alpha|beta/i);
});

test("deduplicates multiple plausible frames from the same origin", () => {
  const diagnostic = diagnoseEmbeddedVisibility("https://host.example", [
    frame("https://player.example/channel/one"),
    frame("https://player.example/channel/two")
  ]);

  assert.equal(diagnostic?.origin, "https://player.example");
  assert.equal(diagnostic?.originCount, 1);
});

test("ignores same-origin, hidden, tiny, opaque, and access-sensitive frames", () => {
  const frames = [
    frame("https://host.example/embed"),
    frame("/relative/embed"),
    frame("https://hidden.example/embed", { rendered: false }),
    frame("https://narrow.example/embed", { visibleWidth: 239 }),
    frame("https://short.example/embed", { visibleHeight: 134 }),
    frame("https://small-area.example/embed", { visibleWidth: 240, visibleHeight: 135 }),
    frame("https://opaque.example/embed", { opaque: true }),
    frame("https://controlled.example/embed", { sensitive: true })
  ];

  assert.equal(diagnoseEmbeddedVisibility("https://host.example", frames), null);
});

test("ignores ad-like, authentication, credential-bearing, and non-HTTP sources", () => {
  const frames = [
    frame("https://ads.example/banner/slot"),
    frame("https://widgets.example/embed", { identity: "Advertisement" }),
    frame("https://accounts.example/login?continue=%2Fvideo"),
    frame("https://widgets.example/%6cogin/prompt"),
    frame("https://user:password@player.example/embed"),
    frame("data:text/html,<video></video>"),
    frame("javascript:void(0)"),
    frame("blob:https://player.example/id"),
    frame("about:blank"),
    frame("not a valid URL with spaces")
  ];

  assert.equal(diagnoseEmbeddedVisibility("https://host.example", frames), null);
});

test("fails closed for a non-HTTP top-level origin", () => {
  assert.equal(diagnoseEmbeddedVisibility("file:///tmp/page.html", [frame("https://player.example/embed")]), null);
});

test("a healthy permitted child player retains authority over a top-frame visibility advisory", () => {
  const registry = new PrimaryLeaseRegistry();
  const now = 50_000;
  const topAdvisory = status({
    state: "LIMITED_VISIBILITY", detail: "Possible inaccessible embedded player",
    hasVideo: false, score: 0, candidateId: "", selectedVideoLabel: ""
  }, now);
  const healthyChild = status({
    state: "HEALTHY", detail: "Playback is advancing",
    hasVideo: true, score: 250_000, candidateId: "child-player", selectedVideoLabel: "HTML5 video"
  }, now);

  registry.report(9, 0, topAdvisory, now);
  const childElection = registry.report(9, 4, healthyChild, now);
  assert.equal(childElection.isOwner, true);
  assert.equal(registry.ownerStatus(9, now)?.state, "HEALTHY");

  registry.report(9, 0, { ...topAdvisory, updatedAt: now + 1 }, now + 1);
  assert.equal(registry.ownerStatus(9, now + 1)?.candidateId, "child-player");
  assert.equal(registry.ownerStatus(9, now + 1)?.state, "HEALTHY");
});

function status(
  overrides: Pick<FrameStatus, "state" | "detail" | "hasVideo" | "score" | "candidateId" | "selectedVideoLabel">,
  updatedAt: number
): FrameStatus {
  return {
    ...overrides,
    pageUrl: "https://host.example/watch",
    origin: "https://host.example",
    confidence: 0,
    evidence: [],
    diagnosis: healthyDiagnosis(updatedAt),
    streamKind: overrides.hasVideo ? "CONFIRMED_LIVE" : "UNKNOWN",
    liveIntent: overrides.hasVideo ? "FOLLOWING_LIVE" : "UNKNOWN_LIVE_POSITION",
    liveEdgeLagSeconds: null,
    bufferAheadSeconds: null,
    recoveryCycleId: null,
    circuitState: "CLOSED",
    compatibility: {
      htmlVideo: overrides.hasVideo, crossFrame: false, frameCallbacks: overrides.hasVideo,
      playbackQuality: overrides.hasVideo, liveEdge: overrides.hasVideo, pictureInPicture: overrides.hasVideo,
      fullscreen: overrides.hasVideo, wakeLock: true, protocolBridge: false, visualWatchdog: false,
      playerType: overrides.hasVideo ? "HTML5" : "AUTO",
      level: overrides.hasVideo ? "FULL" : "RESTRICTED",
      limitations: []
    },
    recoveryAction: null,
    nextActionAt: null,
    online: true,
    pageVisible: true,
    frameToken: overrides.hasVideo ? "child-frame" : "top-frame",
    navigationId: "navigation",
    candidateEpoch: overrides.hasVideo ? 1 : 0,
    updatedAt
  };
}
