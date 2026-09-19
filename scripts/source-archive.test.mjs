import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256, sourceDigest } from "./release-integrity.mjs";
import { sourceArchiveMetadata, validateSourceArchive } from "./source-archive.mjs";

const root = await mkdtemp(path.join(tmpdir(), "stream-reviver-source-policy-"));
try {
  const entries = ["README.md", "LICENSE", "package.json", "package-lock.json", "src/main.ts"].map(path => ({ path, mode: "100644" }));
  await mkdir(path.join(root, "src"));
  for (const entry of entries) await writeFile(path.join(root, entry.path), `${entry.path}\n`);
  const identity = {
    schemaVersion: 2, channel: "stable", version: "3.1.5", commit: "a".repeat(40), tree: "b".repeat(40),
    sourceDateEpoch: 1_700_000_000, generatedAt: "2023-11-14T22:13:20.000Z",
    repository: { clean: true }, toolchain: {},
    sourceInputSha256: await sourceDigest(root, entries),
    packageLockSha256: sha256(await readFile(path.join(root, "package-lock.json")))
  };
  const metadata = sourceArchiveMetadata(identity, entries);
  assert.deepEqual(await validateSourceArchive(root, metadata, "3.1.5"), identity);
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", "generated.txt"), "dependency output");
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "generated.txt"), "build output");
  await validateSourceArchive(root, metadata, "3.1.5");
  await assert.rejects(validateSourceArchive(root, metadata, "3.1.6"), /version mismatch/);
  await assert.rejects(validateSourceArchive(root, { ...metadata, schemaVersion: 2 }, "3.1.5"), /Unsupported/);
  await assert.rejects(validateSourceArchive(root, { ...metadata, identity: { ...identity, channel: "development" } }, "3.1.5"));
  await assert.rejects(validateSourceArchive(root, { ...metadata, files: [...entries, { path: "../outside", mode: "100644" }] }, "3.1.5"));
  await assert.rejects(validateSourceArchive(root, { ...metadata, files: [...entries, entries[0]] }, "3.1.5"), /duplicate/);
  await writeFile(path.join(root, "src", "extra.ts"), "unexpected input");
  await assert.rejects(validateSourceArchive(root, metadata, "3.1.5"), /Unexpected source/);
  await rm(path.join(root, "src", "extra.ts"));
  await writeFile(path.join(root, "src", "main.ts"), "tampered input");
  await assert.rejects(validateSourceArchive(root, metadata, "3.1.5"), /content hash mismatch/);
  await rm(path.join(root, "src", "main.ts"));
  await symlink(path.join(root, "README.md"), path.join(root, "src", "main.ts"));
  await assert.rejects(validateSourceArchive(root, metadata, "3.1.5"), /non-symlink/);
  console.log("Source-archive policy passed: no-Git identity, inventory, content, version, channel, path and symlink checks.");
} finally { await rm(root, { recursive: true, force: true }); }
