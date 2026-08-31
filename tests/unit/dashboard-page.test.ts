import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatRelativeTime,
  getDashboardSummary,
  isDashboardState,
  privacySafeDetail,
  privacySafeSiteLabel,
  type DashboardState
} from "../../src/dashboard/dashboard-model";

const NOW = 2_000_000_000_000;

function sampleState(): DashboardState {
  return {
    acknowledged: true,
    enabled: true,
    generatedAt: NOW,
    configuredSites: [
      { origin: "https://healthy.example", host: "healthy.example", enabled: true, permissionGranted: true, activeTabs: 1 },
      { origin: "https://permission.example", host: "permission.example", enabled: true, permissionGranted: false, activeTabs: 0 },
      { origin: "https://off.example", host: "off.example", enabled: false, permissionGranted: true, activeTabs: 0 }
    ],
    activeMonitors: [
      { tabId: 1, origin: "https://healthy.example", host: "healthy.example", state: "HEALTHY", detail: "Playing normally", confidence: 98, recoveryAction: null, updatedAt: NOW },
      { tabId: 2, origin: "https://warning.example", host: "warning.example", state: "RECOVERING", detail: "Trying media reload", confidence: 82, recoveryAction: "MEDIA_RELOAD", updatedAt: NOW - 30_000 },
      { tabId: 3, origin: "https://waiting.example", host: "waiting.example", state: "MONITORING", detail: "Establishing baseline", confidence: 45, recoveryAction: null, updatedAt: NOW - 60_000 }
    ],
    recentRecoveries: [
      { id: "event-1", origin: "https://warning.example", host: "warning.example", action: "MEDIA_RELOAD", outcome: "success", timestamp: NOW - 90_000 }
    ]
  };
}

test("dashboard derives its summary from privacy-safe state", () => {
  assert.deepEqual(getDashboardSummary(sampleState()), {
    activeMonitors: 3,
    healthyMonitors: 1,
    attentionMonitors: 1,
    protectedSites: 1
  });
});

test("dashboard site labels never expose URL paths, queries, fragments, or credentials", () => {
  assert.equal(
    privacySafeSiteLabel("", "https://user:secret@video.example:8443/private/watch?id=42#player"),
    "video.example:8443"
  );
  assert.equal(privacySafeSiteLabel("news.example/live/private?token=secret", ""), "news.example");
  assert.equal(privacySafeSiteLabel("", "not a URL with spaces"), "Unknown site");
  assert.equal(privacySafeSiteLabel("", "file:///Users/person/private/movie.m3u8"), "Local file");
});

test("dashboard replaces URL-like monitor details with state-safe copy", () => {
  const leaked = "Player failed at https://video.example/private/live.m3u8?token=secret#segment";
  const safe = privacySafeDetail(leaked, "ERROR");
  assert.equal(safe, "Monitoring encountered an error.");
  assert.doesNotMatch(safe, /private|token|segment/);
  assert.equal(privacySafeDetail("Buffer is below 2 seconds", "RECOVERING"), "Buffer is below 2 seconds");
});

test("dashboard validates the complete background response before rendering", () => {
  assert.equal(isDashboardState(sampleState()), true);
  assert.equal(isDashboardState({ ...sampleState(), activeMonitors: [{ ...sampleState().activeMonitors[0], tabId: -1 }] }), false);
  assert.equal(isDashboardState({ ...sampleState(), activeMonitors: [{ ...sampleState().activeMonitors[0], confidence: 101 }] }), false);
  assert.equal(isDashboardState({ ...sampleState(), recentRecoveries: [{ ...sampleState().recentRecoveries[0], outcome: "unknown" }] }), false);
  assert.equal(isDashboardState(undefined), false);
});

test("dashboard relative timestamps remain compact and stable", () => {
  assert.equal(formatRelativeTime(NOW, NOW), "Just now");
  assert.equal(formatRelativeTime(NOW - 45_000, NOW), "45s ago");
  assert.equal(formatRelativeTime(NOW - 3_600_000, NOW), "1h ago");
  assert.equal(formatRelativeTime(Number.NaN, NOW), "Time unavailable");
});

test("Mission Control page is accessible, responsive, polled, and DOM-safe", async () => {
  const [html, css, source] = await Promise.all([
    readFile("src/dashboard/dashboard.html", "utf8"),
    readFile("src/dashboard/dashboard.css", "utf8"),
    readFile("src/dashboard/dashboard.ts", "utf8")
  ]);

  assert.match(html, /<html[^>]+lang="en"/);
  assert.match(html, /<meta[^>]+name="viewport"/);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /id="status-announcer"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="error-state"[^>]+role="alert"/);
  assert.match(html, /id="configured-sites-empty"/);
  assert.match(html, /id="active-monitors-empty"/);
  assert.match(html, /id="recent-recoveries-empty"/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /forced-colors/);
  assert.match(source, /POLL_INTERVAL_MS = 3_000/);
  assert.match(source, /sendMessage<unknown>\(\{ type: "GET_DASHBOARD_STATE" \}(?: satisfies RuntimeMessage)?\)/, "state request must carry no payload");
  assert.match(source, /\{ type: "FOCUS_DASHBOARD_TAB", tabId \}/);
  assert.doesNotMatch(source, /\.innerHTML\b/);
  assert.match(source, /\.textContent\s*=/);
});
