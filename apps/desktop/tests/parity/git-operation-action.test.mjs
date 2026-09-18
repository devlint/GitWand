/**
 * Parity tests: `git_operation_action` (Rust) vs `/api/git-operation-action`.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * Destructive, like git-rebase-onto.test.mjs: each side gets its own freshly
 * built repo rather than sharing a cwd, and parity is asserted on the result
 * *and* on the state the action left behind — two implementations can agree on
 * `{halted}` while leaving different working trees, and the state is what the
 * caller acts on next.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@gitwand.test",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@gitwand.test",
  GIT_EDITOR: "true",
};

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();

const dirs = [];

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-parity-op-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/** A repo halted mid-merge on a conflict in file.txt. */
function makeConflictedMergeRepo() {
  const dir = newRepo();
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature\n");
  git(dir, ["commit", "-am", "feature"]);
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["commit", "-am", "main"]);
  try {
    git(dir, ["merge", "feature"]);
  } catch {
    // expected: the merge conflicts
  }
  return dir;
}

/** A clean repo — nothing to abort. */
function makeCleanRepo() {
  return newRepo();
}

async function nodeAction(dev, cwd, operation, action) {
  const res = await dev.fetch("/api/git-operation-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, operation, action }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

function rustAction(cwd, operation, action) {
  // runProbe(command, args) sends `args` as JSON on stdin and returns
  // { ok, value, error } — see tests/parity/probe.mjs.
  return runProbe("git-operation-action", { cwd, operation, action });
}

/**
 * The state a caller acts on next. Commit *subjects*, not `--oneline`: the two
 * repos are built independently, so their SHAs differ by construction and
 * comparing them would fail for a reason that has nothing to do with parity.
 */
function repoShape(cwd) {
  return {
    merging: existsSync(join(cwd, ".git", "MERGE_HEAD")),
    status: git(cwd, ["status", "--porcelain"]),
    subjects: git(cwd, ["log", "--format=%s"]),
  };
}

let dev;
beforeAll(async () => {
  dev = await startDevServer();
});
afterAll(async () => {
  await dev?.stop();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("git_operation_action parity", () => {
  it("aborts a conflicted merge identically on both sides", async () => {
    const rustDir = makeConflictedMergeRepo();
    const nodeDir = makeConflictedMergeRepo();

    const rust = rustAction(rustDir, "merge", "abort");
    const node = await nodeAction(dev, nodeDir, "merge", "abort");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(rust.value.halted).toBe(false);
    expect(node.value.halted).toBe(rust.value.halted);
    expect(repoShape(rustDir)).toEqual(repoShape(nodeDir));
    expect(repoShape(rustDir).merging).toBe(false);
  });

  it("refuses identically when no operation is in progress", async () => {
    const rustDir = makeCleanRepo();
    const nodeDir = makeCleanRepo();

    const rust = rustAction(rustDir, "merge", "abort");
    const node = await nodeAction(dev, nodeDir, "merge", "abort");

    // Both must report failure; the wording is git's and is not asserted on.
    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    expect(repoShape(rustDir)).toEqual(repoShape(nodeDir));
  });

  it("refuses merge+skip on both sides without running git", async () => {
    const rustDir = makeConflictedMergeRepo();
    const nodeDir = makeConflictedMergeRepo();

    const rust = rustAction(rustDir, "merge", "skip");
    const node = await nodeAction(dev, nodeDir, "merge", "skip");

    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    // The repos are untouched: the whitelist refused before git ran.
    expect(repoShape(rustDir).merging).toBe(true);
    expect(repoShape(nodeDir).merging).toBe(true);
  });
});
