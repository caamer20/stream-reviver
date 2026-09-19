import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDeterministicZip } from "./deterministic-zip.mjs";
import { SOURCE_BUILD_METADATA, sourceArchiveMetadata } from "./source-archive.mjs";
import {
  assertReleaseRepository,
  canonicalDigest,
  collectTrackedSource,
  createBuildIdentity,
  expectedReleaseTag,
  hasArgument,
  sha256,
  validateArchivePath
} from "./release-integrity.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const repository = await assertReleaseRepository({
  root,
  version,
  requireTag: hasArgument("--require-tag"),
  expectedTag: expectedReleaseTag()
});
const expectedIdentity = await createBuildIdentity({ root, packageJson, channel: "stable", enforceRelease: true });
const stableRoot = path.join(root, "dist", "stable");
const buildProvenance = JSON.parse(await readFile(path.join(stableRoot, "provenance.json"), "utf8"));
assertBuildIdentity(buildProvenance, expectedIdentity, "stable build provenance");

const artifacts = path.join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const artifactDirectory = await lstat(artifacts);
assert.ok(artifactDirectory.isDirectory() && !artifactDirectory.isSymbolicLink(), "Artifact output must be a real directory");

const sourceFiles = await collectTrackedSource(root, repository.entries);
sourceFiles.push({ name: SOURCE_BUILD_METADATA, mode: "100644", data: Buffer.from(`${JSON.stringify(sourceArchiveMetadata(expectedIdentity, repository.entries), null, 2)}\n`) });
const archiveSpecs = [
  { name: `stream-reviver-${version}-chrome.zip`, entries: await collectOutput(path.join(stableRoot, "chrome")), prefix: "" },
  { name: `stream-reviver-${version}-firefox.zip`, entries: await collectOutput(path.join(stableRoot, "firefox")), prefix: "" },
  { name: `stream-reviver-${version}-source.zip`, entries: sourceFiles, prefix: `stream-reviver-${version}/` }
];
const releases = {};
for (const spec of archiveSpecs) {
  const entries = spec.entries.map((entry) => ({ ...entry, name: `${spec.prefix}${entry.name}` }));
  const bytes = createDeterministicZip(entries);
  await writeArtifact(spec.name, bytes);
  releases[spec.name] = { bytes: bytes.length, sha256: sha256(bytes), content: canonicalDigest(entries) };
}

const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const sbom = createSbom({ packageJson, lock, provenance: buildProvenance, releases });
const sbomName = `stream-reviver-${version}-sbom.cdx.json`;
const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
await writeArtifact(sbomName, sbomBytes);
const releaseTag = expectedReleaseTag() ?? (repository.tags.includes(`v${version}`) ? `v${version}` : null);
await writeArtifact("release-manifest.json", `${JSON.stringify({
  schemaVersion: 2,
  version,
  channel: "stable",
  commit: repository.commit,
  tree: repository.tree,
  sourceDateEpoch: buildProvenance.sourceDateEpoch,
  generatedAt: buildProvenance.generatedAt,
  sourceInputSha256: buildProvenance.sourceInputSha256,
  packageLockSha256: buildProvenance.packageLockSha256,
  toolchain: buildProvenance.toolchain,
  releaseTag,
  archives: releases,
  sbom: { name: sbomName, bytes: sbomBytes.length, sha256: sha256(sbomBytes) }
}, null, 2)}\n`);
console.log(`Created verified deterministic Chrome, Firefox, and tracked-source archives in ${path.relative(root, artifacts)}.`);

