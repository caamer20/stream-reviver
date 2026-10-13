import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const chromeBinary = await findChromeBinary();
const allowSkip = process.argv.includes("--allow-skip");
const enabledScenarios = new Set((process.env.E2E_SCENARIOS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
let executedScenarios = 0;
const viewportSessions = new Map();
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
    const status = await getScenarioStatus(debugPort, "multi");
    assert.ok(status.selectedVideoLabel.includes("test-video"), "main player should beat the muted preview");
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
    const status = await getScenarioStatus(debugPort, "shadow");
    assert.ok(status.selectedVideoLabel.includes("Open shadow root test video"), "open shadow-root video should be discovered and selected");
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

  if (!enabledScenarios.size || enabledScenarios.has("dangerous-control") || enabledScenarios.has("recovery")) {
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
  }

  if (!enabledScenarios.size || enabledScenarios.has("error")) {
    await setTestSettings(debugPort, origin, { recoveryStrategy: ["PAGE_RELOAD"], errorSelector: "", retryButtonSelector: "" });
    await scenario(debugPort, "error", 8_000, async (events, target) => {
      assert.equal(events.filter((item) => item.event === "page-reload").length, 1, "loop protection should limit the test to one automatic reload");
      assert.ok(events.some((item) => item.event === "post-refresh-maximize"), "an automatic reload should trigger the default-on maximize handoff");
      const maximizeState = await evaluateTarget(target, `({nativeFullscreen:!!document.fullscreenElement,cssMaximized:!!document.querySelector('.stream-reviver-maximized')})`);
      assert.ok(maximizeState.nativeFullscreen || maximizeState.cssMaximized,
        `the refreshed stream should be fullscreen or use the safe CSS fallback: ${JSON.stringify(maximizeState)}`);
    });
  }

  if (!enabledScenarios.size || enabledScenarios.has("error-maximize-off")) {
    await setTestSettings(debugPort, origin, {
      recoveryStrategy: ["PAGE_RELOAD"], errorSelector: "", retryButtonSelector: "", autoMaximize: false
    });
    await scenario(debugPort, "error-maximize-off", 8_000, async (events, target) => {
      assert.equal(events.filter((item) => item.event === "page-reload").length, 1, "turning off maximize must not disable automatic page recovery");
      assert.ok(!events.some((item) => item.event === "post-refresh-maximize"), "the per-site opt-out must suppress post-refresh maximize");
      const maximizeState = await evaluateTarget(target, `({nativeFullscreen:!!document.fullscreenElement,cssMaximized:!!document.querySelector('.stream-reviver-maximized')})`);
      assert.deepEqual(maximizeState, { nativeFullscreen: false, cssMaximized: false }, "the opt-out must leave the refreshed page layout unchanged");
    }, "error");
  }

  console.log(`Browser E2E: ${executedScenarios} scenario(s) passed with real extension APIs and deterministic local media fixtures.`);
} catch (error) {
  console.error(chromeLog);
  throw error;
} finally {
  clearTimeout(hardTimeout);
  for (const cdp of viewportSessions.values()) cdp.close();
  viewportSessions.clear();
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

async function scenario(debugPort, mode, waitMs, assertion, pageMode = mode) {
  if (enabledScenarios.size && !enabledScenarios.has(mode)) return;
  executedScenarios += 1;
  console.log(`→ browser scenario: ${mode}`);
  await clearRuntime(debugPort);
  const target = await createTarget(debugPort, `${origin}/test-page.html?mode=${pageMode}`);
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
  const popupMetrics = await setTargetViewport(popup, 390, 600);
  console.log(`Popup CDP layout metrics: ${JSON.stringify(popupMetrics)}`);
  await wait(800);
  const layout = await evaluateTarget(popup, `(()=>{const body=document.body.getBoundingClientRect();const header=document.querySelector('header')?.getBoundingClientRect();const main=document.querySelector('main')?.getBoundingClientRect();const footer=document.querySelector('footer')?.getBoundingClientRect();return{width:body.width,height:body.height,viewportHeight:innerHeight,headerBottom:header?.bottom,mainTop:main?.top,mainBottom:main?.bottom,footerTop:footer?.top,footerBottom:footer?.bottom,footerVisible:!!footer&&footer.bottom<=innerHeight,settingsVisible:!!document.getElementById('open-settings')?.getClientRects().length,feedback:document.getElementById('feedback')?.textContent||''}})()`);
  console.log(`Popup layout: ${JSON.stringify(layout)}`);
  assert.ok(layout.width >= 320 && layout.width <= 390, `popup width should be bounded, got ${layout.width}`);
  assert.equal(layout.height, 600, `popup height should be explicit, got ${layout.height}`);
  assert.equal(layout.viewportHeight, 600, `popup test viewport should be 600px high, got ${layout.viewportHeight}`);
  assert.equal(layout.footerVisible, true, "popup footer should remain visible without scrolling");
  assert.equal(layout.settingsVisible, true, "settings control should remain visible");
  assert.ok(!layout.feedback.includes("startup error"), `popup should initialize without a startup error: ${layout.feedback}`);
  // Let CDP return before the production handler opens a tab and closes this
  // popup. Otherwise Chrome can destroy the evaluation context before replying.
  console.log("Popup navigation: opening Settings");
  await evaluateTarget(popup, `(()=>{setTimeout(()=>document.getElementById('open-settings').click(),0);return true})()`);
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
  console.log("Popup navigation: opening Mission Control");
  await evaluateTarget(dashboardPopup, `(()=>{setTimeout(()=>document.getElementById('open-dashboard').click(),0);return true})()`);
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

    // Exercise the dashboard's list controls against real browser state. Synthetic
    // origins are disabled and have no permissions, so this cannot register page
    // scripts or grant access to the fixture domains.
    const syntheticOrigins = Array.from({ length: 105 }, (_, index) =>
      `https://e2e-site-${String(index).padStart(3, "0")}.example`
    );
    const originalSites = await evaluateWorker(debugPort, `(async()=>{
      const stored=await chrome.storage.local.get('streamReviverSiteSettingsV1');
      return stored.streamReviverSiteSettingsV1??{};
    })()`);
    const seeded = await evaluateWorker(debugPort, `(async()=>{
      const record=structuredClone(${JSON.stringify(originalSites)});
      if(!record||!record.perSite||typeof record.perSite!=='object') throw new Error('Unexpected stored site settings record');
      for (const origin of ${JSON.stringify(syntheticOrigins)}) {
        record.perSite[origin]={enabled:false};
      }
      await chrome.storage.local.set({'streamReviverSiteSettingsV1':record});
      return true;
    })()`);
    assert.equal(seeded, true, "synthetic disabled origins should be seeded in the local site settings record");
    const seededReadModel = await evaluateWorker(debugPort, `chrome.runtime.sendMessage({type:'GET_DASHBOARD_STATE'})`);
    assert.equal(seededReadModel?.configuredSites?.length, 106, "the background read model should contain all 106 real configured origins");
    let renderedSiteCount = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      renderedSiteCount = await evaluateTarget(dashboard, `document.getElementById('configured-sites-count')?.textContent||''`);
      if (/100.*106|106.*100/.test(renderedSiteCount)) break;
      await wait(100);
    }
    assert.match(renderedSiteCount, /100.*106|106.*100/, "Mission Control should render all configured sites from its latest poll");

    const listControls = await evaluateTarget(dashboard, `(()=>({
      search:!!document.getElementById('dashboard-search'),
      siteFilter:!!document.getElementById('site-filter'),
      monitorFilter:!!document.getElementById('monitor-filter'),
      clear:!!document.getElementById('clear-filters'),
      siteCount:document.getElementById('configured-sites-count')?.textContent||'',
      monitorCount:document.getElementById('active-monitors-count')?.textContent||'',
      recoveryCount:document.getElementById('recent-recoveries-count')?.textContent||'',
      protectedTotal:document.getElementById('protected-site-count')?.textContent||'',
      showMoreSites:!!document.getElementById('show-more-sites')
    }))()`);
    assert.equal(listControls.search, true, "Mission Control should expose hostname search");
    assert.equal(listControls.siteFilter, true, "Mission Control should expose site status filtering");
    assert.equal(listControls.monitorFilter, true, "Mission Control should expose monitor status filtering");
    assert.equal(listControls.clear, true, "Mission Control should expose a clear-filters action");
    assert.match(listControls.siteCount, /100.*106|106.*100/, "site count should disclose the initial bounded batch and total");
    assert.equal(listControls.protectedTotal, "1", "filtering and batching must not alter the global protected-site total");
    assert.ok(listControls.monitorCount.length > 0, "monitor count should be available");
    assert.ok(listControls.recoveryCount.length > 0, "recovery count should be available");
    assert.equal(listControls.showMoreSites, true, "a second bounded site batch should be available");

    const searched = await evaluateTarget(dashboard, `(()=>{
      const input=document.getElementById('dashboard-search');
      input.value='e2e-site-104'; input.dispatchEvent(new Event('input',{bubbles:true}));
      const rows=[...document.querySelectorAll('#configured-sites li')];
      return {rows:rows.map((row)=>row.textContent),count:document.getElementById('configured-sites-count')?.textContent||'',
        labels:[...document.querySelectorAll('#configured-sites .site-host')].map((node)=>node.textContent)};
    })()`);
    assert.equal(searched.rows.length, 1, "hostname search should find a site outside the initially rendered batch");
    assert.ok(searched.rows[0].includes("e2e-site-104.example"), "search result should match the hostname");
    assert.ok(searched.labels.every((label)=>!/[/?#]/.test(label)), "site labels should not expose URL paths, queries, or fragments");
    const noMatch = await evaluateTarget(dashboard, `(()=>{
      const input=document.getElementById('dashboard-search');
      input.value='no-such-host.invalid'; input.dispatchEvent(new Event('input',{bubbles:true}));
      return {rows:document.querySelectorAll('#configured-sites li').length,empty:document.getElementById('configured-sites-empty')?.hidden===false};
    })()`);
    assert.equal(noMatch.rows, 0, "unmatched hostname search should hide all site rows");
    assert.equal(noMatch.empty, true, "unmatched hostname search should show a no-results state");
    await evaluateTarget(dashboard, `document.getElementById('clear-filters').click()`);

    const siteStatusFilters = await evaluateTarget(dashboard, `(()=>{
      const filter=document.getElementById('site-filter');
      filter.value='protected'; filter.dispatchEvent(new Event('change',{bubbles:true}));
      const protectedRows=[...document.querySelectorAll('#configured-sites li')];
      filter.value='off'; filter.dispatchEvent(new Event('change',{bubbles:true}));
      const offRows=[...document.querySelectorAll('#configured-sites li')];
      return {protectedCount:protectedRows.length,protectedLabels:protectedRows.map((row)=>row.querySelector('.coverage-status')?.textContent),
        offCount:offRows.length,offLabels:offRows.map((row)=>row.querySelector('.coverage-status')?.textContent)};
    })()`);
    assert.equal(siteStatusFilters.protectedCount, 1, "protected filter should retain only the enabled fixture origin");
    assert.ok(siteStatusFilters.protectedLabels.every((label)=>label==='Protected'), "protected filter results should have protected status");
    assert.equal(siteStatusFilters.offCount, 100, "off filter should keep the rendered batch bounded");
    assert.ok(siteStatusFilters.offLabels.every((label)=>label==='Off'), "off filter results should have off status");
    const offCount = await evaluateTarget(dashboard, `document.getElementById('configured-sites-count')?.textContent||''`);
    assert.match(offCount, /100.*105/, "off filter count should disclose all 105 matching disabled sites");
    await evaluateTarget(dashboard, `document.getElementById('clear-filters').click()`);

    const expanded = await evaluateTarget(dashboard, `(()=>{
      document.getElementById('show-more-sites').click();
      return {count:document.getElementById('configured-sites-count')?.textContent||'',rows:document.querySelectorAll('#configured-sites li').length};
    })()`);
    assert.equal(expanded.rows, 106, "show more should reveal the next bounded site batch");
    assert.match(expanded.count, /106.*106/, "expanded site count should disclose that every site is visible");

    // Open a real monitored fixture so the keyboard/focus path uses the actual
    // dashboard cards produced by the background.
    const monitorFixture = await createTarget(debugPort, `${origin}/test-page.html?mode=healthy`);
    let dashboardState = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      dashboardState = await evaluateWorker(debugPort, `chrome.runtime.sendMessage({type:'GET_DASHBOARD_STATE'})`);
      if (dashboardState?.activeMonitors?.length) break;
      await wait(150);
    }
    // Opening the player target hides Mission Control. Bring the dashboard back
    // to the foreground so its visibility-aware poll can refresh from the
    // background state before checking for the card.
    await bringTargetToFront(dashboard);
    let monitorObservation = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      monitorObservation = await evaluateTarget(dashboard, `({visibility:document.visibilityState,count:document.querySelectorAll('#active-monitors .monitor-card').length})`);
      if (monitorObservation.visibility === 'visible' && monitorObservation.count > 0) break;
      await wait(150);
    }
    assert.ok(monitorObservation?.visibility === 'visible' && monitorObservation.count > 0,
      `a real fixture monitor should appear in visible Mission Control; dashboard=${JSON.stringify(monitorObservation)} background=${JSON.stringify(dashboardState)}`);

    // Count actual production state requests to prove two render cycles keep
    // the active keyboard target stable without relying on fixed-duration waits.
    await evaluateTarget(dashboard, `(()=>{
      window.__e2eOriginalSendMessage=chrome.runtime.sendMessage;
      window.__e2eDashboardReads=0;
      window.__e2ePendingDashboardReads=0;
      window.__e2eFailDashboardRead=false;
      chrome.runtime.sendMessage=function(message,...args){
        if(message?.type!=='GET_DASHBOARD_STATE') return window.__e2eOriginalSendMessage.apply(chrome.runtime,[message,...args]);
        window.__e2eDashboardReads+=1;
        const callback=typeof args.at(-1)==='function'?args.at(-1):null;
        if(window.__e2eFailDashboardRead){
          if(callback){queueMicrotask(()=>callback(undefined));return undefined;}
          return Promise.reject(new Error('E2E forced refresh failure'));
        }
        window.__e2ePendingDashboardReads+=1;
        if(callback){
          args[args.length-1]=(...values)=>{window.__e2ePendingDashboardReads=Math.max(0,window.__e2ePendingDashboardReads-1);callback(...values);};
          return window.__e2eOriginalSendMessage.call(chrome.runtime,message,...args);
        }
        const result=window.__e2eOriginalSendMessage.call(chrome.runtime,message,...args);
        return Promise.resolve(result).finally(()=>{window.__e2ePendingDashboardReads=Math.max(0,window.__e2ePendingDashboardReads-1);});
      };
    })()`);
    const focusPersistence = await evaluateTarget(dashboard, `(()=>{
      const button=document.querySelector('#active-monitors .focus-tab');
      if(!button) return {focused:false};
      button.focus();
      return {focused:document.activeElement===button,host:button.closest('.monitor-card')?.querySelector('h3')?.textContent||''};
    })()`);
    assert.equal(focusPersistence.focused, true, "monitor focus button should receive keyboard focus");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const polls = await evaluateTarget(dashboard, `({reads:window.__e2eDashboardReads,pending:window.__e2ePendingDashboardReads})`);
      if (polls.reads >= 2 && polls.pending === 0) break;
      await wait(150);
    }
    const keptFocus = await evaluateTarget(dashboard, `({focused:document.activeElement?.matches?.('#active-monitors .focus-tab')===true,disabled:document.activeElement?.disabled===true})`);
    const completedDashboardPolls = await evaluateTarget(dashboard, `({reads:window.__e2eDashboardReads,pending:window.__e2ePendingDashboardReads})`);
    assert.ok(completedDashboardPolls.reads >= 2 && completedDashboardPolls.pending === 0, "focus verification requires at least two completed production refreshes");
    assert.equal(keptFocus.focused, true, "focused monitor action should survive two dashboard polling renders");
    assert.equal(keptFocus.disabled, false, "successful polls should leave the preserved focus action enabled");
    await setTargetViewport(dashboard, 1280, 900);
    await evaluateTarget(dashboard, `window.scrollTo(0,0)`);
    await captureTarget(dashboard, "artifacts/dashboard-operability.png");
    await setTargetViewport(dashboard, 360, 800);
    const narrowDashboard = await evaluateTarget(dashboard, `document.documentElement.scrollWidth<=document.documentElement.clientWidth`);
    assert.equal(narrowDashboard, true, "dashboard filters and expanded lists must fit a narrow viewport");
    await captureTarget(dashboard, "artifacts/dashboard-operability-narrow.png");

    // The API call counter verifies that hidden pages stop polling and resume
    // with a fresh read when made visible. visibilityState is overridden only
    // inside this isolated E2E document because headless Chrome visibility is
    // not reliably controllable through its window manager.
    const hiddenPolling = await evaluateTarget(dashboard, `(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
      return window.__e2eDashboardReads;
    })()`);
    await wait(3_500);
    const hiddenReads = await evaluateTarget(dashboard, `window.__e2eDashboardReads`);
    assert.equal(hiddenReads, hiddenPolling, "hidden Mission Control should pause background state polling");
    await evaluateTarget(dashboard, `(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = await evaluateTarget(dashboard, `({reads:window.__e2eDashboardReads,pending:window.__e2ePendingDashboardReads})`);
      if (pending.reads > hiddenReads && pending.pending === 0) break;
      await wait(100);
    }
    const resumedReads = await evaluateTarget(dashboard, `window.__e2eDashboardReads`);
    assert.ok(resumedReads > hiddenReads, "returning Mission Control to visible should immediately refresh state");

    await evaluateTarget(dashboard, `(()=>{window.__e2eFailDashboardRead=true})()`);
    let staleState = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      staleState = await evaluateTarget(dashboard, `(()=>({
        noteVisible:document.getElementById('stale-notice')?.hidden===false,
        disabledFocusButtons:[...document.querySelectorAll('#active-monitors .focus-tab')].every((button)=>button.disabled),
        retryFocused:document.activeElement?.id==='retry-button',
        contentVisible:!document.getElementById('dashboard-content')?.hidden
      }))()`);
      if (staleState.noteVisible) break;
      await wait(100);
    }
    assert.equal(staleState.noteVisible, true, "a failed refresh should label the retained dashboard data as stale");
    assert.equal(staleState.disabledFocusButtons, true, "stale monitor cards should disable tab-focus actions");
    assert.equal(staleState.retryFocused, true, "a failed refresh should move focus from the disabled monitor action to Retry");
    assert.equal(staleState.contentVisible, true, "the last known dashboard data should remain visible during an error");
    await evaluateTarget(dashboard, `(()=>{window.__e2eFailDashboardRead=false})()`);
    await evaluateTarget(dashboard, `(()=>{
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()`);
    let recoveredState = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      recoveredState = await evaluateTarget(dashboard, `(()=>({
        noteHidden:document.getElementById('stale-notice')?.hidden===true,
        focusButtonsEnabled:[...document.querySelectorAll('#active-monitors .focus-tab')].every((button)=>!button.disabled),
        restoredFocus:document.activeElement?.matches?.('#active-monitors .focus-tab')===true
      }))()`);
      if (recoveredState.noteHidden && recoveredState.restoredFocus) break;
      await wait(100);
    }
    assert.equal(recoveredState.noteHidden, true, "a successful refresh should clear the stale-data notice");
    assert.equal(recoveredState.focusButtonsEnabled, true, "a successful refresh should re-enable monitor focus actions");
    assert.equal(recoveredState.restoredFocus, true, "a successful refresh should restore focus to the same monitor action after Retry");
    await evaluateTarget(dashboard, `(()=>{
      chrome.runtime.sendMessage=window.__e2eOriginalSendMessage;
      delete window.__e2eOriginalSendMessage;
      delete window.__e2eDashboardReads;
      delete window.__e2eFailDashboardRead;
    })()`);

    const fallbackFilter = await evaluateTarget(dashboard, `(()=>{
      const button=document.querySelector('#active-monitors .focus-tab');
      button?.focus();
      const state=button?.closest('.monitor-card')?.querySelector('.status-chip')?.textContent?.toLowerCase()||'';
      const filter=document.getElementById('monitor-filter');
      if(!filter) return {filter:false};
      filter.value=state.includes('healthy')?'attention':'healthy';
      filter.dispatchEvent(new Event('change',{bubbles:true}));
      return {filter:true,focused:document.activeElement===filter,remaining:document.querySelectorAll('#active-monitors .monitor-card').length};
    })()`);
    assert.equal(fallbackFilter.filter, true, "monitor status filter should remain available");
    assert.equal(fallbackFilter.focused, true, "removing the focused monitor card should move focus to its filter");
    await evaluateTarget(dashboard, `document.getElementById('clear-filters').click()`);
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${monitorFixture.id}`);

    await evaluateWorker(debugPort, `chrome.storage.local.set({'streamReviverSiteSettingsV1':${JSON.stringify(originalSites)}}).then(()=>true)`);
    await wait(400);

    const importPage = await createTarget(debugPort, `${extensionOrigin}/options.html?e2e=settings-import`);
    await wait(800);
    const importBefore = await evaluateWorker(debugPort, `(async()=>{
      const [sync,local,permissions,registrations]=await Promise.all([
        chrome.storage.sync.get('streamReviverSettings'),
        chrome.storage.local.get('streamReviverSiteSettingsV1'),
        chrome.permissions.getAll(),
        chrome.scripting.getRegisteredContentScripts()
      ]);
      return {global:sync.streamReviverSettings,sites:local.streamReviverSiteSettingsV1,
        origins:[...(permissions.origins||[])].sort(),registrations:registrations.map((item)=>item.id).sort()};
    })()`);
    const uploadSettingsFile = async (text, name) => evaluateTarget(importPage, `(()=>{
      const input=document.getElementById('import-file');
      const transfer=new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'application/json'}));
      input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    await uploadSettingsFile('{"arbitrary":"not a settings backup"}', 'arbitrary.json');
    await wait(150);
    const invalidImport = await evaluateTarget(importPage, `(()=>({
      reviewDisabled:document.getElementById('import-settings')?.disabled===true,
      feedback:document.getElementById('feedback')?.textContent||''
    }))()`);
    assert.equal(invalidImport.reviewDisabled, true, "unrecognized JSON should not open an import review");
    assert.match(invalidImport.feedback, /Invalid settings backup/i, "invalid JSON should explain why it was rejected");
    const afterInvalid = await evaluateWorker(debugPort, `(async()=>{
      const [sync,local,permissions,registrations]=await Promise.all([
        chrome.storage.sync.get('streamReviverSettings'),chrome.storage.local.get('streamReviverSiteSettingsV1'),
        chrome.permissions.getAll(),chrome.scripting.getRegisteredContentScripts()
      ]);
      return {global:sync.streamReviverSettings,sites:local.streamReviverSiteSettingsV1,
        origins:[...(permissions.origins||[])].sort(),registrations:registrations.map((item)=>item.id).sort()};
    })()`);
    assert.deepEqual(afterInvalid, importBefore, "invalid JSON must leave settings, access grants, and registrations unchanged");

    const validBackup = {
      schemaVersion: 4,
      enabled: false,
      stallTimeoutSeconds: 17,
      recoveryStrategy: ["PAGE_RELOAD"],
      perSite: { [origin]: { enabled: true, autoRecover: false } }
    };
    const validBackupText = JSON.stringify(validBackup, null, 2);
    await uploadSettingsFile(validBackupText, 'stream-reviver-settings-e2e.json');
    await wait(150);
    const reviewOpened = await evaluateTarget(importPage, `document.getElementById('import-settings').click()`);
    await wait(300);
    const importReview = await evaluateTarget(importPage, `(()=>{
      const preview=document.getElementById('settings-import-preview')?.textContent||'';
      let normalized=null; try { normalized=JSON.parse(preview); } catch {}
      return {open:document.getElementById('settings-import-dialog')?.open===true,
        summary:document.getElementById('settings-import-summary')?.textContent||'',
        defaults:document.getElementById('settings-import-defaults')?.textContent||'',
        sites:document.getElementById('settings-import-sites')?.textContent||'',
        status:document.getElementById('settings-import-status')?.textContent||'',
        statusLive:document.getElementById('settings-import-status')?.getAttribute('role')==='status'&&document.getElementById('settings-import-status')?.getAttribute('aria-live')==='polite',
        preview,normalized,canonical:normalized!==null&&preview===JSON.stringify(normalized,null,2)};
    })()`);
    assert.equal(reviewOpened, undefined, "review click should be handled by the settings page");
    assert.equal(importReview.open, true, "valid settings backup should open a deliberate review dialog");
    assert.ok(importReview.summary.includes("Replace all saved global settings"), "review should explain that import replaces current settings");
    assert.ok(importReview.defaults.length > 0, "review should disclose fields filled from defaults");
    assert.ok(importReview.sites.includes("Currently enabled"), "review should disclose currently enabled site configuration");
    assert.equal(importReview.statusLive, true, "import review status should be announced accessibly");
    assert.match(importReview.status, /Review the exact normalized replacement/i, "review status should identify the exact preview");
    assert.equal(importReview.canonical, true, "review should show the exact canonical normalized JSON");
    assert.equal(importReview.normalized.enabled, false, "review preview should include the imported global value");
    assert.equal(importReview.normalized.stallTimeoutSeconds, 17, "review preview should retain supported imported values");
    assert.equal(importReview.normalized.perSite[origin].enabled, false, "all imported origins must be disabled in the reviewed preview");
    assert.equal(importReview.normalized.perSite[origin].autoRecover, false, "review preview should retain site-level settings");
    await setTargetViewport(importPage, 1280, 1000);
    await captureTarget(importPage, "artifacts/settings-import-review.png");
    await evaluateTarget(importPage, `document.getElementById('cancel-settings-import').click()`);
    await wait(150);
    assert.deepEqual(
      await evaluateWorker(debugPort, `(async()=>{const [sync,local,permissions,registrations]=await Promise.all([chrome.storage.sync.get('streamReviverSettings'),chrome.storage.local.get('streamReviverSiteSettingsV1'),chrome.permissions.getAll(),chrome.scripting.getRegisteredContentScripts()]);return{global:sync.streamReviverSettings,sites:local.streamReviverSiteSettingsV1,origins:[...(permissions.origins||[])].sort(),registrations:registrations.map((item)=>item.id).sort()}})()`),
      importBefore,
      "canceling review must not mutate settings, access grants, or registrations"
    );

    await evaluateTarget(importPage, `document.getElementById('import-settings').click()`);
    await wait(150);
    await evaluateTarget(importPage, `(()=>{
      window.__e2eOriginalSendMessage=chrome.runtime.sendMessage;
      chrome.runtime.sendMessage=function(message,...args){
        if(message?.type==='SET_SITE_ENABLED'&&message.enabled===false){
          const callback=typeof args.at(-1)==='function'?args.at(-1):null;
          if(callback){queueMicrotask(()=>callback({ok:false,error:'E2E forced site deactivation refusal'}));return undefined;}
          return Promise.resolve({ok:false,error:'E2E forced site deactivation refusal'});
        }
        return window.__e2eOriginalSendMessage.call(chrome.runtime,message,...args);
      };
    })()`);
    await evaluateTarget(importPage, `document.getElementById('apply-settings-import').click()`);
    await wait(500);
    const rejectedApply = await evaluateTarget(importPage, `(()=>({
      open:document.getElementById('settings-import-dialog')?.open===true,
      status:document.getElementById('settings-import-status')?.textContent||'',
      disabled:document.getElementById('apply-settings-import')?.disabled===true
    }))()`);
    assert.equal(rejectedApply.open, true, "a failed site deactivation should keep the import review open");
    assert.match(rejectedApply.status, /E2E forced site deactivation refusal/, "a failed runtime response should be presented in the live import status");
    assert.equal(rejectedApply.disabled, true, "a failed import review should disable unsafe retry until re-review");
    const afterRejectedApply = await evaluateWorker(debugPort, `(async()=>{const [sync,local,permissions,registrations]=await Promise.all([chrome.storage.sync.get('streamReviverSettings'),chrome.storage.local.get('streamReviverSiteSettingsV1'),chrome.permissions.getAll(),chrome.scripting.getRegisteredContentScripts()]);return{global:sync.streamReviverSettings,sites:local.streamReviverSiteSettingsV1,origins:[...(permissions.origins||[])].sort(),registrations:registrations.map((item)=>item.id).sort()}})()`);
    assert.deepEqual(afterRejectedApply, importBefore, "a rejected site deactivation must preserve saved settings, grants, and registrations");
    await evaluateTarget(importPage, `(()=>{
      chrome.runtime.sendMessage=window.__e2eOriginalSendMessage;
      delete window.__e2eOriginalSendMessage;
      document.getElementById('cancel-settings-import').click();
    })()`);
    await wait(150);
    await evaluateTarget(importPage, `document.getElementById('import-settings').click()`);
    await wait(150);
    await evaluateTarget(importPage, `document.getElementById('apply-settings-import').click()`);
    let appliedImport = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      appliedImport = await evaluateWorker(debugPort, `(async()=>{
        const [sync,local,registrations]=await Promise.all([
          chrome.storage.sync.get('streamReviverSettings'),chrome.storage.local.get('streamReviverSiteSettingsV1'),
          chrome.scripting.getRegisteredContentScripts()
        ]);
        return {global:sync.streamReviverSettings?.settings,sites:local.streamReviverSiteSettingsV1?.perSite,
          registrations:registrations.map((item)=>item.id)};
      })()`);
      if (appliedImport.global?.stallTimeoutSeconds === 17 && appliedImport.sites?.[origin]?.enabled === false) break;
      await wait(200);
    }
    assert.equal(appliedImport.global?.enabled, false, "applying the reviewed import should persist imported global values");
    assert.equal(appliedImport.global?.stallTimeoutSeconds, 17, "applying the reviewed import should persist numeric settings");
    assert.equal(appliedImport.sites?.[origin]?.enabled, false, "applying the reviewed import should persist imported origins as disabled");
    assert.equal(appliedImport.sites?.[origin]?.autoRecover, false, "applying the reviewed import should persist site-level values");
    assert.ok(importBefore.registrations.every((id) => !appliedImport.registrations.includes(id)), "applying the import should unregister the previously active site");
    const successfulApplyStatus = await evaluateTarget(importPage, `document.getElementById('feedback')?.textContent||''`);
    assert.match(successfulApplyStatus, /Settings imported/, "successful import should report completion to the user");

    // Restore this isolated E2E profile to its original setup. Restore storage
    // records exactly, then use the production site-enable message to rebuild
    // registrations for any site that was enabled before the import scenario.
    const restored = await evaluateWorker(debugPort, `(async()=>{
      const snapshot=${JSON.stringify(importBefore)};
      await chrome.storage.sync.set({'streamReviverSettings':snapshot.global});
      await chrome.storage.local.set({'streamReviverSiteSettingsV1':snapshot.sites});
      await new Promise((resolve)=>setTimeout(resolve,100));
      const enabled=Object.entries(snapshot.sites?.perSite||{}).filter(([,site])=>site.enabled);
      for(const [siteOrigin] of enabled){
        const parsed=new URL(siteOrigin);
        const pattern=parsed.origin+'/*';
        const has=await chrome.permissions.contains({origins:[pattern]});
        if(!has&&!await chrome.permissions.request({origins:[pattern]})) throw new Error('Could not restore the E2E site grant');
        const result=await chrome.runtime.sendMessage({type:'SET_SITE_ENABLED',origin:siteOrigin,enabled:true});
        if(result?.ok!==true) throw new Error(result?.error||'Could not restore the E2E site registration');
      }
      return true;
    })()`, true);
    assert.equal(restored, true, "the isolated E2E browser should restore its original settings and site registration");
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${importPage.id}`);
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${dashboard.id}`);
  }
  console.log("✓ browser scenario: popup");
}

async function setTestSettings(debugPort, siteOrigin, siteOverrides) {
  const globalPatch = {
    enabled: true,
    autoRefresh: true,
    autoMaximize: true,
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

// Assert player identity from live UI state, not identifying diagnostic history.
async function getScenarioStatus(debugPort, mode) {
  return await evaluateWorker(debugPort, `(async()=>{
    const tabs=await chrome.tabs.query({});
    const tab=tabs.find(t=>t.url===${JSON.stringify(`${origin}/test-page.html?mode=`)}+${JSON.stringify(mode)});
    if(!tab) throw new Error('Scenario tab not found');
    return (await chrome.runtime.sendMessage({type:'GET_POPUP_STATE',tabId:tab.id})).status;
  })()`);
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
  let cdp = viewportSessions.get(target.id);
  if (!cdp) {
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await withTimeout(cdp.open(), 5000, "CDP viewport connection timed out");
    viewportSessions.set(target.id, cdp);
  }
  await withTimeout(cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false
  }), 5000, "CDP viewport override timed out");
  const metrics = await withTimeout(cdp.send("Page.getLayoutMetrics"), 5000, "CDP viewport metrics timed out");
  return metrics.result;
}

async function bringTargetToFront(target) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5000, "CDP foreground connection timed out");
  try { await withTimeout(cdp.send("Page.bringToFront"), 5000, "Could not bring browser target to front"); }
  finally { cdp.close(); }
}

async function captureTarget(target, file) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5000, "CDP screenshot connection timed out");
  try {
    const response = await withTimeout(cdp.send("Page.captureScreenshot", { format: "png" }), 5000, "UI screenshot timed out");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(response.result.data, "base64"));
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
