import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("onboarding exposes four keyboard-accessible, permission-transparent steps", async () => {
  const [html, source] = await Promise.all([
    readFile("src/welcome/welcome.html", "utf8"),
    readFile("src/welcome/welcome.ts", "utf8")
  ]);
  assert.equal([...html.matchAll(/data-step="[1-4]"/g)].length, 4);
  assert.equal([...html.matchAll(/data-progress="[1-4]"/g)].length, 4);
  assert.match(html, /aria-label="Setup progress"/);
  assert.match(html, /id="agree" type="checkbox"/);
  assert.match(html, /name="recovery-mode" value="balanced" checked/);
  assert.match(html, /name="recovery-mode" value="gentle"/);
  assert.match(html, /name="recovery-mode" value="observe"/);
  assert.match(html, /id="first-site" type="url"/);
  assert.match(html, /id="feedback" role="status" aria-live="polite"/);
  assert.match(source, /ext\.permissions\.request/);
  assert.match(source, /ext\.permissions\.remove/, "failed onboarding transactions must roll back their permission");
  assert.match(source, /type: "SET_SITE_ENABLED"/);
});

test("settings page offers basic/advanced disclosure and search without removing advanced controls", async () => {
  const [html, css, source] = await Promise.all([
    readFile("src/options/options.html", "utf8"),
    readFile("src/options/options.css", "utf8"),
    readFile("src/options/options.ts", "utf8")
  ]);
  assert.match(html, /id="settings-search" type="search"/);
  assert.match(html, /role="group" aria-label="Settings detail level"/);
  assert.match(html, /id="basic-mode"[^>]+aria-pressed="true"/);
  assert.match(html, /id="advanced-mode"[^>]+aria-pressed="false"/);
  assert.match(css, /body\[data-settings-mode="basic"\] \.advanced-setting/);
  assert.match(source, /OPTIONS_MODE_KEY/);
  assert.match(source, /filterSettings/);
  assert.match(html, /diagnosis-specific, least-disruptive order/);

  const saveSite = source.slice(source.indexOf("async function saveSite"), source.indexOf("function collectSiteOverrides"));
  assert.ok(saveSite.indexOf("collectSiteOverrides") < saveSite.indexOf("ext.permissions.request"), "site drafts must validate before requesting access");
  assert.ok(saveSite.indexOf("ext.permissions.request") < saveSite.indexOf("ensureVisualConsent"), "the browser permission request must remain the first awaited UI action");
  assert.doesNotMatch(saveSite, /await getDisclaimerAcknowledged/, "an async acknowledgement read would break permission-request user activation");
});

test("popup distinguishes automatic recovery from disruptive page reloads", async () => {
  const [html, source] = await Promise.all([
    readFile("src/popup/popup.html", "utf8"),
    readFile("src/popup/popup.ts", "utf8")
  ]);
  assert.match(html, /id="auto-recover"/);
  assert.match(html, /id="auto-refresh"/);
  assert.match(html, /id="auto-maximize"/);
  assert.match(source, /setSiteOverride\("autoRecover"/);
  assert.match(source, /setSiteOverride\("autoRefresh"/);
});

test("background monitoring gates every hidden-tab diagnosis signal through the user setting", async () => {
  const source = await readFile("src/content/content.ts", "utf8");
  const gatedSamples = source.match(/hidden:\s*this\.settings\.onlyWhenTabVisible\s*&&\s*document\.hidden/g) ?? [];
  assert.ok(gatedSamples.length >= 2, "both typed and legacy health samples must honor onlyWhenTabVisible");
  assert.doesNotMatch(source, /online:\s*navigator\.onLine,\s*hidden:\s*document\.hidden/,
    "typed diagnosis must not silently force hidden-tab suppression");
});

test("disclaimer acknowledgement is versioned and migrates the legacy boolean", async () => {
  const source = await readFile("src/shared/settings.ts", "utf8");
  assert.match(source, /streamReviverDisclaimerAcknowledgedV1/);
  assert.match(source, /LEGACY_ACK_KEY/);
  assert.match(source, /storage\.local\.remove/);
});
