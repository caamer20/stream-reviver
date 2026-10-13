import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const linter = path.join(root, "node_modules", "addons-linter", "bin", "addons-linter");
const environment = { ...process.env };
const lint = spawnSync(process.execPath, [linter, "--warnings-as-errors", "dist/firefox"], {
  cwd: root, env: environment, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000
});
process.stdout.write(lint.stdout ?? "");
process.stderr.write(lint.stderr ?? "");
if (lint.status !== 0) process.exit(lint.status ?? 1);
await validatePopupDimensions();
if (process.argv.includes("--lint-only")) process.exit(0);

const firefox = await findFirefox();
if (!firefox) throw new Error("Firefox was not found. Set FIREFOX_BIN to run the temporary-add-on smoke test.");

const manifest = JSON.parse(await readFile(path.join(root, "dist", "firefox", "manifest.json"), "utf8"));
const expectedId = manifest.browser_specific_settings?.gecko?.id;
assert.ok(expectedId, "Built Firefox manifest must declare an add-on ID.");
const profile = await mkdtemp(path.join(tmpdir(), "stream-reviver-firefox-smoke-"));
const driver = spawn(process.env.GECKODRIVER_BIN ?? "geckodriver", ["--host", "127.0.0.1", "--port", "0", "--allow-system-access"], {
  cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"]
});
let driverLog = "", driverError, driverExited = false, base, sessionId, addonId, firefoxPid, cleanupPromise;
driver.on("error", error => { driverError = error; });
driver.on("exit", () => { driverExited = true; });
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", chunk => { driverLog = `${driverLog}${chunk}`.slice(-24_000); });
const deadline = setTimeout(() => {
  console.error("Firefox smoke exceeded its one-minute deadline.");
  void cleanup().finally(() => process.exit(124));
}, 60_000);
try {
  const startupDeadline = Date.now() + 15_000;
  while (!base && Date.now() < startupDeadline) {
    if (driverError) throw driverError;
    if (driverExited) throw new Error("geckodriver exited before startup.");
    const match = driverLog.match(/Listening on (127\.0\.0\.1:\d+)/);
    if (match) base = `http://${match[1]}`;
    else await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(base, "geckodriver must start within 15 seconds.");
  const session = await request("POST", "/session", { capabilities: { alwaysMatch: {
    browserName: "firefox", "moz:firefoxOptions": { binary: firefox, args: ["-headless", "-profile", profile], prefs: { "extensions.update.enabled": false } }
  } } });
  sessionId = session.sessionId;
  firefoxPid = session.capabilities["moz:processID"];
  assert.equal(path.resolve(session.capabilities["moz:profile"]), profile, "Firefox must use only the new disposable smoke profile.");
  await command("POST", "/timeouts", { script: 10_000, pageLoad: 15_000, implicit: 0 });
  addonId = await command("POST", "/moz/addon/install", { path: path.join(root, "dist", "firefox"), temporary: true });
  assert.equal(addonId, expectedId, "Installed add-on must match the built manifest ID.");
  await command("POST", "/moz/context", { context: "chrome" });
  const info = await command("POST", "/execute/async", {
    script: `const id=arguments[0], done=arguments[arguments.length-1]; (async()=>{const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); const addon=await AddonManager.getAddonByID(id); if(!addon)throw Error('Add-on missing'); return {id:addon.id,version:addon.version,active:addon.isActive,temporary:addon.temporarilyInstalled};})().then(value=>done({value}),error=>done({failure:String(error)}));`,
    args: [addonId]
  });
  if (info.failure) throw new Error(info.failure);
  assert.deepEqual(info.value, { id: expectedId, version: manifest.version, active: true, temporary: true });
  await command("POST", "/moz/context", { context: "content" });
  console.log(`Firefox smoke passed with ${firefox}: manifest lint clean and temporary add-on ${addonId} v${manifest.version} verified active.`);
} catch (error) {
  process.stderr.write(driverLog);
  throw error;
} finally {
  clearTimeout(deadline);
  await cleanup();
}

async function request(method, route, body, timeout = 20_000) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout)
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`${route}: ${JSON.stringify(result.value)}`);
  return result.value;
}
function command(method, route, body) { return request(method, `/session/${sessionId}${route}`, body); }
function cleanup() {
  clearTimeout(deadline);
  cleanupPromise ??= cleanupOnce();
  return cleanupPromise;
}
async function cleanupOnce() {
  let sessionDeleted = false;
  if (sessionId) {
    if (addonId) await request("POST", `/session/${sessionId}/moz/addon/uninstall`, { id: addonId }, 3000).catch(() => undefined);
    await request("DELETE", `/session/${sessionId}`, undefined, 3000).then(() => { sessionDeleted = true; }).catch(() => undefined);
    sessionId = undefined;
  }
  // The PID came from this disposable session, never from a user's open browser.
  if (firefoxPid && !sessionDeleted) { try { process.kill(firefoxPid, "SIGKILL"); } catch { /* already closed */ } }
  if (!driverExited) {
    driver.kill("SIGTERM");
    await Promise.race([new Promise(resolve => driver.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (!driverExited) driver.kill("SIGKILL");
  }
  await rm(profile, { recursive: true, force: true });
}

async function findFirefox() {
  const candidates = [
    process.env.FIREFOX_BIN,
    process.platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : undefined,
    process.platform === "linux" ? "/usr/bin/firefox" : undefined
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

async function validatePopupDimensions() {
  const css = await readFile(path.join(root, "dist", "firefox", "popup.css"), "utf8");
  const htmlRule = css.match(/(?:^|\n)html\s*\{([^}]*)\}/)?.[1] ?? "";
  const bodyRule = css.match(/(?:^|\n)body\s*\{([^}]*)\}/)?.[1] ?? "";
  for (const [selector, declarations] of [["html", htmlRule], ["body", bodyRule]]) {
    if (!/\bwidth\s*:\s*390px\b/.test(declarations) || !/\bheight\s*:\s*600px\b/.test(declarations)) {
      throw new Error(`Firefox popup ${selector} must have explicit 390px × 600px dimensions.`);
    }
    if (/\b(?:100v[wh]|min\([^;]*v[wh])\b/.test(declarations)) {
      throw new Error(`Firefox popup ${selector} must not depend on viewport-relative dimensions.`);
    }
  }
}
