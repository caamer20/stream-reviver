import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const channel = readArgument("--channel") ?? null;
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const base = channel ? path.join("dist", channel) : "dist";
const roots = [path.join(base, "chrome"), path.join(base, "firefox")];
const checksums = {};

for (const root of roots) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, `${root} must be Manifest V3`);
  assert.equal(manifest.version, packageJson.version, `${root} version mismatch`);
  assert.equal(manifest.default_locale, "en", `${root} must declare its localization fallback`);
  assert.equal(manifest.name, "__MSG_extensionName__", `${root} must use a localized name`);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"], `${root} permission set changed`);
  assert.deepEqual(manifest.optional_permissions, ["notifications"], `${root} optional permission set changed`);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], `${root} optional host capability changed`);
  assert.match(manifest.content_security_policy.extension_pages, /^script-src 'self'; object-src 'none'$/, `${root} must prohibit remote scripts and objects`);
  assert.ok(!manifest.host_permissions, `${root} must not request persistent broad host access`);
  assert.ok(!manifest.content_scripts, `${root} must use explicit per-origin dynamic registration`);
  assert.ok(await exists(path.join(root, "_locales", "en", "messages.json")), `${root} must include English locale messages`);
  const buildInfo = JSON.parse(await readFile(path.join(root, "build-info.json"), "utf8"));
  assert.equal(buildInfo.version, packageJson.version, `${root} build metadata version mismatch`);
  if (channel) assert.equal(buildInfo.channel, channel, `${root} build metadata channel mismatch`);

  let totalBytes = 0;
  for (const file of await walk(root)) {
    const relative = path.relative(process.cwd(), file);
    const bytes = await readFile(file);
    totalBytes += bytes.length;
    checksums[relative] = createHash("sha256").update(bytes).digest("hex");
    if (file.endsWith(".js")) {
      const source = bytes.toString("utf8");
      assert.ok(!/\beval\s*\(/.test(source), `${relative} contains eval()`);
      assert.ok(!/\bnew\s+Function\s*\(/.test(source), `${relative} contains dynamic code generation`);
      assert.ok(!/\b(?:fetch|XMLHttpRequest|EventSource)\s*\(/.test(source), `${relative} contains an unreviewed network API`);
      assert.ok(!/origins\s*:\s*\[\s*["']<all_urls>/.test(source), `${relative} requests broad host access at runtime`);
      assert.ok(bytes.length < 750_000, `${relative} exceeds the 750 KB per-script budget`);
    }
    if (file.endsWith(".html")) {
      const source = bytes.toString("utf8");
      assert.ok(!/<script[^>]+src=["']https?:/i.test(source), `${relative} references a remote script`);
      assert.ok(!/<link[^>]+href=["']https?:/i.test(source), `${relative} references a remote stylesheet`);
    }
  }
  assert.ok(totalBytes < 3_000_000, `${root} exceeds the 3 MB unpacked size budget`);
}

const checksumPath = path.join(base, "checksums.json");
await writeFile(checksumPath, `${JSON.stringify({ algorithm: "SHA-256", files: checksums }, null, 2)}\n`);
console.log(`Release validation passed for ${Object.keys(checksums).length} files (${channel ?? "development"}); wrote ${checksumPath}`);

function readArgument(name) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function walk(root) {
  const result = [];
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    if ((await stat(file)).isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result.sort();
}
