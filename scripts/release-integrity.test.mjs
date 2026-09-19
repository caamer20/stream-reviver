import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertPinnedToolchain,
  assertReleaseRepository,
  expectedReleaseTag,
  validateArchivePath,
  validateExtensionVersion
} from "./release-integrity.mjs";

// These tests create their own 1.2.3 repository. A CI tag for the real project
// must not become the expected tag of that independent fixture. This changes
// only this test process; production release commands keep their environment.
delete process.env.STREAM_REVIVER_EXPECTED_TAG;
delete process.env.GITHUB_REF;

const root = await mkdtemp(path.join(os.tmpdir(), "stream-reviver-release-policy-test-"));
try {
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Release Policy Test"]);
  git(["config", "user.email", "release-policy@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  await writeFile(path.join(root, "LICENSE"), "MIT\n");
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.2.3"}\n');
  await writeFile(path.join(root, "package-lock.json"), '{"name":"fixture","version":"1.2.3","lockfileVersion":3,"packages":{}}\n');
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await mkdirAndWrite("src/main.ts", "export {};\n");
  git(["add", "."]);
  commit("initial fixture");

  const clean = await assertReleaseRepository({ root, version: "1.2.3" });
  assert.equal(clean.clean, true);

  await writeFile(path.join(root, "README.md"), "# dirty fixture\n");
  await assert.rejects(() => assertReleaseRepository({ root, version: "1.2.3" }), /clean Git worktree/);
  git(["restore", "README.md"]);

  await mkdirAndWrite("src/untracked.ts", "export const untracked = true;\n");
  await assert.rejects(() => assertReleaseRepository({ root, version: "1.2.3" }), /clean Git worktree/);
  await rm(path.join(root, "src", "untracked.ts"));

  git(["tag", "v1.2.2"]);
  await assert.rejects(() => assertReleaseRepository({ root, version: "1.2.3" }), /do not match package version/);
  git(["tag", "--delete", "v1.2.2"]);
  git(["tag", "v1.2.3"]);
  await assertReleaseRepository({ root, version: "1.2.3", requireTag: true, expectedTag: "v1.2.3" });
  git(["tag", "--delete", "v1.2.3"]);
  await assert.rejects(() => assertReleaseRepository({ root, version: "1.2.3", requireTag: true }), /requires v1.2.3/);

  await symlink("main.ts", path.join(root, "src", "linked.ts"));
  git(["add", "src/linked.ts"]);
  commit("unsafe symlink fixture");
  await assert.rejects(() => assertReleaseRepository({ root, version: "1.2.3" }), /unsafe Git mode 120000/);
  git(["rm", "src/linked.ts"]);
  commit("remove unsafe symlink fixture");

  await writeFile(path.join(root, "private.txt"), "not allowlisted\n");
  git(["add", "private.txt"]);
  commit("unallowlisted fixture");
  await assert.rejects(() => assertReleaseRepository({ root, version: "1.2.3" }), /outside the release source allowlist/);

  assert.equal(expectedReleaseTag([], { STREAM_REVIVER_EXPECTED_TAG: "v1.2.3" }), "v1.2.3");
  assert.equal(expectedReleaseTag([], { GITHUB_REF: "refs/tags/v1.2.3" }), "v1.2.3");
  assert.throws(() => validateArchivePath("../escape"), /not normalized|escapes/);
  assert.throws(() => validateArchivePath("src\\escape"), /backslashes/);
  assert.throws(() => validateExtensionVersion("1.2.65536"), /exceeds 65535/);
  assert.doesNotThrow(() => assertPinnedToolchain(
    { engines: { node: "24.2.0", npm: "11.4.2" }, packageManager: "npm@11.4.2" },
    { node: "24.2.0", npm: "11.4.2" }
  ));
  assert.throws(() => assertPinnedToolchain(
    { engines: { node: "24.2.0", npm: "11.4.2" }, packageManager: "npm@11.4.2" },
    { node: "24.3.0", npm: "11.4.2" }
  ), /requires Node 24.2.0/);

  console.log("Release-integrity policy tests passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function mkdirAndWrite(relative, contents) {
  const { mkdir } = await import("node:fs/promises");
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function git(args) {
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

function commit(message) {
  execFileSync("git", ["commit", "--quiet", "-m", message], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}
