import test from "node:test";
import assert from "node:assert/strict";
import {
  RecoveryCoordinator, actionLimit, emptyRecoveryStore, type ActionBudget, type RecoveryLedgerStore,
  type RecoveryPersistence
} from "../../src/background/recovery-coordinator";
import type { RecoveryAction } from "../../src/shared/types";

class MemoryPersistence implements RecoveryPersistence {
  value: RecoveryLedgerStore = emptyRecoveryStore();
  async load(): Promise<RecoveryLedgerStore> { return structuredClone(this.value); }
  async save(store: RecoveryLedgerStore): Promise<void> { this.value = structuredClone(store); }
}

const owner = { tabId: 7, frameId: 2, navigationId: "navigation-1", candidateId: "candidate-1", candidateEpoch: 1 };
const budget: ActionBudget = { windowMs: 10 * 60_000, perActionLimit: 2, maxCycleActions: 5 };

function create(now = 1_000) {
  const persistence = new MemoryPersistence();
  let clock = now;
  let sequence = 0;
  const coordinator = new RecoveryCoordinator(persistence, () => clock, () => `id-${++sequence}`);
  return { coordinator, persistence, setNow: (value: number) => { clock = value; } };
}

async function authorize(coordinator: RecoveryCoordinator, cycleId: string, action: RecoveryAction = "PLAY", customBudget = budget) {
  return coordinator.authorize({
    ...owner, cycleId, origin: "https://example.com", pageUrl: "https://example.com/live?token=secret",
    ownerPageUrlKey: "owner-page-binding", action, failureKind: "DECODE_FREEZE", countdownSeconds: 5,
    budget: customBudget
  });
}

test("one-use authorization permits exactly one action commit", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-1");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  const first = await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  const duplicate = await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  assert.equal(first.allowed, true);
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.duplicate, true);
});

test("concurrent commit retries still consume a nonce once", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-race");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  const results = await Promise.all([
    coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget),
    coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget)
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
});

test("terminal outcomes are recorded exactly once", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-terminal");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  const first = await coordinator.complete(7, token.cycleId, token.actionId, token.authorizationNonce, true, 250);
  const duplicate = await coordinator.complete(7, token.cycleId, token.actionId, token.authorizationNonce, false, 500);
  assert.equal(first.recorded, true);
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.action?.success, true);
});

test("an uncommitted authorization cannot be completed as an action outcome", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-not-initiated", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  const result = await coordinator.complete(
    7, token.cycleId, token.actionId, token.authorizationNonce, false, 0, "premature result"
  );
  assert.equal(result.recorded, false);
  assert.equal((await coordinator.getAction(7, token.cycleId, token.actionId))?.state, "COUNTDOWN");
});

test("a disappearing executor expires its committed action exactly once", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-lost-executor");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  setNow(4_000);
  const first = await coordinator.expireCommittedForOwner(7, {
    frameId: owner.frameId, navigationId: owner.navigationId,
    candidateId: owner.candidateId, candidateEpoch: owner.candidateEpoch
  }, "Player frame disappeared");
  const duplicate = await coordinator.expireCommittedForOwner(7, { frameId: owner.frameId }, "Repeated reconciliation");
  const lateCompletion = await coordinator.complete(7, token.cycleId, token.actionId, token.authorizationNonce, true, 5_000);
  assert.equal(first.length, 1);
  assert.equal(first[0].origin, "https://example.com");
  assert.equal(first[0].action.state, "EXPIRED");
  assert.equal(first[0].action.success, false);
  assert.equal(first[0].action.durationMs, 3_000);
  assert.equal(duplicate.length, 0);
  assert.equal(lateCompletion.recorded, false);
  assert.equal(lateCompletion.duplicate, true);
  assert.equal((await coordinator.getCycle(7, token.cycleId))?.state, "EXPIRED");
});

test("executor reconciliation is bound to the exact player identity", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-owner-binding");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  assert.deepEqual(await coordinator.expireCommittedForOwner(7, { frameId: owner.frameId, candidateEpoch: 99 }, "Wrong owner"), []);
  assert.equal((await coordinator.getAction(7, token.cycleId, token.actionId))?.state, "INITIATED");
});

test("rediscover can adopt a freshly elected replacement candidate in the same frame", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-rediscover", "REDISCOVER");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  assert.equal(await coordinator.adoptReplacementCandidate({
    ...owner, candidateId: "candidate-2", candidateEpoch: 2,
    cycleId: token.cycleId, origin: "https://example.com", elected: true
  }), "ADOPTED");
  assert.equal((await coordinator.getAction(7, token.cycleId, token.actionId))?.candidateId, "candidate-2");
  assert.equal((await coordinator.getCycle(7, token.cycleId))?.candidateEpoch, 2);
  assert.equal((await coordinator.complete(
    7, token.cycleId, token.actionId, token.authorizationNonce, true, 1_000
  )).recorded, true);
});

