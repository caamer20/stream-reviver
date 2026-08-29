export const SETTINGS_SCHEMA_VERSION = 3;

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
export type PlayerType = "AUTO" | "HTML5" | "MSE" | "HLS_JS" | "DASH_JS" | "WEBRTC" | "CANVAS";
export type CircuitState = "CLOSED" | "HALF_OPEN" | "OPEN_UNTIL" | "OPEN_REQUIRES_USER";

export type MonitorState =
  | "DISABLED"
  | "SITE_NOT_ENABLED"
  | "URL_EXCLUDED"
  | "SNOOZED"
  | "OFFLINE"
  | "NO_VIDEO_FOUND"
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
  frameToken: string;
  updatedAt: number;
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
}

export interface ActionOutcome {
  action: RecoveryAction;
  failureKind: FailureKind;
  success: boolean;
  durationMs: number;
  timestamp: number;
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
  actionOutcomes: Partial<Record<RecoveryAction, { successes: number; failures: number; averageDurationMs: number }>>;
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

export type RuntimeMessage =
  | { type: "GET_CONTEXT"; origin: string; pageUrl: string }
  | { type: "GET_POPUP_STATE"; tabId?: number; origin?: string }
  | { type: "GET_HISTORY"; tabId?: number; limit?: number }
  | { type: "GET_SITE_MODEL"; origin: string }
  | { type: "GET_PROFILES" }
  | { type: "SAVE_PROFILE"; profile: SiteProfile }
  | { type: "DELETE_PROFILE"; profileId: string }
  | { type: "CLEAR_HISTORY"; tabId?: number }
  | { type: "ACKNOWLEDGE_DISCLAIMER" }
  | { type: "UPDATE_GLOBAL_SETTINGS"; patch: Partial<GlobalSettings> }
  | { type: "SET_SITE_ENABLED"; origin: string; enabled: boolean; tabId?: number }
  | { type: "SET_SITE_OVERRIDES"; origin: string; overrides: SiteSettings; replace?: boolean }
  | { type: "SAVE_SITE_SELECTOR"; origin: string; field: SelectorField; selector: string; tabId?: number }
  | { type: "REPORT_STATUS"; status: Omit<FrameStatus, "updatedAt"> }
  | { type: "LOG_HISTORY"; entry: Omit<HistoryEvent, "id" | "timestamp" | "tabId" | "frameId"> }
  | { type: "REQUEST_AUTO_REFRESH"; origin: string; pageUrl: string; reason: string; confidence: number }
  | { type: "RECORD_AUTO_REFRESH"; origin: string; pageUrl: string }
  | { type: "CANCEL_AUTO_REFRESH" }
  | { type: "PLAYBACK_SUCCESS"; pageUrl: string }
  | { type: "RECORD_ACTION_OUTCOME"; origin: string; outcome: ActionOutcome }
  | { type: "RECORD_HEALTH_SAMPLE"; origin: string; sample: HealthSample }
  | { type: "RECORD_USER_FEEDBACK"; origin: string; correct: boolean; failureKind: FailureKind }
  | { type: "SAVE_SESSION_SNAPSHOT"; snapshot: PlayerSessionSnapshot }
  | { type: "CLEAR_SESSION_SNAPSHOT"; origin: string }
  | { type: "CLAIM_AUTO_MAXIMIZE"; pageUrl: string }
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
  | { type: "REQUEST_VISUAL_SAMPLE"; rect: { x: number; y: number; width: number; height: number } }
  | { type: "EXTEND_COUNTDOWN"; tabId: number; seconds: number }
  | { type: "CANCEL_TAB_COUNTDOWN"; tabId: number }
  | { type: "SETTINGS_CHANGED"; settings: EffectiveSettings }
  | { type: "START_COUNTDOWN"; seconds: number; reason: string }
  | { type: "EXTEND_COUNTDOWN_IN_PAGE"; seconds: number }
  | { type: "STOP_COUNTDOWN"; reason?: string }
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
  | { type: "STOP_ELEMENT_PICKER" };
