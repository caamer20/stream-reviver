import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertPinnedToolchain, inspectToolchain } from "./release-integrity.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const toolchain = await inspectToolchain(root, packageJson);
assertPinnedToolchain(packageJson, toolchain);
console.log(`Pinned release toolchain verified: Node ${toolchain.node}, npm ${toolchain.npm}.`);