test("retry can wait through temporary candidate absence but unrelated actions cannot transfer", async () => {
  const { coordinator } = create();
  const retry = await authorize(coordinator, "cycle-retry-replacement", "RETRY_BUTTON");
  assert.equal(retry.authorized, true);
  if (!retry.authorized) return;
  await coordinator.commit(7, retry.authorization.cycleId, retry.authorization.actionId,
    retry.authorization.authorizationNonce, budget);
  assert.equal(await coordinator.adoptReplacementCandidate({
    ...owner, candidateId: "", candidateEpoch: 2, cycleId: retry.authorization.cycleId,
    origin: "https://example.com", elected: false
  }), "WAITING");
  assert.equal((await coordinator.getAction(7, retry.authorization.cycleId, retry.authorization.actionId))?.state, "INITIATED");

  const otherCoordinator = create().coordinator;
  const play = await authorize(otherCoordinator, "cycle-play-no-transfer", "PLAY");
  assert.equal(play.authorized, true);
  if (!play.authorized) return;
  await otherCoordinator.commit(7, play.authorization.cycleId, play.authorization.actionId,
    play.authorization.authorizationNonce, budget);
  assert.equal(await otherCoordinator.adoptReplacementCandidate({
    ...owner, candidateId: "candidate-2", candidateEpoch: 2, cycleId: play.authorization.cycleId,
    origin: "https://example.com", elected: true
  }), "REJECTED");
});

test("deadline reconciliation emits one failed outcome for committed non-page actions", async () => {
  const { coordinator, setNow } = create();
  const shortBudget: ActionBudget = { ...budget, executionTimeoutMs: 2_000 };
  const authorized = await authorize(coordinator, "cycle-deadline", "PLAY", shortBudget);
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  const committed = await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, shortBudget);
  assert.equal(committed.action?.expiresAt, 3_000);
  assert.equal((await coordinator.getPendingActions()).length, 1);
  setNow(2_999);
  assert.deepEqual(await coordinator.reconcileExpired(7, token.actionId), []);
  setNow(3_000);
  const first = await coordinator.reconcileExpired(7, token.actionId);
  const duplicate = await coordinator.reconcileExpired(7, token.actionId);
  assert.equal(first.length, 1);
  assert.equal(first[0].action.terminalReason, "Recovery executor did not report a result before its deadline");
  assert.equal(duplicate.length, 0);
  assert.equal((await coordinator.getPendingActions()).length, 0);
});

test("unconsumed authorizations expire without a failed action outcome", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-unused");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  setNow(authorized.authorization.expiresAt);
  assert.deepEqual(await coordinator.reconcileExpired(7, authorized.authorization.actionId), []);
  assert.equal((await coordinator.getAction(7, authorized.authorization.cycleId, authorized.authorization.actionId))?.state, "EXPIRED");
});

test("page reload ignores old-owner disappearance but expires at its verification deadline", async () => {
  const { coordinator, setNow } = create();
  const shortBudget: ActionBudget = { ...budget, executionTimeoutMs: 2_000 };
  const authorized = await authorize(coordinator, "cycle-page-owner", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.acknowledgeCountdownDisplay(7, token.cycleId, token.actionId, token.authorizationNonce, 0);
  setNow(token.countdownDeadline!);
  const committed = await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, shortBudget);
  assert.deepEqual(await coordinator.expireCommittedForOwner(7, { frameId: owner.frameId }, "Frame navigated"), []);
  assert.equal((await coordinator.getAction(7, token.cycleId, token.actionId))?.state, "INITIATED");
  setNow(committed.action!.expiresAt);
  const expired = await coordinator.reconcileExpired(7, token.actionId);
  assert.equal(expired.length, 1);
  assert.match(expired[0].action.terminalReason ?? "", /did not verify recovery/i);
  assert.deepEqual(await coordinator.reconcileExpired(7, token.actionId), []);
});

