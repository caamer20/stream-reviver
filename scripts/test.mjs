import { build } from "esbuild";
import { mkdir, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const outdir = ".test-dist";
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const sourceTests = (await readdir("tests")).filter((file) => file.endsWith(".test.ts")).map((file) => `tests/${file}`);
await build({
  entryPoints: sourceTests,
  outdir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20"
});

const testFiles = (await readdir(outdir))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => `${outdir}/${file}`);
const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit"
});
process.exitCode = result.status ?? 1;
