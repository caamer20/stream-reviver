import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertPinnedToolchain, inspectToolchain, sha256, sourceDigest, validateTrackedSource } from "./release-integrity.mjs";

export const SOURCE_BUILD_METADATA = "SOURCE_BUILD.json";

export function sourceArchiveMetadata(identity, entries) {
  return {
    schemaVersion: 1,
    identity,
    files: entries.map(({ path, mode }) => ({ path, mode })).sort((a, b) => a.path.localeCompare(b.path))
  };
}

// Reviewer-only reconstruction, not a release authorization. Normal stable
// builds, release checks, and packaging continue to require clean, tagged Git.
export async function sourceArchiveIdentity(root, packageJson) {
  const metadataPath = path.join(root, SOURCE_BUILD_METADATA);
  const info = await lstat(metadataPath);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Source metadata must be a regular file");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const identity = await validateSourceArchive(root, metadata, packageJson.version);
  const toolchain = await inspectToolchain(root, packageJson);
  assertPinnedToolchain(packageJson, toolchain);
  assert.deepEqual(toolchain, identity.toolchain, "Reviewer toolchain must match the submitted build");
  return identity;
}

export async function validateSourceArchive(root, metadata, version) {
  assert.equal(metadata.schemaVersion, 1, "Unsupported source metadata schema");
  const identity = metadata.identity;
  assert.equal(identity.schemaVersion, 2);
  assert.equal(identity.channel, "stable");
  assert.equal(identity.version, version, "Source version mismatch");
  for (const key of ["commit", "tree"]) assert.match(identity[key], /^[0-9a-f]{40}$/);
  for (const key of ["sourceInputSha256", "packageLockSha256"]) assert.match(identity[key], /^[0-9a-f]{64}$/);
  assert.equal(identity.repository.clean, true);
  assert.ok(Number.isSafeInteger(identity.sourceDateEpoch) && identity.sourceDateEpoch > 0);
  assert.equal(identity.generatedAt, new Date(identity.sourceDateEpoch * 1000).toISOString());
  assert.ok(Array.isArray(metadata.files), "Source inventory is required");
  await validateTrackedSource(root, metadata.files);
  const expected = new Set(metadata.files.map(file => file.path));
  const found = new Set();
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      // Only outputs/dependencies created by documented reviewer commands are
      // excluded. Extra source files and symlinked source directories fail.
      if (!prefix && ["node_modules", "dist"].includes(entry.name) && entry.isDirectory()) continue;
      if (!prefix && entry.name === SOURCE_BUILD_METADATA) continue;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), `${name}/`);
      else {
        assert.ok(entry.isFile() && !entry.isSymbolicLink(), `Source must be regular: ${name}`);
        assert.ok(expected.has(name), `Unexpected source file: ${name}`);
        found.add(name);
      }
    }
  }
  await visit(root);
  assert.deepEqual([...found].sort(), [...expected].sort(), "Source inventory mismatch");
  assert.equal(await sourceDigest(root, metadata.files), identity.sourceInputSha256, "Source content hash mismatch");
  assert.equal(sha256(await readFile(path.join(root, "package-lock.json"))), identity.packageLockSha256, "Source lockfile mismatch");
  return identity;
}
