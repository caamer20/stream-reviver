import { SETTINGS_SCHEMA_VERSION, type RuntimeMessage } from "./types";

export interface ValidationResult { ok: boolean; error?: string }

type Validator = (value: unknown) => ValidationResult;

const noPayload = new Set<RuntimeMessage["type"]>([
  "GET_PROFILES", "GET_DASHBOARD_STATE", "ACKNOWLEDGE_DISCLAIMER", "GET_PRIVACY_STATE", "ACKNOWLEDGE_VISUAL_PRIVACY",
  "REQUEST_PARENT_MAXIMIZE", "CANCEL_SELECTOR_PICKER", "RETRY_MONITORING",
  "PICTURE_IN_PICTURE_NOW", "JUMP_TO_LIVE_NOW", "STOP_ELEMENT_PICKER", "SHUTDOWN_MONITOR", "RESET_RUNTIME_STATE"
]);
const knownTypes = new Set<RuntimeMessage["type"]>([
  "GET_CONTEXT", "GET_POPUP_STATE", "GET_DASHBOARD_STATE", "FOCUS_DASHBOARD_TAB", "GET_HISTORY", "GET_SITE_MODEL", "GET_PROFILES", "SAVE_PROFILE", "DELETE_PROFILE",
  "CLEAR_HISTORY", "CLEAR_DATA", "GET_PRIVACY_STATE", "ACKNOWLEDGE_VISUAL_PRIVACY", "ACKNOWLEDGE_DISCLAIMER",
  "UPDATE_GLOBAL_SETTINGS", "SET_SITE_ENABLED", "SET_SITE_OVERRIDES", "SAVE_SITE_SELECTOR", "REPORT_STATUS", "LOG_HISTORY",
  "VALIDATE_SITE_SELECTOR",
  "REQUEST_AUTO_REFRESH", "RECORD_AUTO_REFRESH", "AUTHORIZE_RECOVERY_ACTION", "COMMIT_RECOVERY_ACTION", "COMPLETE_RECOVERY_ACTION", "EXTEND_AUTO_REFRESH", "CANCEL_AUTO_REFRESH", "PLAYBACK_SUCCESS", "RECORD_ACTION_OUTCOME",
  "RECORD_HEALTH_SAMPLE", "RECORD_USER_FEEDBACK", "SAVE_SESSION_SNAPSHOT", "CLEAR_SESSION_SNAPSHOT", "CLAIM_AUTO_MAXIMIZE",
  "SAVE_PLAYER_PREFERENCES", "REQUEST_PARENT_MAXIMIZE", "REQUEST_IFRAME_RECOVERY", "MANUAL_REFRESH", "MANUAL_MAXIMIZE",
  "MANUAL_PICTURE_IN_PICTURE", "MANUAL_JUMP_TO_LIVE", "PIN_PRIMARY_VIDEO", "START_SELECTOR_PICKER", "CANCEL_SELECTOR_PICKER",
  "SNOOZE_TAB", "SET_EVENT_MODE", "RESET_TAB_ATTEMPTS", "REQUEST_VISUAL_SAMPLE", "EXTEND_COUNTDOWN", "CANCEL_TAB_COUNTDOWN",
  "SHUTDOWN_MONITOR", "RESET_RUNTIME_STATE", "SETTINGS_CHANGED", "START_COUNTDOWN", "EXTEND_COUNTDOWN_IN_PAGE", "STOP_COUNTDOWN", "SHOW_LOOP_WARNING", "RETRY_MONITORING",
  "RESTORE_SESSION_SNAPSHOT", "SNOOZE_UNTIL", "EVENT_MODE_UNTIL", "MAXIMIZE_NOW", "PICTURE_IN_PICTURE_NOW", "JUMP_TO_LIVE_NOW", "MAXIMIZE_IFRAME",
  "RECOVER_IFRAME", "BEGIN_ELEMENT_PICKER", "VALIDATE_SELECTOR", "STOP_ELEMENT_PICKER"
]);

