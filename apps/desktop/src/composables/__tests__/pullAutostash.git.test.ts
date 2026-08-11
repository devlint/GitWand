/**
 * Real-git contract tests for `git pull --autostash` — the drift lock for
 * the findings table in docs/superpowers/specs/2026-08-11-issue-150-auto-stash-pull-plan.md
 * (§2). Every assertion here documents a git behavior the implementation
 * (`pull()` / `settleAutostash()` in useGitRepo.ts) depends on. If git ever
 * changes one of these, this suite fails loudly instead of the app silently
 * mis-detecting a conflict.
 *
 * Uses real temporary git repos (a bare "remote" + two clones) per AGENTS.md
 * — never a mocked git layer. Vitest runs test files under Node even with
 * the jsdom environment, so `node:child_process` / `node:fs` work fine here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTHOR_NAME = "GitWand Test";
const AUTHOR_EMAIL = "test@gitwand.test";
// Real git subprocesses (init/clone/push/pull) are slower than the 5s default
// under full-suite parallel load — give them real headroom instead of flaking.
const GIT_TEST_TIMEOUT_MS = 20_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    // Same hygiene as tests/parity/fixtures.mjs — no ambient user config leaking in.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // `rebase --continue` reuses the original commit message, but set a no-op
    // editor defensively so the suite never hangs waiting on one.
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

/**
 * Runs git and never throws — callers assert on the exit code themselves.
 * Uses `spawnSync` (not `execFileSync`) because `execFileSync` only returns
 * stdout on success and silently forwards stderr straight to the parent's
 * stderr instead of capturing it — `spawnSync` returns both streams
 * unconditionally, which the "Applied autostash." assertions below depend on.
 */
function gitTry(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function isGitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let createdDirs: string[] = [];

function mkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-autostash-"));
  createdDirs.push(dir);
  return dir;
}

function initRepo(dir: string) {
  git(dir, ["init", "--initial-branch=main", "--quiet"]);
  git(dir, ["config", "user.name", AUTHOR_NAME]);
  git(dir, ["config", "user.email", AUTHOR_EMAIL]);
}

function writeAndCommit(dir: string, file: string, content: string, message: string) {
  writeFileSync(join(dir, file), content, "utf-8");
  git(dir, ["add", "--", file]);
  git(dir, ["commit", "-m", message, "--quiet"]);
}

function cloneRepo(remoteDir: string): string {
  const dir = mkdir();
  git(dir, ["clone", "--quiet", remoteDir, "."]);
  git(dir, ["config", "user.name", AUTHOR_NAME]);
  git(dir, ["config", "user.email", AUTHOR_EMAIL]);
  return dir;
}

/**
 * Bare "remote" + clone `a` (the repo under test, always pulling) + clone
 * `b` (used to independently push commits that `a` then pulls). Both track
 * origin/main.
 */
function setupTriangle(): { remote: string; a: string; b: string } {
  const remote = mkdir();
  git(remote, ["init", "--bare", "--initial-branch=main", "--quiet"]);

  const a = mkdir();
  initRepo(a);
  writeAndCommit(a, "base.txt", "base\n", "initial commit");
  // Tracked from the start so tests can dirty it as a WIP edit — `--autostash`
  // only stashes tracked changes, never untracked files (finding G), so a
  // brand-new untracked file would silently skip the autostash mechanism.
  writeAndCommit(a, "wip.txt", "wip original\n", "add wip.txt");
  git(a, ["remote", "add", "origin", remote]);
  git(a, ["push", "-u", "origin", "main", "--quiet"]);

  const b = cloneRepo(remote);

  return { remote, a, b };
}

