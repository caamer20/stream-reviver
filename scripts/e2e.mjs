import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const chromeBinary = await findChromeBinary();
if (!chromeBinary) {
  console.log("Chrome for Testing or Chromium was not found; browser E2E tests skipped.");
  process.exit(0);
}
console.log(`Browser E2E using: ${chromeBinary}`);

const temp = await mkdtemp(path.join(tmpdir(), "stream-reviver-e2e-"));
const extensionDir = path.join(temp, "extension");
const profileDir = path.join(temp, "profile");
await cp("dist/chrome", extensionDir, { recursive: true });
const manifestPath = path.join(extensionDir, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
manifest.content_scripts = [{
  matches: ["http://127.0.0.1/*"], js: ["content.js"], css: ["content.css"],
  all_frames: true, run_at: "document_start"
}, {
  matches: ["http://127.0.0.1/*"], js: ["page-bridge.js"], all_frames: true, run_at: "document_start", world: "MAIN"
}];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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

const chrome = spawn(chromeBinary, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking", "--disable-component-update",
  `--user-data-dir=${profileDir}`, `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
  "--remote-debugging-port=0", "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (chunk) => { chromeLog = `${chromeLog}${chunk}`.slice(-20_000); });

try {
  const debugPort = await waitForDebugPort(profileDir);
  console.log(`Chrome debugging ready on port ${debugPort}`);
  await waitForWorker(debugPort);
  console.log("Extension service worker is running");
  await setTestSettings(debugPort, origin, {});
  console.log("Test settings initialized");

  await scenario(debugPort, "healthy", 10_000, async (events) => {
    assert.ok(events.some((item) => item.event === "status-healthy"), "healthy video should reach HEALTHY");
    assert.ok(!events.some((item) => item.event === "page-reload"), "healthy video must not reload");
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

  await setTestSettings(debugPort, origin, {
    recoveryStrategy: ["RETRY_BUTTON", "PAGE_RELOAD"],
    errorSelector: ".simulated-stream-error",
    retryButtonSelector: ".retry-stream"
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

  console.log("Browser E2E: 9 scenarios passed (healthy, multi-video, DOM churn, SPA, iframe, access suppression, replacement, verified soft recovery, loop protection)");
} catch (error) {
  console.error(chromeLog);
  throw error;
} finally {
  chrome.kill("SIGTERM");
  server.close();
  await rm(temp, { recursive: true, force: true });
}

async function scenario(debugPort, mode, waitMs, assertion) {
  console.log(`→ browser scenario: ${mode}`);
  await clearRuntime(debugPort);
  const target = await createTarget(debugPort, `${origin}/test-page.html?mode=${mode}`);
  await wait(waitMs);
  const events = await getHistory(debugPort);
  try { await assertion(events); }
  catch (error) {
    console.error(`Scenario ${mode} history:\n${JSON.stringify(events, null, 2)}`);
    throw error;
  }
  await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`);
  console.log(`✓ browser scenario: ${mode}`);
}

async function setTestSettings(debugPort, siteOrigin, siteOverrides) {
  const settings = {
    schemaVersion: 3,
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
    historyLimit: 500,
    perSite: { [siteOrigin]: { enabled: true, ...siteOverrides } }
  };
  const environment = await evaluateWorker(debugPort, `({href:location.href,chromeType:typeof chrome,storageType:typeof chrome?.storage,chromeKeys:Object.keys(chrome||{})})`);
  if (environment.storageType !== "object") throw new Error(`Extension API unavailable in E2E context: ${JSON.stringify(environment)}`);
  await evaluateWorker(debugPort, `(async()=>{await chrome.storage.local.set({streamReviverDisclaimerAcknowledged:true});await chrome.storage.sync.set({streamReviverSettings:${JSON.stringify(settings)}});return true})()`);
  await wait(300);
}

async function clearRuntime(debugPort) {
  await evaluateWorker(debugPort, `(async()=>{await chrome.storage.local.set({streamReviverHistoryV2:[]});await chrome.storage.session.set({streamReviverLoopStateV2:{},streamReviverStatusV2:{}});return true})()`);
}
async function getHistory(debugPort) {
  return await evaluateWorker(debugPort, `(async()=>{const x=await chrome.storage.local.get('streamReviverHistoryV2');return x.streamReviverHistoryV2||[]})()`);
}

async function evaluateWorker(debugPort, expression) {
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
    const response = await withTimeout(cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), 8000, "CDP evaluation timed out");
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
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
    return response.result?.result?.value === "Stream Reviver";
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
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-for-testing");
  }
  for (const candidate of candidates.reverse()) {
    try { await stat(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}
