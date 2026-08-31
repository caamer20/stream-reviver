import test from "node:test";
import assert from "node:assert/strict";
import {
  computeClippedAreaRatio, FRAME_ROUTE_STALE_MS, isFrameRouteFresh, type RectBounds
} from "../../src/content/frame-coordinator";

function rect(left: number, top: number, width: number, height: number): RectBounds {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

test("frame visibility uses the visible fraction of the player rather than viewport share", () => {
  const smallButFullyVisible = rect(20, 20, 320, 180);
  assert.equal(computeClippedAreaRatio(smallButFullyVisible, [rect(0, 0, 1920, 1080)]), 1);
});

test("frame visibility compounds viewport and clipping-ancestor intersections", () => {
  const frame = rect(0, 0, 400, 200);
  const viewport = rect(0, 0, 300, 200);
  const clippingAncestor = rect(100, 0, 300, 100);
  // Final intersection is x=100..300 and y=0..100 => 20,000/80,000.
  assert.equal(computeClippedAreaRatio(frame, [viewport, clippingAncestor]), 0.25);
});

test("frame visibility returns zero for fully clipped or zero-area frames", () => {
  assert.equal(computeClippedAreaRatio(rect(500, 500, 100, 100), [rect(0, 0, 200, 200)]), 0);
  assert.equal(computeClippedAreaRatio(rect(0, 0, 0, 100), [rect(0, 0, 200, 200)]), 0);
});

test("frame routes expire deterministically and disconnected routes fail closed", () => {
  const now = 100_000;
  assert.equal(isFrameRouteFresh(now - FRAME_ROUTE_STALE_MS, true, now), true);
  assert.equal(isFrameRouteFresh(now - FRAME_ROUTE_STALE_MS - 1, true, now), false);
  assert.equal(isFrameRouteFresh(now, false, now), false);
  assert.equal(isFrameRouteFresh(now + 1, true, now), false);
});
