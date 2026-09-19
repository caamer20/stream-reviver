import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertReleaseRepository, createBuildIdentity, expectedReleaseTag, hasArgument } from "./release-integrity.mjs";
import { artifactInventory } from "./release-artifacts.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const requireTag = hasArgument("--require-tag");
const expectedTag = expectedReleaseTag();
const repository = await assertReleaseRepository({ root, version: packageJson.version, requireTag, expectedTag });
const identity = await createBuildIdentity({ root, packageJson, channel: "stable", enforceRelease: true });
const baseline = await artifactInventory(path.join(root, "artifacts"), { version: packageJson.version, commit: repository.commit });
assert.ok(baseline["release-manifest.json"], "Run the normal packaging command before the reproducibility check");

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "stream-reviver-reproducibility-"));
const runs = [];
try {
  for (let run = 1; run <= 2; run += 1) {
    const workspace = path.join(temporaryRoot, `run-${run}`);
    runCommand("git", ["clone", "--quiet", "--no-hardlinks", "--no-checkout", root, workspace], root);
    runCommand("git", ["checkout", "--quiet", "--detach", repository.commit], workspace);
    runCommand("npm", ["ci", "--no-audit", "--no-fund"], workspace);
    runCommand(process.execPath, ["scripts/build.mjs", "--channel", "stable"], workspace);
    runCommand(process.execPath, ["scripts/release-check.mjs", "--channel", "stable"], workspace);
    const packageArguments = ["scripts/package.mjs"];
    if (requireTag) packageArguments.push("--require-tag");
    if (expectedTag) packageArguments.push("--expected-tag", expectedTag);
    runCommand(process.execPath, packageArguments, workspace);
    runs.push(await artifactInventory(path.join(workspace, "artifacts")));
  }
  assert.deepEqual(runs[0], runs[1], "Independent clean builds produced different release artifact hashes");
  assert.deepEqual(baseline, runs[0], "Current release artifacts differ from independent clean builds");
  const report = {
    schemaVersion: 1,
    version: packageJson.version,
    commit: repository.commit,
    tree: repository.tree,
    generatedAt: identity.generatedAt,
    workspaces: 2,
    result: "identical",
    artifacts: runs[0]
  };
  await writeFile(path.join(root, "artifacts", "reproducibility.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Reproducibility verified: two independent clean workspaces match ${Object.keys(runs[0]).length} packaged artifacts.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function runCommand(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: String(identity.sourceDateEpoch),
      ...(expectedTag ? { STREAM_REVIVER_EXPECTED_TAG: expectedTag } : {})
    },
    stdio: "inherit"
  });
}
