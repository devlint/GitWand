/**
 * Parity on FAILURE for the commands that mutate the working tree or HEAD.
 *
 * The happy paths are covered elsewhere. What hides best, and what this suite
 * exists for, is a pair of backends that agree while succeeding and disagree
 * while failing: `read_file` rejected non-UTF-8 in Rust and substituted
 * U+FFFD in Node, and nothing noticed until a parity test asked.
 *
 * Both sides must refuse, **and leave the same state behind**. Agreeing on
 * "no" while leaving different working trees is not parity: the state is what
 * the user acts on next.
 *
 * Route names come from `src/utils/commandRegistry.ts`, which is the authority
 * on which dev-server route stands in for which command.
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
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: ENV,
  }).trim();

/** git, returning "" instead of throwing — for a repo with no commits yet. */
function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

const dirs = [];

/** A repo with one commit on `main`. */
function baseRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gw-parity-writefail-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/** An initialised repo with no commit yet: HEAD is unborn. */
function unbornRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gw-parity-writefail-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "uncommitted\n");
  git(dir, ["add", "."]);
  return dir;
}

/** `baseRepo` plus an uncommitted edit, so an operation needing a clean tree refuses. */
function dirtyRepo() {
  const dir = baseRepo();
  writeFileSync(join(dir, "file.txt"), "uncommitted\n");
  return dir;
}

/**
 * The state a caller acts on next. Subjects rather than `--oneline`: the two
 * repositories are built independently, so their SHAs differ by construction
 * and comparing them would fail for a reason that has nothing to do with parity.
 */
function repoShape(cwd) {
  return {
    status: git(cwd, ["status", "--porcelain"]),
    // These three fail on an unborn HEAD, which is a legitimate fixture below.
    subjects: tryGit(cwd, ["log", "--format=%s"]),
    branch: tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    merging: existsSync(join(cwd, ".git", "MERGE_HEAD")),
    staged: tryGit(cwd, ["show", ":file.txt"]).slice(0, 40),
  };
}

/**
 * Run a command through the probe and report whether it refused.
 *
 * `runProbe`'s `ok` reflects the probe's exit code, which is not the same
 * question: several of these commands return `Ok(GitPushPullResult)` with
 * `success: false` when git refuses — the exact shape that produced #197.
 * Reading only the exit code here would have called a refusal a success.
 */
function rustRun(cwd, command, args) {
  const r = runProbe("command-parity", { command, args: { cwd, ...args } });
  const refused = !r.ok || r.value?.success === false;
  return { ok: !refused, error: r.error ?? r.value?.message, value: r.value };
}

async function nodeRun(dev, route, body) {
  const res = await dev.fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Several routes answer HTTP 200 with { success: false }; both shapes are a
  // refusal, and the caller cares about the refusal, not about the transport.
  const refused = !res.ok || data.success === false;
  return { ok: !refused, error: data.error ?? data.message };
}

/**
 * Both sides refuse, and the two repositories end up identical.
 *
 * The messages travel into the assertion text deliberately: when this kind of
 * test last failed in this repo, a bare boolean said nothing about what either
 * side printed and recovering it cost a local reproduction.
 */
function expectSameRefusal(rust, node, rustDir, nodeDir) {
  expect(
    rust.ok,
    `rust unexpectedly succeeded: ${JSON.stringify(rust.value)}`,
  ).toBe(false);
  expect(node.ok, `node unexpectedly succeeded`).toBe(false);
  expect(
    repoShape(rustDir),
    `both refused, but left different repositories.\n  rust: ${rust.error}\n  node: ${node.error}`,
  ).toEqual(repoShape(nodeDir));
}

let dev;
beforeAll(async () => {
  dev = await startDevServer();
}, 15_000);
afterAll(async () => {
  await dev?.stop();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("parity on failure: working-tree commands", () => {
  it("git_merge refuses an unknown branch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_merge", { branch: "no-such-branch" });
    const node = await nodeRun(dev, "/api/git-merge", {
      cwd: nodeDir,
      branch: "no-such-branch",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_cherry_pick refuses an unknown commit identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    const ghost = "0000000000000000000000000000000000000000";

    const rust = rustRun(rustDir, "git_cherry_pick", { hash: ghost });
    const node = await nodeRun(dev, "/api/git-cherry-pick", {
      cwd: nodeDir,
      hashes: [ghost],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_checkout_commit refuses an unknown ref identically", async () => {
    const rustDir = dirtyRepo();
    const nodeDir = dirtyRepo();

    const rust = rustRun(rustDir, "git_checkout_commit", { hash: "deadbeef" });
    const node = await nodeRun(dev, "/api/git-checkout-commit", {
      cwd: nodeDir,
      hash: "deadbeef",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });
});

describe("parity on failure: stash and history commands", () => {
  it("git_stash refuses a repo with no initial commit identically", async () => {
    // A clean tree is NOT a refusal: `git stash` exits 0 with "No local
    // changes to save". Before the first commit it genuinely fails.
    const rustDir = unbornRepo();
    const nodeDir = unbornRepo();

    const rust = rustRun(rustDir, "git_stash", {});
    const node = await nodeRun(dev, "/api/git-stash", { cwd: nodeDir });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stash_pop refuses an empty stash identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_stash_pop", {});
    const node = await nodeRun(dev, "/api/git-stash-pop", { cwd: nodeDir });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stash_apply refuses an empty stash identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_stash_apply", { index: 0 });
    const node = await nodeRun(dev, "/api/git-stash-apply", {
      cwd: nodeDir,
      index: 0,
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_revert_commit refuses an unknown commit identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_revert_commit", { hash: "deadbeef" });
    const node = await nodeRun(dev, "/api/git-revert-commit", {
      cwd: nodeDir,
      hash: "deadbeef",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_reset_to_commit refuses an unknown commit identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_reset_to_commit", {
      hash: "deadbeef",
      mode: "hard",
    });
    const node = await nodeRun(dev, "/api/git-reset-to-commit", {
      cwd: nodeDir,
      hash: "deadbeef",
      mode: "hard",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_discard refuses a path outside the repository identically", async () => {
    // This one is about a guard, not about git: safe_repo_path() is supposed to
    // refuse it (AGENTS.md § Security). A disagreement here is security-relevant.
    const rustDir = dirtyRepo();
    const nodeDir = dirtyRepo();

    const rust = rustRun(rustDir, "git_discard", { path: "../escape.txt" });
    const node = await nodeRun(dev, "/api/git-discard", {
      cwd: nodeDir,
      paths: ["../escape.txt"],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_switch_branch refuses an unknown branch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_switch_branch", {
      branch: "no-such-branch",
    });
    const node = await nodeRun(dev, "/api/git-switch-branch", {
      cwd: nodeDir,
      branch: "no-such-branch",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });
});
