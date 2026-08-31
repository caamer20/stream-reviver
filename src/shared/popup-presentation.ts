import type { MonitorState, PopupState, RecoveryAction, SiteSettings } from "./types";

export const POPUP_STATUS_STALE_AFTER_MS = 45_000;

export type PopupTone = "neutral" | "healthy" | "warning" | "error" | "monitoring";
export type SiteOverrideMode = "default" | "on" | "off";
type PopupBooleanOverride = "autoRecover" | "autoRefresh" | "autoMaximize";

export interface PopupCopy {
  key: string;
  fallback: string;
  substitutions?: string[];
}

export interface PopupActionVisibility {
  refresh: boolean;
  maximize: boolean;
  pictureInPicture: boolean;
  pickPlayer: boolean;
  jumpLive: boolean;
  cancelCountdown: boolean;
  extendCountdown: boolean;
  resetAttempts: boolean;
  resume: boolean;
  snooze: boolean;
  eventMode: boolean;
}

export interface PopupPresentation {
  activeProtection: boolean;
  stale: boolean;
  tone: PopupTone;
  protection: PopupCopy;
  headline: PopupCopy;
  detail: PopupCopy;
  nextAction: PopupCopy;
  freshness: PopupCopy;
  coverage: PopupCopy;
  evidenceStrength: string;
  actions: PopupActionVisibility;
  announcementKey: string;
}

const STATIC_STATES = new Set<MonitorState>(["DISABLED", "SITE_NOT_ENABLED", "URL_EXCLUDED", "SNOOZED"]);
const ATTENTION_STATES = new Set<MonitorState>(["SUSPECTED_DOWN", "RECOVERING", "COUNTDOWN", "REFRESHING", "PAUSED_TOO_MANY_REFRESHES", "ERROR"]);

const HEADLINES: Record<MonitorState, PopupCopy> = {
  DISABLED: copy("popupStatusDisabled", "Stream Reviver is off"),
  SITE_NOT_ENABLED: copy("popupStatusSiteNotEnabled", "This site is not protected"),
  URL_EXCLUDED: copy("popupStatusUrlExcluded", "This page is excluded"),
  SNOOZED: copy("popupStatusSnoozed", "Protection is snoozed"),
  OFFLINE: copy("popupStatusOffline", "Waiting for internet access"),
  NO_VIDEO_FOUND: copy("popupStatusNoVideo", "No stream detected yet"),
  LIMITED_VISIBILITY: copy("popupStatusLimited", "Player visibility is limited"),
  MONITORING: copy("popupStatusMonitoring", "Checking stream health"),
  HEALTHY: copy("popupStatusHealthy", "Stream is playing normally"),
  SUSPECTED_DOWN: copy("popupStatusSuspected", "Playback may be interrupted"),
  RECOVERING: copy("popupStatusRecovering", "Trying to restore playback"),
  COUNTDOWN: copy("popupStatusCountdown", "Page reload scheduled"),
  REFRESHING: copy("popupStatusRefreshing", "Reloading the page"),
  PAUSED_TOO_MANY_REFRESHES: copy("popupStatusRecoveryStopped", "Automatic recovery stopped"),
  MAXIMIZE_BLOCKED: copy("popupStatusMaximizeBlocked", "A click is needed to maximize"),
  ERROR: copy("popupStatusError", "Stream Reviver needs attention")
};

const NEXT_ACTIONS: Record<MonitorState, PopupCopy> = {
  DISABLED: copy("popupNextEnableGlobal", "Turn on Stream Reviver to resume protection."),
  SITE_NOT_ENABLED: copy("popupNextEnableSite", "Enable this site below to begin monitoring."),
  URL_EXCLUDED: copy("popupNextReviewUrlRules", "Change this site's URL rules in Settings to monitor this page."),
  SNOOZED: copy("popupNextResume", "Resume protection when you are ready."),
  OFFLINE: copy("popupNextReconnect", "Reconnect to the internet; recovery attempts are preserved."),
  NO_VIDEO_FOUND: copy("popupNextStartOrPick", "Start the stream or pick the primary player."),
  LIMITED_VISIBILITY: copy("popupNextReviewCoverage", "Open technical details to see what the browser can inspect."),
  MONITORING: copy("popupNextWaitForBaseline", "Leave the stream playing while health checks establish a baseline."),
  HEALTHY: copy("popupNextNoAction", "No action is needed."),
  SUSPECTED_DOWN: copy("popupNextConfirming", "Stream Reviver will confirm the problem before acting."),
  RECOVERING: copy("popupNextRecoveryStep", "Stream Reviver is running the next safe recovery step."),
  COUNTDOWN: copy("popupNextCountdown", "Cancel or extend the countdown if you do not want a reload."),
  REFRESHING: copy("popupNextRefreshing", "Wait for the page and player to return."),
  PAUSED_TOO_MANY_REFRESHES: copy("popupNextResetAttempts", "Review the attempts, then reset only when you want to retry."),
  MAXIMIZE_BLOCKED: copy("popupNextMaximizeClick", "Use Maximize now and approve the browser prompt."),
  ERROR: copy("popupNextReviewSettings", "Open technical details or Settings to review the configuration.")
};

