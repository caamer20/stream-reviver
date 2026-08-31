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
