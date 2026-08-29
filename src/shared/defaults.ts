import { SETTINGS_SCHEMA_VERSION, type Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  enabled: true,
  autoRefresh: true,
  autoMaximize: true,
  checkIntervalSeconds: 3,
  healthyCheckIntervalSeconds: 8,
  suspectCheckIntervalSeconds: 1,
  mutationDebounceMs: 400,
  stallTimeoutSeconds: 12,
  pageLoadGraceSeconds: 15,
  refreshCountdownSeconds: 5,
  maxAutoRefreshes: 3,
  refreshWindowMinutes: 10,
  successResetSeconds: 120,
  failureConfidenceThreshold: 65,
  failureConfirmationChecks: 3,
  onlyWhenTabVisible: true,
  waitWhileOffline: true,
  lockPrimaryVideo: true,
  detectFrozenFrames: true,
  restorePlayerPreferences: true,
  useCssMaximizeFallback: true,
  attemptNativeFullscreenClick: true,
  enablePictureInPicture: true,
  showBadge: true,
  showNotifications: false,
  localHistoryEnabled: true,
  historyLimit: 200,
  enableAdaptiveTuning: true,
  enableAdvancedPlayerBridge: false,
  enableVisualWatchdog: false,
  keepScreenAwake: false,
  protectTabFromDiscard: false,
  liveEdgeThresholdSeconds: 30,
  recoveryVerificationSeconds: 15,
  maxRecoveryActionsPerCycle: 8,
  visualSampleIntervalSeconds: 10,
  recoveryStrategy: ["WAIT", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "PAGE_RELOAD"],
  recoveryBackoffSeconds: [5, 15, 45, 120],
  perSite: {}
};

export const DISCLAIMER =
  "Disclaimer: This extension automatically reloads web pages and may affect playback behavior. " +
  "Use it only on websites you have the right to access and in accordance with each site’s terms " +
  "of service. Automatic refresh and fullscreen may not work on all websites due to browser " +
  "security restrictions or site design. For a better viewing experience, we recommend using an " +
  "ad blocker such as uBlock Origin and/or AdGuard. This extension does not guarantee stream " +
  "availability and is not responsible for interrupted playback, site errors, or account actions " +
  "taken by websites.";
