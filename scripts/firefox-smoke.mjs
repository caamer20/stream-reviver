import { spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const webExt = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "web-ext.cmd" : "web-ext");
const environment = { ...process.env, NO_UPDATE_NOTIFIER: "1", WEB_EXT_NO_UPDATE_NOTIFIER: "1" };
const lint = spawnSync(webExt, ["lint", "--source-dir", "dist/firefox", "--warnings-as-errors"], {
  cwd: root, env: environment, encoding: "utf8", maxBuffer: 10 * 1024 * 1024
});
process.stdout.write(lint.stdout ?? "");
process.stderr.write(lint.stderr ?? "");
if (lint.status !== 0) process.exit(lint.status ?? 1);
await validatePopupDimensions();
if (process.argv.includes("--lint-only")) process.exit(0);

const firefox = await findFirefox();
if (!firefox) throw new Error("Firefox was not found. Set FIREFOX_BIN to run the temporary-add-on smoke test.");

const child = spawn(webExt, [
  "run", "--source-dir", "dist/firefox", "--firefox", firefox,
  "--no-reload", "--no-input", "--start-url", "about:blank", "--arg=-headless"
], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
let installed = false;
const append = (chunk) => {
  output = `${output}${chunk}`.slice(-20_000);
  if (/Installed .* as a temporary add-on/.test(output)) {
    installed = true;
    setTimeout(() => child.kill("SIGINT"), 1_000);
  }
};
child.stdout.on("data", append);
child.stderr.on("data", append);
const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
const exitCode = await new Promise((resolve) => child.once("exit", resolve));
clearTimeout(timeout);
if (!installed) {
  process.stderr.write(output);
  throw new Error(`Firefox did not install the temporary add-on (exit ${String(exitCode)}).`);
}
console.log(`Firefox smoke passed with ${firefox}: manifest lint clean and temporary add-on installed.`);

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
