export const SETTINGS_SCHEMA_VERSION = 4;

export type FailureKind =
  | "NONE"
  | "STARTUP_DELAY"
  | "USER_PAUSED"
  | "AUTOPLAY_BLOCKED"
  | "NETWORK_OFFLINE"
  | "NETWORK_STARVATION"
  | "BUFFER_UNDERRUN"
  | "LIVE_EDGE_DRIFT"
  | "DECODE_FREEZE"
  | "RENDER_FREEZE"
  | "MEDIA_SOURCE_ERROR"
  | "NO_USABLE_SOURCE"
  | "LIVE_STREAM_ENDED"
  | "PLAYER_REPLACED"
  | "PLAYER_CONTROL_ERROR"
  | "WEBRTC_NETWORK_FAILURE"
  | "ACCESS_INTERRUPTION"
  | "TAB_SUSPENDED"
  | "BROWSER_RESUMED"
  | "UNKNOWN_FAILURE";

export type StreamKind = "CONFIRMED_LIVE" | "LIKELY_LIVE" | "DVR_LIVE" | "VOD" | "UNKNOWN";
export type LiveIntent = "FOLLOWING_LIVE" | "INTENTIONALLY_BEHIND_LIVE" | "UNKNOWN_LIVE_POSITION";
/**
 * The strongest playback intent the monitor can establish without guessing.
 * Ambiguous page-driven pauses remain SITE_PAUSED and are never treated as a
 * request to resume automatically.
 */
export type PlaybackIntent =
  | "NEVER_PLAYED"
  | "USER_REQUESTED_PLAY"
  | "PLAYING"
  | "USER_PAUSED"
  | "AUTOPLAY_BLOCKED"
  | "SITE_PAUSED"
  | "ENDED_NORMALLY";
export type PlayerType = "AUTO" | "HTML5" | "MSE" | "HLS_JS" | "DASH_JS" | "WEBRTC" | "CANVAS";
export type CircuitState = "CLOSED" | "VERIFYING" | "HALF_OPEN" | "OPEN_COOLDOWN" | "OPEN_REQUIRES_USER";
export type DataClearTarget = "history" | "models" | "preferences" | "profiles" | "runtime" | "all";

export type MonitorState =
  | "DISABLED"
  | "SITE_NOT_ENABLED"
  | "URL_EXCLUDED"
  | "SNOOZED"
  | "OFFLINE"
  | "NO_VIDEO_FOUND"
  | "LIMITED_VISIBILITY"
  | "MONITORING"
  | "HEALTHY"
  | "SUSPECTED_DOWN"
  | "RECOVERING"
  | "COUNTDOWN"
  | "REFRESHING"
  | "PAUSED_TOO_MANY_REFRESHES"
  | "MAXIMIZE_BLOCKED"
  | "ERROR";

export type RecoveryAction =
  | "WAIT"
  | "USER_PROMPT"
  | "REDISCOVER"
  | "PLAY"
  | "LIVE_EDGE"
  | "RETRY_BUTTON"
  | "MEDIA_RELOAD"
  | "IFRAME_RELOAD"
  | "PAGE_RELOAD"
  | "BACKUP_HANDOFF";

export type SelectorField =
  | "selectedVideoSelector"
  | "videoContainerSelector"
  | "fullscreenButtonSelector"
  | "playButtonSelector"
  | "retryButtonSelector"
  | "liveButtonSelector"
  | "errorSelector"
  | "accessInterruptionSelector"
  | "adIndicatorSelector";

