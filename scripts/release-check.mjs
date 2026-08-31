import assert from "node:assert/strict";
import { lstat, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, createBuildIdentity, readArgument, sha256 } from "./release-integrity.mjs";
import { assertNoEgressInHtml, assertNoEgressInSource } from "./no-egress.mjs";

const EXTENSION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

const channel = readArgument("--channel") ?? null;
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const base = channel ? path.join("dist", channel) : "dist";
const roots = [path.join(base, "chrome"), path.join(base, "firefox")];
const checksums = {};
const expectedIdentity = await createBuildIdentity({ root: process.cwd(), packageJson, channel: channel ?? "development" });
const provenance = JSON.parse(await readFile(path.join(base, "provenance.json"), "utf8"));
assertIdentity(provenance, expectedIdentity, `${base}/provenance.json`);

for (const root of roots) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, `${root} must be Manifest V3`);
  assert.equal(manifest.version, packageJson.version, `${root} version mismatch`);
  assert.equal(manifest.default_locale, "en", `${root} must declare its localization fallback`);
  assert.equal(manifest.name, "__MSG_extensionName__", `${root} must use a localized name`);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting", "alarms"], `${root} permission set changed`);
  assert.deepEqual(manifest.optional_permissions, ["notifications"], `${root} optional permission set changed`);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], `${root} optional host capability changed`);
  assert.equal(manifest.content_security_policy.extension_pages, EXTENSION_CSP, `${root} must prohibit extension-page network, embedding, navigation, remote scripts, and objects`);
  assert.ok(!manifest.host_permissions, `${root} must not request persistent broad host access`);
  assert.ok(!manifest.content_scripts, `${root} must use explicit per-origin dynamic registration`);
  assert.deepEqual(manifest.action.default_icon, manifest.icons, `${root} action and product icon maps must stay aligned`);
  assert.ok(await exists(path.join(root, "_locales", "en", "messages.json")), `${root} must include English locale messages`);
  const buildInfo = JSON.parse(await readFile(path.join(root, "build-info.json"), "utf8"));
  assertIdentity(buildInfo, expectedIdentity, `${root}/build-info.json`);
  assert.equal(buildInfo.target, path.basename(root), `${root} build metadata target mismatch`);

  for (const size of [16, 32, 48, 128]) {
    const filename = manifest.icons[String(size)];
    assert.equal(filename, `icon-${size}.png`, `${root} must map the ${size} px product icon`);
    const icon = await readFile(path.join(root, filename));
    assert.ok(icon.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), `${root}/${filename} must be PNG`);
    assert.equal(icon.readUInt32BE(16), size, `${root}/${filename} width mismatch`);
    assert.equal(icon.readUInt32BE(20), size, `${root}/${filename} height mismatch`);
    assert.equal(icon[25], 6, `${root}/${filename} must preserve RGBA transparency`);
    assert.ok(icon.length > 300, `${root}/${filename} is unexpectedly simple or empty`);
  }

  let totalBytes = 0;
  const outputEntries = [];
  for (const file of await walk(root)) {
    const relative = path.relative(process.cwd(), file);
    const bytes = await readFile(file);
    outputEntries.push({ name: path.relative(root, file).replaceAll(path.sep, "/"), data: bytes });
    totalBytes += bytes.length;
    checksums[relative] = sha256(bytes);
    if (file.endsWith(".js")) {
      const source = bytes.toString("utf8");
      assert.ok(!/\beval\s*\(/.test(source), `${relative} contains eval()`);
      assert.ok(!/\bnew\s+Function\s*\(/.test(source), `${relative} contains dynamic code generation`);
      assertNoEgressInSource(source, relative, path.basename(file) === "content.js"
        ? {
            userNavigationIdentifiers: { performRecoveryAction: ["backup"] }
          }
        : {});
      assert.ok(!/origins\s*:\s*\[\s*["']<all_urls>/.test(source), `${relative} requests broad host access at runtime`);
      assert.ok(bytes.length < 750_000, `${relative} exceeds the 750 KB per-script budget`);
    }
    if (file.endsWith(".html")) {
      const source = bytes.toString("utf8");
      assert.ok(!/<script[^>]+src=["']https?:/i.test(source), `${relative} references a remote script`);
      assert.ok(!/<link[^>]+href=["']https?:/i.test(source), `${relative} references a remote stylesheet`);
      assertNoEgressInHtml(source, relative);
    }
  }
  assert.ok(totalBytes < 3_000_000, `${root} exceeds the 3 MB unpacked size budget`);
  assert.deepEqual(canonicalDigest(outputEntries), provenance.targets?.[path.basename(root)], `${root} output hash does not match build provenance`);
}

const checksumPath = path.join(base, "checksums.json");
await writeFile(checksumPath, `${JSON.stringify({ algorithm: "SHA-256", files: checksums }, null, 2)}\n`);
console.log(`Release validation passed for ${Object.keys(checksums).length} files (${channel ?? "development"}); wrote ${checksumPath}`);

async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function walk(root) {
  const result = [];
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const info = await lstat(file);
    assert.ok(!info.isSymbolicLink(), `${file} must not be a symlink`);
    if (info.isDirectory()) result.push(...await walk(file));
    else {
      assert.ok(info.isFile(), `${file} must be a regular file`);
      result.push(file);
    }
  }
  return result.sort();
}

function assertIdentity(actual, expected, label) {
  for (const key of [
    "schemaVersion", "channel", "version", "commit", "tree", "sourceDateEpoch", "generatedAt",
    "sourceInputSha256", "packageLockSha256", "repository", "toolchain"
  ]) assert.deepEqual(actual[key], expected[key], `${label} ${key} does not match the current source/toolchain`);
}
