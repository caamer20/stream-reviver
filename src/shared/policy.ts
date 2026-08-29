import type { EffectiveSettings, FailureKind, LocalSiteModel, RecoveryAction } from "./types";

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

export function planRecovery(kind: FailureKind, settings: EffectiveSettings, model?: LocalSiteModel | null): RecoveryAction[] {
  const enabled = new Set(settings.recoveryStrategy);
  enabled.add("USER_PROMPT");
  enabled.add("REDISCOVER");
  let actions = POLICIES[kind].filter((action) => enabled.has(action));
  if (!settings.retryButtonSelector) actions = actions.filter((action) => action !== "RETRY_BUTTON");
  if (!settings.backupUrls.length) actions = actions.filter((action) => action !== "BACKUP_HANDOFF");
  if (!settings.enableAdaptiveTuning || !model || model.sampleCount < 20 || model.sessionCount < 3) return unique(actions).slice(0, settings.maxRecoveryActionsPerCycle);
  const safe = actions.filter((action) => risk(action) <= 2);
  const disruptive = actions.filter((action) => risk(action) > 2);
  safe.sort((a, b) => learnedScore(model, b) - learnedScore(model, a) || risk(a) - risk(b));
  return unique([...safe, ...disruptive]).slice(0, settings.maxRecoveryActionsPerCycle);
}

export function actionRisk(action: RecoveryAction): number { return risk(action); }

function learnedScore(model: LocalSiteModel, action: RecoveryAction): number {
  const outcome = model.actionOutcomes[action];
  if (!outcome) return 0.5;
  return (outcome.successes + 1) / (outcome.successes + outcome.failures + 2);
}
function risk(action: RecoveryAction): number {
  if (action === "WAIT" || action === "REDISCOVER") return 0;
  if (action === "USER_PROMPT" || action === "PLAY" || action === "LIVE_EDGE") return 1;
  if (action === "RETRY_BUTTON" || action === "MEDIA_RELOAD") return 2;
  if (action === "IFRAME_RELOAD") return 3;
  if (action === "PAGE_RELOAD") return 4;
  return 5;
}
function unique(actions: RecoveryAction[]): RecoveryAction[] { return [...new Set(actions)]; }
