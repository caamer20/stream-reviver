import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRuntimeMessage, type SenderIdentity } from "../../src/shared/authorization";
import type { RuntimeMessage } from "../../src/shared/types";

const origin = "https://example.com";
const pageUrl = `${origin}/live`;
const content: SenderIdentity = { extensionPage: false, contentScript: true, senderUrl: pageUrl, tabId: 7 };
const extension: SenderIdentity = { extensionPage: true, contentScript: false, senderUrl: "chrome-extension://id/options.html", tabId: 3 };

const contentMessages: RuntimeMessage[] = [
  { type: "GET_CONTEXT", origin, pageUrl, navigationId: "navigation" }, { type: "LOG_HISTORY", entry: { event: "x", detail: "x", level: "info", url: pageUrl } },
  { type: "REQUEST_AUTO_REFRESH", origin, pageUrl, reason: "x", confidence: 90 }, { type: "RECORD_AUTO_REFRESH", origin, pageUrl },
  { type: "AUTHORIZE_RECOVERY_ACTION", origin, pageUrl, recoveryCycleId: "cycle", action: "PLAY", reason: "x", confidence: 90 },
  { type: "COMMIT_RECOVERY_ACTION", pageUrl, recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce" },
  { type: "COMPLETE_RECOVERY_ACTION", origin, pageUrl, recoveryCycleId: "cycle", actionId: "action", authorizationNonce: "nonce", success: true, durationMs: 100, failureKind: "DECODE_FREEZE" },
  { type: "CANCEL_AUTO_REFRESH" }, { type: "PLAYBACK_SUCCESS", pageUrl }, { type: "CLEAR_SESSION_SNAPSHOT", origin },
  { type: "CLAIM_AUTO_MAXIMIZE", pageUrl, recoveryCycleId: "cycle" }, { type: "REQUEST_PARENT_MAXIMIZE" }, { type: "REQUEST_IFRAME_RECOVERY", frameToken: "f" },
  {
    type: "REQUEST_VISUAL_SAMPLE", origin, pageUrl, navigationId: "navigation", candidateId: "candidate", candidateEpoch: 1,
    rect: { x: 0, y: 0, width: 100, height: 100 }, viewport: { width: 1280, height: 720 }
  }
];
for (const message of contentMessages) test(`content sender is authorized for ${message.type}`, () => assert.equal(authorizeRuntimeMessage(message, content).ok, true));

const extensionMessages: RuntimeMessage[] = [
  { type: "GET_POPUP_STATE", tabId: 7, origin }, { type: "GET_DASHBOARD_STATE" }, { type: "FOCUS_DASHBOARD_TAB", tabId: 7 },
  { type: "GET_HISTORY" }, { type: "GET_SITE_MODEL", origin }, { type: "GET_PROFILES" },
  { type: "CLEAR_HISTORY" }, { type: "CLEAR_DATA", target: "runtime" }, { type: "GET_PRIVACY_STATE" }, { type: "ACKNOWLEDGE_VISUAL_PRIVACY" },
  { type: "ACKNOWLEDGE_DISCLAIMER" }, { type: "UPDATE_GLOBAL_SETTINGS", patch: { enabled: true } },
  { type: "SET_SITE_ENABLED", origin, enabled: true, tabId: 7 }, { type: "SET_SITE_OVERRIDES", origin, overrides: { autoRefresh: false } },
  { type: "MANUAL_REFRESH", tabId: 7, origin }, { type: "MANUAL_MAXIMIZE", tabId: 7 }, { type: "PIN_PRIMARY_VIDEO", tabId: 7 },
  { type: "SNOOZE_TAB", tabId: 7, until: null }, { type: "SET_EVENT_MODE", tabId: 7, until: null }, { type: "RESET_TAB_ATTEMPTS", tabId: 7 }
];
for (const message of extensionMessages) test(`extension page is authorized for ${message.type}`, () => assert.equal(authorizeRuntimeMessage(message, extension).ok, true));

for (const message of extensionMessages.slice(0, 12)) test(`content sender is denied administrative ${message.type}`, () => assert.equal(authorizeRuntimeMessage(message, content).ok, false));
for (const message of contentMessages.filter((message) => message.type !== "LOG_HISTORY").slice(0, 8)) test(`extension page is denied content-only ${message.type}`, () => assert.equal(authorizeRuntimeMessage(message, extension).ok, false));

test("content sender cannot claim a different origin", () => assert.equal(authorizeRuntimeMessage({ type: "GET_CONTEXT", origin: "https://evil.example", pageUrl, navigationId: "navigation" }, content).ok, false));
test("content sender cannot claim a cross-origin URL", () => assert.equal(authorizeRuntimeMessage({ type: "PLAYBACK_SUCCESS", pageUrl: "https://evil.example/live" }, content).ok, false));
test("cycle-scoped auto-maximize claims remain bound to the sender URL", () => assert.equal(authorizeRuntimeMessage({
  type: "CLAIM_AUTO_MAXIMIZE", pageUrl: "https://evil.example/live", recoveryCycleId: "cycle"
}, content).ok, false));
test("visual requests are bound to the sender origin", () => assert.equal(authorizeRuntimeMessage({
  type: "REQUEST_VISUAL_SAMPLE", origin: "https://evil.example", pageUrl, navigationId: "navigation", candidateId: "candidate", candidateEpoch: 1,
  rect: { x: 0, y: 0, width: 100, height: 100 }, viewport: { width: 1280, height: 720 }
}, content).ok, false));
test("unsupported sender URL is rejected", () => assert.equal(authorizeRuntimeMessage({ type: "CANCEL_AUTO_REFRESH" }, { ...content, senderUrl: "about:blank" }).ok, false));