const globalBooleanKeys = [
  "enabled", "autoRecover", "autoRefresh", "autoMaximize", "onlyWhenTabVisible", "waitWhileOffline", "lockPrimaryVideo",
  "detectFrozenFrames", "restorePlayerPreferences", "useCssMaximizeFallback", "attemptNativeFullscreenClick",
  "enablePictureInPicture", "showBadge", "showNotifications", "localHistoryEnabled", "enableAdaptiveTuning",
  "enableAdvancedPlayerBridge", "enableVisualWatchdog", "keepScreenAwake", "protectTabFromDiscard"
] as const;
const globalNumericBounds = {
  checkIntervalSeconds: [1, 60], healthyCheckIntervalSeconds: [2, 120], suspectCheckIntervalSeconds: [0.5, 10],
  mutationDebounceMs: [100, 5_000], stallTimeoutSeconds: [5, 300], pageLoadGraceSeconds: [0, 300],
  refreshCountdownSeconds: [1, 60], maxAutoRefreshes: [1, 20], refreshWindowMinutes: [1, 1_440],
  successResetSeconds: [10, 3_600], failureConfidenceThreshold: [40, 100], failureConfirmationChecks: [1, 10],
  historyLimit: [20, 1_000], liveEdgeThresholdSeconds: [5, 600], recoveryVerificationSeconds: [3, 120],
  maxRecoveryActionsPerCycle: [1, 30], visualSampleIntervalSeconds: [5, 120]
} as const;
const globalArrayKeys = ["recoveryStrategy", "recoveryBackoffSeconds"] as const;
const selectorFields = [
  "selectedVideoSelector", "videoContainerSelector", "fullscreenButtonSelector", "playButtonSelector", "retryButtonSelector",
  "liveButtonSelector", "errorSelector", "accessInterruptionSelector", "adIndicatorSelector"
] as const;
const siteOnlyKeys = [
  ...selectorFields, "declaredPlayerType", "backupUrls", "profileId", "includeUrlPatterns", "excludeUrlPatterns"
] as const;
const effectiveOnlyKeys = ["schemaVersion", "siteEnabled", ...siteOnlyKeys] as const;
const globalKeys = [...globalBooleanKeys, ...Object.keys(globalNumericBounds), ...globalArrayKeys] as const;

