import test from "node:test";
import assert from "node:assert/strict";
import {
  decideVisualSampleAccess,
  mapVisualCrop,
  MIN_VISUAL_SAMPLE_INTERVAL_MS,
  perceptualVisualHash,
  VISUAL_HASH_HEX_LENGTH,
  type VisualSampleAccessInput
} from "../../src/background/visual-watchdog";

const allowed: VisualSampleAccessInput = {
  frameId: 0,
  senderActive: true,
  tabActive: true,
  pageVisible: true,
  disclaimerAcknowledged: true,
  visualPrivacyAcknowledged: true,
  globalEnabled: true,
  siteEnabled: true,
  featureEnabled: true,
  urlEnabled: true,
  exactOriginPermission: true,
  primaryOwner: true,
  originMatchesOwner: true,
  pageMatchesOwner: true,
  inFlight: false,
  lastSampleAt: null,
  now: 100_000,
  intervalMs: 10_000
};

test("visual access is granted only when every sensitive-capture precondition holds", () => {
  assert.deepEqual(decideVisualSampleAccess(allowed), { ok: true });
});

for (const [field, value] of [
  ["frameId", 1],
  ["senderActive", false],
  ["tabActive", false],
  ["pageVisible", false],
  ["disclaimerAcknowledged", false],
  ["visualPrivacyAcknowledged", false],
  ["globalEnabled", false],
  ["siteEnabled", false],
  ["featureEnabled", false],
  ["urlEnabled", false],
  ["exactOriginPermission", false],
  ["primaryOwner", false],
  ["originMatchesOwner", false],
  ["pageMatchesOwner", false]
] as const) {
  test(`visual access fails closed when ${field} is invalid`, () => {
    assert.equal(decideVisualSampleAccess({ ...allowed, [field]: value }).ok, false);
  });
}

test("visual access rejects concurrent and too-frequent samples", () => {
  assert.deepEqual(decideVisualSampleAccess({ ...allowed, inFlight: true }), {
    ok: false, unavailable: true, error: "A visual sample is already in progress."
  });
  assert.equal(decideVisualSampleAccess({ ...allowed, lastSampleAt: 95_001 }).ok, false);
  assert.equal(decideVisualSampleAccess({ ...allowed, lastSampleAt: 90_000 }).ok, true);
});

test("visual access enforces a five-second floor even for an invalid shorter interval", () => {
  assert.equal(decideVisualSampleAccess({ ...allowed, intervalMs: 1, lastSampleAt: allowed.now - MIN_VISUAL_SAMPLE_INTERVAL_MS + 1 }).ok, false);
  assert.equal(decideVisualSampleAccess({ ...allowed, intervalMs: Number.NaN, lastSampleAt: allowed.now - MIN_VISUAL_SAMPLE_INTERVAL_MS }).ok, true);
});

test("crop mapping converts top-level CSS coordinates to capture pixels", () => {
  assert.deepEqual(mapVisualCrop(
    { x: 10, y: 20, width: 30, height: 40 },
    { width: 100, height: 100 },
    200,
    400
  ), { x: 20, y: 80, width: 60, height: 160 });
});

test("crop mapping clips to the viewport and rejects unsafe geometry", () => {
  assert.deepEqual(mapVisualCrop(
    { x: -10, y: -20, width: 50, height: 60 },
    { width: 100, height: 100 },
    200,
    400
  ), { x: 0, y: 0, width: 80, height: 160 });
  assert.equal(mapVisualCrop({ x: 0, y: 0, width: 15, height: 100 }, { width: 100, height: 100 }, 100, 100), null);
  assert.equal(mapVisualCrop({ x: 200, y: 0, width: 100, height: 100 }, { width: 100, height: 100 }, 100, 100), null);
  assert.equal(mapVisualCrop({ x: Number.NaN, y: 0, width: 100, height: 100 }, { width: 100, height: 100 }, 100, 100), null);
  assert.equal(mapVisualCrop({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 100 }, 100, 100), null);
});

test("perceptual visual hash is deterministic and fixed to 64 bits", () => {
  const pixels = new Uint8ClampedArray(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel += 1) {
    const value = pixel < 32 ? 0 : 255;
    pixels[pixel * 4] = value;
    pixels[pixel * 4 + 1] = value;
    pixels[pixel * 4 + 2] = value;
    pixels[pixel * 4 + 3] = 255;
  }
  const hash = perceptualVisualHash(pixels);
  assert.equal(hash, "00000000ffffffff");
  assert.equal(hash?.length, VISUAL_HASH_HEX_LENGTH);
  assert.match(hash ?? "", /^[0-9a-f]{16}$/);
  assert.equal(perceptualVisualHash(new Uint8ClampedArray(7)), null);
});
