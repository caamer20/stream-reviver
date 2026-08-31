import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardHost, dashboardRecoveryEvents, dashboardSafeDetail, dashboardStateRank
} from "../../src/background/dashboard-state";
import type { HistoryEvent } from "../../src/shared/types";

test("dashboard backend exposes only a hostname and rejects path-like detail", () => {
  assert.equal(dashboardHost("https://video.example:8443"), "video.example:8443");
  assert.equal(dashboardHost("file://"), "Local file");
  assert.equal(dashboardHost("javascript:alert(1)"), "Unknown site");
  assert.equal(dashboardSafeDetail("Playback is healthy"), "Playback is healthy");
  assert.equal(
    dashboardSafeDetail("Failed at https://video.example/private/live?token=secret"),
    "Status details are available in the current-tab popup."
  );
  assert.equal(
    dashboardSafeDetail("Open /private/watch?id=42"),
    "Status details are available in the current-tab popup."
  );
});

test("dashboard backend converts bounded recovery history without leaking page URLs", () => {
  const history: HistoryEvent[] = [
    event("success", "recovery-action-succeeded", "https://video.example/private?token=x", {
      action: "PLAY", recoveryCycleId: "cycle-1"
    }),
    event("duplicate", "recovery-verified", "https://video.example/other", {
      action: "PLAY", recoveryCycleId: "cycle-1"
    }),
    event("scheduled", "countdown-started", "", { recoveryCycleId: "cycle-2" }, 7),
    event("ignored", "navigation", "https://video.example/private")
  ];
  const output = dashboardRecoveryEvents(history, new Map([[7, { origin: "https://embed.example" }]]));
  assert.deepEqual(output, [
    {
      id: "success", origin: "https://video.example", host: "video.example", action: "PLAY",
      outcome: "success", timestamp: 1_000
    },
    {
      id: "scheduled", origin: "https://embed.example", host: "embed.example", action: "PAGE_RELOAD",
      outcome: "scheduled", timestamp: 1_000
    }
  ]);
  assert.doesNotMatch(JSON.stringify(output), /private|token/);
});

test("dashboard attention ordering keeps urgent monitors first", () => {
  assert.ok(dashboardStateRank("ERROR") > dashboardStateRank("RECOVERING"));
  assert.ok(dashboardStateRank("RECOVERING") > dashboardStateRank("HEALTHY"));
  assert.ok(dashboardStateRank("HEALTHY") > dashboardStateRank("NO_VIDEO_FOUND"));
});

function event(
  id: string,
  name: string,
  url: string,
  metadata?: Record<string, unknown>,
  tabId?: number
): HistoryEvent {
  return { id, timestamp: 1_000, level: "info", event: name, detail: "detail", url, metadata, tabId };
}
