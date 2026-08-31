import { loopUrlKey } from "../shared/loop-policy";
import type { FailureKind, RecoveryAction } from "../shared/types";

export const RECOVERY_LEDGER_VERSION = 4;
export const RECOVERY_RESUME_WINDOW_MS = 2 * 60_000;
export const ACTION_AUTHORIZATION_TTL_MS = 60_000;
export const ACTION_EXECUTION_TTL_MS = 3 * 60_000;

export type RecoveryCycleState = "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELED" | "EXPIRED";
export type RecoveryActionState = "AUTHORIZED" | "COUNTDOWN" | "INITIATED" | "SUCCEEDED" | "FAILED" | "CANCELED" | "EXPIRED";
export type ReplacementAdoption = "ADOPTED" | "WAITING" | "REJECTED";

export interface RecoveryActionRecord {
  id: string;
  cycleId: string;
  action: RecoveryAction;
  authorizationNonce: string;
  ownerFrameId: number;
  navigationId: string;
  candidateId: string;
  candidateEpoch: number;
  topLevelUrlKey: string;
  ownerPageUrlKey: string;
  displayFrameId: number | null;
  authorizedAt: number;
  expiresAt: number;
  countdownDeadline: number | null;
  state: RecoveryActionState;
  committedAt: number | null;
  terminalAt: number | null;
  success: boolean | null;
  durationMs: number | null;
  failureKind: FailureKind;
  terminalReason: string | null;
}

export interface RecoveryCycleRecord {
  id: string;
  tabId: number;
  origin: string;
  ownerFrameId: number;
  navigationIds: string[];
  candidateId: string;
  candidateEpoch: number;
  initialUrlKey: string;
  currentUrlKey: string;
  urlChain: string[];
  failureKind: FailureKind;
  state: RecoveryCycleState;
  createdAt: number;
  updatedAt: number;
  terminalAt: number | null;
  terminalReason: string | null;
  actions: Record<string, RecoveryActionRecord>;
  activeActionId: string | null;
}

export interface RecoveryTabRecord {
  cycles: Record<string, RecoveryCycleRecord>;
  actionAttempts: Partial<Record<RecoveryAction, number[]>>;
}

export interface RecoveryLedgerStore {
  version: number;
  tabs: Record<string, RecoveryTabRecord>;
}

export interface RecoveryPersistence {
  load(): Promise<RecoveryLedgerStore>;
  save(store: RecoveryLedgerStore): Promise<void>;
}

export interface ActionBudget {
  windowMs: number;
  perActionLimit: number;
  maxCycleActions: number;
  /** Longest time a committed DOM action may wait for its executor to report
   * a terminal result. The default intentionally covers the longest built-in
   * playback-verification period plus scheduling jitter. */
  executionTimeoutMs?: number;
}

export interface RecoveryOwner {
  tabId: number;
  frameId: number;
  navigationId: string;
  candidateId: string;
  candidateEpoch: number;
}

export interface RecoveryAuthorization extends RecoveryOwner {
  cycleId: string;
  actionId: string;
  authorizationNonce: string;
  action: RecoveryAction;
  authorizedAt: number;
  expiresAt: number;
  countdownDeadline: number | null;
}

export interface ResumeRecovery {
  cycleId: string;
  failureKind: FailureKind;
  action: RecoveryAction;
  actionId: string;
  authorizationNonce: string;
  startedAt: number;
}

export interface ExpiredRecoveryAction {
  tabId: number;
  origin: string;
  action: RecoveryActionRecord;
}

export interface RecoveryOwnerMatch {
  frameId?: number;
  navigationId?: string;
  candidateId?: string;
  candidateEpoch?: number;
}

/** Durable, serialized recovery ledger. All one-use nonce and budget changes
 * happen inside one storage transaction queue so content-script retries and
 * alarm/content countdown races cannot execute an action twice. */
