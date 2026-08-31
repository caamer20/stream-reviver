import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const chromeBinary = await findChromeBinary();
const allowSkip = process.argv.includes("--allow-skip");
const enabledScenarios = new Set((process.env.E2E_SCENARIOS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
let executedScenarios = 0;
if (!chromeBinary) {
  const message = "Chrome for Testing or Chromium was not found; the browser E2E gate cannot run.";
  if (allowSkip) { console.log(`${message} Explicit --allow-skip accepted.`); process.exit(0); }
  throw new Error(message);
}
console.log(`Browser E2E using: ${chromeBinary}`);

const temp = await mkdtemp(path.join(tmpdir(), "stream-reviver-e2e-"));
const extensionDir = path.join(temp, "extension");
const profileDir = path.join(temp, "profile");
await cp("dist/chrome", extensionDir, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = pathname === "/" ? "test-page.html" : pathname.slice(1);
    const file = path.resolve("dist/test-page", relative);
    if (!file.startsWith(path.resolve("dist/test-page"))) throw new Error("Invalid path");
    const body = await readFile(file);
    response.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end("Not found");
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const serverPort = server.address().port;
const origin = `http://127.0.0.1:${serverPort}`;

// Headless Chrome intentionally leaves extension permission-warning dialogs
// pending. Seed only the fixture origin as a required test permission; keep the
// shipped registration architecture intact (no static content scripts and no
// broad host access). Permission UI grant/denial remains a headed/manual gate.
const manifestPath = path.join(extensionDir, "manifest.json");
const productionManifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(productionManifest.host_permissions, undefined, "production build must not request persistent broad host access");
assert.equal(productionManifest.content_scripts, undefined, "production build must use dynamic content-script registration");
assert.deepEqual(productionManifest.optional_host_permissions, ["<all_urls>"], "production build must declare optional host access");
productionManifest.host_permissions = [`${origin}/*`];
await writeFile(manifestPath, `${JSON.stringify(productionManifest, null, 2)}\n`);
console.log(`Seeded only ${origin} for headless permission testing; dynamic registration remains unchanged.`);

const chrome = spawn(chromeBinary, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update",
  `--user-data-dir=${profileDir}`, `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
  "--remote-debugging-port=0", "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (chunk) => { chromeLog = `${chromeLog}${chunk}`.slice(-20_000); });
const hardTimeoutMs = Math.max(30_000, Number(process.env.E2E_TIMEOUT_MS) || 600_000);
const hardTimeout = setTimeout(async () => {
  console.error(`Browser E2E exceeded its ${hardTimeoutMs}ms hard deadline.\n${chromeLog}`);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  server.closeAllConnections?.();
  await rm(temp, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
  process.exit(124);
}, hardTimeoutMs);
hardTimeout.unref();

try {
  const debugPort = await waitForDebugPort(profileDir);
  console.log(`Chrome debugging ready on port ${debugPort}`);
  await waitForWorker(debugPort);
  console.log("Extension service worker is running");
  await setTestSettings(debugPort, origin, {});
  console.log("Test settings initialized");

  await popupScenario(debugPort);

  await scenario(debugPort, "healthy", 10_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-healthy"), "healthy video should reach HEALTHY");
    assert.ok(!events.some((item) => item.event === "page-reload"), "healthy video must not reload");
  });

  await scenario(debugPort, "lifecycle", 8_000, async (events, target) => {
    assert.ok(events.some((item) => item.event === "status-healthy"), "lifecycle fixture should start healthy");
    const tabId = await evaluateWorker(debugPort, `(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.includes(${JSON.stringify(`mode=lifecycle`)}))?.id??null})()`);
    assert.ok(Number.isInteger(tabId), "lifecycle fixture tab should be discoverable");
    const disabled = await evaluateWorker(debugPort, `chrome.runtime.sendMessage({type:'SET_SITE_ENABLED',origin:${JSON.stringify(origin)},enabled:false,tabId:${tabId}})`);
    assert.equal(disabled?.ok, true, "disabling should stop the open-page monitor");
    await wait(1_000);
    const enabled = await evaluateWorker(debugPort, `chrome.runtime.sendMessage({type:'SET_SITE_ENABLED',origin:${JSON.stringify(origin)},enabled:true,tabId:${tabId}})`);
    assert.equal(enabled?.ok, true, "re-enabling should inject a fresh monitor into the open page");
    await wait(6_000);
    const finalEvents = await getHistory(debugPort);
    assert.ok(finalEvents.some((item) => item.event === "site-disabled"), "disable transition should be recorded");
    assert.ok(finalEvents.some((item) => item.event === "site-enabled"), "enable transition should be recorded");
    assert.ok(finalEvents.filter((item) => item.event === "status-healthy").length >= 2, "monitoring should resume without a page reload");
    assert.ok(target.id, "lifecycle target should remain open during reinjection");
  });

  await scenario(debugPort, "multi", 10_000, async (events) => {
    assert.ok(events.some((item) => item.event === "player-selected" && item.detail.includes("test-video")), "main player should beat the muted preview");
    assert.ok(events.some((item) => item.event === "status-healthy"), "multiple-video page should remain healthy");
  });

  await scenario(debugPort, "churn", 10_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-healthy"), "DOM churn must not prevent healthy detection");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "DOM churn must not trigger recovery");
  });

  await scenario(debugPort, "spa", 13_000, async (events) => {
    assert.ok(events.some((item) => item.event === "navigation"), "SPA URL change should be observed");
    assert.ok(events.some((item) => item.event === "status-healthy"), "SPA-injected player should become healthy");
  });

  await scenario(debugPort, "delayed", 30_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-no_video_found"), "delayed fixture should initially report no video");
    assert.ok(events.some((item) => item.event === "status-healthy"), "delayed player injection should eventually become healthy");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "missing video before delayed injection must not trigger recovery");
  });

  await scenario(debugPort, "shadow", 10_000, async (events) => {
    assert.ok(events.some((item) => item.event === "player-selected" && item.detail.includes("Open shadow root test video")), "open shadow-root video should be discovered and selected");
    assert.ok(events.some((item) => item.event === "status-healthy"), "open shadow-root player should become healthy");
  });

  await scenario(debugPort, "iframe", 8_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-healthy" && (item.frameId ?? 0) > 0), "iframe player should report healthy from a child frame");
  });

  await scenario(debugPort, "access", 9_000, async (events) => {
    assert.ok(events.some((item) => item.detail.includes("Access or consent interruption")), "access interruption should be reported");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "access interruption must suppress recovery");
  });

  await scenario(debugPort, "replace", 12_000, async (events) => {
    assert.ok(events.filter((item) => item.event === "player-selected").length >= 2, "replacement player should be rediscovered");
    assert.ok(events.some((item) => item.event === "status-healthy"), "replacement player should become healthy");
  });

  await scenario(debugPort, "paused", 8_000, async (events) => {
    assert.ok(events.some((item) => item.detail.includes("paused")), "paused video should be identified as intentional/non-actionable");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "paused video must not trigger recovery");
  });

  await scenario(debugPort, "ended", 10_000, async (events) => {
    assert.ok(events.some((item) => item.detail.includes("Finite video ended normally")), "finite ended media should be classified as normal VOD completion");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "ended VOD must not trigger recovery");
  });

  await scenario(debugPort, "nested", 9_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-healthy" && (item.frameId ?? 0) > 0), "nested iframe player should report healthy from a child frame");
  });

  await scenario(debugPort, "protocol-spoof", 8_000, async (events) => {
    assert.ok(!events.some((item) => item.event === "recovery-step"), "an untrusted page-world protocol signal must not authorize recovery");
    assert.ok(!events.some((item) => item.event === "page-reload"), "an untrusted page-world protocol signal must not reload the page");
  });

  await scenario(debugPort, "audio-only", 4_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-no_video_found"), "audio-only pages should not be misclassified as video streams");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "audio-only pages must not recover automatically");
  });

  await scenario(debugPort, "stall", 24_000, async (events) => {
    assert.ok(events.some((item) => item.event === "recovery-step"), "a sustained stalled player should enter recovery");
    const firstRecovery = events.find((item) => item.event === "recovery-step");
    const selected = events.find((item) => item.event === "player-selected");
    if (firstRecovery && selected) {
      assert.ok(firstRecovery.timestamp - selected.timestamp >= 5_000, "stalled playback must not recover before the configured elapsed timeout");
    }
  });

  await setTestSettings(debugPort, origin, {
    recoveryStrategy: ["RETRY_BUTTON", "PAGE_RELOAD"],
    errorSelector: ".simulated-stream-error",
    retryButtonSelector: ".retry-stream"
  });
  await scenario(debugPort, "dangerous-control", 8_000, async (events) => {
    assert.ok(events.some((item) => item.detail.includes("Access or consent interruption")), "sensitive modal context should be recognized");
    assert.ok(!events.some((item) => item.event === "recovery-step"), "matching controls inside sensitive dialogs must not be clicked");
  });
  await scenario(debugPort, "recovery", 11_000, async (events) => {
    assert.ok(events.some((item) => item.event === "recovery-step" && item.metadata?.action === "RETRY_BUTTON"), "configured retry control should be used");
    assert.ok(events.some((item) => item.event === "status-healthy"), "retry action should restore playback");
    assert.ok(!events.some((item) => item.event === "page-reload"), "successful soft recovery should avoid page reload");
  });

  await setTestSettings(debugPort, origin, { recoveryStrategy: ["PAGE_RELOAD"], errorSelector: "", retryButtonSelector: "" });
  await scenario(debugPort, "error", 8_000, async (events) => {
    assert.equal(events.filter((item) => item.event === "page-reload").length, 1, "loop protection should limit the test to one automatic reload");
  });

  console.log(`Browser E2E: ${executedScenarios} scenario(s) passed with real extension APIs and deterministic local media fixtures.`);
} catch (error) {
  console.error(chromeLog);
  throw error;
} finally {
  clearTimeout(hardTimeout);
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      wait(2_000)
    ]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  }
  server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    wait(2_000)
  ]);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function scenario(debugPort, mode, waitMs, assertion) {
  if (enabledScenarios.size && !enabledScenarios.has(mode)) return;
  executedScenarios += 1;
  console.log(`→ browser scenario: ${mode}`);
  await clearRuntime(debugPort);
  const target = await createTarget(debugPort, `${origin}/test-page.html?mode=${mode}`);
  await wait(waitMs);
  const events = await getHistory(debugPort);
  try { await assertion(events, target); }
  catch (error) {
    console.error(`Scenario ${mode} history:\n${JSON.stringify(events, null, 2)}`);
    throw error;
  }
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  console.log(`✓ browser scenario: ${mode}`);
}

async function popupScenario(debugPort) {
  if (enabledScenarios.size && !enabledScenarios.has("popup")) return;
  executedScenarios += 1;
  console.log("→ browser scenario: popup");
  const worker = await waitForWorker(debugPort);
  const extensionOrigin = worker.url.match(/^chrome-extension:\/\/[^/]+/)?.[0];
  if (!extensionOrigin) throw new Error(`Unexpected extension worker URL: ${worker.url}`);
  const existingTargets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  for (const target of existingTargets.filter((item) => item.type === "page" && item.url.startsWith(extensionOrigin))) {
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => undefined);
  }
  const popup = await createTarget(debugPort, `${extensionOrigin}/popup.html?e2e=1`);
  await setTargetViewport(popup, 390, 600);
  await wait(800);
  const layout = await evaluateTarget(popup, `(()=>{const body=document.body.getBoundingClientRect();const header=document.querySelector('header')?.getBoundingClientRect();const main=document.querySelector('main')?.getBoundingClientRect();const footer=document.querySelector('footer')?.getBoundingClientRect();return{width:body.width,height:body.height,viewportHeight:innerHeight,headerBottom:header?.bottom,mainTop:main?.top,mainBottom:main?.bottom,footerTop:footer?.top,footerBottom:footer?.bottom,footerVisible:!!footer&&footer.bottom<=innerHeight,settingsVisible:!!document.getElementById('open-settings')?.getClientRects().length,feedback:document.getElementById('feedback')?.textContent||''}})()`);
  console.log(`Popup layout: ${JSON.stringify(layout)}`);
  assert.ok(layout.width >= 320 && layout.width <= 390, `popup width should be bounded, got ${layout.width}`);
  assert.equal(layout.height, 600, `popup height should be explicit, got ${layout.height}`);
  assert.equal(layout.viewportHeight, 600, `popup test viewport should be 600px high, got ${layout.viewportHeight}`);
  assert.equal(layout.footerVisible, true, "popup footer should remain visible without scrolling");
  assert.equal(layout.settingsVisible, true, "settings control should remain visible");
  assert.ok(!layout.feedback.includes("startup error"), `popup should initialize without a startup error: ${layout.feedback}`);
  await evaluateTarget(popup, `(()=>{document.getElementById('open-settings').click();return true})()`);
  await wait(800);
  const after = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const options = after.find((item) => item.type === "page" && item.url.startsWith(`${extensionOrigin}/options.html`));
  assert.ok(options, "settings should open after the popup awaits openOptionsPage()");
  if (options) await fetch(`http://127.0.0.1:${debugPort}/json/close/${options.id}`);
  const stillOpen = after.find((item) => item.id === popup.id);
  if (stillOpen) await fetch(`http://127.0.0.1:${debugPort}/json/close/${popup.id}`);

  const dashboardPopup = await createTarget(debugPort, `${extensionOrigin}/popup.html?e2e=dashboard`);
  await setTargetViewport(dashboardPopup, 390, 600);
  await wait(800);
  await evaluateTarget(dashboardPopup, `(()=>{document.getElementById('open-dashboard').click();return true})()`);
  await wait(1_000);
  const dashboardTargets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const dashboard = dashboardTargets.find((item) => item.type === "page" && item.url.startsWith(`${extensionOrigin}/dashboard.html`));
  assert.ok(dashboard, "Mission Control should open from the popup");
  if (dashboard) {
    await setTargetViewport(dashboard, 1280, 800);
    const dashboardLayout = await evaluateTarget(dashboard, `(()=>({
      contentVisible:!document.getElementById('dashboard-content')?.hidden,
      errorHidden:!!document.getElementById('error-state')?.hidden,
      summaryCards:document.querySelectorAll('.summary-card').length,
      protectedSites:document.getElementById('protected-site-count')?.textContent||'',
      localOnly:document.querySelector('footer')?.textContent?.includes('locally')||false,
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth
    }))()`);
    assert.equal(dashboardLayout.contentVisible, true, "Mission Control should render live background state");
    assert.equal(dashboardLayout.errorHidden, true, "Mission Control should initialize without an error");
    assert.equal(dashboardLayout.summaryCards, 4, "Mission Control should render all summary cards");
    assert.equal(dashboardLayout.localOnly, true, "Mission Control should retain its local-data privacy notice");
    assert.equal(dashboardLayout.horizontalOverflow, false, "Mission Control should fit a desktop viewport without horizontal overflow");
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${dashboard.id}`);
  }
  console.log("✓ browser scenario: popup");
}

async function setTestSettings(debugPort, siteOrigin, siteOverrides) {
  const globalPatch = {
    enabled: true,
    autoRefresh: true,
    pageLoadGraceSeconds: 0,
    checkIntervalSeconds: 1,
    healthyCheckIntervalSeconds: 2,
    suspectCheckIntervalSeconds: 0.5,
    stallTimeoutSeconds: 5,
    failureConfirmationChecks: 2,
    recoveryVerificationSeconds: 3,
    refreshCountdownSeconds: 1,
    maxAutoRefreshes: 1,
    recoveryBackoffSeconds: [1, 1],
    localHistoryEnabled: true,
    historyLimit: 500
  };
  const environment = await evaluateWorker(debugPort, `({href:location.href,chromeType:typeof chrome,storageType:typeof chrome?.storage,chromeKeys:Object.keys(chrome||{})})`);
  if (environment.storageType !== "object") throw new Error(`Extension API unavailable in E2E context: ${JSON.stringify(environment)}`);
  const configured = await evaluateWorker(debugPort, `(async()=>{
    const send=(message)=>chrome.runtime.sendMessage(message);
    await send({type:'ACKNOWLEDGE_DISCLAIMER'});
    const globalResult=await send({type:'UPDATE_GLOBAL_SETTINGS',patch:${JSON.stringify(globalPatch)}});
    const draft=await send({type:'SET_SITE_OVERRIDES',origin:${JSON.stringify(siteOrigin)},overrides:{enabled:false,...${JSON.stringify(siteOverrides)}},replace:true});
    const pattern=${JSON.stringify(`${siteOrigin}/*`)};
    const already=await chrome.permissions.contains({origins:[pattern]});
    const granted=already||await chrome.permissions.request({origins:[pattern]});
    const enabled=granted?await send({type:'SET_SITE_ENABLED',origin:${JSON.stringify(siteOrigin)},enabled:true}):{ok:false,error:'permission denied'};
    return{globalResult,draft,granted,enabled,registrations:(await chrome.scripting.getRegisteredContentScripts()).map(x=>x.id)};
  })()`, true);
  assert.equal(configured.globalResult?.ok, true, `global settings should save through the production message path: ${JSON.stringify(configured)}`);
  assert.equal(configured.draft?.ok, true, `site draft should save before permission: ${JSON.stringify(configured)}`);
  assert.equal(configured.granted, true, `optional host permission should be granted from a simulated user gesture: ${JSON.stringify(configured)}`);
  assert.equal(configured.enabled?.ok, true, `site should enable through dynamic registration: ${JSON.stringify(configured)}`);
  assert.ok(configured.registrations.some((id) => id.startsWith("stream_reviver_")), "production dynamic content-script registration should exist");
  await wait(500);
}

async function clearRuntime(debugPort) {
  await evaluateWorker(debugPort, `(async()=>{
    await chrome.runtime.sendMessage({type:'CLEAR_HISTORY'});
    await chrome.runtime.sendMessage({type:'CLEAR_DATA',target:'runtime'});
    return true;
  })()`);
}
async function getHistory(debugPort) {
  return await evaluateWorker(debugPort, `(async()=>{const x=await chrome.storage.local.get('streamReviverHistoryV2');return x.streamReviverHistoryV2||[]})()`);
}

async function evaluateWorker(debugPort, expression, userGesture = false) {
  const worker = await waitForWorker(debugPort);
  const extensionOrigin = worker.url.match(/^chrome-extension:\/\/[^/]+/)?.[0];
  if (!extensionOrigin) throw new Error(`Unexpected extension worker URL: ${worker.url}`);
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === "page" && item.url.startsWith(extensionOrigin))
    ?? await createTarget(debugPort, `${extensionOrigin}/options.html?e2e=1`);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5000, "CDP WebSocket connection timed out");
  try {
    await withTimeout(cdp.send("Runtime.enable"), 5000, "CDP runtime enable timed out");
    const response = await withTimeout(cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }), 8000, "CDP evaluation timed out");
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  } finally { cdp.close(); }
}

async function evaluateTarget(target, expression) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5000, "CDP target connection timed out");
  try {
    await withTimeout(cdp.send("Runtime.enable"), 5000, "CDP runtime enable timed out");
    const response = await withTimeout(cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), 8000, "CDP evaluation timed out");
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  } finally { cdp.close(); }
}

async function setTargetViewport(target, width, height) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5000, "CDP viewport connection timed out");
  try {
    await withTimeout(cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false
    }), 5000, "CDP viewport override timed out");
  } finally { cdp.close(); }
}

async function createTarget(debugPort, url) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create Chrome target: ${response.status}`);
  return response.json();
}
async function waitForWorker(debugPort) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json()).catch(() => []);
    const workers = targets.filter((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"));
    for (const worker of workers) if (await isStreamReviverWorker(worker)) return worker;
    await wait(100);
  }
  throw new Error("Extension service worker did not start");
}

