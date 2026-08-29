import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const roots = ["dist/chrome", "dist/firefox"];
const checksums = {};

for (const root of roots) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, `${root} must be Manifest V3`);
  assert.equal(manifest.version, "3.0.0", `${root} version mismatch`);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"], `${root} permission set changed`);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"], `${root} optional host capability changed`);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/, `${root} must prohibit remote scripts`);
  assert.ok(!manifest.host_permissions, `${root} must not request persistent broad host access`);

  for (const file of await walk(root)) {
    const relative = path.relative(process.cwd(), file);
    const bytes = await readFile(file);
    checksums[relative] = createHash("sha256").update(bytes).digest("hex");
    if (!file.endsWith(".js")) continue;
    const source = bytes.toString("utf8");
    assert.ok(!/\beval\s*\(/.test(source), `${relative} contains eval()`);
    assert.ok(!/\bnew\s+Function\s*\(/.test(source), `${relative} contains dynamic code generation`);
    assert.ok(!/<script[^>]+src=["']https?:/i.test(source), `${relative} references a remote script`);
  }
}

await writeFile("dist/checksums.json", `${JSON.stringify({ algorithm: "SHA-256", generatedAt: new Date().toISOString(), files: checksums }, null, 2)}\n`);
console.log(`Release validation passed for ${Object.keys(checksums).length} files; wrote dist/checksums.json`);

async function walk(root) {
  const result = [];
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    if ((await stat(file)).isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result.sort();
}
