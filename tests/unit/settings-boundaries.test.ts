import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import { normalizeSettings } from "../../src/shared/settings";
import type { GlobalSettings } from "../../src/shared/types";

const numericBounds: Array<[keyof GlobalSettings, number, number]> = [
  ["checkIntervalSeconds", 1, 60], ["healthyCheckIntervalSeconds", 2, 120], ["suspectCheckIntervalSeconds", .5, 10],
  ["mutationDebounceMs", 100, 5000], ["stallTimeoutSeconds", 5, 300], ["pageLoadGraceSeconds", 0, 300],
  ["refreshCountdownSeconds", 1, 60], ["maxAutoRefreshes", 1, 20], ["refreshWindowMinutes", 1, 1440],
  ["successResetSeconds", 10, 3600], ["failureConfidenceThreshold", 40, 100], ["failureConfirmationChecks", 1, 10],
  ["historyLimit", 20, 1000], ["liveEdgeThresholdSeconds", 5, 600], ["recoveryVerificationSeconds", 3, 120],
  ["maxRecoveryActionsPerCycle", 1, 30], ["visualSampleIntervalSeconds", 5, 120]
];
for (const [key, minimum, maximum] of numericBounds) {
  test(`${String(key)} clamps to its minimum`, () => assert.equal(normalizeSettings({ [key]: minimum - 10_000 })[key], minimum));
  test(`${String(key)} clamps to its maximum`, () => assert.equal(normalizeSettings({ [key]: maximum + 10_000 })[key], maximum));
  test(`${String(key)} keeps a valid midpoint`, () => {
    const midpoint = (minimum + maximum) / 2;
    assert.equal(normalizeSettings({ [key]: midpoint })[key], midpoint);
  });
}

const booleans: Array<keyof GlobalSettings> = ["enabled", "autoRefresh", "autoMaximize", "onlyWhenTabVisible", "waitWhileOffline", "lockPrimaryVideo", "detectFrozenFrames", "restorePlayerPreferences", "useCssMaximizeFallback", "attemptNativeFullscreenClick", "enablePictureInPicture", "showBadge", "showNotifications", "localHistoryEnabled", "enableAdaptiveTuning", "enableAdvancedPlayerBridge", "enableVisualWatchdog", "keepScreenAwake", "protectTabFromDiscard"];
for (const key of booleans) test(`${String(key)} rejects non-boolean values`, () => assert.equal(normalizeSettings({ [key]: "true" })[key], DEFAULT_SETTINGS[key]));