async function isStreamReviverWorker(target) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  try {
    await withTimeout(cdp.open(), 1000, "worker inspect timeout");
    await cdp.send("Runtime.enable");
    const response = await cdp.send("Runtime.evaluate", {
      expression: `globalThis.chrome?.runtime?.getManifest?.().name`,
      returnByValue: true
    });
    return String(response.result?.result?.value ?? "").startsWith("Stream Reviver");
  } catch { return false; }
  finally { cdp.close(); }
}
async function waitForDebugPort(profileDir) {
  const file = path.join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return Number((await readFile(file, "utf8")).split(/\r?\n/)[0]); } catch { await wait(100); }
  }
  throw new Error("Chrome remote debugging port did not become available");
}

function Cdp(url) {
  this.url = url;
  this.id = 0;
  this.pending = new Map();
  this.open = () => new Promise((resolve, reject) => {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("open", resolve, { once: true });
    this.socket.addEventListener("error", reject, { once: true });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message);
    });
  });
  this.send = (method, params = {}) => {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  };
  this.close = () => this.socket?.close();
}

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))
  ]);
}

async function findChromeBinary() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.platform === "darwin") {
    const cache = path.join(homedir(), "Library", "Caches", "ms-playwright");
    try {
      for (const entry of await readdir(cache)) {
        if (!entry.startsWith("chromium-")) continue;
        candidates.push(path.join(cache, entry, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
      }
    } catch { /* Playwright cache is optional */ }
    candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-for-testing", "/usr/bin/google-chrome");
  }
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}
