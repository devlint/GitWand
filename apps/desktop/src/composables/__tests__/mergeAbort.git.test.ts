/**
 * Real-git contract tests for `git merge --abort` and `git cherry-pick --abort`
 * — the drift lock for the design in
 * docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md (§3.1, §3.3,
 * §3.6). Every assertion documents a git behaviour the implementation
 * (`abortMerge` / `cherryPickAbort` in useGitRepo.ts) depends on: chiefly that a
 * refused abort is distinguishable from a successful one by exit code, which is
 * what the frontend reads through `GitPushPullResult.success`.
 *
 * Uses real temporary git repos per AGENTS.md — never a mocked git layer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTHOR_NAME = "GitWand Test";
const AUTHOR_EMAIL = "test@gitwand.test";
// Real git subprocesses. 60s matches the other git-backed suites: a timeout
// here exists to catch a hang, not to enforce a performance budget.
const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    // Same hygiene as tests/parity/fixtures.mjs — no ambient user config.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EDITOR: "true",
    EDITOR: "true",
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs git and never throws — callers assert on the exit code themselves. */
function tryGit(cwd: string, args: string[]): GitResult {
  const res = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-abort-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/**
 * Leaves `dir` in a conflicted merge of `feature` into `main`, both branches
 * having changed the same line of file.txt.
 */
function makeConflictedMerge(dir: string): void {
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature\n");
  git(dir, ["commit", "-am", "feature change"]);
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["commit", "-am", "main change"]);
  const merge = tryGit(dir, ["merge", "feature"]);
  // Sanity: the fixture must actually produce a conflict.
  expect(merge.status).not.toBe(0);
  expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("git merge --abort", () => {
  it(
    "exits 0 and clears MERGE_HEAD during a conflicted merge",
    () => {
      const dir = makeRepo();
      makeConflictedMerge(dir);

      const res = tryGit(dir, ["merge", "--abort"]);

      expect(res.status).toBe(0);
      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exits non-zero and writes to stderr when no merge is in progress",
    () => {
      const dir = makeRepo();

      const res = tryGit(dir, ["merge", "--abort"]);

      expect(res.status).not.toBe(0);
      expect(res.stderr.trim()).not.toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exits non-zero when a file the merge staged has been edited since",
    () => {
      // §3.3: git refuses an abort it cannot perform without destroying work,
      // and says so on stderr — here "error: Entry 'extra.txt' not uptodate.
      // Cannot merge.", which is the very refusal the design quotes. The
      // assertions stay on the exit code and a non-empty stderr, never on
      // git's exact wording, which varies by version.
      //
      // (The plan originally reached this state by un-staging extra.txt with
      // `git rm --cached`; that abort succeeds — an untracked file is no
      // obstacle. What git refuses to discard is a *staged* merge result the
      // working tree has since moved away from.)
      const dir = makeRepo();
      git(dir, ["checkout", "-b", "feature"]);
      writeFileSync(join(dir, "file.txt"), "feature\n");
      writeFileSync(join(dir, "extra.txt"), "from feature\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "feature adds extra.txt"]);
      git(dir, ["checkout", "main"]);
      writeFileSync(join(dir, "file.txt"), "main\n");
      git(dir, ["commit", "-am", "main change"]);
      const merge = tryGit(dir, ["merge", "feature"]);
      expect(merge.status).not.toBe(0);
      // extra.txt merged cleanly and sits staged in the index; editing it now
      // leaves the abort no way back to HEAD without destroying that edit.
      writeFileSync(join(dir, "extra.txt"), "edited by hand\n");

      const res = tryGit(dir, ["merge", "--abort"]);

      expect(res.status).not.toBe(0);
      expect(res.stderr.trim()).not.toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("git cherry-pick --abort", () => {
  it(
    "exits non-zero when no sequencer is in progress",
    () => {
      // §3.6: this case is why the web path of gitCherryPickAbort must fail
      // the way the Tauri path does — it is reachable from the UI whenever
      // isCherryPicking has drifted from the repo.
      const dir = makeRepo();

      const res = tryGit(dir, ["cherry-pick", "--abort"]);

      expect(res.status).not.toBe(0);
      expect(res.stderr.trim()).not.toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exits 0 and clears the sequencer during a conflicted cherry-pick",
    () => {
      const dir = makeRepo();
      git(dir, ["checkout", "-b", "feature"]);
      writeFileSync(join(dir, "file.txt"), "feature\n");
      git(dir, ["commit", "-am", "feature change"]);
      const featureSha = git(dir, ["rev-parse", "HEAD"]).trim();
      git(dir, ["checkout", "main"]);
      writeFileSync(join(dir, "file.txt"), "main\n");
      git(dir, ["commit", "-am", "main change"]);
      const pick = tryGit(dir, ["cherry-pick", featureSha]);
      expect(pick.status).not.toBe(0);

      const res = tryGit(dir, ["cherry-pick", "--abort"]);

      expect(res.status).toBe(0);
      expect(existsSync(join(dir, ".git", "sequencer"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

/**
 * The marker files `git_repo_state` keys off to name the operation in progress
 * (dev-server.mjs /api/git-repo-state, and its Rust twin). The conflict banner
 * now believes that answer over its own `isCherryPicking` ref, so if git ever
 * stopped writing these, the banner would silently mislabel again.
 */
describe("the markers git_repo_state reads", () => {
  it(
    "writes CHERRY_PICK_HEAD and no MERGE_HEAD during a conflicted cherry-pick",
    () => {
      const dir = makeRepo();
      git(dir, ["checkout", "-b", "feature"]);
      writeFileSync(join(dir, "file.txt"), "feature\n");
      git(dir, ["commit", "-am", "feature change"]);
      const featureSha = git(dir, ["rev-parse", "HEAD"]).trim();
      git(dir, ["checkout", "main"]);
      writeFileSync(join(dir, "file.txt"), "main\n");
      git(dir, ["commit", "-am", "main change"]);
      const pick = tryGit(dir, ["cherry-pick", featureSha]);
      expect(pick.status).not.toBe(0);

      expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "writes MERGE_HEAD and no CHERRY_PICK_HEAD during a conflicted merge",
    () => {
      const dir = makeRepo();
      makeConflictedMerge(dir);

      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
      expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