describe.skipIf(!isGitAvailable())(
  "pull --autostash git-facts contract (locks the #150 plan's §2 findings table)",
  () => {
    beforeEach(() => {
      createdDirs = [];
    });

    afterEach(() => {
      for (const dir of createdDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("A: clean pull is unchanged — fast-forwards, exit 0, empty stash, no MERGE_AUTOSTASH", () => {
      const { a, b } = setupTriangle();
      writeAndCommit(b, "new.txt", "new\n", "b: add new.txt");
      git(b, ["push", "--quiet"]);

      const res = gitTry(a, ["pull", "--no-rebase", "--autostash", "--quiet"]);

      expect(res.status).toBe(0);
      expect(existsSync(join(a, "new.txt"))).toBe(true);
      expect(git(a, ["stash", "list"]).trim()).toBe("");
      expect(existsSync(join(a, ".git", "MERGE_AUTOSTASH"))).toBe(false);
    }, GIT_TEST_TIMEOUT_MS);

    it("B: dirty non-overlapping pull auto-restores WIP — local edit + staged file survive, stash empty", () => {
      const { a, b } = setupTriangle();
      writeAndCommit(b, "remote.txt", "remote change\n", "b: add remote.txt");
      git(b, ["push", "--quiet"]);

      // Local dirty edit on a file the incoming commit never touches.
      writeFileSync(join(a, "base.txt"), "base\nlocal edit\n", "utf-8");
      // A staged new file — index state must be preserved across the autostash round-trip.
      writeFileSync(join(a, "staged.txt"), "staged content\n", "utf-8");
      git(a, ["add", "--", "staged.txt"]);

      const res = gitTry(a, ["pull", "--no-rebase", "--autostash", "--quiet"]);

      expect(res.status).toBe(0);
      expect(existsSync(join(a, "remote.txt"))).toBe(true);
      expect(readFileSync(join(a, "base.txt"), "utf-8")).toContain("local edit");
      const porcelain = git(a, ["status", "--porcelain"]);
      expect(porcelain).toContain("A  staged.txt");
      expect(git(a, ["stash", "list"]).trim()).toBe("");
    }, GIT_TEST_TIMEOUT_MS);

    it("C: autostash apply conflicts — exit code 0 (the surprising fact), UU file, no MERGE_HEAD, one real stash entry", () => {
      const { a, b } = setupTriangle();
      // b edits the same line of base.txt that a will dirty locally.
      writeFileSync(join(b, "base.txt"), "base\nremote change on this line\n", "utf-8");
      git(b, ["add", "--", "base.txt"]);
      git(b, ["commit", "-m", "b: edit base.txt", "--quiet"]);
      git(b, ["push", "--quiet"]);

      writeFileSync(join(a, "base.txt"), "base\nlocal change on this line\n", "utf-8");

      const res = gitTry(a, ["pull", "--no-rebase", "--autostash", "--quiet"]);

      // git pull exits 0 even though re-applying the parked WIP hit conflicts.
      expect(res.status).toBe(0);

      const porcelain = git(a, ["status", "--porcelain"]);
      expect(porcelain).toMatch(/^UU /m);
      expect(existsSync(join(a, ".git", "MERGE_HEAD"))).toBe(false);

      const stashList = git(a, ["stash", "list"]).trim().split("\n").filter(Boolean);
      expect(stashList).toHaveLength(1);
      expect(stashList[0]).toContain("autostash");

      // The locale-proof detection predicate settleAutostash() relies on:
      // a conflicted file present AND no merge/rebase operation in progress.
      const opInProgress =
        existsSync(join(a, ".git", "rebase-merge")) ||
        existsSync(join(a, ".git", "rebase-apply")) ||
        existsSync(join(a, ".git", "MERGE_HEAD"));
      expect(opInProgress).toBe(false);
    }, GIT_TEST_TIMEOUT_MS);

    it("D: rebase-mode — local commit conflicts, autostash parked in rebase-merge, WIP restored on continue", () => {
      const { a, b } = setupTriangle();
      writeFileSync(join(b, "base.txt"), "base\nremote change\n", "utf-8");
      git(b, ["add", "--", "base.txt"]);
      git(b, ["commit", "-m", "b: edit base.txt", "--quiet"]);
      git(b, ["push", "--quiet"]);

      // A local commit (not just a dirty file) that conflicts on rebase.
      writeFileSync(join(a, "base.txt"), "base\nlocal change\n", "utf-8");
      git(a, ["add", "--", "base.txt"]);
      git(a, ["commit", "-m", "a: edit base.txt", "--quiet"]);

      // Dirty WIP unrelated to the conflict — a modification to an already
      // tracked file (not a new untracked one — see setupTriangle's comment).
      // Must stay pristine until the rebase concludes; git parks it, GitWand
      // must never touch it.
      writeFileSync(join(a, "wip.txt"), "wip original\nwork in progress\n", "utf-8");

      const res = gitTry(a, ["pull", "--rebase", "--autostash", "--quiet"]);

      // The rebase itself conflicts — unrelated to the autostash-apply (C) signature.
      expect(res.status).not.toBe(0);
      expect(existsSync(join(a, ".git", "rebase-merge", "autostash"))).toBe(true);
      expect(readFileSync(join(a, "wip.txt"), "utf-8")).toBe("wip original\n");
      expect(git(a, ["status", "--porcelain"])).not.toContain("wip.txt");

      // Resolve and continue.
      writeFileSync(join(a, "base.txt"), "base\nresolved\n", "utf-8");
      git(a, ["add", "--", "base.txt"]);
      const continueRes = gitTry(a, ["rebase", "--continue"]);

      expect(continueRes.status).toBe(0);
      expect(continueRes.stdout + continueRes.stderr).toMatch(/Applied autostash/);
      expect(readFileSync(join(a, "wip.txt"), "utf-8")).toBe("wip original\nwork in progress\n");
      expect(git(a, ["status", "--porcelain"])).toContain("wip.txt");
      expect(git(a, ["stash", "list"]).trim()).toBe("");
    }, GIT_TEST_TIMEOUT_MS);

    it("E: rebase-mode abort restores the WIP — the rebase banner's Abort button can't eat a user's work", () => {
      const { a, b } = setupTriangle();
      writeFileSync(join(b, "base.txt"), "base\nremote change\n", "utf-8");
      git(b, ["add", "--", "base.txt"]);
      git(b, ["commit", "-m", "b: edit base.txt", "--quiet"]);
      git(b, ["push", "--quiet"]);

      writeFileSync(join(a, "base.txt"), "base\nlocal change\n", "utf-8");
      git(a, ["add", "--", "base.txt"]);
      git(a, ["commit", "-m", "a: edit base.txt", "--quiet"]);

      writeFileSync(join(a, "wip.txt"), "wip original\nwork in progress\n", "utf-8");

      const res = gitTry(a, ["pull", "--rebase", "--autostash", "--quiet"]);
      expect(res.status).not.toBe(0);
      expect(existsSync(join(a, ".git", "rebase-merge", "autostash"))).toBe(true);

      const abortRes = gitTry(a, ["rebase", "--abort"]);

      expect(abortRes.status).toBe(0);
      expect(abortRes.stdout + abortRes.stderr).toMatch(/Applied autostash/);
      expect(readFileSync(join(a, "wip.txt"), "utf-8")).toBe("wip original\nwork in progress\n");
      expect(git(a, ["status", "--porcelain"])).toContain("wip.txt");
      expect(git(a, ["stash", "list"]).trim()).toBe("");
    }, GIT_TEST_TIMEOUT_MS);

    it("G: untracked collision is still an error — --autostash does not help, no data loss (documented limitation)", () => {
      const { a, b } = setupTriangle();
      writeAndCommit(b, "incoming.txt", "from remote\n", "b: add incoming.txt");
      git(b, ["push", "--quiet"]);

      // Untracked local file with the same name as the incoming file.
      writeFileSync(join(a, "incoming.txt"), "local untracked version\n", "utf-8");

      const res = gitTry(a, ["pull", "--no-rebase", "--autostash", "--quiet"]);

      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/untracked working tree files would be overwritten/i);
      // No data loss — the local file is untouched.
      expect(readFileSync(join(a, "incoming.txt"), "utf-8")).toBe("local untracked version\n");
    }, GIT_TEST_TIMEOUT_MS);
  },
);
