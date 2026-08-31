import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import {
  getPopupPresentation,
  getSiteOverrideMode,
  POPUP_STATUS_STALE_AFTER_MS,
  withSiteOverride
} from "../../src/shared/popup-presentation";
import type { PopupState } from "../../src/shared/types";

const ORIGIN = "https://stream.example";

test("healthy protected sites present health, freshness, coverage, and relevant actions", () => {
  const now = 1_000_000;
  const state = popupState(now, { state: "HEALTHY", hasVideo: true, compatibilityLevel: "FULL" });
  const view = getPopupPresentation(state, now);

  assert.equal(view.activeProtection, true);
  assert.equal(view.stale, false);
  assert.equal(view.protection.key, "popupProtectionOn");
  assert.equal(view.headline.key, "popupStatusHealthy");
  assert.equal(view.coverage.fallback, "FULL");
  assert.equal(view.evidenceStrength, "—");
  assert.equal(view.actions.maximize, true);
  assert.equal(view.actions.pictureInPicture, true);
  assert.equal(view.actions.refresh, false);
});

test("old persisted reports are presented as stale rather than healthy", () => {
  const now = 1_000_000;
  const state = popupState(now - POPUP_STATUS_STALE_AFTER_MS - 1, { state: "HEALTHY", hasVideo: true, confidence: 93 });
  const view = getPopupPresentation(state, now);

  assert.equal(view.stale, true);
  assert.equal(view.headline.key, "popupStatusStale");
  assert.equal(view.evidenceStrength, "—");
  assert.match(view.freshness.fallback, /^Last update/);
  assert.equal(view.actions.maximize, false);
  assert.equal(view.actions.refresh, false);
});

test("countdown and circuit states expose only their immediate recovery controls", () => {
  const now = 1_000_000;
  const countdown = getPopupPresentation(popupState(now, { state: "COUNTDOWN", confidence: 84 }), now);
  assert.equal(countdown.actions.cancelCountdown, true);
  assert.equal(countdown.actions.extendCountdown, true);
  assert.equal(countdown.actions.refresh, false);

  const stopped = getPopupPresentation(popupState(now, { state: "PAUSED_TOO_MANY_REFRESHES", confidence: 100 }), now);
  assert.equal(stopped.actions.resetAttempts, true);
  assert.equal(stopped.actions.cancelCountdown, false);
});

test("snoozed protection clearly offers resume", () => {
  const now = 1_000_000;
  const state = popupState(now, { state: "SNOOZED", snoozedUntil: -1 });
  const view = getPopupPresentation(state, now);
  assert.equal(view.activeProtection, false);
  assert.equal(view.protection.key, "popupProtectionSnoozed");
  assert.equal(view.actions.resume, true);
  assert.equal(view.actions.snooze, false);
});

test("Default/On/Off site overrides preserve unrelated site configuration", () => {
  const original = { enabled: true, autoRecover: true, autoRefresh: false, errorSelector: ".player-error" };
  assert.equal(getSiteOverrideMode(original, "autoRecover"), "on");
  assert.equal(getSiteOverrideMode(original, "autoRefresh"), "off");
  assert.equal(getSiteOverrideMode(original, "autoMaximize"), "default");

  const inherited = withSiteOverride(original, "autoRefresh", "default");
  assert.equal(inherited.autoRefresh, undefined);
  assert.equal(inherited.enabled, true);
  assert.equal(inherited.errorSelector, ".player-error");
  assert.equal(original.autoRefresh, false, "the source settings must not be mutated");

  assert.equal(withSiteOverride(inherited, "autoRecover", "off").autoRecover, false);
  assert.equal(withSiteOverride(inherited, "autoMaximize", "on").autoMaximize, true);
  assert.equal(withSiteOverride(inherited, "autoMaximize", "off").autoMaximize, false);
});