test("rolling per-action budgets survive separate recovery cycles", async () => {
  const { coordinator } = create();
  const oneAttempt: ActionBudget = { ...budget, perActionLimit: 1 };
  const first = await authorize(coordinator, "cycle-a", "PLAY", oneAttempt);
  assert.equal(first.authorized, true);
  if (!first.authorized) return;
  await coordinator.commit(7, first.authorization.cycleId, first.authorization.actionId, first.authorization.authorizationNonce, oneAttempt);
  await coordinator.complete(7, first.authorization.cycleId, first.authorization.actionId, first.authorization.authorizationNonce, false, 10);
  const second = await authorize(coordinator, "cycle-b", "PLAY", oneAttempt);
  assert.equal(second.authorized, false);
  if (!second.authorized) assert.match(second.error, /budget exhausted/i);
});

test("sustained playback can explicitly clear rolling action budgets", async () => {
  const { coordinator } = create();
  const oneAttempt: ActionBudget = { ...budget, perActionLimit: 1 };
  const first = await authorize(coordinator, "cycle-before-health", "PLAY", oneAttempt);
  assert.equal(first.authorized, true);
  if (!first.authorized) return;
  await coordinator.commit(7, first.authorization.cycleId, first.authorization.actionId, first.authorization.authorizationNonce, oneAttempt);
  await coordinator.complete(7, first.authorization.cycleId, first.authorization.actionId, first.authorization.authorizationNonce, true, 10);
  await coordinator.clearBudgets(7);
  const afterHealth = await authorize(coordinator, "cycle-after-health", "PLAY", oneAttempt);
  assert.equal(afterHealth.authorized, true);
});

test("a committed page reload resumes the same transaction after a redirect", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-redirect", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  await coordinator.acknowledgeCountdownDisplay(
    7, authorized.authorization.cycleId, authorized.authorization.actionId,
    authorized.authorization.authorizationNonce, 0
  );
  setNow(6_000);
  await coordinator.commit(7, authorized.authorization.cycleId, authorized.authorization.actionId, authorized.authorization.authorizationNonce, budget);
  setNow(7_000);
  const resumed = await coordinator.resume(7, owner.frameId, "https://example.com", "owner-page-binding", "navigation-2");
  await coordinator.adoptPageReloadOwner({
    ...owner, navigationId: "navigation-2", cycleId: "cycle-redirect",
    origin: "https://example.com", pageUrl: "https://example.com/canonical?new=1",
    pageUrlBindingKey: "owner-page-binding"
  });
  const cycle = await coordinator.getCycle(7, "cycle-redirect");
  assert.equal(resumed?.cycleId, "cycle-redirect");
  assert.deepEqual(cycle?.urlChain, ["https://example.com/live", "https://example.com/canonical"]);
  assert.deepEqual(cycle?.navigationIds, ["navigation-1", "navigation-2"]);
});

test("page reload resume is provisional until the elected replacement frame adopts it", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-frame-bound", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  await coordinator.acknowledgeCountdownDisplay(
    7, authorized.authorization.cycleId, authorized.authorization.actionId,
    authorized.authorization.authorizationNonce, 0
  );
  setNow(6_000);
  await coordinator.commit(7, authorized.authorization.cycleId, authorized.authorization.actionId,
    authorized.authorization.authorizationNonce, budget);
  setNow(7_000);
  assert.equal((await coordinator.resume(
    7, owner.frameId + 1, "https://example.com", "owner-page-binding", "navigation-2"
  ))?.cycleId, "cycle-frame-bound");
  assert.deepEqual((await coordinator.getCycle(7, "cycle-frame-bound"))?.navigationIds, ["navigation-1"]);
  assert.equal(await coordinator.adoptPageReloadOwner({
    tabId: 7, frameId: owner.frameId + 1, navigationId: "navigation-2", candidateId: "candidate-2",
    candidateEpoch: 1, cycleId: "cycle-frame-bound", origin: "https://example.com",
    pageUrl: "https://example.com/live", pageUrlBindingKey: "owner-page-binding"
  }), true);
  const cycle = await coordinator.getCycle(7, "cycle-frame-bound");
  assert.equal(cycle?.ownerFrameId, owner.frameId + 1);
  assert.equal(cycle?.actions[authorized.authorization.actionId].ownerFrameId, owner.frameId + 1);
  assert.deepEqual(cycle?.navigationIds, ["navigation-1", "navigation-2"]);
});

test("page reload cannot resume or be adopted on another exact page binding", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-page-binding", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.acknowledgeCountdownDisplay(7, token.cycleId, token.actionId, token.authorizationNonce, 0);
  setNow(token.countdownDeadline!);
  await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  assert.equal(await coordinator.resume(7, 3, "https://example.com", "another-page-binding", "navigation-2"), null);
  assert.equal(await coordinator.adoptPageReloadOwner({
    tabId: 7, frameId: 3, navigationId: "navigation-2", candidateId: "candidate-2", candidateEpoch: 1,
    cycleId: token.cycleId, origin: "https://example.com", pageUrl: "https://example.com/other",
    pageUrlBindingKey: "another-page-binding"
  }), false);
});

