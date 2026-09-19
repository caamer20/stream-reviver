import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticExport } from "../../src/shared/diagnostic-export";
import { normalizeSettings } from "../../src/shared/settings";
import type { HistoryEvent } from "../../src/shared/types";

const settings = normalizeSettings({
  perSite: {
    "https://private.example": {
      enabled: true,
      selectedVideoSelector: "#account-player",
      retryButtonSelector: ".retry-secret",
      backupUrls: ["https://backup.example/private/live?token=secret"],
      includeUrlPatterns: ["https://private.example/member/*"]
    }
  }
});
const history: HistoryEvent[] = [{
  id: "event-1", timestamp: 1, level: "warning", event: "recovery-step",
  detail: "Retrying https://private.example/member/live?token=secret",
  url: "https://private.example/member/live?token=secret#fragment",
  metadata: { action: "PLAY", score: 90, rawSelector: "#secret", nested: { unsafe: true } }
}];

test("default diagnostic export removes identifying site details", () => {
  const output = createDiagnosticExport({ exportedAt: "2026-01-01T00:00:00Z", extensionVersion: "1.0.0", browserDetails: "Exact Browser 1.2.3", settings, history }, {
    includeOrigins: false, includeUrlPaths: false, includeSelectors: false, includeBrowserDetails: false
  });
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /private\.example|backup\.example|account-player|retry-secret|token=secret|Exact Browser/);
  assert.match(serialized, /site-1|redacted/);
  assert.match(serialized, /"action":"PLAY"/);
  assert.doesNotMatch(serialized, /rawSelector|nested/);
});

test("explicit diagnostic options include requested identifying fields but never query strings", () => {
  const output = createDiagnosticExport({ exportedAt: "2026-01-01T00:00:00Z", extensionVersion: "1.0.0", browserDetails: "Browser 1", settings, history }, {
    includeOrigins: true, includeUrlPaths: true, includeSelectors: true, includeBrowserDetails: true
  });
  const serialized = JSON.stringify(output);
  assert.match(serialized, /private\.example/);
  assert.match(serialized, /account-player/);
  assert.match(serialized, /Browser 1/);
  assert.doesNotMatch(serialized, /token=secret|#fragment/);
});

test("diagnostic exports redact historical selectors and page-derived player labels", () => {
  const legacyHistory: HistoryEvent[] = [
    { id: "legacy-selector", timestamp: 1, level: "info", event: "selector-saved", detail: "selectedVideoSelector saved as #former-private-account", url: "https://private.example" },
    { id: "legacy-player", timestamp: 2, level: "info", event: "player-selected", detail: "video (private account stream title) selected", url: "https://private.example", metadata: { score: 91 } }
  ];
  for (const includeSelectors of [false, true]) {
    const output = createDiagnosticExport({ exportedAt: "2026-09-19T00:00:00Z", extensionVersion: "3.1.6", settings, history: legacyHistory }, {
      includeOrigins: false, includeUrlPaths: false, includeSelectors, includeBrowserDetails: false
    });
    const serialized = JSON.stringify(output);
    assert.doesNotMatch(serialized, /former-private-account|private account stream title/);
    assert.match(serialized, /Custom selector updated|Primary video selected/);
    assert.match(serialized, /"score":91/);
    // Selector opt-in applies to current configuration, not old historical
    // values that may no longer be known or relevant to the user.
    assert.equal(serialized.includes("#account-player"), includeSelectors);
  }
});