test("popup markup keeps disclaimer, quiet live status, settings access, and localized controls", async () => {
  const [html, css, source, messagesText] = await Promise.all([
    readFile("src/popup/popup.html", "utf8"),
    readFile("src/popup/popup.css", "utf8"),
    readFile("src/popup/popup.ts", "utf8"),
    readFile("src/_locales/en/messages.json", "utf8")
  ]);
  const messages = JSON.parse(messagesText) as Record<string, { message: string }>;

  assert.match(html, /<details class="disclaimer-details" open>/);
  assert.match(html, /id="disclaimer-copy"/);
  assert.match(html, /id="acknowledge-check" type="checkbox"/);
  assert.match(html, /id="status-announcer"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.doesNotMatch(html, /class="status-card"[^>]+aria-live=/, "the whole status card must not be a live region");
  assert.match(html, /<footer>[\s\S]*id="open-settings"/, "Settings must remain in the fixed footer");
  assert.doesNotMatch(`${html}\n${source}`, /failure confidence/i);

  assert.match(css, /html\s*\{[^}]*width:\s*390px;[^}]*height:\s*600px;/);
  assert.match(css, /body\s*\{[^}]*width:\s*390px;[^}]*height:\s*600px;/);
  assert.match(css, /@media \(max-width:\s*359px\)[\s\S]*html, body\s*\{\s*width:\s*320px;/);

  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) {
    assert.equal(typeof messages[match[1]]?.message, "string", `missing popup locale message ${match[1]}`);
  }
});

function popupState(updatedAt: number, overrides: {
  state?: PopupState["status"]["state"];
  hasVideo?: boolean;
  confidence?: number;
  compatibilityLevel?: PopupState["status"]["compatibility"]["level"];
  snoozedUntil?: number | null;
} = {}): PopupState {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.perSite[ORIGIN] = { enabled: true };
  return {
    acknowledged: true,
    origin: ORIGIN,
    supportedPage: true,
    settings,
    effective: {
      ...settings,
      siteEnabled: true,
      selectedVideoSelector: "",
      videoContainerSelector: "",
      fullscreenButtonSelector: "",
      playButtonSelector: "",
      retryButtonSelector: "",
      liveButtonSelector: "",
      errorSelector: "",
      accessInterruptionSelector: "",
      adIndicatorSelector: "",
      declaredPlayerType: "AUTO",
      backupUrls: [],
      profileId: "",
      includeUrlPatterns: [],
      excludeUrlPatterns: []
    },
    status: {
      state: overrides.state ?? "HEALTHY",
      detail: "Playback is advancing normally",
      pageUrl: `${ORIGIN}/live`,
      origin: ORIGIN,
      hasVideo: overrides.hasVideo ?? false,
      score: 100,
      confidence: overrides.confidence ?? 0,
      evidence: [],
      selectedVideoLabel: "Main player",
      diagnosis: { kind: "NONE", alternatives: [], confidence: 0, severity: "none", detail: "Healthy", evidence: [], recoverySafe: false, requiresUser: false, observedAt: updatedAt },
      streamKind: "CONFIRMED_LIVE",
      liveIntent: "FOLLOWING_LIVE",
      liveEdgeLagSeconds: 2,
      bufferAheadSeconds: 8,
      recoveryCycleId: null,
      circuitState: "CLOSED",
      compatibility: {
        htmlVideo: true,
        crossFrame: true,
        frameCallbacks: true,
        playbackQuality: true,
        liveEdge: true,
        pictureInPicture: true,
        fullscreen: true,
        wakeLock: false,
        protocolBridge: false,
        visualWatchdog: false,
        playerType: "HTML5",
        level: overrides.compatibilityLevel ?? "PARTIAL",
        limitations: ["Wake lock is unavailable"]
      },
      recoveryAction: null,
      nextActionAt: null,
      online: true,
      pageVisible: true,
      frameToken: "top",
      navigationId: "navigation-1",
      candidateId: "candidate-1",
      candidateEpoch: 1,
      updatedAt
    },
    recentHistory: [],
    snoozedUntil: overrides.snoozedUntil ?? null,
    refreshAttempts: 0,
    eventModeUntil: null,
    siteModel: null
  };
}