export interface GlobalSettings {
  enabled: boolean;
  /** Master switch for all automatic recovery actions. */
  autoRecover: boolean;
  /** Additional opt-in for the disruptive PAGE_RELOAD recovery action. */
  autoRefresh: boolean;
  autoMaximize: boolean;
  checkIntervalSeconds: number;
  healthyCheckIntervalSeconds: number;
  suspectCheckIntervalSeconds: number;
  mutationDebounceMs: number;
  stallTimeoutSeconds: number;
  pageLoadGraceSeconds: number;
  refreshCountdownSeconds: number;
  maxAutoRefreshes: number;
  refreshWindowMinutes: number;
  successResetSeconds: number;
  failureConfidenceThreshold: number;
  failureConfirmationChecks: number;
  onlyWhenTabVisible: boolean;
  waitWhileOffline: boolean;
  lockPrimaryVideo: boolean;
  detectFrozenFrames: boolean;
  restorePlayerPreferences: boolean;
  useCssMaximizeFallback: boolean;
  attemptNativeFullscreenClick: boolean;
  enablePictureInPicture: boolean;
  showBadge: boolean;
  showNotifications: boolean;
  localHistoryEnabled: boolean;
  historyLimit: number;
  enableAdaptiveTuning: boolean;
  enableAdvancedPlayerBridge: boolean;
  enableVisualWatchdog: boolean;
  keepScreenAwake: boolean;
  protectTabFromDiscard: boolean;
  liveEdgeThresholdSeconds: number;
  recoveryVerificationSeconds: number;
  maxRecoveryActionsPerCycle: number;
  visualSampleIntervalSeconds: number;
  recoveryStrategy: RecoveryAction[];
  recoveryBackoffSeconds: number[];
}

export interface SiteSettings extends Partial<GlobalSettings> {
  enabled?: boolean;
  selectedVideoSelector?: string;
  videoContainerSelector?: string;
  fullscreenButtonSelector?: string;
  playButtonSelector?: string;
  retryButtonSelector?: string;
  liveButtonSelector?: string;
  errorSelector?: string;
  accessInterruptionSelector?: string;
  adIndicatorSelector?: string;
  declaredPlayerType?: PlayerType;
  backupUrls?: string[];
  profileId?: string;
  includeUrlPatterns?: string[];
  excludeUrlPatterns?: string[];
}

export interface Settings extends GlobalSettings {
  schemaVersion: number;
  perSite: Record<string, SiteSettings>;
}

export interface EffectiveSettings extends GlobalSettings {
  schemaVersion: number;
  siteEnabled: boolean;
  selectedVideoSelector: string;
  videoContainerSelector: string;
  fullscreenButtonSelector: string;
  playButtonSelector: string;
  retryButtonSelector: string;
  liveButtonSelector: string;
  errorSelector: string;
  accessInterruptionSelector: string;
  adIndicatorSelector: string;
  declaredPlayerType: PlayerType;
  backupUrls: string[];
  profileId: string;
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
}

/**
 * Diagnostic hint emitted from the page's MAIN JavaScript world. Every field
 * is attacker-controlled from the extension's perspective and must never
 * independently authorize a recovery action.
 */
export interface ProtocolObservation {
  kind: "MSE" | "HLS_JS" | "DASH_JS" | "WEBRTC";
  observedAt: number;
  readyState?: string;
  fatalError?: string;
  appendAgeMs?: number;
  packetsReceivedDelta?: number;
  packetsLostDelta?: number;
  jitterSeconds?: number;
  framesDecodedDelta?: number;
  framesRenderedDelta?: number;
  freezeCountDelta?: number;
}

export interface FailureDiagnosis {
  kind: FailureKind;
  alternatives: FailureKind[];
  confidence: number;
  severity: "none" | "info" | "warning" | "critical";
  detail: string;
  evidence: HealthEvidence[];
  recoverySafe: boolean;
  requiresUser: boolean;
  observedAt: number;
}

export interface CompatibilityReport {
  htmlVideo: boolean;
  crossFrame: boolean;
  frameCallbacks: boolean;
  playbackQuality: boolean;
  liveEdge: boolean;
  pictureInPicture: boolean;
  fullscreen: boolean;
  wakeLock: boolean;
  protocolBridge: boolean;
  visualWatchdog: boolean;
  playerType: PlayerType;
  level: "FULL" | "PARTIAL" | "RESTRICTED";
  limitations: string[];
}

export interface HealthEvidence {
  signal: string;
  detail: string;
  weight: number;
}