test("page reload cannot commit before its acknowledged visible deadline", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-visible-deadline", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  assert.equal((await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget)).allowed, false);
  await coordinator.acknowledgeCountdownDisplay(7, token.cycleId, token.actionId, token.authorizationNonce, 0);
  setNow(token.countdownDeadline! - 1);
  assert.equal((await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget)).allowed, false);
  setNow(token.countdownDeadline!);
  assert.equal((await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget)).allowed, true);
});

test("one tab cannot hold nonterminal actions from simultaneous recovery cycles", async () => {
  const { coordinator } = create();
  const first = await authorize(coordinator, "cycle-only-one", "PAGE_RELOAD");
  assert.equal(first.authorized, true);
  const second = await authorize(coordinator, "cycle-conflict", "PLAY");
  assert.equal(second.authorized, false);
  if (!second.authorized) assert.match(second.error, /another recovery action/i);
});

test("page reload authorization persists its bound top-level URL key", async () => {
  const { coordinator } = create();
  const result = await coordinator.authorize({
    ...owner, cycleId: "cycle-url-bound", origin: "https://example.com",
    pageUrl: "https://player.example.com/live", topLevelUrlKey: "https://example.com/watch",
    ownerPageUrlKey: "owner-page-binding",
    action: "PAGE_RELOAD", failureKind: "DECODE_FREEZE", countdownSeconds: 5, budget
  });
  assert.equal(result.authorized, true);
  if (!result.authorized) return;
  const action = await coordinator.getAction(7, result.authorization.cycleId, result.authorization.actionId);
  assert.equal(action?.topLevelUrlKey, "https://example.com/watch");
});

test("canceling a countdown makes its token permanently unusable", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-cancel", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.cancelCurrent(7, "viewer canceled", {
    cycleId: token.cycleId, actionId: token.actionId, authorizationNonce: token.authorizationNonce
  });
  const committed = await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  assert.equal(committed.allowed, false);
  assert.equal(committed.duplicate, true);
});

test("a stale watchdog cannot cancel a concurrently extended countdown", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-extend-race", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  const originalDeadline = token.countdownDeadline!;
  const extended = await coordinator.extendCountdown(7, 30, {
    cycleId: token.cycleId, actionId: token.actionId, authorizationNonce: token.authorizationNonce
  });
  assert.ok(extended?.countdownDeadline && extended.countdownDeadline > originalDeadline);
  assert.equal(await coordinator.cancelCurrent(7, "stale watchdog", {
    cycleId: token.cycleId, actionId: token.actionId, authorizationNonce: token.authorizationNonce,
    countdownDeadline: originalDeadline
  }), null);
  assert.equal((await coordinator.getCountdown(7))?.countdownDeadline, extended?.countdownDeadline);
});

test("cancel cannot acknowledge success after a page reload action is initiated", async () => {
  const { coordinator, setNow } = create();
  const authorized = await authorize(coordinator, "cycle-initiated-cancel", "PAGE_RELOAD");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.acknowledgeCountdownDisplay(7, token.cycleId, token.actionId, token.authorizationNonce, 0);
  setNow(token.countdownDeadline!);
  assert.equal((await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget)).allowed, true);
  assert.equal(await coordinator.cancelCurrent(7, "too late", {
    cycleId: token.cycleId, actionId: token.actionId, authorizationNonce: token.authorizationNonce
  }), null);
  assert.equal((await coordinator.getAction(7, token.cycleId, token.actionId))?.state, "INITIATED");
});

test("viewer reset refuses to erase a committed recovery transaction", async () => {
  const { coordinator } = create();
  const authorized = await authorize(coordinator, "cycle-reset-race", "PLAY");
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const token = authorized.authorization;
  await coordinator.commit(7, token.cycleId, token.actionId, token.authorizationNonce, budget);
  assert.deepEqual(await coordinator.resetTab(7), { reset: false, canceled: [] });
  assert.equal((await coordinator.getAction(7, token.cycleId, token.actionId))?.state, "INITIATED");
});

test("riskier actions receive stricter rolling limits", () => {
  assert.equal(actionLimit("PAGE_RELOAD", 3, 8), 3);
  assert.equal(actionLimit("MEDIA_RELOAD", 3, 8), 2);
  assert.equal(actionLimit("BACKUP_HANDOFF", 3, 8), 1);
  assert.equal(actionLimit("PLAY", 3, 8), 3);
});
