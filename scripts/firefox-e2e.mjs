import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Only a new, disposable geckodriver profile is used. The system context is
// limited to reading add-on identity and granting the local fixture origin;
// every product operation goes through the extension's production messages.
const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
const packagePath = argument("--package");
const previousPath = argument("--previous");
const captureReviewerVideo = process.argv.includes("--capture-reviewer-video");
assert.ok(!previousPath || packagePath, "--previous requires the signed --package to upgrade to");
const expectedVersion = argument("--expected-version") ?? JSON.parse(await readFile("package.json", "utf8")).version;
const reportPath = path.resolve(argument("--report") ?? "artifacts/firefox-e2e-report.json");
const evidenceRoot = reportPath.replace(/\.json$/, "") + "-ui";
const downloadRoot = await mkdtemp(path.join(tmpdir(), "stream-reviver-firefox-download-"));
const addonPath = path.resolve(packagePath ?? "dist/firefox");
await stat(addonPath);
if (previousPath) await stat(path.resolve(previousPath));
const report = {
  startedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  cleanTree: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "",
  mode: previousPath ? "signed-upgrade" : packagePath ? "signed-install" : "temporary-development",
  expectedVersion, checks: [], result: "running"
};
for (const [key, file] of [["packageSha256", packagePath], ["previousSha256", previousPath]]) {
  if (file) report[key] = createHash("sha256").update(await readFile(file)).digest("hex");
}
const fixtureRoot = path.resolve("dist/test-page");
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const file = path.resolve(fixtureRoot, `.${pathname === "/" ? "/test-page.html" : pathname}`);
    assert.ok(file.startsWith(`${fixtureRoot}${path.sep}`));
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    const content = await readFile(file);
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    response.end(content);
  } catch { response.writeHead(404); response.end("Not found"); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const siblingServer = createServer(server.listeners("request")[0]);
await new Promise((resolve, reject) => { siblingServer.once("error", reject); siblingServer.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const siblingOrigin = `http://127.0.0.1:${siblingServer.address().port}`;
// N-1 had broken custom-port grants. Seed a standard origin to verify a real
// working old-version configuration, then exercise custom ports after upgrade.
const seedOrigin = previousPath ? "http://127.0.0.1" : origin;
const pattern = `http://127.0.0.1/*`;
const driver = spawn(process.env.GECKODRIVER_BIN ?? "geckodriver", ["--host", "127.0.0.1", "--port", "0", "--allow-system-access"], { stdio: ["ignore", "pipe", "pipe"] });
let driverLog = "", driverError, base, sessionId, addonId, controlWindow, optionsUrl, firefoxPid;
driver.on("error", error => { driverError = error; });
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", chunk => { driverLog = `${driverLog}${chunk}`.slice(-24_000); });
const deadline = setTimeout(() => { console.error("Firefox E2E exceeded its 4-minute deadline"); void cleanup().finally(() => process.exit(124)); }, 240_000);
try {
  await eventually(async () => {
    if (driverError) throw driverError;
    const match = driverLog.match(/Listening on (127\.0\.0\.1:\d+)/);
    if (match) base = `http://${match[1]}`;
    return !!base;
  }, "geckodriver must start", 15_000);
  const firefoxOptions = { args: ["-headless"], prefs: {
    "extensions.update.enabled": false, "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0,
    "browser.download.folderList": 2, "browser.download.dir": downloadRoot, "browser.download.useDownloadDir": true,
    "browser.helperApps.neverAsk.saveToDisk": "application/json"
  } };
  if (process.env.FIREFOX_BIN) firefoxOptions.binary = process.env.FIREFOX_BIN;
  const session = await request("POST", "/session", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": firefoxOptions } } });
  sessionId = session.sessionId;
  firefoxPid = session.capabilities["moz:processID"];
  report.browserVersion = session.capabilities.browserVersion;
  report.platform = session.capabilities.platformName;
  await command("POST", "/timeouts", { script: 20_000, pageLoad: 30_000, implicit: 0 });
  await command("POST", "/window/rect", { width: 1440, height: 1000 });
  addonId = await command("POST", "/moz/addon/install", { path: path.resolve(previousPath ?? addonPath), temporary: !packagePath });
  report.addonId = addonId;
  report.initialAddon = await addonInfo();
  assert.equal(report.initialAddon.active, true);
  if (packagePath) assert.equal(report.initialAddon.temporary, false, "signed package must install persistently");
  controlWindow = await command("GET", "/window");
  await openOptions();
  await check("fresh-install-defaults", async () => {
    await eventually(() => script("return document.getElementById('enabled')?.checked === true;"), "settings must finish loading");
    assert.equal(await script("return document.getElementById('autoMaximize').checked;"), true);
    assert.equal(await extension("return browser.permissions.contains({origins:[arguments[0]]});", [pattern]), false);
  });
  await check("settings-save-and-reload", async () => {
    await send({ type: "ACKNOWLEDGE_DISCLAIMER" });
    await script("document.getElementById('autoMaximize').checked=false; document.getElementById('stallTimeoutSeconds').value='37'; document.getElementById('save-global').click();");
    await eventually(async () => (await state()).global.stallTimeoutSeconds === 37, "UI settings must persist");
    await send({ type: "SET_SITE_OVERRIDES", origin: seedOrigin, overrides: { enabled: false, autoMaximize: false }, replace: true });
    await command("POST", "/refresh", {});
    await eventually(() => script("return document.getElementById('stallTimeoutSeconds')?.value === '37';"), "saved settings must render after reload");
    assert.equal(await script("return document.getElementById('autoMaximize').checked;"), false);
  });
  // Headless testing seeds precisely one optional localhost permission, using
  // Firefox's permission store. This does not exercise the human permission UI.
  await chromeScript(`const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs'); const {ExtensionParent}=ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs'); await ExtensionPermissions.add(arguments[0],{origins:[arguments[1]],permissions:[]},ExtensionParent.GlobalManager.getExtension(arguments[0])); return true;`, [addonId, pattern]);
  await openOptions();
  await eventually(() => extension("return browser.permissions.contains({origins:[arguments[0]]});", [pattern]), "fixture permission must be granted");
  await send({ type: "SET_SITE_ENABLED", origin: seedOrigin, enabled: true });
  const before = await state();
  if (previousPath) {
    await check("signed-upgrade-preserves-settings-and-permission", async () => {
      // Firefox closes extension-owned documents during an upgrade. Keep the
      // driver control tab on a neutral document so its window handle survives.
      await command("POST", "/url", { url: "about:blank" });
      const upgradedId = await command("POST", "/moz/addon/install", { path: addonPath, temporary: false });
      assert.equal(upgradedId, addonId, "upgrade must preserve the add-on ID");
      const info = await addonInfo();
      assert.equal(info.version, expectedVersion);
      assert.equal(info.temporary, false);
      assert.equal(info.active, true);
      assert.notEqual(info.version, report.initialAddon.version, "upgrade test needs two distinct versions");
      await openOptions();
      const after = await state();
      assert.deepEqual(after.global, before.global);
      assert.deepEqual(after.sites, before.sites);
      assert.equal(after.acknowledged, true);
      assert.equal(await extension("return browser.permissions.contains({origins:[arguments[0]]});", [pattern]), true);
      await eventually(async () => (await extension("return browser.scripting.getRegisteredContentScripts();")).length > 0, "upgrade must restore dynamic registration");
    });
  }
  const current = await addonInfo();
  report.currentAddon = current;
  assert.equal(current.version, expectedVersion);
  await openOptions();
  if (previousPath) {
    await send({ type: "SET_SITE_ENABLED", origin, enabled: true });
    await send({ type: "SET_SITE_ENABLED", origin: seedOrigin, enabled: false });
  }
  await send({ type: "UPDATE_GLOBAL_SETTINGS", patch: { autoMaximize: true, pageLoadGraceSeconds: 0, checkIntervalSeconds: 1, healthyCheckIntervalSeconds: 2, suspectCheckIntervalSeconds: 0.5, stallTimeoutSeconds: 5, failureConfirmationChecks: 2, recoveryVerificationSeconds: 3, refreshCountdownSeconds: 1, maxAutoRefreshes: 1, recoveryBackoffSeconds: [1, 1], historyLimit: 500, localHistoryEnabled: true } });
  await send({ type: "SET_SITE_OVERRIDES", origin, overrides: { enabled: true, recoveryStrategy: ["PAGE_RELOAD"], enableAdvancedPlayerBridge: true }, replace: true });
  await check("default-diagnostic-preview-redaction", async () => {
    const selector = "#private-selector-fixture";
    await send({ type: "SAVE_SITE_SELECTOR", origin, field: "fullscreenButtonSelector", selector });
    await extension("return browser.runtime.sendMessage(arguments[0]);", [{ type: "LOG_HISTORY", entry: {
      event: "synthetic-privacy-check", level: "info", detail: `Fixture URL ${origin}/private-route-fixture?private-query-fixture=1#private-fragment-fixture`,
      url: `${origin}/private-route-fixture?private-query-fixture=1#private-fragment-fixture`,
      metadata: { action: "WAIT" }
    } }]);
    for (const [event, detail] of [
      ["selector-saved", "selectedVideoSelector saved as #legacy-private-selector-fixture"],
      ["player-selected", "video (private-player-label-fixture) selected"]
    ]) await extension("return browser.runtime.sendMessage(arguments[0]);", [{ type: "LOG_HISTORY", entry: { event, detail, level: "info", url: origin } }]);
    const rejected = await extension("return browser.runtime.sendMessage(arguments[0]);", [{ type: "LOG_HISTORY", entry: {
      event: "rejected-metadata-fixture", detail: "Synthetic fixture", level: "info", url: origin,
      metadata: { privateUnknown: "unknown-metadata-fixture", screenshot: "screenshot-fixture" }
    } }]);
    assert.equal(rejected?.ok, false, "unknown diagnostic metadata must be rejected at the message boundary");
    await command("POST", "/refresh", {});
    await eventually(() => script("return document.getElementById('diagnostic-history')?.textContent.includes('synthetic-privacy-check');"), "history must load in the real settings UI");
    await script("document.getElementById('export-diagnostics').click();");
    const preview = await script("return document.getElementById('diagnostic-export-preview').textContent;");
    const parsed = JSON.parse(preview);
    report.diagnosticPreviewRedaction = parsed.redaction;
    assert.equal(parsed.redaction.selectors, true);
    assert.equal(parsed.browserDetails, "redacted");
    try {
      for (const secret of [origin, selector, "legacy-private-selector-fixture", "private-player-label-fixture", "private-route-fixture", "private-query-fixture", "private-fragment-fixture", "unknown-metadata-fixture", "screenshot-fixture"]) {
        assert.ok(!preview.includes(secret), `default preview must redact ${secret}`);
      }
    } catch (error) { report.failedSyntheticDiagnosticPreview = parsed; throw error; }
    await screenshot("diagnostic-preview.png");
    await script("document.getElementById('download-diagnostics').click();");
    let downloaded;
    await eventually(async () => {
      const files = await readdir(downloadRoot);
      downloaded = files.find(name => /^stream-reviver-diagnostics-.*\.json$/.test(name));
      return downloaded && !files.some(name => name.endsWith(".part")) && (await stat(path.join(downloadRoot, downloaded))).size > 0;
    }, "reviewed diagnostic bundle must download");
    const bytes = await readFile(path.join(downloadRoot, downloaded));
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), parsed, "downloaded bundle must match the reviewed redacted preview");
    await writeFile(path.join(evidenceRoot, "diagnostic-default-export.json"), bytes);
    report.diagnosticDownload = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), matchesPreview: true };
    await send({ type: "SAVE_SITE_SELECTOR", origin, field: "fullscreenButtonSelector", selector: "" });
  });
  await check("sibling-port-is-not-monitored-or-bridged", async () => {
    const tab = await command("POST", "/window/new", { type: "tab" });
    await command("POST", "/window", { handle: tab.handle });
    await command("POST", "/url", { url: `${siblingOrigin}/test-page.html?mode=healthy` });
    await new Promise(resolve => setTimeout(resolve, 3_000));
    assert.equal(await script("return !!window.__streamReviverProtocolBridgeV3;"), false);
    assert.equal(await script("return !!document.querySelector('#stream-reviver-ui-host');"), false);
    await command("POST", "/window", { handle: controlWindow });
    const saved = await extension("return browser.storage.local.get(['streamReviverSiteModelsV3','streamReviverSessionVisitsV3','streamReviverHistoryV2']);");
    assert.ok(!JSON.stringify(saved).includes(siblingOrigin), "unenabled sibling must not create model, session, or history records");
    await command("POST", "/window", { handle: tab.handle });
    await command("DELETE", "/window");
    await command("POST", "/window", { handle: controlWindow });
  });
  await scenario("healthy-playback", "healthy", 10_000, async (events) => {
    assert.equal(report.lastFixture.bridge, true, "authorized optional bridge must initialize");
    assert.ok(events.some(item => item.event === "status-healthy"), "healthy stream must be recognized");
    assert.ok(!events.some(item => item.event === "recovery-step" || item.event === "page-reload"), "healthy stream must never recover");
  });
  await scenario("manual-pause-protection", "paused", 9_000, async events => {
    assert.ok(events.some(item => item.event === "status-monitoring" && item.detail?.includes("Video is paused; automatic recovery is suppressed")), "paused playback must be recognized and protected");
    assert.ok(!events.some(item => item.event === "recovery-step" || item.event === "page-reload"), "manual pause must never recover");
  });
  await scenario("refresh-and-fullscreen", "error", 12_000, async (events, layout) => {
    assert.equal(events.filter(item => item.event === "page-reload").length, 1, "loop protection must allow only one refresh");
    assert.ok(events.some(item => item.event === "post-refresh-maximize"));
    assert.ok(layout.fullscreen || layout.maximized, "refreshed stream must fill viewport");
  });
  await send({ type: "SET_SITE_OVERRIDES", origin, overrides: { enabled: true, recoveryStrategy: ["PAGE_RELOAD"], autoMaximize: false }, replace: true });
  await scenario("fullscreen-opt-out", "error", 12_000, async (events, layout) => {
    assert.equal(events.filter(item => item.event === "page-reload").length, 1);
    assert.ok(!events.some(item => item.event === "post-refresh-maximize"));
    assert.deepEqual(layout, { fullscreen: false, maximized: false });
  });
  await check("dashboard-privacy-and-disabled-closed-focus", async () => {
    // Keep a sibling grant enabled so disabling/restoring this fixture does
    // not require a new headless permission grant.
    await send({ type: "SET_SITE_ENABLED", origin: siblingOrigin, enabled: true });
    const tab = await command("POST", "/window/new", { type: "tab" });
    await command("POST", "/window", { handle: tab.handle });
    await command("POST", "/url", { url: `${origin}/test-page.html?mode=healthy&private-dashboard-query=1#private-dashboard-fragment` });
    await new Promise(resolve => setTimeout(resolve, 6_000));
    await command("POST", "/window", { handle: controlWindow });
    const browserTab = await extension("return (await browser.tabs.query({})).find(tab=>tab.url?.includes('private-dashboard-query')); ");
    assert.ok(browserTab?.id);
    const dashboard = await extension("return browser.runtime.sendMessage({type:'GET_DASHBOARD_STATE'});");
    assert.ok(dashboard.activeMonitors.some(monitor => monitor.tabId === browserTab.id));
    for (const secret of ["test-page.html", "private-dashboard-query", "private-dashboard-fragment"]) assert.ok(!JSON.stringify(dashboard).includes(secret));
    await command("POST", "/url", { url: optionsUrl.replace("options.html", "dashboard.html") });
    await eventually(() => script("return document.getElementById('dashboard-content')?.hidden === false;"), "dashboard must render");
    const visible = await script("return document.getElementById('main-content').innerText;");
    assert.ok(visible.includes("127.0.0.1"));
    for (const secret of ["test-page.html", "private-dashboard-query", "private-dashboard-fragment", origin]) assert.ok(!visible.includes(secret));
    await screenshot("dashboard.png");
    await send({ type: "SET_SITE_ENABLED", origin, enabled: false });
    assert.equal((await extension("return browser.runtime.sendMessage({type:'FOCUS_DASHBOARD_TAB',tabId:arguments[0]});", [browserTab.id])).ok, false, "disabled target must not be focused");
    await send({ type: "SET_SITE_ENABLED", origin, enabled: true });
    await command("POST", "/window", { handle: tab.handle });
    await command("DELETE", "/window");
    await command("POST", "/window", { handle: controlWindow });
    assert.equal((await extension("return browser.runtime.sendMessage({type:'FOCUS_DASHBOARD_TAB',tabId:arguments[0]});", [browserTab.id])).ok, false, "closed target must not be focused");
    await openOptions();
  });
  await check("disable-retains-shared-permission-for-enabled-sibling", async () => {
    await send({ type: "SET_SITE_ENABLED", origin: siblingOrigin, enabled: true });
    await send({ type: "SET_SITE_ENABLED", origin, enabled: false });
    assert.equal(await extension("return browser.permissions.contains({origins:[arguments[0]]});", [pattern]), true);
    await eventually(async () => (await extension("return browser.scripting.getRegisteredContentScripts();")).length === 1, "only the enabled sibling registration must remain");
  });
  await scenario("enabled-sibling-continues-monitoring", "healthy", 6_000, async events => {
    assert.ok(events.some(item => item.event === "status-healthy"));
  }, siblingOrigin);
  await check("last-disable-revokes-permission-and-registration", async () => {
    await send({ type: "SET_SITE_ENABLED", origin: siblingOrigin, enabled: false });
    await eventually(async () => !(await extension("return browser.permissions.contains({origins:[arguments[0]]});", [pattern])), "disable must revoke site access");
    await eventually(async () => (await extension("return browser.scripting.getRegisteredContentScripts();")).length === 0, "last disable must remove all registrations");
  });
  // Gecko can abort callbacks when their document is discarded, even a
  // one-statement callback. Retain all stacks for review; bounded driver
  // requests and behavioral assertions, not console-warning count, determine
  // whether a live scenario succeeds.
  report.result = "passed";
  console.log(`Firefox E2E: ${report.checks.length} checks passed (${report.mode}, Firefox ${report.browserVersion}).`);
} catch (error) {
  report.result = "failed";
  report.error = error.stack ?? String(error);
  console.error(driverLog);
  throw error;
} finally {
  clearTimeout(deadline);
  report.finishedAt = new Date().toISOString();
  report.scriptTimeoutWarnings = (driverLog.match(/Script terminated by timeout/g) ?? []).length;
  report.extensionScriptTimeoutWarnings = extensionTimeoutWarnings();
  report.runtimeWarningPolicy = "All warning stacks are retained; Gecko may abort callbacks during document disposal. Functional assertions and bounded driver requests define pass/fail. Warnings are not independent security-review evidence.";
  if (report.scriptTimeoutWarnings) report.browserDiagnostics = driverLog;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await cleanup();
}

