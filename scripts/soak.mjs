import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const smoke = process.argv.includes("--smoke");
const allowSkip = process.argv.includes("--allow-skip");
const scenarios = (readArgument("--scenarios") ?? "healthy,churn,replace,protocol-spoof").split(",").map((value) => value.trim()).filter(Boolean);
const supportedScenarios = new Set(["healthy", "churn", "replace", "protocol-spoof"]);
for (const mode of scenarios) assert.ok(supportedScenarios.has(mode), `Unsupported soak scenario: ${mode}`);
assert.ok(scenarios.length > 0, "At least one soak scenario is required");

const durationMs = resolveDuration();
const cycleLimit = Math.floor(numberArgument("--iterations") ?? (smoke ? 1 : Number.POSITIVE_INFINITY));
const scenarioSeconds = numberArgument("--scenario-seconds") ?? (smoke ? 20 : 30);
const reportPath = path.resolve(readArgument("--report") ?? "artifacts/soak-report.json");
const maxHeapGrowthMbPerHour = numberArgument("--max-heap-growth-mb-per-hour") ?? 8;
const chromeBinary = await findChromeBinary();

if (!chromeBinary) {
  const message = "Chrome for Testing or Chromium was not found; a soak gate requires a real browser.";
  if (allowSkip) { console.log(`${message} Explicit --allow-skip accepted.`); process.exit(0); }
  throw new Error(message);
}

const startedAt = Date.now();
const deadline = Number.isFinite(durationMs) ? startedAt + durationMs : Number.POSITIVE_INFINITY;
const report = {
  schemaVersion: 1,
  status: "running",
  startedAt: new Date(startedAt).toISOString(),
  completedAt: null,
  durationSeconds: 0,
  requested: {
    smoke,
    durationSeconds: Number.isFinite(durationMs) ? durationMs / 1000 : null,
    cycleLimit: Number.isFinite(cycleLimit) ? cycleLimit : null,
    scenarioSeconds,
    scenarios,
    maxHeapGrowthMbPerHour
  },
  environment: {
    commit: commandOutput("git", ["rev-parse", "--verify", "HEAD"]) || "unknown",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    chromeBinary,
    chromeVersion: null
  },
  cyclesCompleted: 0,
  scenariosCompleted: 0,
  samples: [],
  assessment: null,
  failure: null
};

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "stream-reviver-soak-"));
const extensionDir = path.join(temporaryRoot, "extension");
const profileDir = path.join(temporaryRoot, "profile");
await cp("dist/chrome", extensionDir, { recursive: true });

let server;
let chrome;
let pageTarget;
let extensionTarget;
let origin;
let debugPort;
let chromeLog = "";

try {
  server = await startFixtureServer();
  const address = server.address();
  assert.ok(address && typeof address === "object", "Fixture server did not expose a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
  await seedExactTestPermission(extensionDir, origin);

  chrome = spawn(chromeBinary, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--js-flags=--expose-gc",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--remote-debugging-port=0",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", (chunk) => { chromeLog = `${chromeLog}${chunk}`.slice(-20_000); });

  debugPort = await waitForDebugPort(profileDir);
  const browserVersion = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
  report.environment.chromeVersion = browserVersion.Browser ?? "unknown";
  const worker = await waitForWorker(debugPort);
  const extensionOrigin = worker.url.match(/^chrome-extension:\/\/[^/]+/)?.[0];
  assert.ok(extensionOrigin, `Unexpected extension worker URL: ${worker.url}`);
  extensionTarget = await createTarget(debugPort, `${extensionOrigin}/options.html?soak=1`);
  pageTarget = await createTarget(debugPort, "about:blank");
  await waitForExtensionApi(extensionTarget);
  await configureExtension(extensionTarget, origin);
  console.log(`Long-lived soak started with ${report.environment.chromeVersion}; one browser/profile will run ${scenarios.join(", ")}.`);

  let cycle = 0;
  while (cycle < cycleLimit && (Date.now() < deadline || cycle === 0)) {
    cycle += 1;
    for (const mode of scenarios) {
      const scenarioStartedAt = Date.now();
      await navigateTarget(pageTarget, `${origin}/test-page.html?mode=${mode}&soakCycle=${cycle}`);
      await wait(scenarioSeconds * 1000);
      const events = (await readHistory(extensionTarget)).filter((item) => Number(item.timestamp) >= scenarioStartedAt - 500);
      const dashboard = await readDashboardState(extensionTarget);
      assertHealthyScenario(mode, events, dashboard);
      report.samples.push(await collectSample({ debugPort, pageTarget, extensionTarget, chromePid: chrome.pid, cycle, mode, dashboard }));
      report.scenariosCompleted += 1;
      console.log(`✓ soak cycle ${cycle} ${mode}: ${events.length} event(s), ${formatSample(report.samples.at(-1))}`);
    }
    report.cyclesCompleted = cycle;
    if (Date.now() >= deadline) break;
  }

  report.assessment = assessSamples(report.samples, maxHeapGrowthMbPerHour);
  assert.deepEqual(report.assessment.failures, [], `Soak resource guard failed:\n${report.assessment.failures.join("\n")}`);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  report.durationSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), wait(2_000)]);
  }
  if (server) {
    server.closeAllConnections?.();
    await withTimeout(new Promise((resolve) => server.close(resolve)), 2_000, "Fixture server shutdown timed out").catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`Soak gate passed ${report.cyclesCompleted} cycle(s), ${report.scenariosCompleted} scenarios, and ${report.samples.length} resource samples in ${report.durationSeconds}s.`);