export interface FrameStatus {
  state: MonitorState;
  detail: string;
  pageUrl: string;
  origin: string;
  hasVideo: boolean;
  score: number;
  confidence: number;
  evidence: HealthEvidence[];
  selectedVideoLabel: string;
  diagnosis: FailureDiagnosis;
  streamKind: StreamKind;
  liveIntent: LiveIntent;
  liveEdgeLagSeconds: number | null;
  bufferAheadSeconds: number | null;
  recoveryCycleId: string | null;
  circuitState: CircuitState;
  compatibility: CompatibilityReport;
  recoveryAction: RecoveryAction | null;
  nextActionAt: number | null;
  online: boolean;
  pageVisible: boolean;
  frameToken: string;
  navigationId: string;
  candidateId: string;
  candidateEpoch: number;
  updatedAt: number;
}

export interface RecoveryActionAuthorization {
  tabId: number;
  frameId: number;
  navigationId: string;
  candidateId: string;
  candidateEpoch: number;
  cycleId: string;
  actionId: string;
  authorizationNonce: string;
  action: RecoveryAction;
  authorizedAt: number;
  expiresAt: number;
  countdownDeadline: number | null;
}

export interface RecoveryResumeContext {
  cycleId: string;
  failureKind: FailureKind;
  action: RecoveryAction;
  actionId: string;
  authorizationNonce: string;
  startedAt: number;
}

export interface PlayerPreferences {
  volume: number;
  muted: boolean;
  playbackRate: number;
  captionsShowing: boolean;
  cssMaximized: boolean;
  followingLive?: boolean;
  pictureInPicture?: boolean;
}

export interface PlayerSessionSnapshot extends PlayerPreferences {
  id: string;
  origin: string;
  pageUrlKey: string;
  playerLabel: string;
  streamKind: StreamKind;
  wasPlaying: boolean;
  mediaPosition: number | null;
  scrollX: number;
  scrollY: number;
  createdAt: number;
  expiresAt: number;
  recoveryCycleId: string;
  navigationId: string;
}

export interface ActionOutcome {
  action: RecoveryAction;
  failureKind: FailureKind;
  success: boolean;
  durationMs: number;
  timestamp: number;
}

export interface ActionOutcomeSummary {
  successes: number;
  failures: number;
  averageDurationMs: number;
}

export interface FailureFeedbackSummary {
  correct: number;
  falseAlarms: number;
}

export interface HealthSample {
  startupMs: number;
  rebufferMs: number;
  liveLagSeconds: number | null;
  timestamp: number;
}

export interface LocalSiteModel {
  origin: string;
  sampleCount: number;
  sessionCount: number;
  startupAverageMs: number;
  rebufferAverageMs: number;
  liveLagAverageSeconds: number;
  falseAlarms: number;
  correctRecoveries: number;
  /** Aggregate kept for backwards-compatible display and coarse diagnostics. */
  actionOutcomes: Partial<Record<RecoveryAction, ActionOutcomeSummary>>;
  /** The adaptive policy reads this diagnosis-scoped model so success on one
   * failure class cannot reorder actions for an unrelated class. */
  actionOutcomesByFailure: Partial<Record<FailureKind, Partial<Record<RecoveryAction, ActionOutcomeSummary>>>>;
  feedbackByFailure: Partial<Record<FailureKind, FailureFeedbackSummary>>;
  updatedAt: number;
}

export interface SiteProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  version: number;
  originPatterns: string[];
  urlPatterns: string[];
  declaredPlayerType: PlayerType;
  selectors: Partial<Record<SelectorField, string>>;
  recoveryStrategy: RecoveryAction[];
  backupUrls: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface SelectorValidationResult {
  ok: boolean;
  syntacticallyValid: boolean;
  matchCount: number;
  visibleCount: number;
  riskyCount: number;
  frameUrl: string;
  warning: string;
  error?: string;
}

export interface HistoryEvent {
  id: string;
  timestamp: number;
  level: "info" | "warning" | "error" | "success";
  event: string;
  detail: string;
  url: string;
  tabId?: number;
  frameId?: number;
  metadata?: Record<string, unknown>;
}

