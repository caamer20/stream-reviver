import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256, validateExtensionVersion } from "./release-integrity.mjs";

// Test reports and older releases may share the directory. Only the current
// manifest's exact expected outputs participate in reproducibility checks.
export async function artifactInventory(directory, expected = {}) {
  const directoryInfo = await lstat(directory);
  assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), "Artifact directory must be a real directory");
  const manifestBytes = await regularFile(directory, "release-manifest.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 2, "Unsupported release manifest schema");
  validateExtensionVersion(manifest.version);
  if (expected.version) assert.equal(manifest.version, expected.version, "Artifact version is stale");
  if (expected.commit) assert.equal(manifest.commit, expected.commit, "Artifact commit is stale");
  const prefix = `stream-reviver-${manifest.version}`;
  const archives = ["chrome", "firefox", "source"].map(kind => `${prefix}-${kind}.zip`);
  assert.deepEqual(Object.keys(manifest.archives).sort(), [...archives].sort(), "Release archives must match the exact versioned browser/source names");
  assert.equal(manifest.sbom.name, `${prefix}-sbom.cdx.json`, "Unexpected SBOM path");
  const result = { "release-manifest.json": { bytes: manifestBytes.length, sha256: sha256(manifestBytes) } };
  for (const name of [...archives, manifest.sbom.name]) {
    const bytes = await regularFile(directory, name);
    const actual = { bytes: bytes.length, sha256: sha256(bytes) };
    const declared = manifest.archives[name] ?? manifest.sbom;
    assert.equal(actual.bytes, declared.bytes, `Artifact size does not match manifest: ${name}`);
    assert.equal(actual.sha256, declared.sha256, `Artifact hash does not match manifest: ${name}`);
    result[name] = actual;
  }
  return result;
}

async function regularFile(directory, name) {
  const file = path.join(directory, name);
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Release artifact must be a regular file: ${name}`);
  return readFile(file);
}
