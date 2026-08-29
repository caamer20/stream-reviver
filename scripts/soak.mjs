import { spawnSync } from "node:child_process";

const hours = numericArgument("--hours");
const iterations = Math.max(1, Math.floor(numericArgument("--iterations") ?? 1));
const deadline = hours ? Date.now() + hours * 60 * 60_000 : null;
let completed = 0;
const startedAt = Date.now();
do {
  const result = spawnSync(process.execPath, ["scripts/e2e.mjs"], {
    stdio: "inherit",
    env: { ...process.env, E2E_SCENARIOS: "healthy,churn,replace,protocol-spoof" }
  });
  if (result.status !== 0) throw new Error(`Soak cycle ${completed + 1} failed with exit ${String(result.status)}`);
  completed += 1;
} while (deadline ? Date.now() < deadline : completed < iterations);
console.log(`Soak gate passed ${completed} cycle(s) over ${((Date.now() - startedAt) / 60_000).toFixed(1)} minutes.`);

function numericArgument(name) {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const value = direct ? direct.slice(name.length + 1) : process.argv[process.argv.indexOf(name) + 1];
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
