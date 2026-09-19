import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactInventory } from "./release-artifacts.mjs";
import { canonicalDigest } from "./release-integrity.mjs";

const root = process.cwd();
const manifest = JSON.parse(await readFile("artifacts/release-manifest.json", "utf8"));
await artifactInventory(path.join(root, "artifacts"), { version: JSON.parse(await readFile("package.json", "utf8")).version });
const temporary = await mkdtemp(path.join(tmpdir(), "stream-reviver-source-rebuild-"));
try {
  const sourceName = `stream-reviver-${manifest.version}-source.zip`;
  // Only the local, manifest-verified archive produced by our deterministic
  // packager is extracted, never an arbitrary downloaded ZIP.
  run("unzip", ["-q", path.join(root, "artifacts", sourceName), "-d", temporary], root);
  const workspace = path.join(temporary, `stream-reviver-${manifest.version}`);
  run("npm", ["ci", "--no-audit", "--no-fund"], workspace);
  run("npm", ["run", "build:source"], workspace);
  const targets = {};
  for (const browser of ["chrome", "firefox"]) {
    targets[browser] = canonicalDigest(await collect(path.join(workspace, "dist", "source-archive", browser)));
    assert.deepEqual(targets[browser], manifest.archives[`stream-reviver-${manifest.version}-${browser}.zip`].content, `${browser} source rebuild differs from submitted package`);
  }
  await writeFile(path.join(root, "artifacts", "source-rebuild.json"), `${JSON.stringify({
    schemaVersion: 1, version: manifest.version, commit: manifest.commit, result: "identical",
    sourceSha256: manifest.archives[sourceName].sha256, gitMetadataRequired: false, targets
  }, null, 2)}\n`);
  console.log("Source-only rebuild verified: Chrome and Firefox match submitted files without Git metadata.");
} finally { await rm(temporary, { recursive: true, force: true }); }

function run(command, args, cwd) { execFileSync(command, args, { cwd, stdio: "inherit" }); }
async function collect(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...await collect(path.join(directory, entry.name), `${prefix}${entry.name}/`));
    else {
      assert.ok(entry.isFile() && !entry.isSymbolicLink());
      files.push({ name: `${prefix}${entry.name}`, mode: "100644", data: await readFile(path.join(directory, entry.name)) });
    }
  }
  return files;
}
