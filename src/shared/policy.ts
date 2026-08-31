import type { EffectiveSettings, FailureKind, LocalSiteModel, PlayerType, RecoveryAction } from "./types";
import { contextualOutcomeCount, contextualSuccessRate } from "./outcomes";

export interface RecoveryContext {
  playerType?: PlayerType;
  hasVideo?: boolean;
  hasRetryControl?: boolean;
  insideIframe?: boolean;
  playIntent?: "UNKNOWN" | "USER_REQUESTED" | "PLAYING" | "USER_PAUSED" | "SITE_PAUSED" | "AUTOPLAY_BLOCKED";
  followingLive?: boolean;
  mediaReloadSafe?: boolean;
  online?: boolean;
}

export interface RecoveryActionDefinition {
  action: RecoveryAction;
  risk: number;
  disruption: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "NAVIGATION";
  requiresUser: boolean;
  timeoutMs: number;
  expectedEffect: string;
  verification: string;
}

const ACTION_DEFINITIONS: Record<RecoveryAction, RecoveryActionDefinition> = {
  WAIT: { action: "WAIT", risk: 0, disruption: "NONE", requiresUser: false, timeoutMs: 5_000, expectedEffect: "The player recovers without mutation", verification: "Sustained media-time or frame progress" },
  REDISCOVER: { action: "REDISCOVER", risk: 0, disruption: "NONE", requiresUser: false, timeoutMs: 3_000, expectedEffect: "A current primary player is selected", verification: "A stable candidate lease is acquired" },
  USER_PROMPT: { action: "USER_PROMPT", risk: 1, disruption: "LOW", requiresUser: true, timeoutMs: 0, expectedEffect: "The viewer chooses an allowed recovery", verification: "A trusted user gesture initiates a follow-up action" },
  PLAY: { action: "PLAY", risk: 1, disruption: "LOW", requiresUser: false, timeoutMs: 8_000, expectedEffect: "Playback starts or resumes", verification: "Media time and frames advance sustainably" },
  LIVE_EDGE: { action: "LIVE_EDGE", risk: 1, disruption: "LOW", requiresUser: false, timeoutMs: 8_000, expectedEffect: "Playback returns to the moving live edge", verification: "Live lag falls while playback advances" },
  RETRY_BUTTON: { action: "RETRY_BUTTON", risk: 2, disruption: "MEDIUM", requiresUser: false, timeoutMs: 15_000, expectedEffect: "The configured player retry flow restarts playback", verification: "The same or replacement player becomes healthy" },
  MEDIA_RELOAD: { action: "MEDIA_RELOAD", risk: 2, disruption: "MEDIUM", requiresUser: false, timeoutMs: 20_000, expectedEffect: "The browser reloads the selected media resource", verification: "The selected source becomes playable and advances" },
  IFRAME_RELOAD: { action: "IFRAME_RELOAD", risk: 3, disruption: "HIGH", requiresUser: false, timeoutMs: 30_000, expectedEffect: "The bound player frame navigates to its current source", verification: "A replacement frame lease reports sustained health" },
  PAGE_RELOAD: { action: "PAGE_RELOAD", risk: 4, disruption: "NAVIGATION", requiresUser: false, timeoutMs: 60_000, expectedEffect: "The top-level page reloads", verification: "A post-navigation primary player reports sustained health" },
  BACKUP_HANDOFF: { action: "BACKUP_HANDOFF", risk: 5, disruption: "NAVIGATION", requiresUser: true, timeoutMs: 0, expectedEffect: "The viewer confirms opening a configured backup", verification: "The destination is user-confirmed" }
};

