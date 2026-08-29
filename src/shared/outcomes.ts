import type { ActionOutcome, FailureKind, HealthSample, LocalSiteModel, RecoveryAction } from "./types";

export function emptySiteModel(origin: string): LocalSiteModel {
  return { origin, sampleCount: 0, sessionCount: 0, startupAverageMs: 0, rebufferAverageMs: 0, liveLagAverageSeconds: 0, falseAlarms: 0, correctRecoveries: 0, actionOutcomes: {}, updatedAt: Date.now() };
}

export function addActionOutcome(model: LocalSiteModel, outcome: ActionOutcome): LocalSiteModel {
  const next = structuredClone(model);
  const current = next.actionOutcomes[outcome.action] ?? { successes: 0, failures: 0, averageDurationMs: 0 };
  const attempts = current.successes + current.failures;
  if (outcome.success) current.successes += 1; else current.failures += 1;
  current.averageDurationMs = attempts === 0 ? outcome.durationMs : (current.averageDurationMs * attempts + outcome.durationMs) / (attempts + 1);
  next.actionOutcomes[outcome.action] = current;
  next.sampleCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function addUserFeedback(model: LocalSiteModel, correct: boolean, _kind: FailureKind): LocalSiteModel {
  const next = structuredClone(model);
  if (correct) next.correctRecoveries += 1; else next.falseAlarms += 1;
  next.sampleCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function addHealthSample(model: LocalSiteModel, sample: HealthSample): LocalSiteModel {
  const next = structuredClone(model);
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
  const next = structuredClone(model);
  next.sessionCount += 1;
  next.updatedAt = Date.now();
  return next;
}

export function preferredAction(model: LocalSiteModel, allowed: RecoveryAction[]): RecoveryAction | null {
  return [...allowed].sort((a, b) => rate(model, b) - rate(model, a))[0] ?? null;
}
function rate(model: LocalSiteModel, action: RecoveryAction): number {
  const value = model.actionOutcomes[action]; return value ? (value.successes + 1) / (value.successes + value.failures + 2) : 0.5;
}
function rollingAverage(previous: number, value: number, count: number, maximum: number): number {
  const safe = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, maximum));
  return count === 0 ? safe : (previous * count + safe) / (count + 1);
}
