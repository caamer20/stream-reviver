import type { FrameStatus } from "../shared/types";

export const FRAME_FRESHNESS_MS = 45_000;
export const PRIMARY_LEASE_MS = 30_000;
export const PRIMARY_CHALLENGER_DWELL_MS = 6_000;
export const PRIMARY_SCORE_MARGIN = 15;

export interface PrimaryLease {
  id: string;
  tabId: number;
  frameId: number;
  navigationId: string;
  candidateId: string;
  candidateEpoch: number;
  issuedAt: number;
  renewedAt: number;
  expiresAt: number;
}

interface CandidateEntry {
  frameId: number;
  status: FrameStatus;
  firstSeenAt: number;
}

interface TabElection {
  candidates: Map<number, CandidateEntry>;
  lease?: PrimaryLease;
}

export interface ElectionResult {
  lease: PrimaryLease | null;
  isOwner: boolean;
  changed: boolean;
}

/**
 * Elects one authoritative player per tab. The incumbent is deliberately
 * sticky: a challenger must remain present and beat it by a meaningful score
 * margin before ownership can move. This prevents ads/player DOM churn from
 * bouncing recovery authority between frames.
 */
export class PrimaryLeaseRegistry {
  private readonly tabs = new Map<number, TabElection>();

  report(tabId: number, frameId: number, status: FrameStatus, now = Date.now()): ElectionResult {
    const tab = this.getTab(tabId);
    this.prune(tab, now);
    const previous = tab.candidates.get(frameId);
    const sameCandidate = !!previous && previous.status.navigationId === status.navigationId &&
      previous.status.candidateId === status.candidateId && previous.status.candidateEpoch === status.candidateEpoch;
    tab.candidates.set(frameId, {
      frameId,
      status,
      firstSeenAt: sameCandidate ? previous!.firstSeenAt : now
    });

    const before = tab.lease;
    const incumbent = before && this.findLeaseCandidate(tab, before, now);
    const eligible = [...tab.candidates.values()].filter((candidate) => isEligible(candidate.status, now));
    const best = eligible.sort(compareCandidates)[0];
    let owner = incumbent ?? null;

    if (!owner) owner = best ?? null;
    else if (best && best.frameId !== owner.frameId) {
      const stable = now - best.firstSeenAt >= PRIMARY_CHALLENGER_DWELL_MS;
      const decisive = best.status.score >= owner.status.score + PRIMARY_SCORE_MARGIN;
      if (stable && decisive) owner = best;
    }

    if (!owner) tab.lease = undefined;
    else if (matchesLease(before, owner)) {
      tab.lease = { ...before!, renewedAt: now, expiresAt: now + PRIMARY_LEASE_MS };
    } else {
      tab.lease = {
        id: randomId(), tabId, frameId: owner.frameId,
        navigationId: owner.status.navigationId, candidateId: owner.status.candidateId,
        candidateEpoch: owner.status.candidateEpoch, issuedAt: now, renewedAt: now,
        expiresAt: now + PRIMARY_LEASE_MS
      };
    }

    return {
      lease: tab.lease ?? null,
      isOwner: !!tab.lease && tab.lease.frameId === frameId &&
        tab.lease.navigationId === status.navigationId && tab.lease.candidateId === status.candidateId &&
        tab.lease.candidateEpoch === status.candidateEpoch,
      changed: before?.id !== tab.lease?.id
    };
  }

  get(tabId: number, now = Date.now()): PrimaryLease | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    this.prune(tab, now);
    if (!tab.lease || !this.findLeaseCandidate(tab, tab.lease, now)) {
      tab.lease = undefined;
      return null;
    }
    return tab.lease;
  }

  owns(tabId: number, frameId: number, navigationId: string, candidateId: string, candidateEpoch: number, now = Date.now()): boolean {
    const lease = this.get(tabId, now);
    return !!lease && lease.frameId === frameId && lease.navigationId === navigationId &&
      lease.candidateId === candidateId && lease.candidateEpoch === candidateEpoch;
  }

  ownerStatus(tabId: number, now = Date.now()): FrameStatus | undefined {
    const lease = this.get(tabId, now);
    return lease ? this.tabs.get(tabId)?.candidates.get(lease.frameId)?.status : undefined;
  }

  removeFrame(tabId: number, frameId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.candidates.delete(frameId);
    if (tab.lease?.frameId === frameId) tab.lease = undefined;
  }

  removeTab(tabId: number): void { this.tabs.delete(tabId); }
  clear(): void { this.tabs.clear(); }

  private getTab(tabId: number): TabElection {
    let tab = this.tabs.get(tabId);
    if (!tab) { tab = { candidates: new Map() }; this.tabs.set(tabId, tab); }
    return tab;
  }

  private findLeaseCandidate(tab: TabElection, lease: PrimaryLease, now: number): CandidateEntry | undefined {
    if (lease.expiresAt <= now) return undefined;
    const candidate = tab.candidates.get(lease.frameId);
    return candidate && isEligible(candidate.status, now) && candidate.status.navigationId === lease.navigationId &&
      candidate.status.candidateId === lease.candidateId && candidate.status.candidateEpoch === lease.candidateEpoch
      ? candidate : undefined;
  }

  private prune(tab: TabElection, now: number): void {
    for (const [frameId, candidate] of tab.candidates) {
      if (now - candidate.status.updatedAt > FRAME_FRESHNESS_MS) tab.candidates.delete(frameId);
    }
  }
}

function isEligible(status: FrameStatus, now: number): boolean {
  return status.hasVideo && status.candidateId.length > 0 && status.navigationId.length > 0 &&
    now - status.updatedAt <= FRAME_FRESHNESS_MS &&
    !["DISABLED", "SITE_NOT_ENABLED", "URL_EXCLUDED", "SNOOZED"].includes(status.state);
}

function compareCandidates(a: CandidateEntry, b: CandidateEntry): number {
  if (a.status.score !== b.status.score) return b.status.score - a.status.score;
  if (a.status.online !== b.status.online) return a.status.online ? -1 : 1;
  if (a.frameId === 0 || b.frameId === 0) return a.frameId === 0 ? -1 : 1;
  return a.frameId - b.frameId;
}

function matchesLease(lease: PrimaryLease | undefined, candidate: CandidateEntry): boolean {
  return !!lease && lease.frameId === candidate.frameId && lease.navigationId === candidate.status.navigationId &&
    lease.candidateId === candidate.status.candidateId && lease.candidateEpoch === candidate.status.candidateEpoch;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
