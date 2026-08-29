import test from "node:test";
import assert from "node:assert/strict";
import { assessVideoHealth, type HealthSnapshot } from "../src/shared/health";

const base: HealthSnapshot = {
  explicitError: false, withinGrace: false, online: true, hidden: false, paused: false, userPaused: false,
  ended: false, timeAdvanced: false, framesAdvanced: null, readyState: 1, networkState: 2,
  stalledForMs: 13_000, frameStalledForMs: 13_000, stallTimeoutMs: 12_000, waitingEvents: 2,
  liveEdgeLagSeconds: null, droppedFrameRatio: null
};

test("advancing playback is healthy", () => {
  const result = assessVideoHealth({ ...base, timeAdvanced: true, framesAdvanced: true, readyState: 4, waitingEvents: 0, stalledForMs: 0 });
  assert.equal(result.state, "healthy"); assert.equal(result.confidence, 0);
});
test("a user-paused video suppresses recovery", () => { assert.equal(assessVideoHealth({ ...base, paused: true, userPaused: true }).state, "paused"); });
test("multiple sustained stall signals cross the threshold", () => {
  const result = assessVideoHealth(base); assert.equal(result.state, "suspected"); assert.ok(result.confidence >= 65);
  assert.deepEqual(result.evidence.map((item) => item.signal), ["time-stalled", "not-ready", "repeated-waiting"]);
});
test("brief buffering remains monitoring", () => {
  const result = assessVideoHealth({ ...base, stalledForMs: 4_000, frameStalledForMs: 4_000, waitingEvents: 1 });
  assert.equal(result.state, "monitoring"); assert.ok(result.confidence < 65);
});
test("the grace period wins over early errors", () => { assert.equal(assessVideoHealth({ ...base, explicitError: true, withinGrace: true }).state, "monitoring"); });
test("offline state pauses recovery", () => {
  const result = assessVideoHealth({ ...base, online: false }); assert.equal(result.state, "offline"); assert.equal(result.confidence, 0);
});
test("an ended live video is suspected down", () => { assert.equal(assessVideoHealth({ ...base, paused: true, ended: true, waitingEvents: 0 }).state, "suspected"); });
test("frozen presented frames are detected while media time advances", () => {
  const result = assessVideoHealth({ ...base, timeAdvanced: true, framesAdvanced: false, readyState: 4, stalledForMs: 0, waitingEvents: 0 });
  assert.equal(result.state, "suspected"); assert.ok(result.evidence.some((item) => item.signal === "frames-frozen"));
});
test("explicit errors have maximum confidence", () => {
  const result = assessVideoHealth({ ...base, explicitError: true, errorDetail: "decoder failed" });
  assert.equal(result.confidence, 100); assert.equal(result.detail, "decoder failed");
});