export interface PopupState {
  acknowledged: boolean;
  origin: string | null;
  supportedPage: boolean;
  settings: Settings;
  effective: EffectiveSettings | null;
  status: FrameStatus;
  recentHistory: HistoryEvent[];
  snoozedUntil: number | null;
  refreshAttempts: number;
  eventModeUntil: number | null;
  siteModel: LocalSiteModel | null;
}

export interface DashboardConfiguredSite {
  origin: string;
  host: string;
  enabled: boolean;
  permissionGranted: boolean;
  activeTabs: number;
}

export interface DashboardActiveMonitor {
  tabId: number;
  origin: string;
  host: string;
  state: MonitorState;
  detail: string;
  confidence: number;
  recoveryAction: RecoveryAction | null;
  updatedAt: number;
}

export interface DashboardRecoveryEvent {
  id: string;
  origin: string;
  host: string;
  action: RecoveryAction;
  outcome: "scheduled" | "success" | "failed" | "cancelled" | "paused";
  timestamp: number;
}

export interface DashboardState {
  acknowledged: boolean;
  enabled: boolean;
  generatedAt: number;
  configuredSites: DashboardConfiguredSite[];
  activeMonitors: DashboardActiveMonitor[];
  recentRecoveries: DashboardRecoveryEvent[];
}

