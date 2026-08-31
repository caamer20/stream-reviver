import test from "node:test";
import assert from "node:assert/strict";
import { planRecovery, validateAutomaticRecoverySetting, validateRecoveryAction } from "../../src/shared/policy";
import { effectiveSettings, normalizeSettings } from "../../src/shared/settings";

const settings = effectiveSettings(normalizeSettings({
  recoveryStrategy: ["IFRAME_RELOAD", "PAGE_RELOAD"]
}), "https://player.example");

const safeReason = /replacement-frame handoff cannot yet be safely verified/i;

test("automatic iframe reload is denied at the mutation-setting boundary", () => {
  const result = validateAutomaticRecoverySetting("IFRAME_RELOAD", settings);
  assert.equal(result.allowed, false);
  assert.match(result.reason, safeReason);
});

test("iframe reload is denied even for a positively identified iframe player", () => {
  const result = validateRecoveryAction("IFRAME_RELOAD", {
    insideIframe: true,
    hasVideo: true,
    online: true,
    playIntent: "PLAYING"
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, safeReason);
});

test("iframe reload is excluded from automatic plans with and without frame context", () => {
  const withoutContext = planRecovery("DECODE_FREEZE", settings);
  const insideIframe = planRecovery("DECODE_FREEZE", settings, null, {
    insideIframe: true,
    hasVideo: true,
    online: true,
    playIntent: "PLAYING"
  });

  assert.equal(withoutContext.includes("IFRAME_RELOAD"), false);
  assert.equal(insideIframe.includes("IFRAME_RELOAD"), false);
  assert.equal(withoutContext.includes("PAGE_RELOAD"), true, "the fail-closed guard must not disable the verified fallback");
});
