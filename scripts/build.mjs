import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIconPng } from "./icon.mjs";

const root = process.cwd();
const requestedChannel = readArgument("--channel") ?? "development";
if (!["development", "beta", "stable"].includes(requestedChannel)) throw new Error(`Unknown build channel: ${requestedChannel}`);
const legacyLayout = !process.argv.includes("--channel");
const outRoot = legacyLayout ? path.join(root, "dist") : path.join(root, "dist", requestedChannel);
const browsers = ["chrome", "firefox"];
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const channelConfig = JSON.parse(await readFile(path.join(root, "config", `${requestedChannel}.json`), "utf8"));
const commit = gitCommit();
const entryPoints = {
  background: "src/background/background.ts",
  content: "src/content/content.ts",
  "page-bridge": "src/page-bridge/bridge.ts",
  popup: "src/popup/popup.ts",
  options: "src/options/options.ts",
  welcome: "src/welcome/welcome.ts"
};

if (legacyLayout) {
  for (const name of [...browsers, "test-page", "checksums.json", "provenance.json"]) await rm(path.join(outRoot, name), { recursive: true, force: true });
} else await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });

for (const browser of browsers) {
  const outdir = path.join(outRoot, browser);
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints,
    outdir,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: browser === "chrome" ? ["chrome109"] : ["firefox140"],
    sourcemap: channelConfig.includeSourceMaps,
    minify: false,
    legalComments: "none",
    define: {
      __TARGET_BROWSER__: JSON.stringify(browser),
      __BUILD_CHANNEL__: JSON.stringify(requestedChannel),
      __BUILD_VERSION__: JSON.stringify(packageJson.version)
    }
  });

  for (const file of [
    "popup/popup.html",
    "popup/popup.css",
    "options/options.html",
    "options/options.css",
    "welcome/welcome.html",
    "welcome/welcome.css",
    "content/content.css"
  ]) {
    const source = path.join(root, "src", file);
    const destination = path.join(outdir, path.basename(file));
    await cp(source, destination);
  }

  const localesDir = path.join(outdir, "_locales");
  await cp(path.join(root, "src", "_locales"), localesDir, { recursive: true });
  const englishMessagesPath = path.join(localesDir, "en", "messages.json");
  const englishMessages = JSON.parse(await readFile(englishMessagesPath, "utf8"));
  const localizedSuffix = channelConfig.nameSuffix ? ` ${channelConfig.nameSuffix}` : "";
  englishMessages.extensionName.message = `Stream Reviver${localizedSuffix}`;
  englishMessages.shortName.message = `Stream Reviver${localizedSuffix}`.slice(0, 30);
  englishMessages.extensionDescription.message = `${channelConfig.descriptionPrefix}Classify, diagnose, and safely recover failed live streams with local, explainable automation.`.slice(0, 132);
  await writeFile(englishMessagesPath, `${JSON.stringify(englishMessages, null, 2)}\n`);

  const manifest = createManifest(browser);
  await writeFile(path.join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outdir, "build-info.json"), `${JSON.stringify({
    channel: requestedChannel, version: packageJson.version, commit, target: browser
  }, null, 2)}\n`);

  for (const size of [16, 32, 48, 128]) {
    await writeFile(path.join(outdir, `icon-${size}.png`), createIconPng(size));
  }
}

await cp(path.join(root, "test"), path.join(outRoot, "test-page"), { recursive: true });
await writeFile(path.join(outRoot, "provenance.json"), `${JSON.stringify({
  channel: requestedChannel, version: packageJson.version, commit, generatedAt: new Date().toISOString(), node: process.version
}, null, 2)}\n`);
console.log(`Built ${requestedChannel} Chrome, Firefox, and test-page output in ${path.relative(root, outRoot)}`);

function createManifest(browser) {
  const manifest = {
    manifest_version: 3,
    default_locale: "en",
    name: "__MSG_extensionName__",
    short_name: "__MSG_shortName__",
    version: packageJson.version,
    description: "__MSG_extensionDescription__",
    permissions: ["storage", "activeTab", "scripting"],
    optional_permissions: ["notifications"],
    optional_host_permissions: ["<all_urls>"],
    action: {
      default_title: "__MSG_actionTitle__",
      default_popup: "popup.html",
      default_icon: iconMap()
    },
    icons: iconMap(),
    options_ui: {
      page: "options.html",
      open_in_tab: true
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'"
    },
    commands: {
      "refresh-stream": {
        suggested_key: { default: "Alt+Shift+R", mac: "MacCtrl+Shift+R" },
        description: "Refresh the monitored stream"
      },
      "maximize-stream": {
        suggested_key: { default: "Alt+Shift+M", mac: "MacCtrl+Shift+M" },
        description: "Maximize the primary stream"
      },
      "toggle-monitoring": { description: "Pause or resume monitoring in the current tab" },
      "cancel-refresh": { description: "Cancel a pending automatic refresh" }
    }
  };

  if (browser === "chrome") {
    manifest.minimum_chrome_version = "109";
    manifest.background = { service_worker: "background.js" };
  } else {
    manifest.browser_specific_settings = {
      gecko: {
        id: channelConfig.firefoxId,
        strict_min_version: "140.0",
        data_collection_permissions: {
          required: ["none"]
        }
      },
      gecko_android: {
        strict_min_version: "142.0"
      }
    };
    // Firefox MV3 uses a non-persistent background script rather than Chrome's
    // service_worker key. The bundled background is compatible with both.
    manifest.background = { scripts: ["background.js"], persistent: false };
  }

  return manifest;
}

function readArgument(name) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function gitCommit() {
  try { return execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return "uncommitted"; }
}

function iconMap() {
  return {
    "16": "icon-16.png",
    "32": "icon-32.png",
    "48": "icon-48.png",
    "128": "icon-128.png"
  };
}
