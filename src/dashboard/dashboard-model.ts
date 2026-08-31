import type {
  DashboardActiveMonitor, DashboardConfiguredSite, DashboardRecoveryEvent, DashboardState,
  MonitorState, RecoveryAction
} from "../shared/types";
export type { DashboardActiveMonitor, DashboardConfiguredSite, DashboardRecoveryEvent, DashboardState } from "../shared/types";

export interface DashboardSummary {
  activeMonitors: number;
  healthyMonitors: number;
  attentionMonitors: number;
  protectedSites: number;
}

export interface MonitorPresentation {
  label: string;
  detail: string;
  tone: "neutral" | "active" | "healthy" | "warning" | "critical";
  i18nKey: string;
}

const ATTENTION_STATES = new Set<MonitorState>([
  "OFFLINE",
  "LIMITED_VISIBILITY",
  "SUSPECTED_DOWN",
  "RECOVERING",
  "COUNTDOWN",
  "REFRESHING",
  "PAUSED_TOO_MANY_REFRESHES",
  "MAXIMIZE_BLOCKED",
  "ERROR"
]);

const MONITOR_PRESENTATIONS: Record<MonitorState, MonitorPresentation> = {
  DISABLED: { label: "Disabled", detail: "Protection is globally disabled.", tone: "neutral", i18nKey: "dashboardStateDisabled" },
  SITE_NOT_ENABLED: { label: "Not protected", detail: "This site is not enabled for monitoring.", tone: "neutral", i18nKey: "dashboardStateSiteNotEnabled" },
  URL_EXCLUDED: { label: "Excluded", detail: "Monitoring is excluded by this site's rules.", tone: "neutral", i18nKey: "dashboardStateUrlExcluded" },
  SNOOZED: { label: "Snoozed", detail: "Protection is temporarily snoozed.", tone: "neutral", i18nKey: "dashboardStateSnoozed" },
  OFFLINE: { label: "Offline", detail: "Waiting for network access.", tone: "warning", i18nKey: "dashboardStateOffline" },
  NO_VIDEO_FOUND: { label: "Waiting", detail: "No stream is currently detected.", tone: "neutral", i18nKey: "dashboardStateNoVideo" },
  LIMITED_VISIBILITY: { label: "Limited", detail: "The browser has limited visibility into this player.", tone: "warning", i18nKey: "dashboardStateLimited" },
  MONITORING: { label: "Monitoring", detail: "Establishing a stream-health baseline.", tone: "active", i18nKey: "dashboardStateMonitoring" },
  HEALTHY: { label: "Healthy", detail: "The stream is playing normally.", tone: "healthy", i18nKey: "dashboardStateHealthy" },
  SUSPECTED_DOWN: { label: "Checking", detail: "Playback may be interrupted; confirming before acting.", tone: "warning", i18nKey: "dashboardStateSuspected" },
  RECOVERING: { label: "Recovering", detail: "Trying a safe recovery step.", tone: "warning", i18nKey: "dashboardStateRecovering" },
  COUNTDOWN: { label: "Reload pending", detail: "A page reload is waiting in its safety countdown.", tone: "warning", i18nKey: "dashboardStateCountdown" },
  REFRESHING: { label: "Reloading", detail: "The monitored tab is reloading.", tone: "warning", i18nKey: "dashboardStateRefreshing" },
  PAUSED_TOO_MANY_REFRESHES: { label: "Recovery paused", detail: "Automatic recovery stopped after repeated attempts.", tone: "critical", i18nKey: "dashboardStateRecoveryPaused" },
  MAXIMIZE_BLOCKED: { label: "Action needed", detail: "A browser-approved click is needed to maximize the player.", tone: "warning", i18nKey: "dashboardStateMaximizeBlocked" },
  ERROR: { label: "Needs attention", detail: "Monitoring encountered an error.", tone: "critical", i18nKey: "dashboardStateError" }
};

const ACTION_LABELS: Record<RecoveryAction, string> = {
  WAIT: "Wait and verify",
  USER_PROMPT: "Request user action",
  REDISCOVER: "Find the player again",
  PLAY: "Resume playback",
  LIVE_EDGE: "Return to live",
  RETRY_BUTTON: "Use the player's retry control",
  MEDIA_RELOAD: "Reload the media",
  IFRAME_RELOAD: "Reload the player frame",
  PAGE_RELOAD: "Reload the page",
  BACKUP_HANDOFF: "Open a configured backup"
};

const OUTCOME_LABELS: Record<DashboardRecoveryEvent["outcome"], string> = {
  scheduled: "Scheduled",
  success: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused"
};

