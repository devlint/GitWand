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
  // A dispatcher that does not know the command looks exactly like a refusal,
  // and a stale probe binary then turns every test in this file green for the
  // wrong reason. Fail loudly instead — this cost a full round of phantom
  // "divergences" once already.
  if (/command-parity does not know/.test(String(r.error))) {
    throw new Error(
      `the probe has no arm for '${command}'. If you just added one, rebuild ` +
        `it: cargo build --example parity-probe`,
    );
  }
  const refused = !r.ok || r.value?.success === false;
  return { ok: !refused, error: r.error ?? r.value?.message, value: r.value };
}

async function nodeRun(dev, route, body) {
  const res = await dev.fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // A route may answer a literal `null` body; `.catch` does not fire for that.
  const data = (await res.json().catch(() => null)) ?? {};
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

/**
 * The index, ref and submodule commands.
 *
 * Several of these cannot be made to fail by their own semantics — `git stash
 * clear` and `git submodule init` exit 0 on a repo that has nothing to clear or
 * initialise. For those, the failure under test is a `cwd` that is not a
 * repository at all, which is the case where `safe_repo_path()` on one side and
 * `resolve()` on the other have the most room to disagree.
 */
describe("parity on failure: index, ref and submodule commands", () => {
  /** A directory that exists but is not a git repository. */
  function notARepo() {
    const dir = mkdtempSync(join(tmpdir(), "gw-parity-notrepo-"));
    dirs.push(dir);
    writeFileSync(join(dir, "file.txt"), "not a repo\n");
    return dir;
  }

  /** Both sides refuse; neither repository exists to compare, so only the refusal is asserted. */
  function expectBothRefuse(rust, node) {
    expect(rust.ok, `rust unexpectedly succeeded: ${JSON.stringify(rust.value)}`).toBe(false);
    expect(node.ok, "node unexpectedly succeeded").toBe(false);
  }

  it("git_commit refuses an empty message identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    writeFileSync(join(rustDir, "file.txt"), "changed\n");
    writeFileSync(join(nodeDir, "file.txt"), "changed\n");
    git(rustDir, ["add", "."]);
    git(nodeDir, ["add", "."]);

    const rust = rustRun(rustDir, "git_commit", { message: "" });
    const node = await nodeRun(dev, "/api/git-commit", { cwd: nodeDir, message: "" });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_amend_commit refuses on a repo with no commit identically", async () => {
    const rustDir = unbornRepo();
    const nodeDir = unbornRepo();

    const rust = rustRun(rustDir, "git_amend_commit", { message: "amended" });
    const node = await nodeRun(dev, "/api/git-amend-commit", {
      cwd: nodeDir,
      message: "amended",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_create_branch refuses a name that already exists identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_create_branch", { name: "main" });
    const node = await nodeRun(dev, "/api/git-create-branch", { cwd: nodeDir, name: "main" });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_delete_branch refuses the checked-out branch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_delete_branch", { name: "main" });
    const node = await nodeRun(dev, "/api/git-delete-branch", { cwd: nodeDir, name: "main" });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_interactive_rebase refuses an unknown base identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_interactive_rebase", { base: "deadbeef" });
    const node = await nodeRun(dev, "/api/git-interactive-rebase", {
      cwd: nodeDir,
      base: "deadbeef",
      todoLines: [],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_pull refuses a repo with no remote identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_pull", { strategy: "merge" });
    const node = await nodeRun(dev, "/api/git-pull", { cwd: nodeDir, strategy: "merge" });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stage refuses a path outside the repository identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_stage", { path: "../escape.txt" });
    const node = await nodeRun(dev, "/api/git-stage", {
      cwd: nodeDir,
      paths: ["../escape.txt"],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_unstage refuses a path outside the repository identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_unstage", { path: "../escape.txt" });
    const node = await nodeRun(dev, "/api/git-unstage", {
      cwd: nodeDir,
      paths: ["../escape.txt"],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stage_patch refuses a malformed patch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    const garbage = "this is not a patch\n";

    const rust = rustRun(rustDir, "git_stage_patch", { patch: garbage });
    const node = await nodeRun(dev, "/api/git-stage-patch", { cwd: nodeDir, patch: garbage });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_unstage_patch refuses a malformed patch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    const garbage = "this is not a patch\n";

    const rust = rustRun(rustDir, "git_unstage_patch", { patch: garbage });
    const node = await nodeRun(dev, "/api/git-unstage-patch", { cwd: nodeDir, patch: garbage });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stash_drop refuses an empty stash identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_stash_drop", { index: 0 });
    const node = await nodeRun(dev, "/api/git-stash-drop", { cwd: nodeDir, index: 0 });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_add_to_gitignore refuses a multi-line entry identically", async () => {
    // Not a traversal: neither side validates the entry against the repo root,
    // because the entry is a gitignore *pattern* and the file it is written to
    // is always the repo's own .gitignore. What both sides do refuse is a
    // newline, which would silently add rules the user never asked for (#183).
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    const entry = "build\nsecrets.env";

    const rust = rustRun(rustDir, "git_add_to_gitignore", { path: entry });
    const node = await nodeRun(dev, "/api/git-gitignore", { cwd: nodeDir, path: entry });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_submodule_add refuses an unreachable url identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    const url = "/nonexistent/not-a-repo.git";

    const rust = rustRun(rustDir, "git_submodule_add", { url, path: "sub" });
    const node = await nodeRun(dev, "/api/git-submodule-add", {
      cwd: nodeDir,
      url,
      path: "sub",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_submodule_update_one refuses an unknown submodule identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_submodule_update_one", { path: "no-such-sub" });
    const node = await nodeRun(dev, "/api/git-submodule-update-one", {
      cwd: nodeDir,
      path: "no-such-sub",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  // The four below cannot be made to fail by their own semantics on a valid
  // repository, so the failure under test is a cwd that is not a repository.
  it("git_stash_clear refuses a cwd that is not a repository identically", async () => {
    const rust = rustRun(notARepo(), "git_stash_clear", {});
    const node = await nodeRun(dev, "/api/git-stash-clear", { cwd: notARepo() });
    expectBothRefuse(rust, node);
  });

  it("git_submodule_init refuses a cwd that is not a repository identically", async () => {
    const rust = rustRun(notARepo(), "git_submodule_init", {});
    const node = await nodeRun(dev, "/api/git-submodule-init", { cwd: notARepo() });
    expectBothRefuse(rust, node);
  });

  it("git_submodule_update refuses a cwd that is not a repository identically", async () => {
    const rust = rustRun(notARepo(), "git_submodule_update", {});
    const node = await nodeRun(dev, "/api/git-submodule-update", { cwd: notARepo() });
    expectBothRefuse(rust, node);
  });

  // `snapshot_create` has no failure case to compare: it is typed
  // `Result<Option<SnapshotMeta>, String>` and answers `Ok(None)` rather than
  // erroring — even on a directory that is not a repository. There is nothing
  // to assert parity on until it has a reachable refusal, and inventing one
  // would test the fixture rather than the command.
});

/**
 * The two routes the registry audit found missing: `backend.ts` fetched
 * `/api/git-commit-template-path` and `/api/git-config-identity`, and
 * `dev-server.mjs` declared neither, so both 404'd under `pnpm dev:web`.
 * Fixed here, and pinned at parity so the fix is the Rust behaviour rather
 * than an approximation of it.
 */
describe("parity: the two routes the audit found missing", () => {
  it("git_commit_template_path answers null identically when unset", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_commit_template_path", {});
    const node = await nodeRun(dev, "/api/git-commit-template-path", { cwd: nodeDir });

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(rust.value.path).toBeNull();
  });

  it("git_commit_template_path returns the same configured path on both sides", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    git(rustDir, ["config", "commit.template", ".gitmessage"]);
    git(nodeDir, ["config", "commit.template", ".gitmessage"]);

    const rust = rustRun(rustDir, "git_commit_template_path", {});
    const res = await dev.fetch("/api/git-commit-template-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: nodeDir }),
    });
    const nodeBody = await res.json();

    expect(rust.value.path).toBe(".gitmessage");
    expect(nodeBody.path).toBe(rust.value.path);
  });

  it("git_config_identity returns the same pair on both sides", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    for (const d of [rustDir, nodeDir]) {
      git(d, ["config", "user.name", "Parity Person"]);
      git(d, ["config", "user.email", "parity@gitwand.test"]);
    }

    const rust = rustRun(rustDir, "git_config_identity", {});
    const res = await dev.fetch("/api/git-config-identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: nodeDir }),
    });
    const nodeBody = await res.json();

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(rust.value).toEqual(["Parity Person", "parity@gitwand.test"]);
    expect(nodeBody).toEqual(rust.value);
  });

  it("git_config_identity refuses an empty identity identically", async () => {
    // The two backends are separate processes and inherit the developer's
    // global git config, so "unconfigured" cannot be arranged by withholding
    // one — an earlier version of this test read the machine's real name and
    // passed on one side only. Setting the local values to empty is what both
    // sides actually have to refuse.
    const rustDir = baseRepo();
    const nodeDir = baseRepo();
    for (const d of [rustDir, nodeDir]) {
      git(d, ["config", "user.name", ""]);
      git(d, ["config", "user.email", ""]);
    }

    const rust = rustRun(rustDir, "git_config_identity", {});
    const node = await nodeRun(dev, "/api/git-config-identity", { cwd: nodeDir });

    expect(rust.ok, "rust unexpectedly succeeded").toBe(false);
    expect(node.ok, "node unexpectedly succeeded").toBe(false);
  });
});