console.log(`Machine-readable report: ${path.relative(process.cwd(), reportPath)}`);

function resolveDuration() {
  const seconds = numberArgument("--duration-seconds");
  const minutes = numberArgument("--minutes");
  const hours = numberArgument("--hours");
  const supplied = [seconds, minutes, hours].filter((value) => value !== null);
  assert.ok(supplied.length <= 1, "Specify only one of --duration-seconds, --minutes, or --hours");
  if (seconds) return seconds * 1000;
  if (minutes) return minutes * 60_000;
  if (hours) return hours * 60 * 60_000;
  return smoke ? Number.POSITIVE_INFINITY : 24 * 60 * 60_000;
}

async function startFixtureServer() {
  const instance = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      const relative = pathname === "/" ? "test-page.html" : pathname.slice(1);
      const base = path.resolve("dist/test-page");
      const file = path.resolve(base, relative);
      if (file !== base && !file.startsWith(`${base}${path.sep}`)) throw new Error("Invalid fixture path");
      const body = await readFile(file);
      response.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  return instance;
}

async function seedExactTestPermission(directory, siteOrigin) {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.host_permissions, undefined, "Production manifest must not have required host permissions");
  assert.equal(manifest.content_scripts, undefined, "Production manifest must use dynamic content-script registration");
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], "Production manifest optional host declaration changed");
  manifest.host_permissions = [`${siteOrigin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function configureExtension(target, siteOrigin) {
  const result = await evaluateTarget(target, `(async()=>{
    const send=(message)=>chrome.runtime.sendMessage(message);
    const globalPatch={enabled:true,autoRecover:true,autoRefresh:true,onlyWhenTabVisible:false,pageLoadGraceSeconds:0,checkIntervalSeconds:1,healthyCheckIntervalSeconds:2,suspectCheckIntervalSeconds:0.5,stallTimeoutSeconds:8,failureConfirmationChecks:2,recoveryVerificationSeconds:3,refreshCountdownSeconds:1,maxAutoRefreshes:1,recoveryBackoffSeconds:[1,1],localHistoryEnabled:true,historyLimit:500};
    await send({type:'ACKNOWLEDGE_DISCLAIMER'});
    const globalResult=await send({type:'UPDATE_GLOBAL_SETTINGS',patch:globalPatch});
    const draft=await send({type:'SET_SITE_OVERRIDES',origin:${JSON.stringify(siteOrigin)},overrides:{enabled:false},replace:true});
    const enabled=await send({type:'SET_SITE_ENABLED',origin:${JSON.stringify(siteOrigin)},enabled:true});
    await send({type:'CLEAR_HISTORY'});
    await send({type:'CLEAR_DATA',target:'runtime'});
    return{globalResult,draft,enabled,registrations:(await chrome.scripting.getRegisteredContentScripts()).map(item=>item.id)};
  })()`, true);
  assert.equal(result.globalResult?.ok, true, `Global soak settings failed: ${JSON.stringify(result)}`);
  assert.equal(result.draft?.ok, true, `Site soak draft failed: ${JSON.stringify(result)}`);
  assert.equal(result.enabled?.ok, true, `Site soak enable failed: ${JSON.stringify(result)}`);
  assert.ok(result.registrations.some((id) => id.startsWith("stream_reviver_")), "Dynamic content-script registration is missing");
}

function assertHealthyScenario(mode, events, dashboard) {
  const currentMonitor = dashboard.activeMonitors?.find((item) => item.origin === origin);
  const safelyAwaitingCorroboration = mode === "protocol-spoof"
    && currentMonitor?.state === "MONITORING" && !currentMonitor.recoveryAction;
  assert.ok(events.some((item) => item.event === "status-healthy") || currentMonitor?.state === "HEALTHY" || safelyAwaitingCorroboration,
    `${mode} must reach its safe expected state during soak; current state: ${currentMonitor?.state ?? "missing"} (${currentMonitor?.detail ?? "no detail"})`);
  assert.ok(!events.some((item) => item.event === "page-reload"), `${mode} caused a false page reload during soak`);
  assert.ok(!events.some((item) => item.event === "recovery-step"), `${mode} caused a false recovery during soak`);
  if (mode === "replace") assert.ok(events.filter((item) => item.event === "player-selected").length >= 2, "replace must rediscover the player");
}

async function readHistory(target) {
  return evaluateTarget(target, `(async()=>{const value=await chrome.storage.local.get('streamReviverHistoryV2');return value.streamReviverHistoryV2||[]})()`);
}

async function readDashboardState(target) {
  const state = await evaluateTarget(target, `chrome.runtime.sendMessage({type:'GET_DASHBOARD_STATE'})`);
  assert.ok(state && Array.isArray(state.activeMonitors), "Mission Control state was unavailable during soak");
  return state;
}

async function collectSample({ debugPort: port, pageTarget: target, extensionTarget: extension, chromePid, cycle, mode, dashboard }) {
  const page = await targetMetrics(target);
  const worker = await waitForWorker(port);
  const workerMetrics = await targetMetrics(worker);
  const storage = await evaluateTarget(extension, `(async()=>{
    const localBytes=await chrome.storage.local.getBytesInUse(null);
    const syncBytes=await chrome.storage.sync.getBytesInUse(null);
    const sessionBytes=chrome.storage.session?await chrome.storage.session.getBytesInUse(null):0;
    const history=(await chrome.storage.local.get('streamReviverHistoryV2')).streamReviverHistoryV2||[];
    const registrations=await chrome.scripting.getRegisteredContentScripts();
    return{localBytes,syncBytes,sessionBytes,historyEntries:history.length,registrationCount:registrations.length};
  })()`);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  return {
    timestamp: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    cycle,
    mode,
    monitorState: dashboard.activeMonitors?.find((item) => item.origin === origin)?.state ?? "MISSING",
    chromeRssKb: processRssKb(chromePid),
    targetCount: targets.length,
    page,
    worker: workerMetrics,
    storage
  };
}

async function targetMetrics(target) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5_000, "CDP metrics connection timed out");
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Performance.enable").catch(() => undefined);
    await cdp.send("HeapProfiler.collectGarbage").catch(() => undefined);
    const [heap, dom, performance] = await Promise.all([
      cdp.send("Runtime.getHeapUsage"),
      cdp.send("Memory.getDOMCounters").catch(() => ({ result: {} })),
      cdp.send("Performance.getMetrics").catch(() => ({ result: { metrics: [] } }))
    ]);
    const metrics = Object.fromEntries((performance.result?.metrics ?? []).map((item) => [item.name, item.value]));
    return {
      heapUsedBytes: heap.result?.usedSize ?? 0,
      heapTotalBytes: heap.result?.totalSize ?? 0,
      documents: dom.result?.documents ?? 0,
      nodes: dom.result?.nodes ?? 0,
      eventListeners: dom.result?.jsEventListeners ?? 0,
      taskDurationSeconds: metrics.TaskDuration ?? 0,
      scriptDurationSeconds: metrics.ScriptDuration ?? 0
    };
  } finally { cdp.close(); }
}

function assessSamples(samples, maxGrowthMbPerHour) {
  assert.ok(samples.length > 0, "Soak produced no resource samples");
  const failures = [];
  const first = samples[0];
  const last = samples.at(-1);
  const peak = (selector) => Math.max(...samples.map(selector));
  const pageHeapSlope = slopePerHour(samples, (sample) => sample.page.heapUsedBytes);
  const workerHeapSlope = slopePerHour(samples, (sample) => sample.worker.heapUsedBytes);
  const pageHeapDelta = last.page.heapUsedBytes - first.page.heapUsedBytes;
  const workerHeapDelta = last.worker.heapUsedBytes - first.worker.heapUsedBytes;
  const monotonicPageRatio = monotonicIncreaseRatio(samples.map((sample) => sample.page.heapUsedBytes));
  const monotonicWorkerRatio = monotonicIncreaseRatio(samples.map((sample) => sample.worker.heapUsedBytes));
  const maxGrowthBytesPerHour = maxGrowthMbPerHour * 1024 * 1024;

  if (peak((sample) => sample.storage.localBytes) > 5 * 1024 * 1024) failures.push("local storage exceeded the 5 MiB soak guard");
  if (peak((sample) => sample.storage.syncBytes) > 100 * 1024) failures.push("sync storage exceeded the 100 KiB soak guard");
  if (peak((sample) => sample.storage.historyEntries) > 500) failures.push("local history exceeded its configured 500-entry cap");
  if (peak((sample) => sample.targetCount) > first.targetCount + 2) failures.push("browser target count grew beyond the two-target allowance");
  if (peak((sample) => sample.page.nodes) > 25_000) failures.push("fixture page DOM exceeded 25,000 nodes");
  if (peak((sample) => sample.chromeRssKb ?? 0) > 2 * 1024 * 1024) failures.push("Chrome resident memory exceeded the 2 GiB safety guard");

  if (samples.length >= 8 && pageHeapSlope > maxGrowthBytesPerHour && pageHeapDelta > 16 * 1024 * 1024) failures.push(`page heap slope ${(pageHeapSlope / 1024 / 1024).toFixed(2)} MiB/hour exceeds ${maxGrowthMbPerHour} MiB/hour`);
  if (samples.length >= 8 && workerHeapSlope > maxGrowthBytesPerHour && workerHeapDelta > 16 * 1024 * 1024) failures.push(`worker heap slope ${(workerHeapSlope / 1024 / 1024).toFixed(2)} MiB/hour exceeds ${maxGrowthMbPerHour} MiB/hour`);
  if (samples.length >= 8 && monotonicPageRatio >= 0.9 && pageHeapDelta > 8 * 1024 * 1024) failures.push("page heap increased monotonically across at least 90% of samples");
  if (samples.length >= 8 && monotonicWorkerRatio >= 0.9 && workerHeapDelta > 8 * 1024 * 1024) failures.push("worker heap increased monotonically across at least 90% of samples");

  return {
    failures,
    baseline: first,
    final: last,
    peaks: {
      chromeRssKb: peak((sample) => sample.chromeRssKb ?? 0),
      pageHeapUsedBytes: peak((sample) => sample.page.heapUsedBytes),
      workerHeapUsedBytes: peak((sample) => sample.worker.heapUsedBytes),
      localStorageBytes: peak((sample) => sample.storage.localBytes),
      syncStorageBytes: peak((sample) => sample.storage.syncBytes),
      sessionStorageBytes: peak((sample) => sample.storage.sessionBytes),
      historyEntries: peak((sample) => sample.storage.historyEntries),
      targetCount: peak((sample) => sample.targetCount),
      pageNodes: peak((sample) => sample.page.nodes),
      pageEventListeners: peak((sample) => sample.page.eventListeners)
    },
    trends: { pageHeapBytesPerHour: pageHeapSlope, workerHeapBytesPerHour: workerHeapSlope, pageHeapDeltaBytes: pageHeapDelta, workerHeapDeltaBytes: workerHeapDelta, monotonicPageRatio, monotonicWorkerRatio }
  };
}

function slopePerHour(samples, selector) {
  if (samples.length < 2) return 0;
  const xs = samples.map((sample) => sample.elapsedSeconds / 3600);
  const ys = samples.map(selector);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  if (denominator === 0) return 0;
  return xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0) / denominator;
}

function monotonicIncreaseRatio(values) {
  if (values.length < 2) return 0;
  let increases = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] >= values[index - 1]) increases += 1;
  return increases / (values.length - 1);
}

function formatSample(sample) {
  const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  return `page heap ${mib(sample.page.heapUsedBytes)} MiB, worker heap ${mib(sample.worker.heapUsedBytes)} MiB, local storage ${sample.storage.localBytes} B, history ${sample.storage.historyEntries}`;
}

async function navigateTarget(target, url) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5_000, "CDP navigation connection timed out");
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.bringToFront");
    const response = await cdp.send("Page.navigate", { url });
    assert.ok(!response.result?.errorText, `Navigation failed: ${response.result?.errorText}`);
    await cdp.send("Page.bringToFront");
  } finally { cdp.close(); }
}

async function evaluateTarget(target, expression, userGesture = false) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await withTimeout(cdp.open(), 5_000, "CDP evaluation connection timed out");
  try {
    await cdp.send("Runtime.enable");
    const response = await withTimeout(cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }), 10_000, "CDP evaluation timed out");
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  } finally { cdp.close(); }
}

async function createTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create Chrome target: ${response.status}`);
  return response.json();
}

