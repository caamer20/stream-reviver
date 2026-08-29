import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const temporary = await mkdtemp(path.join(tmpdir(), "stream-reviver-performance-"));
const bundle = path.join(temporary, "benchmark.mjs");
try {
  await build({ entryPoints: ["scripts/performance-benchmark.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20" });
  const result = spawnSync(process.execPath, [bundle], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || "Performance benchmark failed");
  const report = JSON.parse(result.stdout.trim());
  const minimums = { diagnosis: 25_000, observations: 10_000, settings: 2_000 };
  for (const [name, minimum] of Object.entries(minimums)) {
    const actual = report.results[name].operationsPerSecond;
    if (actual < minimum) throw new Error(`${name} throughput ${Math.round(actual)} ops/s is below the ${minimum} ops/s budget`);
  }
  console.log("Performance budgets passed:");
  for (const [name, value] of Object.entries(report.results)) console.log(`  ${name}: ${Math.round(value.operationsPerSecond).toLocaleString()} ops/s (${value.durationMs.toFixed(1)} ms)`);
} finally { await rm(temporary, { recursive: true, force: true }); }
