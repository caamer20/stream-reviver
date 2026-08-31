import type { ActionOutcome, FailureKind, HealthSample, LocalSiteModel, RecoveryAction } from "./types";

export function emptySiteModel(origin: string): LocalSiteModel {
  return {
    origin, sampleCount: 0, sessionCount: 0, startupAverageMs: 0, rebufferAverageMs: 0,
    liveLagAverageSeconds: 0, falseAlarms: 0, correctRecoveries: 0, actionOutcomes: {},
    actionOutcomesByFailure: {}, feedbackByFailure: {}, updatedAt: Date.now()
  };
}

export function addActionOutcome(model: LocalSiteModel, outcome: ActionOutcome): LocalSiteModel {
  const next = upgradeSiteModel(model);
  next.actionOutcomes[outcome.action] = updateOutcomeSummary(next.actionOutcomes[outcome.action], outcome);
  const scoped = next.actionOutcomesByFailure[outcome.failureKind] ?? {};
  scoped[outcome.action] = updateOutcomeSummary(scoped[outcome.action], outcome);
  next.actionOutcomesByFailure[outcome.failureKind] = scoped;
  next.sampleCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function addUserFeedback(model: LocalSiteModel, correct: boolean, kind: FailureKind): LocalSiteModel {
  const next = upgradeSiteModel(model);
  if (correct) next.correctRecoveries += 1; else next.falseAlarms += 1;
  const scoped = next.feedbackByFailure[kind] ?? { correct: 0, falseAlarms: 0 };
  if (correct) scoped.correct += 1; else scoped.falseAlarms += 1;
  next.feedbackByFailure[kind] = scoped;
  next.sampleCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function addHealthSample(model: LocalSiteModel, sample: HealthSample): LocalSiteModel {
  const next = upgradeSiteModel(model);
  // A session is registered when content starts, before its health summary is
  // written, so exclude the current session from the previous-sample count.
  const count = Math.max(0, next.sessionCount - 1);
  next.startupAverageMs = rollingAverage(next.startupAverageMs, sample.startupMs, count, 24 * 60 * 60_000);
  next.rebufferAverageMs = rollingAverage(next.rebufferAverageMs, sample.rebufferMs, count, 24 * 60 * 60_000);
  if (sample.liveLagSeconds !== null && Number.isFinite(sample.liveLagSeconds)) {
    next.liveLagAverageSeconds = rollingAverage(next.liveLagAverageSeconds, sample.liveLagSeconds, count, 24 * 60 * 60);
  }
  next.sampleCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function addSession(model: LocalSiteModel): LocalSiteModel {
  const next = upgradeSiteModel(model);
  next.sessionCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function preferredAction(model: LocalSiteModel, allowed: RecoveryAction[], failureKind?: FailureKind): RecoveryAction | null {
  return [...allowed].sort((a, b) => rate(model, b, failureKind) - rate(model, a, failureKind))[0] ?? null;
}

export function contextualOutcomeCount(model: LocalSiteModel, failureKind: FailureKind, actions?: RecoveryAction[]): number {
  const scoped = model.actionOutcomesByFailure?.[failureKind] ?? {};
  const selected = actions ?? Object.keys(scoped) as RecoveryAction[];
  return selected.reduce((total, action) => {
    const value = scoped[action];
    return total + (value?.successes ?? 0) + (value?.failures ?? 0);
  }, 0);
}

export function contextualSuccessRate(model: LocalSiteModel, failureKind: FailureKind, action: RecoveryAction): number {
  return rate(model, action, failureKind);
}

function rate(model: LocalSiteModel, action: RecoveryAction, failureKind?: FailureKind): number {
  const value = failureKind ? model.actionOutcomesByFailure?.[failureKind]?.[action] : model.actionOutcomes[action];
  return value ? (value.successes + 1) / (value.successes + value.failures + 2) : 0.5;
}
function rollingAverage(previous: number, value: number, count: number, maximum: number): number {
  const safe = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, maximum));
  return count === 0 ? safe : (previous * count + safe) / (count + 1);
}

function updateOutcomeSummary(current: LocalSiteModel["actionOutcomes"][RecoveryAction] | undefined, outcome: ActionOutcome) {
  const next = current ? { ...current } : { successes: 0, failures: 0, averageDurationMs: 0 };
  const attempts = next.successes + next.failures;
  if (outcome.success) next.successes += 1; else next.failures += 1;
  const duration = Math.max(0, Number.isFinite(outcome.durationMs) ? outcome.durationMs : 0);
  next.averageDurationMs = attempts === 0 ? duration : (next.averageDurationMs * attempts + duration) / (attempts + 1);
  return next;
}

/** Older persisted models are upgraded lazily without discarding local data. */
function upgradeSiteModel(model: LocalSiteModel): LocalSiteModel {
  const next = structuredClone(model) as LocalSiteModel;
  next.actionOutcomes ??= {};
  next.actionOutcomesByFailure ??= {};
  next.feedbackByFailure ??= {};
  return next;
}
