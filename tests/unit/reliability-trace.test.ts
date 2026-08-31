import test from "node:test";
import assert from "node:assert/strict";
import { ReliabilityTraceBuffer, replayReliabilityTrace, type ReliabilityTraceEvent } from "../../src/shared/reliability-trace";

function event(sequence: number, kind: ReliabilityTraceEvent["event"], patch: Partial<ReliabilityTraceEvent> = {}): ReliabilityTraceEvent {
  return {
    version: 1, sequence, timestamp: 1_000 + sequence, monotonicMs: sequence * 10,
    sessionId: "session", tabSessionId: "tab", frameChain: ["top"], navigationId: "nav",
    candidateFingerprint: "candidate", event: kind, failureKind: "DECODE_FREEZE", confidence: 90,
    recoverySafe: true, isPrimaryOwner: true, cycleId: "cycle", actionId: "action",
    actionNonce: "nonce", action: "PLAY", signalSource: "ISOLATED_MEDIA", decision: kind,
    cancellationReason: null, ...patch
  };
}

test("valid exactly-once action traces replay without violations", () => {
  const result = replayReliabilityTrace([
    event(1, "ACTION_AUTHORIZED"), event(2, "ACTION_COMMITTED"), event(3, "ACTION_SUCCEEDED")
  ]);
  assert.deepEqual(result.violations, []);
  assert.equal(result.committedActions, 1);
  assert.equal(result.terminalActions, 1);
});

test("replay detects non-primary, duplicate, canceled, and protected reload mutations", () => {
  const trace = [
    event(1, "ACTION_AUTHORIZED", { isPrimaryOwner: false, action: "PAGE_RELOAD", failureKind: "USER_PAUSED" }),
    event(2, "ACTION_CANCELED", { action: "PAGE_RELOAD", failureKind: "USER_PAUSED" }),
    event(3, "ACTION_COMMITTED", { action: "PAGE_RELOAD", failureKind: "USER_PAUSED" }),
    event(4, "ACTION_COMMITTED", { action: "PAGE_RELOAD", failureKind: "USER_PAUSED" }),
    event(5, "ACTION_FAILED", { action: "PAGE_RELOAD", failureKind: "USER_PAUSED" }),
    event(6, "ACTION_SUCCEEDED", { action: "PAGE_RELOAD", failureKind: "USER_PAUSED" })
  ];
  const violations = replayReliabilityTrace(trace).violations.join("\n");
  assert.match(violations, /authorized-by-non-primary/);
  assert.match(violations, /committed-after-cancel/);
  assert.match(violations, /committed-twice/);
  assert.match(violations, /reload-for-protected-state/);
  assert.match(violations, /multiple-terminal-results/);
});

test("trace recorder is bounded and does not accept browsing-content fields", () => {
  const buffer = new ReliabilityTraceBuffer(20);
  for (let index = 0; index < 30; index += 1) {
    const { version: _version, sequence: _sequence, ...value } = event(index + 1, "OBSERVATION", {
      actionId: null, actionNonce: null, action: null, cycleId: null
    });
    buffer.append(value);
  }
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.length, 20);
  assert.equal(snapshot[0].sequence, 11);
  assert.equal("url" in snapshot[0], false);
  assert.equal("selector" in snapshot[0], false);
});

test("trace replay rejects unsupported schema versions", () => {
  assert.throws(() => replayReliabilityTrace([{ ...event(1, "OBSERVATION"), version: 2 as 1 }]), /Unsupported/);
});