async function request(method, route, body, timeout = 45_000) {
  const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${route}: ${JSON.stringify(result.value)}`);
  return result.value;
}
function extensionTimeoutWarnings() {
  return (driverLog.match(/JavaScript warning: moz-extension:[^\n]*Script terminated by timeout/g) ?? []).length;
}
function command(method, route, body) { return request(method, `/session/${sessionId}${route}`, body); }
function script(code, args = []) { return command("POST", "/execute/sync", { script: code, args }); }
async function extension(code, args = []) {
  const result = await command("POST", "/execute/async", { script: `const done=arguments[arguments.length-1]; (async()=>{${code}})().then(value=>done({value}),error=>done({failure:String(error)}));`, args });
  if (result.failure) throw new Error(result.failure);
  return result.value;
}
async function chromeScript(code, args = []) {
  await command("POST", "/moz/context", { context: "chrome" });
  try { return await extension(code, args); }
  finally { await command("POST", "/moz/context", { context: "content" }); }
}
async function addonInfo() {
  return chromeScript(`const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); const addon=await AddonManager.getAddonByID(arguments[0]); if(!addon)throw Error('Add-on missing'); return {version:addon.version,active:addon.isActive,temporary:addon.temporarilyInstalled,signedState:addon.signedState};`, [addonId]);
}
async function openOptions() {
  optionsUrl = await chromeScript("return WebExtensionPolicy.getByID(arguments[0]).getURL('options.html');", [addonId]);
  await command("POST", "/window", { handle: controlWindow });
  await command("POST", "/url", { url: optionsUrl });
  await eventually(() => script("return typeof browser?.runtime?.sendMessage === 'function';"), "extension page must expose its API");
}
async function send(message) {
  const response = await extension("return browser.runtime.sendMessage(arguments[0]);", [message]);
  assert.equal(response?.ok, true, `${message.type} must succeed: ${JSON.stringify(response)}`);
  return response;
}
async function state() {
  return extension(`const sync=await browser.storage.sync.get('streamReviverSettings'); const local=await browser.storage.local.get(['streamReviverSiteSettingsV1','streamReviverDisclaimerAcknowledgedV1']); return {global:sync.streamReviverSettings?.settings,sites:local.streamReviverSiteSettingsV1?.perSite,acknowledged:local.streamReviverDisclaimerAcknowledgedV1===true};`);
}
async function scenario(name, mode, duration, verify, fixtureOrigin = origin) {
  await check(name, async () => {
    await send({ type: "CLEAR_HISTORY" });
    await send({ type: "CLEAR_DATA", target: "runtime" });
    report.registrations = await extension("return browser.scripting.getRegisteredContentScripts();");
    const tab = await command("POST", "/window/new", { type: "tab" });
    await command("POST", "/window", { handle: tab.handle });
    await command("POST", "/url", { url: `${fixtureOrigin}/test-page.html?mode=${mode}` });
    if (captureReviewerVideo && name === "refresh-and-fullscreen") await recordReviewerVideo(duration);
    else await new Promise(resolve => setTimeout(resolve, duration));
    report.lastFixture = await script("return {url:location.href,bridge:!!window.__streamReviverProtocolBridgeV3,visibility:document.visibilityState,title:document.title,readout:document.getElementById('readout')?.textContent,videos:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,paused:v.paused,ready:v.readyState}))};");
    const layout = await script("return {fullscreen:!!document.fullscreenElement,maximized:!!document.querySelector('.stream-reviver-maximized')};");
    await command("POST", "/window", { handle: controlWindow });
    const events = await extension("return (await browser.storage.local.get('streamReviverHistoryV2')).streamReviverHistoryV2 ?? [];");
    try { await verify(events, layout); }
    catch (error) {
      report.failedScenarioEvents = events;
      report.failedSettings = await state();
      report.failedPermissions = await extension("return browser.permissions.getAll();");
      report.failedTabs = await extension("return browser.tabs.query({});");
      report.monitorProbe = await extension(`const tabs=await browser.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith(arguments[0]));if(!tab)return null;return browser.scripting.executeScript({target:{tabId:tab.id},func:async()=>({loaded:window.__streamReviverLoaded,context:await browser.runtime.sendMessage({type:'GET_CONTEXT',origin:location.origin,pageUrl:location.href,navigationId:crypto.randomUUID()})})});`, [origin]);
      throw error;
    } finally {
      await command("POST", "/window", { handle: tab.handle });
      await command("DELETE", "/window");
      await command("POST", "/window", { handle: controlWindow });
    }
  });
}
async function check(name, operation) {
  console.log(`→ Firefox: ${name}`);
  await operation();
  report.checks.push({ name, result: "passed", at: new Date().toISOString() });
  console.log(`✓ Firefox: ${name}`);
}
async function screenshot(name) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(path.join(evidenceRoot, name), Buffer.from(await command("GET", "/screenshot"), "base64"));
}
async function recordReviewerVideo(duration) {
  const frames = path.join(evidenceRoot, "refresh-frames");
  await mkdir(frames, { recursive: true });
  const started = Date.now();
  let count = 0;
  while (Date.now() - started < duration) {
    const frameStarted = Date.now();
    await writeFile(path.join(frames, `${String(count++).padStart(4, "0")}.png`), Buffer.from(await command("GET", "/screenshot"), "base64"));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 500 - (Date.now() - frameStarted))));
  }
  const elapsedSeconds = (Date.now() - started) / 1000;
  const output = path.join(evidenceRoot, "refresh-reviewer-demo.mp4");
  execFileSync(process.env.FFMPEG_BIN ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(count / elapsedSeconds),
    "-i", path.join(frames, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", output
  ]);
  report.reviewerVideo = { file: path.relative(path.dirname(reportPath), output), frames: count, elapsedSeconds, source: "sampled real browser screenshots of the synthetic localhost fixture" };
}
async function eventually(operation, message, timeout = 10_000) {
  const end = Date.now() + timeout;
  do {
    if (await operation()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < end);
  throw new Error(message);
}
async function cleanup() {
  if (sessionId && base) {
    try { await request("DELETE", `/session/${sessionId}`, undefined, 5_000); }
    catch { if (Number.isInteger(firefoxPid)) { try { process.kill(firefoxPid, "SIGTERM"); } catch {} } }
    sessionId = undefined;
  }
  if (driver.exitCode === null) driver.kill("SIGTERM");
  server.closeAllConnections();
  siblingServer.closeAllConnections();
  await new Promise(resolve => siblingServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(downloadRoot, { recursive: true, force: true });
}