async function waitForExtensionApi(target) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ready = await evaluateTarget(target, `typeof chrome === "object" && typeof chrome.runtime?.sendMessage === "function"`);
      if (ready) return;
    } catch { /* the extension document is still loading */ }
    await wait(100);
  }
  throw new Error("Extension page did not expose the runtime API");
}

async function waitForWorker(port) {
  let lastTargets = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    lastTargets = targets.map((target) => ({ type: target.type, url: target.url }));
    const workers = targets.filter((target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"));
    for (const worker of workers) if (await isStreamReviverWorker(worker)) return worker;
    await wait(100);
  }
  throw new Error(`Extension service worker did not start\nObserved targets: ${JSON.stringify(lastTargets)}${chromeLog ? `\nChrome log:\n${chromeLog}` : ""}`);
}

async function isStreamReviverWorker(target) {
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  try {
    await withTimeout(cdp.open(), 1_000, "Worker inspection timed out");
    await cdp.send("Runtime.enable");
    const response = await cdp.send("Runtime.evaluate", {
      expression: `globalThis.chrome?.runtime?.getManifest?.().name`,
      returnByValue: true
    });
    const name = String(response.result?.result?.value ?? "");
    return name.startsWith("Stream Reviver") || name === "__MSG_extensionName__";
  } catch { return false; }
  finally { cdp.close(); }
}

async function waitForDebugPort(directory) {
  const file = path.join(directory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const value = Number((await readFile(file, "utf8")).split(/\r?\n/)[0]);
      if (Number.isInteger(value) && value > 0) return value;
    } catch { /* browser is still starting */ }
    await wait(100);
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

function processRssKb(pid) {
  if (!Number.isInteger(pid)) return null;
  const output = commandOutput("ps", ["-o", "rss=", "-p", String(pid)]);
  const value = Number(output);
  return Number.isFinite(value) ? value : null;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function readArgument(name) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function numberArgument(name) {
  const raw = readArgument(name);
  if (raw === null) return null;
  const value = Number(raw);
  assert.ok(Number.isFinite(value) && value > 0, `${name} must be a positive number`);
  return value;
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function withTimeout(promise, milliseconds, message) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))]); }

async function findChromeBinary() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  if (process.platform === "darwin") {
    const cache = path.join(homedir(), "Library", "Caches", "ms-playwright");
    try {
      for (const entry of await readdir(cache)) {
        if (!entry.startsWith("chromium-")) continue;
        candidates.push(path.join(cache, entry, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
        candidates.push(path.join(cache, entry, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"));
      }
    } catch { /* optional cache */ }
    candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-for-testing", "/usr/bin/google-chrome");
  }
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate; } catch { /* next candidate */ }
  }
  return null;
}
