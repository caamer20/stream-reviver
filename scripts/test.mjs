import { build } from "esbuild";
import { mkdir, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const outdir = ".test-dist";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const sourceTests = (await findTests("tests")).sort();
await build({
  entryPoints: sourceTests,
  outdir,
  bundle: true,
  format: "esm",
  splitting: true,
  platform: "node",
  target: "node20",
  // Coverage is measured against the executable bundles. Enabling source-map
  // remapping causes Node to count TypeScript-only declarations as uncovered.
  sourcemap: false
});

const testFiles = (await findTests(outdir, ".test.js")).sort();
const coverageArgs = process.argv.includes("--coverage") ? [
  "--experimental-test-coverage",
  "--test-coverage-lines=90", "--test-coverage-branches=85", "--test-coverage-functions=90"
] : [];
const result = spawnSync(process.execPath, [...coverageArgs, "--test", ...testFiles], {
  stdio: process.argv.includes("--coverage") ? "pipe" : "inherit",
  encoding: process.argv.includes("--coverage") ? "utf8" : undefined,
  maxBuffer: 20 * 1024 * 1024
});
if (process.argv.includes("--coverage")) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const lines = output.split("\n");
  const summaryAt = lines.findIndex((line) => /^ℹ tests /.test(line));
  console.log((summaryAt >= 0 ? lines.slice(summaryAt) : lines).join("\n").trim());
  const thresholdFailure = /coverage does not meet threshold/.test(output);
  process.exitCode = (result.status ?? 1) || (thresholdFailure ? 1 : 0);
} else process.exitCode = result.status ?? 1;

async function findTests(directory, suffix = ".test.ts") {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = `${directory}/${entry.name}`;
    if (entry.isDirectory()) results.push(...await findTests(item, suffix));
    else if (entry.name.endsWith(suffix)) results.push(item);
  }
  return results;
}