export function validateRuntimeMessage(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Message must be a plain object");
  if (typeof value.type !== "string" || !knownTypes.has(value.type as RuntimeMessage["type"])) return invalid("Unknown message type");
  if (hasUnsafeKey(value, 0)) return invalid("Message contains an unsafe key or exceeds nesting limits");
  try { if (JSON.stringify(value).length > 128_000) return invalid("Message exceeds 128 KB"); }
  catch { return invalid("Message is not serializable"); }

  const type = value.type as RuntimeMessage["type"];
  if (noPayload.has(type)) return exact(value, ["type"]);
  switch (type) {
    case "GET_CONTEXT": return all(exact(value, ["type", "origin", "pageUrl", "navigationId"]), origin(value.origin), url(value.pageUrl), identifier(value.navigationId));
    case "GET_POPUP_STATE": return all(exact(value, ["type", "tabId", "origin"]), optionalTab(value.tabId), optional(value.origin, origin));
    case "FOCUS_DASHBOARD_TAB": return all(exact(value, ["type", "tabId"]), tab(value.tabId));
    case "GET_HISTORY": return all(exact(value, ["type", "tabId", "limit"]), optionalTab(value.tabId), optionalNumber(value.limit, 1, 1_000));
    case "GET_SITE_MODEL": return all(exact(value, ["type", "origin"]), origin(value.origin));
    case "DELETE_PROFILE": return all(exact(value, ["type", "profileId"]), text(value.profileId, 1, 100));
    case "CLEAR_HISTORY": return all(exact(value, ["type", "tabId"]), optionalTab(value.tabId));
    case "CLEAR_DATA": return all(exact(value, ["type", "target"]), oneOf(value.target, ["history", "models", "preferences", "profiles", "runtime", "all"]));
    case "SAVE_PROFILE": return all(exact(value, ["type", "profile"]), profile(value.profile));
    case "UPDATE_GLOBAL_SETTINGS": return all(exact(value, ["type", "patch"]), globalSettings(value.patch, "partial"));
    case "SET_SITE_ENABLED": return all(exact(value, ["type", "origin", "enabled", "tabId"]), origin(value.origin), bool(value.enabled), optionalTab(value.tabId));
    case "SET_SITE_OVERRIDES": return all(exact(value, ["type", "origin", "overrides", "replace"]), origin(value.origin), siteSettings(value.overrides), optionalBoolean(value.replace));
    case "SAVE_SITE_SELECTOR": return all(exact(value, ["type", "origin", "field", "selector", "tabId"]), origin(value.origin), selectorField(value.field), text(value.selector, 0, 500), optionalTab(value.tabId));
    case "VALIDATE_SITE_SELECTOR": return all(exact(value, ["type", "origin", "field", "selector"]), origin(value.origin), selectorField(value.field), text(value.selector, 0, 500));
    case "REPORT_STATUS": return all(exact(value, ["type", "status"]), status(value.status));
    case "LOG_HISTORY": return all(exact(value, ["type", "entry"]), historyEntry(value.entry));
    case "REQUEST_AUTO_REFRESH": return all(exact(value, ["type", "origin", "pageUrl", "reason", "confidence"]), origin(value.origin), url(value.pageUrl), text(value.reason, 1, 500), number(value.confidence, 0, 100));
    case "RECORD_AUTO_REFRESH": return all(exact(value, ["type", "origin", "pageUrl"]), origin(value.origin), url(value.pageUrl));
    case "AUTHORIZE_RECOVERY_ACTION": return all(
      exact(value, ["type", "origin", "pageUrl", "recoveryCycleId", "action", "reason", "confidence"]),
      origin(value.origin), url(value.pageUrl), identifier(value.recoveryCycleId), recoveryAction(value.action),
      text(value.reason, 1, 500), number(value.confidence, 0, 100)
    );
    case "COMMIT_RECOVERY_ACTION": return all(
      exact(value, ["type", "pageUrl", "recoveryCycleId", "actionId", "authorizationNonce"]), url(value.pageUrl),
      identifier(value.recoveryCycleId), identifier(value.actionId), identifier(value.authorizationNonce)
    );
    case "COMPLETE_RECOVERY_ACTION": return all(
      exact(value, ["type", "origin", "pageUrl", "recoveryCycleId", "actionId", "authorizationNonce", "success", "durationMs", "failureKind", "reason"]),
      origin(value.origin), url(value.pageUrl), identifier(value.recoveryCycleId), identifier(value.actionId), identifier(value.authorizationNonce),
      bool(value.success), number(value.durationMs, 0, 24 * 60 * 60_000), failureKind(value.failureKind), optional(value.reason, (item) => text(item, 0, 500))
    );
    case "EXTEND_AUTO_REFRESH": return all(
      exact(value, ["type", "recoveryCycleId", "actionId", "authorizationNonce", "seconds"]),
      identifier(value.recoveryCycleId), identifier(value.actionId), identifier(value.authorizationNonce), number(value.seconds, 1, 600)
    );
    case "CANCEL_AUTO_REFRESH": return all(
      exact(value, ["type", "recoveryCycleId", "actionId", "authorizationNonce"]),
      optional(value.recoveryCycleId, identifier), optional(value.actionId, identifier), optional(value.authorizationNonce, identifier)
    );
    case "PLAYBACK_SUCCESS": return all(exact(value, ["type", "pageUrl", "recoveryCycleId"]), url(value.pageUrl), optional(value.recoveryCycleId, identifier));
    case "CLAIM_AUTO_MAXIMIZE": return all(
      exact(value, ["type", "pageUrl", "recoveryCycleId"]), url(value.pageUrl), identifier(value.recoveryCycleId)
    );
    case "RECORD_ACTION_OUTCOME": return all(exact(value, ["type", "origin", "outcome"]), origin(value.origin), actionOutcome(value.outcome));
    case "RECORD_HEALTH_SAMPLE": return all(exact(value, ["type", "origin", "sample"]), origin(value.origin), healthSample(value.sample));
    case "RECORD_USER_FEEDBACK": return all(exact(value, ["type", "origin", "correct", "failureKind"]), origin(value.origin), bool(value.correct), failureKind(value.failureKind));
    case "SAVE_SESSION_SNAPSHOT": return all(exact(value, ["type", "snapshot"]), snapshot(value.snapshot));
    case "CLEAR_SESSION_SNAPSHOT": return all(exact(value, ["type", "origin", "recoveryCycleId"]), origin(value.origin), optional(value.recoveryCycleId, identifier));
    case "SAVE_PLAYER_PREFERENCES": return all(exact(value, ["type", "origin", "preferences"]), origin(value.origin), preferences(value.preferences));
    case "REQUEST_IFRAME_RECOVERY": case "RECOVER_IFRAME": return all(exact(value, ["type", "frameToken"]), text(value.frameToken, 1, 100));
    case "MANUAL_REFRESH": return all(exact(value, ["type", "tabId", "origin"]), tab(value.tabId), origin(value.origin));
    case "MANUAL_MAXIMIZE": case "MANUAL_PICTURE_IN_PICTURE": case "MANUAL_JUMP_TO_LIVE": case "PIN_PRIMARY_VIDEO":
    case "RESET_TAB_ATTEMPTS": case "CANCEL_TAB_COUNTDOWN": return all(exact(value, ["type", "tabId"]), tab(value.tabId));
    case "START_SELECTOR_PICKER": return all(exact(value, ["type", "origin", "field"]), origin(value.origin), selectorField(value.field));
    case "SNOOZE_TAB": case "SET_EVENT_MODE": return all(exact(value, ["type", "tabId", "until"]), tab(value.tabId), nullableNumber(value.until, -1, Date.now() + 366 * 24 * 60 * 60_000));
    case "REQUEST_VISUAL_SAMPLE": return all(
      exact(value, ["type", "origin", "pageUrl", "navigationId", "candidateId", "candidateEpoch", "rect", "viewport"]),
      origin(value.origin), url(value.pageUrl), identifier(value.navigationId), text(value.candidateId, 0, 200),
      integer(value.candidateEpoch, 0, Number.MAX_SAFE_INTEGER), rectangle(value.rect), viewport(value.viewport)
    );
    case "EXTEND_COUNTDOWN": return all(exact(value, ["type", "tabId", "seconds"]), tab(value.tabId), number(value.seconds, 1, 600));
    case "SETTINGS_CHANGED": return all(exact(value, ["type", "settings"]), effectiveSettings(value.settings));
    case "START_COUNTDOWN": return all(
      exact(value, ["type", "reason", "deadline", "recoveryCycleId", "actionId", "authorizationNonce"]),
      text(value.reason, 1, 500), number(value.deadline, 0, Date.now() + 24 * 60 * 60_000),
      identifier(value.recoveryCycleId), identifier(value.actionId), identifier(value.authorizationNonce)
    );
    case "EXTEND_COUNTDOWN_IN_PAGE": return all(
      exact(value, ["type", "deadline", "recoveryCycleId", "actionId", "authorizationNonce"]),
      number(value.deadline, 0, Date.now() + 24 * 60 * 60_000), identifier(value.recoveryCycleId),
      identifier(value.actionId), identifier(value.authorizationNonce)
    );
    case "STOP_COUNTDOWN": return all(
      exact(value, ["type", "recoveryCycleId", "actionId", "authorizationNonce", "reason", "cancelRecovery"]),
      identifier(value.recoveryCycleId), identifier(value.actionId), identifier(value.authorizationNonce),
      optional(value.reason, (item) => text(item, 0, 500)), optionalBoolean(value.cancelRecovery)
    );
    case "RESTORE_SESSION_SNAPSHOT": return all(exact(value, ["type", "snapshot"]), snapshot(value.snapshot));
    case "SHOW_LOOP_WARNING": return all(exact(value, ["type", "detail"]), text(value.detail, 1, 500));
    case "SNOOZE_UNTIL": case "EVENT_MODE_UNTIL": return all(exact(value, ["type", "until"]), nullableNumber(value.until, -1, Date.now() + 366 * 24 * 60 * 60_000));
    case "MAXIMIZE_NOW": case "MAXIMIZE_IFRAME": return all(exact(value, ["type", "manual"]), optionalBoolean(value.manual));
    case "BEGIN_ELEMENT_PICKER": return all(exact(value, ["type", "field"]), selectorField(value.field));
    case "VALIDATE_SELECTOR": return all(exact(value, ["type", "field", "selector"]), selectorField(value.field), text(value.selector, 0, 500));
    default: return invalid("Message schema is not implemented");
  }
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage { return validateRuntimeMessage(value).ok; }

function globalSettings(value: unknown, mode: "partial" | "required"): ValidationResult {
  if (!isRecord(value)) return invalid("Settings must be a plain object");
  const shape = exact(value, globalKeys);
  if (!shape.ok) return shape;
  const required = mode === "required";
  const results: ValidationResult[] = [];
  for (const key of globalBooleanKeys) results.push(required || hasOwn(value, key) ? bool(value[key]) : valid());
  for (const [key, [minimum, maximum]] of Object.entries(globalNumericBounds)) {
    results.push(required || hasOwn(value, key) ? number(value[key], minimum, maximum) : valid());
  }
  if (required || hasOwn(value, "recoveryStrategy")) results.push(array(value.recoveryStrategy, recoveryAction, 0, 10));
  if (required || hasOwn(value, "recoveryBackoffSeconds")) {
    results.push(array(value.recoveryBackoffSeconds, (item) => number(item, 1, 3_600), 0, 10));
  }
  return all(...results);
}

function siteSettings(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Site settings must be a plain object");
  const shape = exact(value, [...globalKeys, ...siteOnlyKeys]);
  if (!shape.ok) return shape;
  const results: ValidationResult[] = [];
  for (const key of globalBooleanKeys) if (hasOwn(value, key)) results.push(bool(value[key]));
  for (const [key, [minimum, maximum]] of Object.entries(globalNumericBounds)) {
    if (hasOwn(value, key)) results.push(number(value[key], minimum, maximum));
  }
  if (hasOwn(value, "recoveryStrategy")) results.push(array(value.recoveryStrategy, recoveryAction, 0, 10));
  if (hasOwn(value, "recoveryBackoffSeconds")) results.push(array(value.recoveryBackoffSeconds, (item) => number(item, 1, 3_600), 0, 10));
  for (const key of selectorFields) if (hasOwn(value, key)) results.push(text(value[key], 0, 500));
  if (hasOwn(value, "declaredPlayerType")) results.push(playerType(value.declaredPlayerType));
  if (hasOwn(value, "backupUrls")) results.push(array(value.backupUrls, httpUrl, 0, 10));
  if (hasOwn(value, "profileId")) results.push(text(value.profileId, 0, 100));
  if (hasOwn(value, "includeUrlPatterns")) results.push(array(value.includeUrlPatterns, (item) => text(item, 1, 500), 0, 50));
  if (hasOwn(value, "excludeUrlPatterns")) results.push(array(value.excludeUrlPatterns, (item) => text(item, 1, 500), 0, 50));
  return all(...results);
}

function effectiveSettings(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Effective settings must be a plain object");
  const shape = exact(value, [...globalKeys, ...effectiveOnlyKeys]);
  if (!shape.ok) return shape;
  const globals: Record<string, unknown> = {};
  for (const key of globalKeys) if (hasOwn(value, key)) globals[key] = value[key];
  return all(
    globalSettings(globals, "required"),
    integer(value.schemaVersion, 1, SETTINGS_SCHEMA_VERSION), bool(value.siteEnabled),
    ...selectorFields.map((key) => text(value[key], 0, 500)), playerType(value.declaredPlayerType),
    array(value.backupUrls, httpUrl, 0, 10), text(value.profileId, 0, 100),
    array(value.includeUrlPatterns, (item) => text(item, 1, 500), 0, 50),
    array(value.excludeUrlPatterns, (item) => text(item, 1, 500), 0, 50)
  );
}

function profile(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Profile must be a plain object");
  return all(
    exact(value, ["schemaVersion", "id", "name", "version", "originPatterns", "urlPatterns", "declaredPlayerType", "selectors", "recoveryStrategy", "backupUrls", "notes", "createdAt", "updatedAt"]),
    oneOf(value.schemaVersion, [1]), text(value.id, 1, 100), text(value.name, 1, 100), integer(value.version, 1, 10_000),
    array(value.originPatterns, (item) => text(item, 1, 500), 0, 20), array(value.urlPatterns, (item) => text(item, 1, 500), 0, 50),
    playerType(value.declaredPlayerType), profileSelectors(value.selectors), array(value.recoveryStrategy, recoveryAction, 0, 10),
    array(value.backupUrls, httpUrl, 0, 10), text(value.notes, 0, 2_000),
    number(value.createdAt, 0, Date.now() + 60_000), number(value.updatedAt, 0, Date.now() + 60_000)
  );
}

function profileSelectors(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Profile selectors must be a plain object");
  const shape = exact(value, selectorFields);
  if (!shape.ok) return shape;
  return all(...selectorFields.map((key) => hasOwn(value, key) ? text(value[key], 0, 500) : valid()));
}

function status(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Status must be a plain object");
  return all(
    exact(value, [
      "state", "detail", "pageUrl", "origin", "hasVideo", "score", "confidence", "evidence", "selectedVideoLabel", "diagnosis",
      "streamKind", "liveIntent", "liveEdgeLagSeconds", "bufferAheadSeconds", "recoveryCycleId", "circuitState", "compatibility",
      "recoveryAction", "nextActionAt", "online", "pageVisible", "frameToken", "navigationId", "candidateId", "candidateEpoch"
    ]),
    monitorState(value.state), text(value.detail, 0, 1_000), url(value.pageUrl), origin(value.origin), bool(value.hasVideo),
    number(value.score, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), number(value.confidence, 0, 100), evidenceList(value.evidence),
    text(value.selectedVideoLabel, 0, 1_000), diagnosis(value.diagnosis), streamKind(value.streamKind), liveIntent(value.liveIntent),
    nullableNumber(value.liveEdgeLagSeconds, 0, 10 * 366 * 24 * 60 * 60), nullableNumber(value.bufferAheadSeconds, 0, 10 * 366 * 24 * 60 * 60),
    nullable(value.recoveryCycleId, identifier), circuitState(value.circuitState), compatibility(value.compatibility),
    nullable(value.recoveryAction, recoveryAction), nullableNumber(value.nextActionAt, 0, Date.now() + 31 * 24 * 60 * 60_000),
    bool(value.online), bool(value.pageVisible), text(value.frameToken, 1, 100), identifier(value.navigationId),
    text(value.candidateId, 0, 200), integer(value.candidateEpoch, 0, Number.MAX_SAFE_INTEGER)
  );
}

function diagnosis(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Diagnosis must be a plain object");
  return all(
    exact(value, ["kind", "alternatives", "confidence", "severity", "detail", "evidence", "recoverySafe", "requiresUser", "observedAt"]),
    failureKind(value.kind), array(value.alternatives, failureKind, 0, 20), number(value.confidence, 0, 100),
    oneOf(value.severity, ["none", "info", "warning", "critical"]), text(value.detail, 0, 1_000), evidenceList(value.evidence),
    bool(value.recoverySafe), bool(value.requiresUser), number(value.observedAt, 0, Date.now() + 24 * 60 * 60_000)
  );
}

function evidenceList(value: unknown): ValidationResult {
  return array(value, (item) => {
    if (!isRecord(item)) return invalid("Evidence must be a plain object");
    return all(exact(item, ["signal", "detail", "weight"]), text(item.signal, 1, 100), text(item.detail, 0, 1_000), number(item.weight, 0, 100));
  }, 0, 20);
}

function compatibility(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Compatibility must be a plain object");
  return all(
    exact(value, ["htmlVideo", "crossFrame", "frameCallbacks", "playbackQuality", "liveEdge", "pictureInPicture", "fullscreen", "wakeLock", "protocolBridge", "visualWatchdog", "playerType", "level", "limitations"]),
    bool(value.htmlVideo), bool(value.crossFrame), bool(value.frameCallbacks), bool(value.playbackQuality), bool(value.liveEdge),
    bool(value.pictureInPicture), bool(value.fullscreen), bool(value.wakeLock), bool(value.protocolBridge), bool(value.visualWatchdog),
    playerType(value.playerType), oneOf(value.level, ["FULL", "PARTIAL", "RESTRICTED"]),
    array(value.limitations, (item) => text(item, 0, 500), 0, 20)
  );
}

function historyEntry(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("History entry must be a plain object");
  return all(
    exact(value, ["event", "detail", "level", "url", "metadata"]), text(value.event, 1, 100), text(value.detail, 0, 2_000),
    oneOf(value.level, ["info", "warning", "error", "success"]), url(value.url), optional(value.metadata, historyMetadata)
  );
}

function historyMetadata(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("History metadata must be a plain object");
  const fields = [
    "action", "actionId", "recoveryCycleId", "failureKind", "diagnosis", "confidence", "evidence", "risk", "score", "state",
    "recoveryAction", "streamKind", "liveIntent", "liveEdgeLagSeconds", "bufferAheadSeconds", "circuitState", "compatibility"
  ] as const;
  const shape = exact(value, fields);
  if (!shape.ok) return shape;
  const validators: Partial<Record<(typeof fields)[number], Validator>> = {
    action: recoveryAction, actionId: identifier, recoveryCycleId: (item) => nullable(item, identifier), failureKind,
    diagnosis, confidence: (item) => number(item, 0, 100), evidence: evidenceList, risk: (item) => number(item, 0, 5),
    score: (item) => number(item, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), state: monitorState,
    recoveryAction: (item) => nullable(item, recoveryAction), streamKind, liveIntent,
    liveEdgeLagSeconds: (item) => nullableNumber(item, 0, 10 * 366 * 24 * 60 * 60),
    bufferAheadSeconds: (item) => nullableNumber(item, 0, 10 * 366 * 24 * 60 * 60), circuitState, compatibility
  };
  return all(...fields.map((key) => hasOwn(value, key) ? validators[key]!(value[key]) : valid()));
}

function actionOutcome(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Action outcome must be a plain object");
  return all(
    exact(value, ["action", "failureKind", "success", "durationMs", "timestamp"]), recoveryAction(value.action), failureKind(value.failureKind),
    bool(value.success), number(value.durationMs, 0, 24 * 60 * 60_000), number(value.timestamp, 0, Date.now() + 60_000)
  );
}

function healthSample(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Health sample must be a plain object");
  return all(
    exact(value, ["startupMs", "rebufferMs", "liveLagSeconds", "timestamp"]), number(value.startupMs, 0, 24 * 60 * 60_000),
    number(value.rebufferMs, 0, 24 * 60 * 60_000), nullableNumber(value.liveLagSeconds, 0, 24 * 60 * 60),
    number(value.timestamp, 0, Date.now() + 60_000)
  );
}

function snapshot(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Session snapshot must be a plain object");
  const shape = exact(value, [
    "id", "origin", "pageUrlKey", "playerLabel", "streamKind", "wasPlaying", "mediaPosition", "volume", "muted", "playbackRate",
    "captionsShowing", "cssMaximized", "followingLive", "pictureInPicture", "scrollX", "scrollY", "createdAt", "expiresAt",
    "recoveryCycleId", "navigationId"
  ]);
  const preferenceShape = preferences(value, true);
  const createdAt = number(value.createdAt, 0, Date.now() + 60_000);
  const expiresAt = number(value.expiresAt, 0, Date.now() + 31 * 24 * 60 * 60_000);
  const chronological = createdAt.ok && expiresAt.ok && (value.expiresAt as number) >= (value.createdAt as number)
    ? valid() : invalid("Session snapshot expiration precedes creation");
  return all(
    shape, preferenceShape, text(value.id, 1, 100), origin(value.origin), text(value.pageUrlKey, 1, 2_000),
    text(value.playerLabel, 0, 1_000), streamKind(value.streamKind), bool(value.wasPlaying),
    nullableNumber(value.mediaPosition, 0, 10 * 366 * 24 * 60 * 60), number(value.scrollX, -10_000_000, 10_000_000),
    number(value.scrollY, -10_000_000, 10_000_000), createdAt, expiresAt, chronological,
    identifier(value.recoveryCycleId), identifier(value.navigationId)
  );
}

function preferences(value: unknown, allowSnapshotFields = false): ValidationResult {
  if (!isRecord(value)) return invalid("Preferences must be a plain object");
  const allowed = ["volume", "muted", "playbackRate", "captionsShowing", "cssMaximized", "followingLive", "pictureInPicture"];
  const shape = allowSnapshotFields ? valid() : exact(value, allowed);
  return all(
    shape, number(value.volume, 0, 1), bool(value.muted), number(value.playbackRate, 0.1, 16),
    bool(value.captionsShowing), bool(value.cssMaximized), optionalBoolean(value.followingLive), optionalBoolean(value.pictureInPicture)
  );
}

function rectangle(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Rectangle must be a plain object");
  return all(
    exact(value, ["x", "y", "width", "height"]), number(value.x, -100_000, 100_000), number(value.y, -100_000, 100_000),
    number(value.width, 1, 100_000), number(value.height, 1, 100_000)
  );
}

function viewport(value: unknown): ValidationResult {
  if (!isRecord(value)) return invalid("Viewport must be a plain object");
  return all(exact(value, ["width", "height"]), number(value.width, 1, 100_000), number(value.height, 1, 100_000));
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): ValidationResult {
  const permitted = new Set(allowed);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && permitted.has(key))
    ? valid() : invalid("Object contains an unexpected field");
}
function selectorField(value: unknown): ValidationResult { return oneOf(value, selectorFields); }
function recoveryAction(value: unknown): ValidationResult { return oneOf(value, ["WAIT", "USER_PROMPT", "REDISCOVER", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "MEDIA_RELOAD", "IFRAME_RELOAD", "PAGE_RELOAD", "BACKUP_HANDOFF"]); }
function failureKind(value: unknown): ValidationResult { return oneOf(value, [
  "NONE", "STARTUP_DELAY", "USER_PAUSED", "AUTOPLAY_BLOCKED", "NETWORK_OFFLINE", "NETWORK_STARVATION",
  "BUFFER_UNDERRUN", "LIVE_EDGE_DRIFT", "DECODE_FREEZE", "RENDER_FREEZE", "MEDIA_SOURCE_ERROR",
  "NO_USABLE_SOURCE", "LIVE_STREAM_ENDED", "PLAYER_REPLACED", "PLAYER_CONTROL_ERROR", "WEBRTC_NETWORK_FAILURE",
  "ACCESS_INTERRUPTION", "TAB_SUSPENDED", "BROWSER_RESUMED", "UNKNOWN_FAILURE"
]); }
function playerType(value: unknown): ValidationResult { return oneOf(value, ["AUTO", "HTML5", "MSE", "HLS_JS", "DASH_JS", "WEBRTC", "CANVAS"]); }
function monitorState(value: unknown): ValidationResult { return oneOf(value, [
  "DISABLED", "SITE_NOT_ENABLED", "URL_EXCLUDED", "SNOOZED", "OFFLINE", "NO_VIDEO_FOUND", "LIMITED_VISIBILITY", "MONITORING",
  "HEALTHY", "SUSPECTED_DOWN", "RECOVERING", "COUNTDOWN", "REFRESHING", "PAUSED_TOO_MANY_REFRESHES", "MAXIMIZE_BLOCKED", "ERROR"
]); }
function streamKind(value: unknown): ValidationResult { return oneOf(value, ["CONFIRMED_LIVE", "LIKELY_LIVE", "DVR_LIVE", "VOD", "UNKNOWN"]); }
function liveIntent(value: unknown): ValidationResult { return oneOf(value, ["FOLLOWING_LIVE", "INTENTIONALLY_BEHIND_LIVE", "UNKNOWN_LIVE_POSITION"]); }
function circuitState(value: unknown): ValidationResult { return oneOf(value, ["CLOSED", "VERIFYING", "HALF_OPEN", "OPEN_COOLDOWN", "OPEN_REQUIRES_USER"]); }
function identifier(value: unknown): ValidationResult { return text(value, 1, 200); }
function origin(value: unknown): ValidationResult {
  if (value === "file://") return valid();
  if (typeof value !== "string" || value.length > 2_000) return invalid("Invalid origin");
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && parsed.origin === value ? valid() : invalid("Invalid origin"); }
  catch { return invalid("Invalid origin"); }
}
function url(value: unknown): ValidationResult {
  if (typeof value !== "string" || value.length > 8_000) return invalid("Invalid URL");
  try { return ["http:", "https:", "file:"].includes(new URL(value).protocol) ? valid() : invalid("Unsupported URL scheme"); }
  catch { return invalid("Invalid URL"); }
}
function httpUrl(value: unknown): ValidationResult {
  if (typeof value !== "string" || value.length > 2_000) return invalid("Invalid HTTP URL");
  try { return ["http:", "https:"].includes(new URL(value).protocol) ? valid() : invalid("Unsupported URL scheme"); }
  catch { return invalid("Invalid HTTP URL"); }
}
function array(value: unknown, validator: Validator, minimum: number, maximum: number): ValidationResult {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return invalid("Invalid array field");
  return all(...value.map(validator));
}
function text(value: unknown, minimum: number, maximum: number): ValidationResult { return typeof value === "string" && value.length >= minimum && value.length <= maximum ? valid() : invalid("Invalid text field"); }
function number(value: unknown, minimum: number, maximum: number): ValidationResult { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? valid() : invalid("Invalid numeric field"); }
function integer(value: unknown, minimum: number, maximum: number): ValidationResult { return Number.isInteger(value) ? number(value, minimum, maximum) : invalid("Invalid integer field"); }
function tab(value: unknown): ValidationResult { return integer(value, 0, Number.MAX_SAFE_INTEGER).ok ? valid() : invalid("Invalid tab identifier"); }
function optionalTab(value: unknown): ValidationResult { return value === undefined ? valid() : tab(value); }
function bool(value: unknown): ValidationResult { return typeof value === "boolean" ? valid() : invalid("Invalid boolean field"); }
function optionalBoolean(value: unknown): ValidationResult { return value === undefined ? valid() : bool(value); }
function optionalNumber(value: unknown, minimum: number, maximum: number): ValidationResult { return value === undefined ? valid() : number(value, minimum, maximum); }
function nullableNumber(value: unknown, minimum: number, maximum: number): ValidationResult { return value === null ? valid() : number(value, minimum, maximum); }
function oneOf(value: unknown, values: readonly unknown[]): ValidationResult { return values.includes(value) ? valid() : invalid("Invalid enum value"); }
function optional(value: unknown, validator: Validator): ValidationResult { return value === undefined ? valid() : validator(value); }
function nullable(value: unknown, validator: Validator): ValidationResult { return value === null ? valid() : validator(value); }
function all(...results: ValidationResult[]): ValidationResult { return results.find((result) => !result.ok) ?? valid(); }
function valid(): ValidationResult { return { ok: true }; }
function invalid(error: string): ValidationResult { return { ok: false, error }; }
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function hasUnsafeKey(value: unknown, depth: number): boolean {
  if (depth > 12 || !value || typeof value !== "object") return depth > 12;
  if (Array.isArray(value)) return value.length > 2_000 || value.some((item) => hasUnsafeKey(item, depth + 1));
  if (!isRecord(value)) return true;
  const entries = Object.entries(value);
  return entries.length > 500 || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) ||
    entries.some(([, item]) => hasUnsafeKey(item, depth + 1));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