export class RecoveryCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: RecoveryPersistence,
    private readonly now: () => number = () => Date.now(),
    private readonly makeId: () => string = randomId
  ) {}

  async resume(tabId: number, _frameId: number, origin: string, pageUrlBindingKey: string, _navigationId: string): Promise<ResumeRecovery | null> {
    return this.transact((store, now) => {
      const tab = store.tabs[String(tabId)];
      if (!tab) return null;
      const cycles = Object.values(tab.cycles).sort((a, b) => b.updatedAt - a.updatedAt);
      for (const cycle of cycles) {
        if (cycle.state !== "ACTIVE" || cycle.origin !== origin) continue;
        const action = cycle.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
        if (!action || action.action !== "PAGE_RELOAD" || action.state !== "INITIATED" ||
          !pageUrlBindingKey || action.ownerPageUrlKey !== pageUrlBindingKey || action.committedAt === null ||
          now - action.committedAt > RECOVERY_RESUME_WINDOW_MS) {
          if (now - cycle.updatedAt > RECOVERY_RESUME_WINDOW_MS) {
            if (action && !isActionTerminal(action.state)) expireAction(action, now, "Recovery context expired");
            expireCycle(cycle, now, "Recovery context expired");
          }
          continue;
        }
        return {
          cycleId: cycle.id, failureKind: action.failureKind, action: action.action,
          actionId: action.id, authorizationNonce: action.authorizationNonce,
          startedAt: action.committedAt
        };
      }
      return null;
    });
  }

  /** Transfers a committed page-reload transaction to the freshly elected
   * post-navigation primary. Callers must perform the tab-wide election first;
   * provisional GET_CONTEXT callers cannot mutate ownership. */
  async adoptPageReloadOwner(input: RecoveryOwner & {
    cycleId: string;
    origin: string;
    pageUrl: string;
    pageUrlBindingKey: string;
  }): Promise<boolean> {
    return this.transact((store, now) => {
      const cycle = store.tabs[String(input.tabId)]?.cycles[input.cycleId];
      const action = cycle?.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
      if (!cycle || cycle.state !== "ACTIVE" || cycle.origin !== input.origin || !action ||
        action.action !== "PAGE_RELOAD" || action.state !== "INITIATED" || action.committedAt === null ||
        now - action.committedAt > RECOVERY_RESUME_WINDOW_MS || !input.pageUrlBindingKey ||
        action.ownerPageUrlKey !== input.pageUrlBindingKey) return false;
      const currentKey = loopUrlKey(input.pageUrl);
      cycle.ownerFrameId = input.frameId;
      cycle.candidateId = input.candidateId;
      cycle.candidateEpoch = input.candidateEpoch;
      if (!cycle.navigationIds.includes(input.navigationId)) cycle.navigationIds.push(input.navigationId);
      cycle.currentUrlKey = currentKey;
      if (cycle.urlChain[cycle.urlChain.length - 1] !== currentKey) cycle.urlChain.push(currentKey);
      cycle.updatedAt = now;
      action.ownerFrameId = input.frameId;
      return true;
    });
  }

  /** Allows only recovery actions whose documented effect may replace the
   * selected player to follow a freshly elected candidate in the same frame
   * and document. Temporary candidate absence waits for the durable execution
   * deadline instead of being misreported as an immediate action failure. */
  async adoptReplacementCandidate(input: RecoveryOwner & {
    cycleId: string;
    origin: string;
    elected: boolean;
  }): Promise<ReplacementAdoption> {
    return this.transact((store, now) => {
      const cycle = store.tabs[String(input.tabId)]?.cycles[input.cycleId];
      const action = cycle?.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
      if (!cycle || cycle.state !== "ACTIVE" || cycle.origin !== input.origin || !action ||
        action.state !== "INITIATED" || !allowsReplacementCandidate(action.action) ||
        action.ownerFrameId !== input.frameId || action.navigationId !== input.navigationId ||
        action.expiresAt <= now) return "REJECTED";
      if (!input.elected || !input.candidateId) return "WAITING";
      action.candidateId = input.candidateId;
      action.candidateEpoch = input.candidateEpoch;
      cycle.ownerFrameId = input.frameId;
      cycle.candidateId = input.candidateId;
      cycle.candidateEpoch = input.candidateEpoch;
      cycle.updatedAt = now;
      return "ADOPTED";
    });
  }

  async authorize(input: RecoveryOwner & {
    cycleId: string;
    origin: string;
    pageUrl: string;
    action: RecoveryAction;
    failureKind: FailureKind;
    countdownSeconds: number;
    budget: ActionBudget;
    topLevelUrlKey?: string;
    ownerPageUrlKey: string;
  }): Promise<{ authorized: true; authorization: RecoveryAuthorization } | { authorized: false; error: string; terminal?: boolean }> {
    return this.transact((store, now) => {
      const tab = getTab(store, input.tabId);
      pruneAttempts(tab, now, input.budget.windowMs);
      for (const existingCycle of Object.values(tab.cycles)) {
        if (existingCycle.state !== "ACTIVE" || !existingCycle.activeActionId) continue;
        const existingAction = existingCycle.actions[existingCycle.activeActionId];
        if (!existingAction || isActionTerminal(existingAction.state)) continue;
        if (existingAction.expiresAt <= now && existingAction.state !== "INITIATED") {
          expireAction(existingAction, now, "Recovery authorization expired before a new cycle started");
          expireCycle(existingCycle, now, "Recovery authorization expired before a new cycle started");
          continue;
        }
        if (existingCycle.id !== input.cycleId) {
          return { authorized: false as const, error: "Another recovery action is already pending in this tab" };
        }
      }
      let cycle = tab.cycles[input.cycleId];
      const currentKey = loopUrlKey(input.pageUrl);
      if (!cycle) {
        cycle = tab.cycles[input.cycleId] = {
          id: input.cycleId, tabId: input.tabId, origin: input.origin, ownerFrameId: input.frameId,
          navigationIds: [input.navigationId], candidateId: input.candidateId, candidateEpoch: input.candidateEpoch,
          initialUrlKey: currentKey, currentUrlKey: currentKey, urlChain: [currentKey], failureKind: input.failureKind,
          state: "ACTIVE", createdAt: now, updatedAt: now, terminalAt: null, terminalReason: null,
          actions: {}, activeActionId: null
        };
      }
      if (cycle.state !== "ACTIVE") return { authorized: false as const, error: `Recovery cycle is ${cycle.state.toLowerCase()}`, terminal: true };
      if (cycle.origin !== input.origin) return { authorized: false as const, error: "Recovery cycle origin changed" };
      if (cycle.ownerFrameId !== input.frameId || cycle.candidateId !== input.candidateId || cycle.candidateEpoch !== input.candidateEpoch) {
        return { authorized: false as const, error: "Primary-player ownership changed" };
      }
      if (!cycle.navigationIds.includes(input.navigationId)) cycle.navigationIds.push(input.navigationId);
      cycle.currentUrlKey = currentKey;
      if (cycle.urlChain[cycle.urlChain.length - 1] !== currentKey) cycle.urlChain.push(currentKey);

      const active = cycle.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
      if (active && !isActionTerminal(active.state)) {
        if (active.expiresAt <= now && active.state !== "INITIATED") {
          expireAction(active, now, "Authorization expired before execution");
          cycle.activeActionId = null;
        } else return { authorized: false as const, error: "Another recovery action is already pending" };
      }
      const committedCount = Object.values(cycle.actions).filter((action) => action.committedAt !== null).length;
      if (committedCount >= input.budget.maxCycleActions) {
        failCycle(cycle, now, "Recovery-cycle action budget exhausted");
        return { authorized: false as const, error: "Recovery-cycle action budget exhausted", terminal: true };
      }
      const attempts = tab.actionAttempts[input.action] ?? [];
      if (attempts.length >= input.budget.perActionLimit) {
        return { authorized: false as const, error: `${input.action} rolling action budget exhausted` };
      }

      const actionId = this.makeId();
      const authorizationNonce = this.makeId();
      const countdownDeadline = input.action === "PAGE_RELOAD" ? now + input.countdownSeconds * 1000 : null;
      const action: RecoveryActionRecord = {
        id: actionId, cycleId: cycle.id, action: input.action, authorizationNonce,
        ownerFrameId: input.frameId, navigationId: input.navigationId, candidateId: input.candidateId,
        candidateEpoch: input.candidateEpoch, topLevelUrlKey: input.topLevelUrlKey ?? "",
        ownerPageUrlKey: input.ownerPageUrlKey, displayFrameId: null,
        authorizedAt: now,
        expiresAt: countdownDeadline === null ? now + ACTION_AUTHORIZATION_TTL_MS : countdownDeadline + ACTION_AUTHORIZATION_TTL_MS,
        countdownDeadline, state: countdownDeadline === null ? "AUTHORIZED" : "COUNTDOWN",
        committedAt: null, terminalAt: null, success: null, durationMs: null,
        failureKind: input.failureKind, terminalReason: null
      };
      cycle.actions[actionId] = action;
      cycle.activeActionId = actionId;
      cycle.updatedAt = now;
      trimCycles(tab, now);
      return { authorized: true as const, authorization: toAuthorization(input.tabId, action) };
    });
  }

  async commit(tabId: number, cycleId: string, actionId: string, authorizationNonce: string, budget: ActionBudget): Promise<{
    allowed: boolean; action?: RecoveryActionRecord; duplicate?: boolean; error?: string;
  }> {
    return this.transact((store, now) => {
      const tab = store.tabs[String(tabId)];
      const cycle = tab?.cycles[cycleId];
      const action = cycle?.actions[actionId];
      if (!tab || !cycle || !action || action.authorizationNonce !== authorizationNonce) return { allowed: false, error: "Unknown recovery authorization" };
      if (action.state === "INITIATED" || isActionTerminal(action.state)) {
        return { allowed: false, duplicate: true, error: "Recovery authorization was already consumed" };
      }
      if (cycle.state !== "ACTIVE") return { allowed: false, error: `Recovery cycle is ${cycle.state.toLowerCase()}` };
      if (action.expiresAt <= now) {
        expireAction(action, now, "Recovery authorization expired");
        expireCycle(cycle, now, "Recovery authorization expired");
        return { allowed: false, error: "Recovery authorization expired" };
      }
      if (action.action === "PAGE_RELOAD") {
        if (action.displayFrameId === null) return { allowed: false, error: "No visible countdown acknowledged this reload" };
        if (action.countdownDeadline === null || now < action.countdownDeadline) {
          return { allowed: false, error: "The visible reload countdown is still active" };
        }
      }
      pruneAttempts(tab, now, budget.windowMs);
      const committedCount = Object.values(cycle.actions).filter((item) => item.committedAt !== null).length;
      if (committedCount >= budget.maxCycleActions) return { allowed: false, error: "Recovery-cycle action budget exhausted" };
      const attempts = tab.actionAttempts[action.action] ?? [];
      if (attempts.length >= budget.perActionLimit) return { allowed: false, error: `${action.action} rolling action budget exhausted` };
      attempts.push(now);
      tab.actionAttempts[action.action] = attempts;
      action.state = "INITIATED";
      action.committedAt = now;
      action.expiresAt = now + Math.max(1_000, budget.executionTimeoutMs ?? ACTION_EXECUTION_TTL_MS);
      cycle.updatedAt = now;
      return { allowed: true, action: structuredClone(action) };
    });
  }

  /** Atomically expires committed, content-executed actions bound to an owner
   * that no longer exists. A late completion then observes a terminal action
   * and is rejected as a duplicate, so failure telemetry is counted once. */
  async expireCommittedForOwner(tabId: number, owner: RecoveryOwnerMatch, reason: string): Promise<ExpiredRecoveryAction[]> {
    return this.transact((store, now) => expireMatchingCommitted(store, tabId, now, reason, (action) =>
      action.action !== "PAGE_RELOAD" && ownerMatches(action, owner)));
  }

  /** Reconciles durable deadlines after an alarm or service-worker restart.
   * Every committed mutation produces one failed outcome when verification is
   * lost; unconsumed authorizations expire without action-outcome telemetry. */
  async reconcileExpired(tabId?: number, actionId?: string): Promise<ExpiredRecoveryAction[]> {
    return this.transact((store, now) => {
      const expired: ExpiredRecoveryAction[] = [];
      const tabs = tabId === undefined
        ? Object.entries(store.tabs)
        : [[String(tabId), store.tabs[String(tabId)]] as const];
      for (const [tabKey, tab] of tabs) {
        if (!tab) continue;
        const numericTabId = Number(tabKey);
        for (const cycle of Object.values(tab.cycles)) {
          if (cycle.state !== "ACTIVE") continue;
          const action = cycle.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
          if (!action || (actionId && action.id !== actionId) || isActionTerminal(action.state) || action.expiresAt > now) continue;
          const committed = action.state === "INITIATED";
          const terminalReason = !committed ? "Recovery authorization expired" :
            action.action === "PAGE_RELOAD"
              ? "Playback did not verify recovery after the page reload"
              : "Recovery executor did not report a result before its deadline";
          expireAction(action, now, terminalReason);
          expireCycle(cycle, now, action.terminalReason!);
          if (committed) expired.push({ tabId: numericTabId, origin: cycle.origin, action: structuredClone(action) });
        }
      }
      return expired;
    });
  }

  /** Pending deadlines are used to reconstruct alarms after an MV3 worker
   * restart. Reading this snapshot does not mutate or extend any deadline. */
  async getPendingActions(): Promise<Array<{ tabId: number; action: RecoveryActionRecord }>> {
    const store = normalizeStore(await this.persistence.load());
    const pending: Array<{ tabId: number; action: RecoveryActionRecord }> = [];
    for (const [tabId, tab] of Object.entries(store.tabs)) {
      for (const cycle of Object.values(tab.cycles)) {
        if (cycle.state !== "ACTIVE" || !cycle.activeActionId) continue;
        const action = cycle.actions[cycle.activeActionId];
        if (action && !isActionTerminal(action.state)) pending.push({ tabId: Number(tabId), action: structuredClone(action) });
      }
    }
    return pending;
  }

  async complete(tabId: number, cycleId: string, actionId: string, authorizationNonce: string, success: boolean,
    durationMs: number, reason: string | null = null): Promise<{ recorded: boolean; duplicate?: boolean; action?: RecoveryActionRecord }> {
    return this.transact((store, now) => {
      const cycle = store.tabs[String(tabId)]?.cycles[cycleId];
      const action = cycle?.actions[actionId];
      if (!cycle || !action || action.authorizationNonce !== authorizationNonce) return { recorded: false };
      if (isActionTerminal(action.state)) return { recorded: false, duplicate: true, action: structuredClone(action) };
      if (action.state !== "INITIATED") return { recorded: false };
      action.state = success ? "SUCCEEDED" : "FAILED";
      action.success = success;
      action.durationMs = Math.max(0, durationMs);
      action.terminalAt = now;
      action.terminalReason = reason;
      cycle.activeActionId = null;
      cycle.updatedAt = now;
      if (success) succeedCycle(cycle, now, reason ?? `${action.action} restored playback`);
      else if (action.action === "PAGE_RELOAD") failCycle(cycle, now, reason ?? "Playback did not recover after page reload");
      return { recorded: true, action: structuredClone(action) };
    });
  }

  async cancelCurrent(tabId: number, reason: string, expected?: {
    cycleId?: string; actionId?: string; authorizationNonce?: string; countdownDeadline?: number;
  }): Promise<RecoveryActionRecord | null> {
    return this.transact((store, now) => {
      const tab = store.tabs[String(tabId)];
      if (!tab) return null;
      const cycles = Object.values(tab.cycles).sort((a, b) => b.updatedAt - a.updatedAt);
      const cycle = cycles.find((item) => item.state === "ACTIVE" && item.activeActionId);
      if (!cycle || (expected?.cycleId && expected.cycleId !== cycle.id)) return null;
      const action = cycle.actions[cycle.activeActionId!];
      if (!action || (expected?.actionId && expected.actionId !== action.id) ||
        (expected?.authorizationNonce && expected.authorizationNonce !== action.authorizationNonce) ||
        (expected?.countdownDeadline !== undefined && expected.countdownDeadline !== action.countdownDeadline)) return null;
      if (action.state !== "AUTHORIZED" && action.state !== "COUNTDOWN") return null;
      action.state = "CANCELED";
      action.terminalAt = now;
      action.success = false;
      action.terminalReason = reason;
      cycle.activeActionId = null;
      cancelCycle(cycle, now, reason);
      return structuredClone(action);
    });
  }

  async acknowledgeCountdownDisplay(
    tabId: number, cycleId: string, actionId: string, authorizationNonce: string, frameId: number
  ): Promise<RecoveryActionRecord | null> {
    return this.transact((store, now) => {
      const cycle = store.tabs[String(tabId)]?.cycles[cycleId];
      const action = cycle?.actions[actionId];
      if (!cycle || cycle.state !== "ACTIVE" || !action || action.state !== "COUNTDOWN" ||
        action.authorizationNonce !== authorizationNonce || !Number.isInteger(frameId) || frameId < 0) return null;
      action.displayFrameId = frameId;
      cycle.updatedAt = now;
      return structuredClone(action);
    });
  }

  async extendCountdown(tabId: number, seconds: number,
    expected?: { cycleId: string; actionId: string; authorizationNonce: string }): Promise<RecoveryActionRecord | null> {
    return this.transact((store, now) => {
      const action = currentCountdown(store.tabs[String(tabId)]);
      if (!action || action.state !== "COUNTDOWN") return null;
      if (expected && (action.cycleId !== expected.cycleId || action.id !== expected.actionId ||
        action.authorizationNonce !== expected.authorizationNonce)) return null;
      action.countdownDeadline = Math.max(action.countdownDeadline ?? now, now) + seconds * 1000;
      action.expiresAt = action.countdownDeadline + ACTION_AUTHORIZATION_TTL_MS;
      const cycle = store.tabs[String(tabId)].cycles[action.cycleId];
      cycle.updatedAt = now;
      return structuredClone(action);
    });
  }

  async getCountdown(tabId: number): Promise<RecoveryActionRecord | null> {
    const store = await this.persistence.load();
    const action = currentCountdown(store.tabs[String(tabId)]);
    return action ? structuredClone(action) : null;
  }

  async getAction(tabId: number, cycleId: string, actionId: string): Promise<RecoveryActionRecord | null> {
    const store = await this.persistence.load();
    const action = store.tabs[String(tabId)]?.cycles[cycleId]?.actions[actionId];
    return action ? structuredClone(action) : null;
  }

  async getCycle(tabId: number, cycleId: string): Promise<RecoveryCycleRecord | null> {
    const store = await this.persistence.load();
    const cycle = store.tabs[String(tabId)]?.cycles[cycleId];
    return cycle ? structuredClone(cycle) : null;
  }

  async removeTab(tabId: number): Promise<void> {
    await this.transact((store) => { delete store.tabs[String(tabId)]; });
  }

  async resetTab(tabId: number, reason = "Recovery attempts reset by the viewer"): Promise<{
    reset: boolean; canceled: RecoveryActionRecord[];
  }> {
    return this.transact((store, now) => {
      const tab = store.tabs[String(tabId)];
      if (!tab) return { reset: true, canceled: [] };
      for (const cycle of Object.values(tab.cycles)) {
        const action = cycle.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
        if (cycle.state === "ACTIVE" && action?.state === "INITIATED") {
          return { reset: false, canceled: [] };
        }
      }
      const canceled: RecoveryActionRecord[] = [];
      tab.actionAttempts = {};
      for (const cycle of Object.values(tab.cycles)) {
        if (cycle.state !== "ACTIVE") continue;
        const action = cycle.activeActionId ? cycle.actions[cycle.activeActionId] : undefined;
        if (action && !isActionTerminal(action.state)) {
          action.state = "CANCELED"; action.terminalAt = now; action.success = false; action.terminalReason = reason;
          canceled.push(structuredClone(action));
        }
        cancelCycle(cycle, now, reason);
      }
      return { reset: true, canceled };
    });
  }

  async clearBudgets(tabId: number): Promise<void> {
    await this.transact((store) => {
      const tab = store.tabs[String(tabId)];
      if (tab) tab.actionAttempts = {};
    });
  }

  async clear(): Promise<void> {
    await this.transact((store) => { store.version = RECOVERY_LEDGER_VERSION; store.tabs = {}; });
  }

  private transact<T>(operation: (store: RecoveryLedgerStore, now: number) => T): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    const task = this.queue.then(async () => {
      try {
        const store = normalizeStore(await this.persistence.load());
        const value = operation(store, this.now());
        await this.persistence.save(store);
        resolve(value);
      } catch (error) { reject(error); }
    });
    this.queue = task.then(() => undefined, () => undefined);
    return result;
  }
}

