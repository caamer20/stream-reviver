import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactInventory } from "./release-artifacts.mjs";
import { sha256 } from "./release-integrity.mjs";

const root = await mkdtemp(path.join(tmpdir(), "stream-reviver-artifact-test-"));
try {
  const bytes = Buffer.from("test release artifact");
  const metadata = { bytes: bytes.length, sha256: sha256(bytes) };
  const manifest = { schemaVersion: 2, version: "3.1.5", commit: "a".repeat(40), archives: {}, sbom: { name: "stream-reviver-3.1.5-sbom.cdx.json", ...metadata } };
  for (const kind of ["chrome", "firefox", "source"]) manifest.archives[`stream-reviver-3.1.5-${kind}.zip`] = { ...metadata };
  for (const name of [...Object.keys(manifest.archives), manifest.sbom.name]) await writeFile(path.join(root, name), bytes);
  const save = (value) => writeFile(path.join(root, "release-manifest.json"), JSON.stringify(value));
  await save(manifest);
  const baseline = await artifactInventory(root, { version: "3.1.5", commit: manifest.commit });
  assert.equal(Object.keys(baseline).length, 5);
  await writeFile(path.join(root, "soak-report.json"), "retained evidence");
  await writeFile(path.join(root, "stream-reviver-3.1.4-firefox.zip"), "older release");
  await mkdir(path.join(root, "signed"));
  assert.deepEqual(await artifactInventory(root), baseline, "unrelated evidence and old packages must not affect reproducibility");
  assert.equal(await readFile(path.join(root, "soak-report.json"), "utf8"), "retained evidence");
  await assert.rejects(artifactInventory(root, { version: "3.1.6" }), /stale/);
  await assert.rejects(artifactInventory(root, { commit: "b".repeat(40) }), /stale/);
  await save({ ...manifest, archives: { ...manifest.archives, "../outside.zip": metadata } });
  await assert.rejects(artifactInventory(root), /exact versioned/);
  await save({ ...manifest, sbom: { ...manifest.sbom, name: "../outside.json" } });
  await assert.rejects(artifactInventory(root), /SBOM path/);
  await save(manifest);
  const chromePath = path.join(root, "stream-reviver-3.1.5-chrome.zip");
  await writeFile(chromePath, Buffer.alloc(bytes.length, 0));
  await assert.rejects(artifactInventory(root), /hash does not match/);
  await rm(chromePath);
  await symlink(path.join(root, "stream-reviver-3.1.5-firefox.zip"), chromePath);
  await assert.rejects(artifactInventory(root), /regular file/);
  console.log("Release artifact inventory tests passed: evidence retention, stale manifests, integrity, paths, and symlinks.");
} finally { await rm(root, { recursive: true, force: true }); }