export function getPopupPresentation(state: PopupState, now = Date.now()): PopupPresentation {
  const status = state.status;
  const configured = state.acknowledged && state.supportedPage && state.settings.enabled && state.effective?.siteEnabled === true;
  const activeProtection = configured && status.state !== "URL_EXCLUDED" && status.state !== "SNOOZED";
  const ageMs = Math.max(0, now - finiteTimestamp(status.updatedAt, now));
  const stale = configured && !STATIC_STATES.has(status.state) && ageMs > POPUP_STATUS_STALE_AFTER_MS;

  const protection = protectionCopy(state, configured);
  const headline = stale ? copy("popupStatusStale", "Waiting for a fresh status") : HEADLINES[status.state];
  const detail = stale
    ? copy(
      "popupStatusStaleDetail",
      "The last player report is out of date. Stream health is unknown until monitoring checks in again."
    )
    : copy("popupStatusReportedDetail", status.detail || "Waiting for a status update.");
  const nextAction = stale
    ? copy("popupNextStale", "Keep the stream tab open; Stream Reviver will update automatically.")
    : recoveryNextAction(status.state, status.recoveryAction);
  const tone = stale ? "neutral" : toneForState(status.state);
  const freshness = configured ? freshnessCopy(ageMs, stale) : copy("popupFreshnessInactive", "Not actively monitoring");
  const coverage = coverageCopy(status.compatibility.level);
  const evidenceStrength = stale || status.confidence <= 0 ? "—" : `${Math.round(status.confidence)}/100`;
  const actions = actionVisibility(state, activeProtection, stale, now);
  const announcementKey = [protection.key, headline.key, status.state, stale ? "stale" : "fresh", nextAction.key].join(":");

  return {
    activeProtection,
    stale,
    tone,
    protection,
    headline,
    detail,
    nextAction,
    freshness,
    coverage,
    evidenceStrength,
    actions,
    announcementKey
  };
}

export function getSiteOverrideMode(site: SiteSettings | undefined, key: PopupBooleanOverride): SiteOverrideMode {
  const value = site?.[key];
  return value === undefined ? "default" : value ? "on" : "off";
}

export function withSiteOverride(
  site: SiteSettings | undefined,
  key: PopupBooleanOverride,
  mode: SiteOverrideMode
): SiteSettings {
  const next = structuredClone(site ?? {});
  if (mode === "default") delete next[key];
  else next[key] = mode === "on";
  return next;
}

function actionVisibility(state: PopupState, activeProtection: boolean, stale: boolean, now: number): PopupActionVisibility {
  const status = state.status;
  const countdown = activeProtection && !stale && status.state === "COUNTDOWN";
  const snoozed = status.state === "SNOOZED" || state.snoozedUntil === -1 || (state.snoozedUntil !== null && state.snoozedUntil > now);
  const hasVideo = activeProtection && !stale && status.hasVideo;
  return {
    refresh: activeProtection && !stale && ATTENTION_STATES.has(status.state) && status.state !== "COUNTDOWN" && status.state !== "REFRESHING",
    maximize: hasVideo && ["HEALTHY", "MONITORING", "MAXIMIZE_BLOCKED"].includes(status.state),
    pictureInPicture: hasVideo && state.effective?.enablePictureInPicture === true,
    pickPlayer: activeProtection && !stale && ["NO_VIDEO_FOUND", "LIMITED_VISIBILITY", "MONITORING", "HEALTHY"].includes(status.state),
    jumpLive: hasVideo && status.streamKind !== "VOD" && status.liveEdgeLagSeconds !== null,
    cancelCountdown: countdown,
    extendCountdown: countdown,
    resetAttempts: activeProtection && !stale && status.state === "PAUSED_TOO_MANY_REFRESHES",
    resume: configuredSite(state) && snoozed,
    snooze: activeProtection && !snoozed,
    eventMode: activeProtection
  };
}