async function writeArtifact(name, bytes) {
  // Never follow an existing output symlink. Atomic replacement also prevents
  // an interrupted packaging run from leaving a partially written archive.
  const temporary = path.join(artifacts, `.package-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path.join(artifacts, name));
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

async function collectOutput(directory) {
  const base = path.resolve(directory);
  const files = [];
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name);
      const relative = path.relative(base, file).replaceAll(path.sep, "/");
      validateArchivePath(relative);
      const info = await lstat(file);
      if (info.isDirectory()) await visit(file);
      else {
        assert.ok(info.isFile() && !info.isSymbolicLink(), `Browser package contains a non-regular file: ${relative}`);
        files.push({ name: relative, mode: "100644", data: await readFile(file) });
      }
    }
  }
  await visit(base);
  assert.ok(files.length > 0, `Browser package directory is empty: ${directory}`);
  return files;
}

function assertBuildIdentity(actual, expected, label) {
  for (const key of [
    "schemaVersion", "channel", "version", "commit", "tree", "sourceDateEpoch", "generatedAt",
    "sourceInputSha256", "packageLockSha256"
  ]) assert.deepEqual(actual[key], expected[key], `${label} ${key} does not match the current clean source`);
  assert.deepEqual(actual.repository, expected.repository, `${label} repository state does not match the current clean source`);
  assert.deepEqual(actual.toolchain, expected.toolchain, `${label} toolchain does not match the pinned release toolchain`);
  assert.ok(actual.targets?.chrome?.sha256 && actual.targets?.firefox?.sha256, `${label} is missing deterministic target hashes`);
}

function createSbom({ packageJson, lock, provenance, releases }) {
  const componentMap = new Map();
  const dependencyNames = new Map();
  for (const [lockPath, value] of Object.entries(lock.packages ?? {})) {
    if (!lockPath.includes("node_modules/") || !value.version) continue;
    const name = packageNameFromLockPath(lockPath);
    const ref = npmPurl(name, value.version);
    if (!componentMap.has(ref)) {
      const component = {
        type: "library",
        "bom-ref": ref,
        name,
        version: value.version,
        scope: "excluded",
        purl: ref,
        properties: [{ name: "stream-reviver:dependency-scope", value: "development/build-only" }]
      };
      const hash = integrityHash(value.integrity);
      if (hash) component.hashes = [hash];
      if (value.license) component.licenses = [{ license: { id: value.license } }];
      componentMap.set(ref, component);
    }
    const refs = dependencyNames.get(name) ?? new Set();
    refs.add(ref);
    dependencyNames.set(name, refs);
  }
  const components = [...componentMap.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const dependencies = [{ ref: `pkg:npm/${packageJson.name}@${packageJson.version}`, dependsOn: [] }];
  for (const component of components) {
    const lockEntry = findLockEntry(lock, component.name, component.version);
    const dependsOn = [];
    for (const dependencyName of Object.keys(lockEntry?.dependencies ?? {}).sort()) {
      for (const ref of dependencyNames.get(dependencyName) ?? []) dependsOn.push(ref);
    }
    dependencies.push({ ref: component["bom-ref"], dependsOn: [...new Set(dependsOn)].sort() });
  }
  const sourceArchive = releases[`stream-reviver-${packageJson.version}-source.zip`];
  const serialSeed = sha256(Buffer.from(`${provenance.commit}\0${packageJson.version}\0${provenance.sourceInputSha256}`));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: deterministicUuidUrn(serialSeed),
    version: 1,
    metadata: {
      timestamp: provenance.generatedAt,
      tools: {
        components: [
          toolComponent("node", provenance.toolchain.node, "Node.js"),
          toolComponent("npm", provenance.toolchain.npm, "npm"),
          toolComponent("esbuild", provenance.toolchain.esbuild, "esbuild"),
          toolComponent("typescript", provenance.toolchain.typescript, "TypeScript")
        ]
      },
      component: {
        type: "application",
        "bom-ref": `pkg:npm/${packageJson.name}@${packageJson.version}`,
        name: packageJson.name,
        version: packageJson.version,
        purl: `pkg:npm/${packageJson.name}@${packageJson.version}`,
        hashes: [{ alg: "SHA-256", content: sourceArchive.sha256 }],
        licenses: [{ license: { id: packageJson.license ?? "MIT" } }],
        properties: [
          { name: "stream-reviver:git-commit", value: provenance.commit },
          { name: "stream-reviver:git-tree", value: provenance.tree },
          { name: "stream-reviver:source-input-sha256", value: provenance.sourceInputSha256 },
          { name: "stream-reviver:package-lock-sha256", value: provenance.packageLockSha256 }
        ]
      }
    },
    components,
    dependencies
  };
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length);
}

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function findLockEntry(lock, name, version) {
  return Object.entries(lock.packages ?? {}).find(([lockPath, value]) =>
    lockPath.includes("node_modules/") && packageNameFromLockPath(lockPath) === name && value.version === version
  )?.[1];
}

function integrityHash(integrity) {
  if (typeof integrity !== "string") return null;
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match) return null;
  return { alg: "SHA-512", content: Buffer.from(match[1], "base64").toString("hex") };
}

function toolComponent(name, version, displayName) {
  return { type: "application", name: displayName, version, "bom-ref": `tool:${name}@${version}` };
}

function deterministicUuidUrn(hex) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `urn:uuid:${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