export function emptyRecoveryStore(): RecoveryLedgerStore {
  return { version: RECOVERY_LEDGER_VERSION, tabs: {} };
}

export function actionLimit(action: RecoveryAction, maxAutoRefreshes: number, maxCycleActions: number): number {
  switch (action) {
    case "PAGE_RELOAD": return Math.max(1, maxAutoRefreshes);
    case "MEDIA_RELOAD": case "IFRAME_RELOAD": return Math.max(1, Math.min(2, maxAutoRefreshes));
    case "USER_PROMPT": case "BACKUP_HANDOFF": return 1;
    default: return Math.max(1, Math.min(3, maxCycleActions));
  }
}

function normalizeStore(value: RecoveryLedgerStore | undefined): RecoveryLedgerStore {
  return value?.version === RECOVERY_LEDGER_VERSION && value.tabs && typeof value.tabs === "object" ? value : emptyRecoveryStore();
}

function getTab(store: RecoveryLedgerStore, tabId: number): RecoveryTabRecord {
  return store.tabs[String(tabId)] ??= { cycles: {}, actionAttempts: {} };
}

function pruneAttempts(tab: RecoveryTabRecord, now: number, windowMs: number): void {
  for (const action of Object.keys(tab.actionAttempts) as RecoveryAction[]) {
    tab.actionAttempts[action] = (tab.actionAttempts[action] ?? []).filter((timestamp) => now - timestamp < windowMs);
  }
}

