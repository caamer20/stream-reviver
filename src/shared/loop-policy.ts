export interface LoopEntry {
  urlKey: string;
  attempts: number[];
  actionAttempts: Record<string, number[]>;
  pausedUntil: number | null;
  pendingMaximizeAt: number | null;
  snoozedUntil: number | null;
  eventModeUntil: number | null;
}

export function loopUrlKey(url: string): string {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; }
  catch { return url.split(/[?#]/)[0]; }
}

export function normalizeLoopEntry(entry: LoopEntry | undefined, pageUrl: string, now = Date.now(), pendingAgeMs = 2 * 60_000): LoopEntry {
  const key = loopUrlKey(pageUrl);
  if (entry?.urlKey === key) return entry;
  if (entry) {
    const newestAttempt = Math.max(...entry.attempts, ...Object.values(entry.actionAttempts ?? {}).flat(), 0);
    // Reloads can redirect or canonicalize the path. Carry recent attempts so
    // a redirect cannot reset the circuit breaker.
    if (now - newestAttempt < pendingAgeMs) return { ...entry, urlKey: key };
  }
  return {
    urlKey: key, attempts: [], actionAttempts: {}, pausedUntil: null, pendingMaximizeAt: null,
    snoozedUntil: entry?.snoozedUntil ?? null, eventModeUntil: entry?.eventModeUntil ?? null
  };
}