function configuredSite(state: PopupState): boolean {
  return state.acknowledged && state.supportedPage && state.settings.enabled && state.effective?.siteEnabled === true;
}

function protectionCopy(state: PopupState, configured: boolean): PopupCopy {
  if (!state.acknowledged) return copy("popupProtectionSetup", "Setup required");
  if (!state.settings.enabled) return copy("popupProtectionGlobalOff", "Globally disabled");
  if (!state.supportedPage) return copy("popupProtectionUnavailable", "Unavailable here");
  if (!configured) return copy("popupProtectionOff", "Site not protected");
  if (state.status.state === "URL_EXCLUDED") return copy("popupProtectionExcluded", "Page excluded");
  if (state.status.state === "SNOOZED") return copy("popupProtectionSnoozed", "Protection snoozed");
  return copy("popupProtectionOn", "Site protected");
}

function recoveryNextAction(state: MonitorState, action: RecoveryAction | null): PopupCopy {
  if (state !== "RECOVERING" || !action) return NEXT_ACTIONS[state];
  const actionLabel = recoveryActionLabel(action);
  return copy("popupNextCurrentRecoveryStep", `Current recovery step: ${actionLabel}.`, [actionLabel]);
}

function recoveryActionLabel(action: RecoveryAction): string {
  const labels: Record<RecoveryAction, string> = {
    WAIT: "wait and recheck",
    USER_PROMPT: "request a playback click",
    REDISCOVER: "find the player again",
    PLAY: "resume playback",
    LIVE_EDGE: "return to the live edge",
    RETRY_BUTTON: "use the configured retry control",
    MEDIA_RELOAD: "reload the media element",
    IFRAME_RELOAD: "reload the player frame",
    PAGE_RELOAD: "reload the page",
    BACKUP_HANDOFF: "offer the configured backup"
  };
  return labels[action];
}

function freshnessCopy(ageMs: number, stale: boolean): PopupCopy {
  if (ageMs < 5_000) return copy("popupFreshJustNow", "Updated just now");
  if (ageMs < 60_000) {
    const seconds = String(Math.max(1, Math.floor(ageMs / 1000)));
    return copy(stale ? "popupLastUpdateSeconds" : "popupFreshSeconds", `${stale ? "Last update" : "Updated"} ${seconds}s ago`, [seconds]);
  }
  if (ageMs < 3_600_000) {
    const minutes = String(Math.max(1, Math.floor(ageMs / 60_000)));
    return copy(stale ? "popupLastUpdateMinutes" : "popupFreshMinutes", `${stale ? "Last update" : "Updated"} ${minutes}m ago`, [minutes]);
  }
  const hours = String(Math.max(1, Math.floor(ageMs / 3_600_000)));
  return copy("popupLastUpdateHours", `Last update ${hours}h ago`, [hours]);
}

function coverageCopy(level: "FULL" | "PARTIAL" | "RESTRICTED"): PopupCopy {
  if (level === "FULL") return copy("popupCoverageFull", "FULL");
  if (level === "PARTIAL") return copy("popupCoveragePartial", "PARTIAL");
  return copy("popupCoverageRestricted", "RESTRICTED");
}

function toneForState(state: MonitorState): PopupTone {
  if (state === "HEALTHY") return "healthy";
  if (["SUSPECTED_DOWN", "RECOVERING", "COUNTDOWN", "OFFLINE", "MAXIMIZE_BLOCKED"].includes(state)) return "warning";
  if (["ERROR", "PAUSED_TOO_MANY_REFRESHES"].includes(state)) return "error";
  if (state === "MONITORING") return "monitoring";
  return "neutral";
}

function finiteTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function copy(key: string, fallback: string, substitutions?: string[]): PopupCopy {
  return substitutions ? { key, fallback, substitutions } : { key, fallback };
}