function currentCountdown(tab: RecoveryTabRecord | undefined): RecoveryActionRecord | null {
  if (!tab) return null;
  const cycles = Object.values(tab.cycles).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const cycle of cycles) {
    if (cycle.state !== "ACTIVE" || !cycle.activeActionId) continue;
    const action = cycle.actions[cycle.activeActionId];
    if (action?.state === "COUNTDOWN") return action;
  }
  return null;
}

function toAuthorization(tabId: number, action: RecoveryActionRecord): RecoveryAuthorization {
  return {
    tabId, frameId: action.ownerFrameId, navigationId: action.navigationId, candidateId: action.candidateId,
    candidateEpoch: action.candidateEpoch, cycleId: action.cycleId, actionId: action.id,
    authorizationNonce: action.authorizationNonce, action: action.action, authorizedAt: action.authorizedAt,
    expiresAt: action.expiresAt, countdownDeadline: action.countdownDeadline
  };
}

function isActionTerminal(state: RecoveryActionState): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELED", "EXPIRED"].includes(state);
}

function allowsReplacementCandidate(action: RecoveryAction): boolean {
  return action === "REDISCOVER" || action === "RETRY_BUTTON";
}

function expireAction(action: RecoveryActionRecord, now: number, reason: string): void {
  action.state = "EXPIRED"; action.terminalAt = now; action.success = false;
  action.durationMs = action.committedAt === null ? 0 : Math.max(0, now - action.committedAt);
  action.terminalReason = reason;
}

