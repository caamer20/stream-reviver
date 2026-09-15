import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { effectiveSettings, normalizeSettings } from "../src/shared/settings";

test("invalid settings fall back and numeric settings are clamped", () => {
  const settings = normalizeSettings({
    enabled: "yes",
    checkIntervalSeconds: -20,
    stallTimeoutSeconds: 900,
    maxAutoRefreshes: 0
  });
  assert.equal(settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(settings.checkIntervalSeconds, 1);
  assert.equal(settings.stallTimeoutSeconds, 300);
  assert.equal(settings.maxAutoRefreshes, 1);
});

test("unsafe per-site keys are discarded", () => {
  const settings = normalizeSettings({
    perSite: {
      "javascript:alert(1)": { enabled: true },
      "https://example.com": { enabled: true }
    }
  });
  assert.deepEqual(Object.keys(settings.perSite), ["https://example.com"]);
});

test("per-site settings override global defaults", () => {
  const settings = normalizeSettings({
    autoRefresh: true,
    perSite: {
      "https://example.com": { enabled: true, autoRefresh: false, stallTimeoutSeconds: 30 }
    }
  });
  const effective = effectiveSettings(settings, "https://example.com");
  assert.equal(effective.siteEnabled, true);
  assert.equal(effective.autoRefresh, false);
  assert.equal(effective.stallTimeoutSeconds, 30);
});

test("post-refresh fullscreen defaults on and supports global and per-site opt-out", () => {
  assert.equal(DEFAULT_SETTINGS.autoMaximize, true);
  assert.equal(normalizeSettings({ autoMaximize: false }).autoMaximize, false);
  const settings = normalizeSettings({
    autoMaximize: true,
    perSite: { "https://example.com": { enabled: true, autoMaximize: false } }
  });
  assert.equal(effectiveSettings(settings, "https://example.com").autoMaximize, false);
});

test("selector strings are trimmed and bounded", () => {
  const settings = normalizeSettings({
    perSite: {
      "https://example.com": { errorSelector: `  .error${"x".repeat(600)}  ` }
    }
  });
  assert.equal(settings.perSite["https://example.com"].errorSelector?.startsWith(".error"), true);
  assert.equal(settings.perSite["https://example.com"].errorSelector?.length, 500);
});

test("v1 settings migrate without losing site configuration", () => {
  const settings = normalizeSettings({ enabled: false, perSite: { "https://example.com": { enabled: true, autoRefresh: false } } });
  assert.equal(settings.schemaVersion, 4);
  assert.equal(settings.enabled, false);
  assert.equal(settings.autoRecover, true);
  assert.equal(settings.perSite["https://example.com"].autoRefresh, false);
  assert.deepEqual(settings.recoveryStrategy, ["WAIT", "PLAY", "LIVE_EDGE", "RETRY_BUTTON", "PAGE_RELOAD"]);
});

test("v3 settings gain the independent automatic-recovery master switch", () => {
  const settings = normalizeSettings({ schemaVersion: 3, autoRefresh: false, perSite: {} });
  assert.equal(settings.schemaVersion, 4);
  assert.equal(settings.autoRecover, true);
  assert.equal(settings.autoRefresh, false);
});

test("v3 reliability settings migrate and clamp safely", () => {
  const settings = normalizeSettings({ liveEdgeThresholdSeconds: 1, recoveryVerificationSeconds: 999, maxRecoveryActionsPerCycle: 0, enableAdaptiveTuning: false });
  assert.equal(settings.liveEdgeThresholdSeconds, 5);
  assert.equal(settings.recoveryVerificationSeconds, 120);
  assert.equal(settings.maxRecoveryActionsPerCycle, 1);
  assert.equal(settings.enableAdaptiveTuning, false);
});

test("backup URLs and player type are validated", () => {
  const settings = normalizeSettings({ perSite: { "https://example.com": { declaredPlayerType: "WEBRTC", backupUrls: ["javascript:alert(1)", "https://backup.example/live"] } } });
  assert.equal(settings.perSite["https://example.com"].declaredPlayerType, "WEBRTC");
  assert.deepEqual(settings.perSite["https://example.com"].backupUrls, ["https://backup.example/live"]);
});

test("unsafe recovery actions and malformed backoff values are removed", () => {
  const settings = normalizeSettings({ recoveryStrategy: ["PLAY", "DELETE_ACCOUNT", "PAGE_RELOAD"], recoveryBackoffSeconds: [-1, "15", "bad", 99999] });
  assert.deepEqual(settings.recoveryStrategy, ["PLAY", "PAGE_RELOAD"]);
  assert.deepEqual(settings.recoveryBackoffSeconds, [1, 15, 3600]);
});

test("URL patterns are normalized and deduplicated per site", () => {
  const settings = normalizeSettings({ perSite: { "https://example.com": { includeUrlPatterns: [" https://example.com/live/* ", "https://example.com/live/*", 42], excludeUrlPatterns: ["https://example.com/account/*"] } } });
  assert.deepEqual(settings.perSite["https://example.com"].includeUrlPatterns, ["https://example.com/live/*"]);
});
