import type { FailureKind, RecoveryAction } from "./types";

export const RELIABILITY_TRACE_VERSION = 1;

export type TraceEventKind =
  | "OBSERVATION"
  | "DIAGNOSIS"
  | "POLICY_DECISION"
  | "ACTION_AUTHORIZED"
  | "ACTION_COMMITTED"
  | "ACTION_SUCCEEDED"
  | "ACTION_FAILED"
  | "ACTION_CANCELED";

export type TraceSignalSource = "ISOLATED_MEDIA" | "PAGE_WORLD" | "CONFIGURED_SELECTOR" | "VISUAL" | "LIFECYCLE";

export interface ReliabilityTraceEvent {
  version: 1;
  sequence: number;
  timestamp: number;
  monotonicMs: number;
  sessionId: string;
  tabSessionId: string;
  frameChain: string[];
  navigationId: string;
  candidateFingerprint: string;
  event: TraceEventKind;
  failureKind: FailureKind;
  confidence: number;
  recoverySafe: boolean;
  isPrimaryOwner: boolean;
  cycleId: string | null;
  actionId: string | null;
  actionNonce: string | null;
  action: RecoveryAction | null;
  signalSource: TraceSignalSource | null;
  decision: string;
  cancellationReason: string | null;
}

export interface TraceReplayResult {
  eventCount: number;
  authorizedActions: number;
  committedActions: number;
  terminalActions: number;
  finalFailureKind: FailureKind;
  violations: string[];
}

/** Bounded in-memory recorder. It deliberately accepts no URL, selector,
 * media title, DOM text, or screenshot field, keeping traces useful without
 * turning them into a browsing-history log. */
export class ReliabilityTraceBuffer {
  private events: ReliabilityTraceEvent[] = [];
  private sequence = 0;

  constructor(private readonly limit = 500) {
    if (!Number.isInteger(limit) || limit < 20 || limit > 5_000) throw new RangeError("Trace limit must be between 20 and 5000");
  }

  append(event: Omit<ReliabilityTraceEvent, "version" | "sequence">): ReliabilityTraceEvent {
    const normalized = normalizeTraceEvent({ ...event, version: RELIABILITY_TRACE_VERSION, sequence: ++this.sequence });
    this.events.push(normalized);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return structuredClone(normalized);
  }

  snapshot(): ReliabilityTraceEvent[] { return structuredClone(this.events); }
  clear(): void { this.events = []; }
}

/** Replays authorization invariants without executing page mutations. This is
 * used by deterministic fixtures and redacted support traces. */
export function replayReliabilityTrace(input: ReliabilityTraceEvent[]): TraceReplayResult {
  const events = input.map(normalizeTraceEvent).sort((a, b) => a.sequence - b.sequence);
  const violations: string[] = [];
  const actions = new Map<string, { authorized: boolean; committed: boolean; terminal: boolean; canceled: boolean; nonce: string | null }>();
  let lastSequence = -1;
  let lastMonotonic = -Infinity;
  let finalFailureKind: FailureKind = "NONE";

  for (const item of events) {
    if (item.sequence <= lastSequence) violations.push(`sequence:${item.sequence}:not-strictly-increasing`);
    if (item.monotonicMs < lastMonotonic) violations.push(`sequence:${item.sequence}:monotonic-clock-regressed`);
    lastSequence = item.sequence;
    lastMonotonic = item.monotonicMs;
    finalFailureKind = item.failureKind;
    if (!item.actionId) continue;
    const action = actions.get(item.actionId) ?? { authorized: false, committed: false, terminal: false, canceled: false, nonce: item.actionNonce };
    if (action.nonce !== item.actionNonce) violations.push(`action:${item.actionId}:nonce-changed`);
    if (item.event === "ACTION_AUTHORIZED") {
      if (!item.isPrimaryOwner) violations.push(`action:${item.actionId}:authorized-by-non-primary`);
      if (action.authorized) violations.push(`action:${item.actionId}:authorized-twice`);
      action.authorized = true;
    } else if (item.event === "ACTION_COMMITTED") {
      if (!action.authorized) violations.push(`action:${item.actionId}:committed-without-authorization`);
      if (!item.isPrimaryOwner) violations.push(`action:${item.actionId}:committed-by-non-primary`);
      if (action.committed) violations.push(`action:${item.actionId}:committed-twice`);
      if (action.canceled) violations.push(`action:${item.actionId}:committed-after-cancel`);
      if (item.action === "PAGE_RELOAD" && isProtectedFailure(item.failureKind)) {
        violations.push(`action:${item.actionId}:reload-for-protected-state`);
      }
      action.committed = true;
    } else if (["ACTION_SUCCEEDED", "ACTION_FAILED", "ACTION_CANCELED"].includes(item.event)) {
      if (action.terminal) violations.push(`action:${item.actionId}:multiple-terminal-results`);
      if (item.event !== "ACTION_CANCELED" && !action.committed) violations.push(`action:${item.actionId}:terminal-without-commit`);
      action.terminal = true;
      action.canceled = item.event === "ACTION_CANCELED";
    }
    actions.set(item.actionId, action);
  }

  return {
    eventCount: events.length,
    authorizedActions: [...actions.values()].filter((value) => value.authorized).length,
    committedActions: [...actions.values()].filter((value) => value.committed).length,
    terminalActions: [...actions.values()].filter((value) => value.terminal).length,
    finalFailureKind,
    violations
  };
}

export function normalizeTraceEvent(value: ReliabilityTraceEvent): ReliabilityTraceEvent {
  if (value.version !== RELIABILITY_TRACE_VERSION) throw new TypeError("Unsupported reliability trace version");
  return {
    ...value,
    sequence: boundedInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER),
    timestamp: boundedNumber(value.timestamp, 0, Number.MAX_SAFE_INTEGER),
    monotonicMs: boundedNumber(value.monotonicMs, 0, Number.MAX_SAFE_INTEGER),
    sessionId: boundedText(value.sessionId, 100),
    tabSessionId: boundedText(value.tabSessionId, 100),
    frameChain: value.frameChain.slice(0, 10).map((item) => boundedText(item, 100)),
    navigationId: boundedText(value.navigationId, 100),
    candidateFingerprint: boundedText(value.candidateFingerprint, 160),
    confidence: boundedNumber(value.confidence, 0, 100),
    cycleId: nullableText(value.cycleId, 100),
    actionId: nullableText(value.actionId, 100),
    actionNonce: nullableText(value.actionNonce, 100),
    decision: boundedText(value.decision, 500),
    cancellationReason: nullableText(value.cancellationReason, 500)
  };
}

function isProtectedFailure(kind: FailureKind): boolean {
  return ["NONE", "STARTUP_DELAY", "USER_PAUSED", "AUTOPLAY_BLOCKED", "NETWORK_OFFLINE", "ACCESS_INTERRUPTION", "TAB_SUSPENDED", "BROWSER_RESUMED"].includes(kind);
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Trace text field is invalid");
  return value.slice(0, maximum);
}
function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : boundedText(value, maximum);
}
function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Trace numeric field is invalid");
  return Math.min(maximum, Math.max(minimum, value));
}
function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  return Math.floor(boundedNumber(value, minimum, maximum));
}
