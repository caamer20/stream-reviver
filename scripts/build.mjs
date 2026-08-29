import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import path from "node:path";

const root = process.cwd();
const outRoot = path.join(root, "dist");
const browsers = ["chrome", "firefox"];
const entryPoints = {
  background: "src/background/background.ts",
  content: "src/content/content.ts",
  "page-bridge": "src/page-bridge/bridge.ts",
  popup: "src/popup/popup.ts",
  options: "src/options/options.ts",
  welcome: "src/welcome/welcome.ts"
};

await rm(outRoot, { recursive: true, force: true });
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
    sourcemap: true,
    minify: false,
    legalComments: "none",
    define: { __TARGET_BROWSER__: JSON.stringify(browser) }
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

  const manifest = createManifest(browser);
  await writeFile(path.join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const size of [16, 32, 48, 128]) {
    await writeFile(path.join(outdir, `icon-${size}.png`), createIconPng(size));
  }
}

await cp(path.join(root, "test"), path.join(outRoot, "test-page"), { recursive: true });
console.log("Built dist/chrome, dist/firefox, and dist/test-page");

function createManifest(browser) {
  const manifest = {
    manifest_version: 3,
    name: "Stream Reviver",
    version: "3.0.0",
    description: "Classify, diagnose, and safely recover failed live streams with local, explainable automation.",
    permissions: ["storage", "activeTab", "scripting"],
    optional_permissions: ["notifications"],
    optional_host_permissions: ["<all_urls>"],
    action: {
      default_title: "Stream Reviver",
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
        id: "stream-reviver@example.local",
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

function iconMap() {
  return {
    "16": "icon-16.png",
    "32": "icon-32.png",
    "48": "icon-48.png",
    "128": "icon-128.png"
  };
}

function createIconPng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const center = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.31;

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const index = y * stride + 1 + x * 4;
      const distance = Math.hypot(x - center, y - center);
      let color = [21, 24, 36, 255];
      if (distance <= outer) color = [113, 72, 232, 255];
      if (distance <= inner) color = [25, 28, 42, 255];

      const play = x > size * 0.42 && x < size * 0.72 &&
        y > size * 0.31 && y < size * 0.69 &&
        Math.abs(y - center) < (x - size * 0.36) * 0.72;
      if (play) color = [255, 255, 255, 255];
      raw.set(color, index);
    }
  }

  const chunks = [];
  chunks.push(pngChunk("IHDR", Buffer.concat([
    uint32(size), uint32(size), Buffer.from([8, 6, 0, 0, 0])
  ])));
  chunks.push(pngChunk("IDAT", deflateSync(raw)));
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([uint32(data.length), name, data, uint32(crc32(Buffer.concat([name, data])))]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