export type RuntimeMessage =
  | { type: "GET_CONTEXT"; origin: string; pageUrl: string; navigationId: string }
  | { type: "GET_POPUP_STATE"; tabId?: number; origin?: string }
  | { type: "GET_DASHBOARD_STATE" }
  | { type: "FOCUS_DASHBOARD_TAB"; tabId: number }
  | { type: "GET_HISTORY"; tabId?: number; limit?: number }
  | { type: "GET_SITE_MODEL"; origin: string }
  | { type: "GET_PROFILES" }
  | { type: "SAVE_PROFILE"; profile: SiteProfile }
  | { type: "DELETE_PROFILE"; profileId: string }
  | { type: "CLEAR_HISTORY"; tabId?: number }
  | { type: "CLEAR_DATA"; target: DataClearTarget }
  | { type: "GET_PRIVACY_STATE" }
  | { type: "ACKNOWLEDGE_VISUAL_PRIVACY" }
  | { type: "ACKNOWLEDGE_DISCLAIMER" }
  | { type: "UPDATE_GLOBAL_SETTINGS"; patch: Partial<GlobalSettings> }
  | { type: "SET_SITE_ENABLED"; origin: string; enabled: boolean; tabId?: number }
  | { type: "SET_SITE_OVERRIDES"; origin: string; overrides: SiteSettings; replace?: boolean }
  | { type: "SAVE_SITE_SELECTOR"; origin: string; field: SelectorField; selector: string; tabId?: number }
  | { type: "VALIDATE_SITE_SELECTOR"; origin: string; field: SelectorField; selector: string }
  | { type: "REPORT_STATUS"; status: Omit<FrameStatus, "updatedAt"> }
  | { type: "LOG_HISTORY"; entry: Omit<HistoryEvent, "id" | "timestamp" | "tabId" | "frameId"> }
  | { type: "REQUEST_AUTO_REFRESH"; origin: string; pageUrl: string; reason: string; confidence: number }
  | { type: "RECORD_AUTO_REFRESH"; origin: string; pageUrl: string }
  | { type: "AUTHORIZE_RECOVERY_ACTION"; origin: string; pageUrl: string; recoveryCycleId: string; action: RecoveryAction; reason: string; confidence: number }
  | { type: "COMMIT_RECOVERY_ACTION"; pageUrl: string; recoveryCycleId: string; actionId: string; authorizationNonce: string }
  | { type: "COMPLETE_RECOVERY_ACTION"; origin: string; pageUrl: string; recoveryCycleId: string; actionId: string; authorizationNonce: string; success: boolean; durationMs: number; failureKind: FailureKind; reason?: string }
  | { type: "EXTEND_AUTO_REFRESH"; recoveryCycleId: string; actionId: string; authorizationNonce: string; seconds: number }
  | { type: "CANCEL_AUTO_REFRESH"; recoveryCycleId?: string; actionId?: string; authorizationNonce?: string }
  | { type: "PLAYBACK_SUCCESS"; pageUrl: string; recoveryCycleId?: string }
  | { type: "RECORD_ACTION_OUTCOME"; origin: string; outcome: ActionOutcome }
  | { type: "RECORD_HEALTH_SAMPLE"; origin: string; sample: HealthSample }
  | { type: "RECORD_USER_FEEDBACK"; origin: string; correct: boolean; failureKind: FailureKind }
  | { type: "SAVE_SESSION_SNAPSHOT"; snapshot: PlayerSessionSnapshot }
  | { type: "CLEAR_SESSION_SNAPSHOT"; origin: string; recoveryCycleId?: string }
  | { type: "CLAIM_AUTO_MAXIMIZE"; pageUrl: string; recoveryCycleId: string }
  | { type: "SAVE_PLAYER_PREFERENCES"; origin: string; preferences: PlayerPreferences }
  | { type: "REQUEST_PARENT_MAXIMIZE" }
  | { type: "REQUEST_IFRAME_RECOVERY"; frameToken: string }
  | { type: "MANUAL_REFRESH"; tabId: number; origin: string }
  | { type: "MANUAL_MAXIMIZE"; tabId: number }
  | { type: "MANUAL_PICTURE_IN_PICTURE"; tabId: number }
  | { type: "MANUAL_JUMP_TO_LIVE"; tabId: number }
  | { type: "PIN_PRIMARY_VIDEO"; tabId: number }
  | { type: "START_SELECTOR_PICKER"; origin: string; field: SelectorField }
  | { type: "CANCEL_SELECTOR_PICKER" }
  | { type: "SNOOZE_TAB"; tabId: number; until: number | null }
  | { type: "SET_EVENT_MODE"; tabId: number; until: number | null }
  | { type: "RESET_TAB_ATTEMPTS"; tabId: number }
  | {
      type: "REQUEST_VISUAL_SAMPLE";
      origin: string;
      pageUrl: string;
      navigationId: string;
      candidateId: string;
      candidateEpoch: number;
      rect: { x: number; y: number; width: number; height: number };
      viewport: { width: number; height: number };
    }
  | { type: "EXTEND_COUNTDOWN"; tabId: number; seconds: number }
  | { type: "CANCEL_TAB_COUNTDOWN"; tabId: number }
  | { type: "SHUTDOWN_MONITOR" }
  | { type: "RESET_RUNTIME_STATE" }
  | { type: "SETTINGS_CHANGED"; settings: EffectiveSettings }
  | { type: "START_COUNTDOWN"; reason: string; deadline: number; recoveryCycleId: string; actionId: string; authorizationNonce: string }
  | { type: "EXTEND_COUNTDOWN_IN_PAGE"; deadline: number; recoveryCycleId: string; actionId: string; authorizationNonce: string }
  | { type: "STOP_COUNTDOWN"; recoveryCycleId: string; actionId: string; authorizationNonce: string; reason?: string; cancelRecovery?: boolean }
  | { type: "RESTORE_SESSION_SNAPSHOT"; snapshot: PlayerSessionSnapshot }
  | { type: "SHOW_LOOP_WARNING"; detail: string }
  | { type: "RETRY_MONITORING" }
  | { type: "SNOOZE_UNTIL"; until: number | null }
  | { type: "EVENT_MODE_UNTIL"; until: number | null }
  | { type: "MAXIMIZE_NOW"; manual?: boolean }
  | { type: "PICTURE_IN_PICTURE_NOW" }
  | { type: "JUMP_TO_LIVE_NOW" }
  | { type: "MAXIMIZE_IFRAME"; manual?: boolean }
  | { type: "RECOVER_IFRAME"; frameToken: string }
  | { type: "BEGIN_ELEMENT_PICKER"; field: SelectorField }
  | { type: "VALIDATE_SELECTOR"; field: SelectorField; selector: string }
  | { type: "STOP_ELEMENT_PICKER" };