const MONITOR_STATES = new Set<MonitorState>(Object.keys(MONITOR_PRESENTATIONS) as MonitorState[]);
const RECOVERY_ACTIONS = new Set<RecoveryAction>(Object.keys(ACTION_LABELS) as RecoveryAction[]);
const RECOVERY_OUTCOMES = new Set<DashboardRecoveryEvent["outcome"]>(Object.keys(OUTCOME_LABELS) as DashboardRecoveryEvent["outcome"][]);

/** Counts are deliberately derived from the same privacy-safe records rendered by the page. */
export function getDashboardSummary(state: DashboardState): DashboardSummary {
  return {
    activeMonitors: state.activeMonitors.length,
    healthyMonitors: state.activeMonitors.filter((monitor) => monitor.state === "HEALTHY").length,
    attentionMonitors: state.activeMonitors.filter((monitor) => ATTENTION_STATES.has(monitor.state)).length,
    protectedSites: state.configuredSites.filter((site) => site.enabled && site.permissionGranted).length
  };
}

export function getMonitorPresentation(state: MonitorState): MonitorPresentation {
  return MONITOR_PRESENTATIONS[state] ?? {
    label: "Status unavailable",
    detail: "Waiting for a recognized monitor status.",
    tone: "neutral",
    i18nKey: "dashboardStateUnknown"
  };
}

/**
 * Returns a hostname (and optional port) only. Even if an unexpected full URL
 * reaches the UI boundary, its path, query, credentials, and fragment are not
 * returned to the renderer.
 */
export function privacySafeSiteLabel(host: string, origin: string): string {
  for (const candidate of [host, origin]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (!value) continue;
    if (value === "file://" || value.startsWith("file:///")) return "Local file";
    try {
      const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) return parsed.host;
    } catch { /* Try the next privacy-safe source. */ }
  }
  return "Unknown site";
}

/**
 * Details are useful context, but they are less important than the privacy
 * boundary. URL-like text is replaced wholesale with the state-specific copy.
 */
export function privacySafeDetail(detail: string, state: MonitorState): string {
  const fallback = getMonitorPresentation(state).detail;
  if (typeof detail !== "string") return fallback;
  const normalized = detail.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  const containsUrl = /\b(?:https?|file):\/\//i.test(normalized)
    || /(?:^|\s)(?:\/|\.\/|\.\.\/)\S/.test(normalized)
    || /\b(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d+)?[/?#]\S*/i.test(normalized)
    || /\?(?:[\w%.-]+)=|#[\w%.-]+/.test(normalized);
  return containsUrl ? fallback : normalized.slice(0, 180);
}

export function recoveryActionLabel(action: RecoveryAction): string {
  return ACTION_LABELS[action] ?? "Recovery action";
}

export function recoveryOutcomeLabel(outcome: DashboardRecoveryEvent["outcome"]): string {
  return OUTCOME_LABELS[outcome] ?? "Updated";
}

export function isDashboardState(value: unknown): value is DashboardState {
  if (!isRecord(value)
    || typeof value.acknowledged !== "boolean"
    || typeof value.enabled !== "boolean"
    || !isFiniteNumber(value.generatedAt)
    || !Array.isArray(value.configuredSites)
    || !Array.isArray(value.activeMonitors)
    || !Array.isArray(value.recentRecoveries)) return false;

  return value.configuredSites.every((site) => isRecord(site)
      && typeof site.origin === "string"
      && typeof site.host === "string"
      && typeof site.enabled === "boolean"
      && typeof site.permissionGranted === "boolean"
      && isFiniteNumber(site.activeTabs))
    && value.activeMonitors.every((monitor) => isRecord(monitor)
      && Number.isInteger(monitor.tabId)
      && Number(monitor.tabId) >= 0
      && typeof monitor.origin === "string"
      && typeof monitor.host === "string"
      && typeof monitor.state === "string"
      && MONITOR_STATES.has(monitor.state as MonitorState)
      && typeof monitor.detail === "string"
      && isFiniteNumber(monitor.confidence)
      && monitor.confidence >= 0
      && monitor.confidence <= 100
      && (monitor.recoveryAction === null
        || (typeof monitor.recoveryAction === "string" && RECOVERY_ACTIONS.has(monitor.recoveryAction as RecoveryAction)))
      && isFiniteNumber(monitor.updatedAt))
    && value.recentRecoveries.every((event) => isRecord(event)
      && typeof event.id === "string"
      && typeof event.origin === "string"
      && typeof event.host === "string"
      && typeof event.action === "string"
      && RECOVERY_ACTIONS.has(event.action as RecoveryAction)
      && typeof event.outcome === "string"
      && RECOVERY_OUTCOMES.has(event.outcome as DashboardRecoveryEvent["outcome"])
      && isFiniteNumber(event.timestamp));
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Time unavailable";
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 10) return "Just now";
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
