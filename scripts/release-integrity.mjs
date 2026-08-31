import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/;
const SAFE_GIT_MODES = new Set(["100644", "100755"]);
const SOURCE_ROOT_FILES = new Set([
  ".gitignore",
  ".node-version",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "ROADMAP.md",
  "SECURITY.md",
  "SUPPORT.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json"
]);
const SOURCE_PREFIXES = [".github/", "config/", "docs/", "scripts/", "src/", "store/", "test/", "tests/"];
const SENSITIVE_BASENAME_PATTERN = /^(?:\.env(?:\..*)?|.*\.(?:key|pem|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519))$/i;

export async function inspectRepository(root = process.cwd()) {
  const commit = git(root, ["rev-parse", "--verify", "HEAD"]);
  assert.match(commit, /^[0-9a-f]{40,64}$/, "Git HEAD must resolve to a commit object");
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  assert.match(tree, /^[0-9a-f]{40,64}$/, "Git HEAD must resolve to a tree object");
  const commitEpoch = Number(git(root, ["show", "-s", "--format=%ct", "HEAD"]));
  assert.ok(Number.isSafeInteger(commitEpoch) && commitEpoch > 0, "Git commit timestamp is invalid");
  const rawStatus = gitBuffer(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const statusRecords = parseStatus(rawStatus);
  const entries = parseTrackedEntries(gitBuffer(root, ["ls-files", "--stage", "-z"]));
  const tags = git(root, ["tag", "--points-at", "HEAD"], { allowEmpty: true }).split("\n").filter(Boolean).sort();
  return {
    commit,
    tree,
    commitEpoch,
    commitTimestamp: new Date(commitEpoch * 1000).toISOString(),
    clean: rawStatus.length === 0,
    changedFileCount: statusRecords.length,
    statusSha256: sha256(rawStatus),
    tags,
    entries
  };
}

export async function assertReleaseRepository({
  root = process.cwd(),
  version,
  requireTag = false,
  expectedTag = expectedReleaseTag()
} = {}) {
  validateExtensionVersion(version);
  const repository = await inspectRepository(root);
  assert.ok(
    repository.clean,
    `Stable release operations require a clean Git worktree; found ${repository.changedFileCount} tracked or untracked change(s)`
  );
  await validateTrackedSource(root, repository.entries);
  validateReleaseTags({ repository, version, requireTag, expectedTag });
  return repository;
}

export async function validateTrackedSource(root, entries) {
  assert.ok(entries.length > 0, "The source archive cannot be created from an empty Git index");
  const seen = new Set();
  for (const entry of entries) {
    assert.ok(!seen.has(entry.path), `Git index contains duplicate/conflicted entry: ${entry.path}`);
    seen.add(entry.path);
    validateArchivePath(entry.path);
    assert.ok(isAllowedSourcePath(entry.path), `Tracked file is outside the release source allowlist: ${entry.path}`);
    assert.ok(SAFE_GIT_MODES.has(entry.mode), `${entry.path} has unsafe Git mode ${entry.mode}; symlinks and submodules are forbidden`);
    assert.ok(!SENSITIVE_BASENAME_PATTERN.test(path.posix.basename(entry.path)), `Potential secret/private-key file cannot be packaged: ${entry.path}`);
    const info = await lstat(path.join(root, ...entry.path.split("/")));
    assert.ok(info.isFile() && !info.isSymbolicLink(), `Release source must be a regular, non-symlink file: ${entry.path}`);
  }
  for (const required of ["LICENSE", "README.md", "package.json", "package-lock.json"]) {
    assert.ok(seen.has(required), `Required source archive file is missing from Git: ${required}`);
  }
}

export async function collectTrackedSource(root, entries) {
  await validateTrackedSource(root, entries);
  const files = [];
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    files.push({ name: entry.path, mode: entry.mode, data: await readFile(path.join(root, ...entry.path.split("/"))) });
  }
  return files;
}

