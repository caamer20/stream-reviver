import type {
  DashboardRecoveryEvent, FrameStatus, HistoryEvent, MonitorState, RecoveryAction
} from "../shared/types";

const DASHBOARD_ACTIONS = new Set<RecoveryAction>([
  "WAIT", "USER_PROMPT", "REDISCOVER", "PLAY", "LIVE_EDGE", "RETRY_BUTTON",
  "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"
]);

export function dashboardRecoveryEvents(
  history: HistoryEvent[],
  statusByTab: ReadonlyMap<number, Pick<FrameStatus, "origin">>
): DashboardRecoveryEvent[] {
  const output: DashboardRecoveryEvent[] = [];
  const seen = new Set<string>();
  for (const item of history) {
    const metadata = item.metadata ?? {};
    const action = dashboardRecoveryAction(item.event, metadata.action ?? metadata.recoveryAction);
    const outcome = dashboardRecoveryOutcome(item.event);
    if (!action || !outcome) continue;
    const origin = safeOrigin(item.url) ?? (item.tabId === undefined ? null : statusByTab.get(item.tabId)?.origin ?? null);
    if (!origin) continue;
    const cycle = typeof metadata.recoveryCycleId === "string" ? metadata.recoveryCycleId : item.id;
    const identity = `${cycle}:${action}:${outcome}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push({ id: item.id, origin, host: dashboardHost(origin), action, outcome, timestamp: item.timestamp });
    if (output.length >= 50) break;
  }
  return output;
}

export function dashboardHost(origin: string): string {
  if (origin === "file://") return "Local file";
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.host.slice(0, 255) : "Unknown site";
  } catch { return "Unknown site"; }
}

export function dashboardSafeDetail(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "Waiting for the next monitor update.";
  if (/\b(?:https?|file):\/\//i.test(normalized)
    || /(?:^|\s)(?:\/|\.\/|\.\.\/)\S/.test(normalized)
    || /[?#][\w%.-]+=/.test(normalized)) {
    return "Status details are available in the current-tab popup.";
  }
  return normalized.slice(0, 180);
}

export function dashboardStateRank(state: MonitorState): number {
  if (["ERROR", "PAUSED_TOO_MANY_REFRESHES"].includes(state)) return 5;
  if (["SUSPECTED_DOWN", "RECOVERING", "COUNTDOWN", "REFRESHING"].includes(state)) return 4;
  if (["OFFLINE", "LIMITED_VISIBILITY", "MAXIMIZE_BLOCKED"].includes(state)) return 3;
  if (state === "HEALTHY") return 2;
  if (state === "MONITORING") return 1;
  return 0;
}

function dashboardRecoveryAction(event: string, value: unknown): RecoveryAction | null {
  if (typeof value === "string" && DASHBOARD_ACTIONS.has(value as RecoveryAction)) return value as RecoveryAction;
  if (["countdown-started", "countdown-canceled", "page-reload", "status-paused_too_many_refreshes"].includes(event)) return "PAGE_RELOAD";
  return null;
}

function dashboardRecoveryOutcome(event: string): DashboardRecoveryEvent["outcome"] | null {
  if (["recovery-step", "countdown-started", "page-reload"].includes(event)) return "scheduled";
  if (["recovery-verified", "recovery-action-succeeded"].includes(event)) return "success";
  if (["recovery-verification-failed", "recovery-action-failed", "recovery-action-expired"].includes(event)) return "failed";
  if (["recovery-action-canceled", "countdown-canceled"].includes(event)) return "cancelled";
  if (event === "status-paused_too_many_refreshes") return "paused";
  return null;
}

function safeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") return "file://";
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}