function ownerMatches(action: RecoveryActionRecord, owner: RecoveryOwnerMatch): boolean {
  return (owner.frameId === undefined || action.ownerFrameId === owner.frameId) &&
    (owner.navigationId === undefined || action.navigationId === owner.navigationId) &&
    (owner.candidateId === undefined || action.candidateId === owner.candidateId) &&
    (owner.candidateEpoch === undefined || action.candidateEpoch === owner.candidateEpoch);
}

function expireMatchingCommitted(
  store: RecoveryLedgerStore,
  tabId: number,
  now: number,
  reason: string,
  matches: (action: RecoveryActionRecord) => boolean
): ExpiredRecoveryAction[] {
  const tab = store.tabs[String(tabId)];
  if (!tab) return [];
  const expired: ExpiredRecoveryAction[] = [];
  for (const cycle of Object.values(tab.cycles)) {
    if (cycle.state !== "ACTIVE" || !cycle.activeActionId) continue;
    const action = cycle.actions[cycle.activeActionId];
    if (!action || action.state !== "INITIATED" || !matches(action)) continue;
    expireAction(action, now, reason);
    expireCycle(cycle, now, reason);
    expired.push({ tabId, origin: cycle.origin, action: structuredClone(action) });
  }
  return expired;
}

function succeedCycle(cycle: RecoveryCycleRecord, now: number, reason: string): void {
  cycle.state = "SUCCEEDED"; cycle.terminalAt = now; cycle.updatedAt = now; cycle.terminalReason = reason; cycle.activeActionId = null;
}

function failCycle(cycle: RecoveryCycleRecord, now: number, reason: string): void {
  cycle.state = "FAILED"; cycle.terminalAt = now; cycle.updatedAt = now; cycle.terminalReason = reason; cycle.activeActionId = null;
}

function cancelCycle(cycle: RecoveryCycleRecord, now: number, reason: string): void {
  cycle.state = "CANCELED"; cycle.terminalAt = now; cycle.updatedAt = now; cycle.terminalReason = reason; cycle.activeActionId = null;
}

function expireCycle(cycle: RecoveryCycleRecord, now: number, reason: string): void {
  cycle.state = "EXPIRED"; cycle.terminalAt = now; cycle.updatedAt = now; cycle.terminalReason = reason; cycle.activeActionId = null;
}

function trimCycles(tab: RecoveryTabRecord, now: number): void {
  const entries = Object.entries(tab.cycles).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [id, cycle] of entries.slice(20)) delete tab.cycles[id];
  for (const [id, cycle] of entries) if (cycle.state !== "ACTIVE" && now - cycle.updatedAt > 24 * 60 * 60_000) delete tab.cycles[id];
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