export async function sourceDigest(root, entries) {
  const files = await collectTrackedSource(root, entries);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.mode, "utf8");
    hash.update("\0");
    hash.update(file.name, "utf8");
    hash.update("\0");
    hash.update(file.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function createBuildIdentity({ root = process.cwd(), packageJson, channel, enforceRelease = channel === "stable" }) {
  validateExtensionVersion(packageJson.version);
  const repository = enforceRelease
    ? await assertReleaseRepository({ root, version: packageJson.version })
    : await inspectRepository(root);
  const sourceInputSha256 = await sourceDigest(root, repository.entries);
  const packageLockSha256 = sha256(await readFile(path.join(root, "package-lock.json")));
  const toolchain = await inspectToolchain(root, packageJson);
  if (enforceRelease) assertPinnedToolchain(packageJson, toolchain);
  const sourceDateEpoch = resolveSourceDateEpoch(repository.commitEpoch);
  return {
    schemaVersion: 2,
    channel,
    version: packageJson.version,
    commit: repository.commit,
    tree: repository.tree,
    sourceDateEpoch,
    generatedAt: new Date(sourceDateEpoch * 1000).toISOString(),
    sourceInputSha256,
    packageLockSha256,
    repository: {
      clean: repository.clean,
      changedFileCount: repository.changedFileCount,
      statusSha256: repository.statusSha256
    },
    toolchain
  };
}

export async function inspectToolchain(root, packageJson = null) {
  packageJson ??= JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const dependencyVersion = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? "missing";
  return {
    node: process.version.replace(/^v/, ""),
    npm: commandVersion("npm", ["--version"], root),
    esbuild: dependencyVersion("esbuild"),
    typescript: dependencyVersion("typescript"),
    webExt: dependencyVersion("web-ext"),
    packageManager: packageJson.packageManager ?? "unpinned"
  };
}

export function assertPinnedToolchain(packageJson, toolchain) {
  const expectedNode = packageJson.engines?.node;
  const expectedNpm = packageJson.engines?.npm;
  assert.ok(expectedNode, "package.json must pin engines.node to an exact version");
  assert.ok(expectedNpm, "package.json must pin engines.npm to an exact version");
  assert.match(expectedNode, /^\d+\.\d+\.\d+$/, "engines.node must be an exact semantic version");
  assert.match(expectedNpm, /^\d+\.\d+\.\d+$/, "engines.npm must be an exact semantic version");
  assert.equal(toolchain.node, expectedNode, `Release requires Node ${expectedNode}; found ${toolchain.node}`);
  assert.equal(toolchain.npm, expectedNpm, `Release requires npm ${expectedNpm}; found ${toolchain.npm}`);
  assert.equal(packageJson.packageManager, `npm@${expectedNpm}`, "packageManager must exactly match engines.npm");
}

export function validateReleaseTags({ repository, version, requireTag = false, expectedTag = null }) {
  const versionTag = `v${version}`;
  if (expectedTag) {
    assert.match(expectedTag, RELEASE_TAG_PATTERN, `Expected release tag is invalid: ${expectedTag}`);
    assert.equal(expectedTag, versionTag, `Release tag ${expectedTag} does not match package version ${version}`);
    assert.ok(repository.tags.includes(expectedTag), `Expected release tag ${expectedTag} does not point at HEAD ${repository.commit}`);
  }
  const releaseTags = repository.tags.filter((tag) => RELEASE_TAG_PATTERN.test(tag));
  assert.ok(releaseTags.every((tag) => tag === versionTag), `HEAD has release tag(s) that do not match package version ${version}: ${releaseTags.join(", ")}`);
  if (requireTag) assert.ok(repository.tags.includes(versionTag), `Tagged release requires ${versionTag} to point at HEAD ${repository.commit}`);
}

export function validateExtensionVersion(version) {
  assert.equal(typeof version, "string", "package version must be a string");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
  assert.ok(match, `Extension version must contain three or four integers: ${version}`);
  for (const component of match.slice(1).filter((value) => value !== undefined)) {
    assert.ok(Number(component) <= 65_535, `Extension version component exceeds 65535: ${version}`);
  }
}

export function expectedReleaseTag(argv = process.argv.slice(2), environment = process.env) {
  const argument = readArgument("--expected-tag", argv);
  if (argument) return argument;
  if (environment.STREAM_REVIVER_EXPECTED_TAG) return environment.STREAM_REVIVER_EXPECTED_TAG;
  if (environment.GITHUB_REF_TYPE === "tag" && environment.GITHUB_REF_NAME) return environment.GITHUB_REF_NAME;
  if (environment.GITHUB_REF?.startsWith("refs/tags/")) return environment.GITHUB_REF.slice("refs/tags/".length);
  return null;
}

export function hasArgument(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

export function readArgument(name, argv = process.argv.slice(2)) {
  const direct = argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

export function validateArchivePath(relative) {
  assert.ok(relative.length > 0, "Archive paths cannot be empty");
  assert.ok(!relative.startsWith("/"), `Archive path cannot be absolute: ${relative}`);
  assert.ok(!relative.includes("\\"), `Archive path cannot contain backslashes: ${relative}`);
  assert.ok(!/[\0-\x1f\x7f]/.test(relative), `Archive path contains control characters: ${JSON.stringify(relative)}`);
  assert.equal(path.posix.normalize(relative), relative, `Archive path is not normalized: ${relative}`);
  assert.ok(!relative.split("/").includes(".."), `Archive path escapes its root: ${relative}`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(entries) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    validateArchivePath(entry.name);
    hash.update(entry.name, "utf8");
    hash.update("\0");
    hash.update(entry.data);
    hash.update("\0");
    bytes += entry.data.length;
  }
  return { sha256: hash.digest("hex"), bytes, fileCount: entries.length };
}

function isAllowedSourcePath(relative) {
  return SOURCE_ROOT_FILES.has(relative) || SOURCE_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function parseTrackedEntries(raw) {
  return raw.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\t");
    assert.ok(separator > 0, `Cannot parse Git index record: ${record}`);
    const metadata = record.slice(0, separator).split(" ");
    assert.equal(metadata.length, 3, `Cannot parse Git index metadata: ${record}`);
    return { mode: metadata[0], object: metadata[1], stage: metadata[2], path: record.slice(separator + 1) };
  });
}

function parseStatus(raw) {
  const records = raw.toString("utf8").split("\0").filter(Boolean);
  const statuses = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    statuses.push(record);
    const status = record.slice(0, 2);
    if (/[RC]/.test(status)) index += 1;
  }
  return statuses;
}

function resolveSourceDateEpoch(commitEpoch) {
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === "") return commitEpoch;
  assert.match(raw, /^\d+$/, "SOURCE_DATE_EPOCH must contain only decimal seconds");
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value) && value > 0, "SOURCE_DATE_EPOCH is outside the supported range");
  return value;
}

function commandVersion(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`Unable to determine ${command} version: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function git(root, args, options = {}) {
  const value = gitBuffer(root, args).toString("utf8").trim();
  if (!options.allowEmpty) assert.ok(value, `git ${args.join(" ")} returned no data`);
  return value;
}

function gitBuffer(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`Git repository inspection failed (git ${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