const POLICIES: Record<FailureKind, RecoveryAction[]> = {
  NONE: [], STARTUP_DELAY: ["WAIT"], USER_PAUSED: [], AUTOPLAY_BLOCKED: ["USER_PROMPT", "PLAY"],
  NETWORK_OFFLINE: ["WAIT"], NETWORK_STARVATION: ["WAIT", "PLAY", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD"],
  BUFFER_UNDERRUN: ["WAIT", "PLAY", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD"],
  LIVE_EDGE_DRIFT: ["LIVE_EDGE", "PLAY", "RETRY_BUTTON", "PAGE_RELOAD"],
  DECODE_FREEZE: ["PLAY", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD"],
  RENDER_FREEZE: ["PLAY", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD"],
  MEDIA_SOURCE_ERROR: ["RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"],
  NO_USABLE_SOURCE: ["WAIT", "REDISCOVER", "RETRY_BUTTON", "PAGE_RELOAD", "BACKUP_HANDOFF"],
  LIVE_STREAM_ENDED: ["RETRY_BUTTON", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"],
  PLAYER_REPLACED: ["WAIT", "REDISCOVER"], PLAYER_CONTROL_ERROR: ["REDISCOVER", "RETRY_BUTTON", "PAGE_RELOAD"],
  WEBRTC_NETWORK_FAILURE: ["WAIT", "RETRY_BUTTON", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"],
  ACCESS_INTERRUPTION: [], TAB_SUSPENDED: [], BROWSER_RESUMED: ["WAIT"],
  UNKNOWN_FAILURE: ["WAIT", "PLAY", "REDISCOVER", "RETRY_BUTTON", "PAGE_RELOAD"]
};

const IFRAME_RELOAD_SAFETY_REASON =
  "Automatic iframe reload is temporarily disabled because replacement-frame handoff cannot yet be safely verified";

export function planRecovery(kind: FailureKind, settings: EffectiveSettings, model?: LocalSiteModel | null, context?: RecoveryContext): RecoveryAction[] {
  if (!settings.autoRecover) return [];
  const enabled = new Set(settings.recoveryStrategy);
  enabled.add("USER_PROMPT");
  enabled.add("REDISCOVER");
  let actions = POLICIES[kind].filter((action) => enabled.has(action));
  // Reloading an iframe destroys the authorizing frame identity. Until a
  // replacement frame can inherit the action ledger and prove sustained
  // health under a new primary lease, never put this mutation in an
  // automatic plan—even when the caller has not supplied frame context.
  actions = actions.filter((action) => action !== "IFRAME_RELOAD");
  if (!settings.autoRefresh) actions = actions.filter((action) => action !== "PAGE_RELOAD");
  if (!settings.retryButtonSelector) actions = actions.filter((action) => action !== "RETRY_BUTTON");
  if (!settings.backupUrls.length) actions = actions.filter((action) => action !== "BACKUP_HANDOFF");
  if (context) actions = actions.filter((action) => validateRecoveryAction(action, context).allowed);
  const feedback = model?.feedbackByFailure?.[kind];
  if (settings.enableAdaptiveTuning && feedback && feedback.falseAlarms > feedback.correct) {
    // A viewer-reported false alarm immediately removes every automatic
    // mutation for this diagnosis. Passive checks and explicit user choices
    // remain available; later correct feedback can restore the static policy.
    actions = unique([
      ...actions.filter((action) => risk(action) === 0 || ACTION_DEFINITIONS[action].requiresUser),
      "USER_PROMPT"
    ]);
  }
  // Health samples and feedback do not make an action model trustworthy. Only
  // outcomes for this diagnosis are allowed to influence its ordering.
  if (!settings.enableAdaptiveTuning || !model || model.sessionCount < 3 || contextualOutcomeCount(model, kind, actions) < 5) {
    return unique(actions).slice(0, settings.maxRecoveryActionsPerCycle);
  }
  const safe = actions.filter((action) => risk(action) <= 2);
  const disruptive = actions.filter((action) => risk(action) > 2);
  safe.sort((a, b) => learnedScore(model, kind, b) - learnedScore(model, kind, a) || risk(a) - risk(b));
  return unique([...safe, ...disruptive]).slice(0, settings.maxRecoveryActionsPerCycle);
}

/**
 * Revalidates the user's automatic-action choices at the mutation boundary.
 * PAGE_RELOAD is deliberately double-gated because it navigates the tab;
 * manual actions do not pass through this automatic-recovery gate.
 */
export function validateAutomaticRecoverySetting(
  action: RecoveryAction,
  settings: Pick<EffectiveSettings, "autoRecover" | "autoRefresh">
): { allowed: boolean; reason: string } {
  if (!settings.autoRecover) return denied("Automatic recovery is disabled");
  if (action === "IFRAME_RELOAD") return denied(IFRAME_RELOAD_SAFETY_REASON);
  if (action === "PAGE_RELOAD" && !settings.autoRefresh) return denied("Automatic page refresh is disabled");
  return { allowed: true, reason: "Automatic recovery is enabled for this action" };
}

export function actionRisk(action: RecoveryAction): number { return risk(action); }

export function recoveryActionDefinition(action: RecoveryAction): RecoveryActionDefinition {
  return ACTION_DEFINITIONS[action];
}

export function validateRecoveryAction(action: RecoveryAction, context: RecoveryContext): { allowed: boolean; reason: string } {
  if (context.online === false && action !== "WAIT" && action !== "USER_PROMPT") return denied("The browser is offline");
  if (action === "IFRAME_RELOAD") return denied(IFRAME_RELOAD_SAFETY_REASON);
  if (action === "PLAY") {
    if (context.hasVideo === false) return denied("No selected HTML media element is available");
    if (context.playIntent === "USER_PAUSED") return denied("The viewer intentionally paused playback");
  }
  if (action === "LIVE_EDGE") {
    if (context.hasVideo === false) return denied("No selected HTML media element is available");
    if (context.followingLive !== true) return denied("Follow-live intent has not been positively established");
  }
  if (action === "RETRY_BUTTON" && context.hasRetryControl === false) return denied("No unambiguous configured retry control is available");
  if (action === "MEDIA_RELOAD") {
    if (context.hasVideo === false) return denied("No selected HTML media element is available");
    if (context.playerType === "WEBRTC" || context.playerType === "CANVAS") return denied("This player type does not expose a reloadable media resource");
    if (["MSE", "HLS_JS", "DASH_JS"].includes(context.playerType ?? "") && context.mediaReloadSafe !== true) {
      return denied("A JavaScript-managed media source has not declared media reload safe");
    }
  }
  return { allowed: true, reason: "Action preconditions are satisfied" };
}

function learnedScore(model: LocalSiteModel, kind: FailureKind, action: RecoveryAction): number {
  return contextualSuccessRate(model, kind, action);
}
function risk(action: RecoveryAction): number {
  return ACTION_DEFINITIONS[action].risk;
}
function unique(actions: RecoveryAction[]): RecoveryAction[] { return [...new Set(actions)]; }
function denied(reason: string): { allowed: false; reason: string } { return { allowed: false, reason }; }
