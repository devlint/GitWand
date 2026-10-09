/**
 * `planDiscard` against real git: each plan is run with the exact commands the
 * Rust backend issues (`git_unstage` → `reset HEAD --`, `git_discard` →
 * `checkout --` / `clean -f --`), and the repo must come back to HEAD.
 *
 * Real temporary repos per AGENTS.md — never a mocked git layer.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDiscard, selectDiscardEntries } from "../discardPlan";
import type { RepoFileEntry } from "../../composables/useGitRepo";

const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "GitWand Test",
    GIT_AUTHOR_EMAIL: "test@gitwand.test",
    GIT_COMMITTER_NAME: "GitWand Test",
    GIT_COMMITTER_EMAIL: "test@gitwand.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

let repo: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: gitEnv(), encoding: "utf-8" });
}

function write(path: string, content: string) {
  writeFileSync(join(repo, path), content);
}

/** Run a plan the way App.vue → useGitRepo → the Rust commands do. */
function apply(entries: RepoFileEntry[]) {
  const plan = planDiscard(entries);
  if (plan.unstage.length) git(["reset", "-q", "HEAD", "--", ...plan.unstage]);
  if (plan.checkout.length) git(["checkout", "--", ...plan.checkout]);
  if (plan.clean.length) git(["clean", "-f", "-q", "--", ...plan.clean]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitwand-discard-"));
  git(["init", "-q"]);
  write("mod.txt", "base\n");
  write("del.txt", "base\n");
  write("old.txt", "base\n");
  write("part.txt", "base\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("planDiscard against real git", () => {
  it("restores a staged modification", () => {
    write("mod.txt", "changed\n");
    git(["add", "mod.txt"]);
    apply([{ path: "mod.txt", status: "modified", section: "staged" }]);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(repo, "mod.txt"), "utf-8")).toBe("base\n");
  }, GIT_TEST_TIMEOUT_MS);

  it("deletes a staged addition", () => {
    write("new.txt", "new\n");
    git(["add", "new.txt"]);
    apply([{ path: "new.txt", status: "added", section: "staged" }]);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("restores a staged deletion", () => {
    git(["rm", "-q", "del.txt"]);
    apply([{ path: "del.txt", status: "deleted", section: "staged" }]);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, "del.txt"))).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("undoes a staged rename: old path back, new path gone", () => {
    git(["mv", "old.txt", "renamed.txt"]);
    apply([{ path: "renamed.txt", oldPath: "old.txt", status: "renamed", section: "staged" }]);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, "old.txt"))).toBe(true);
    expect(existsSync(join(repo, "renamed.txt"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("discards both halves of a partially staged file", () => {
    write("part.txt", "staged\n");
    git(["add", "part.txt"]);
    write("part.txt", "staged + unstaged\n");
    apply([
      { path: "part.txt", status: "modified", section: "staged" },
      { path: "part.txt", status: "modified", section: "unstaged" },
    ]);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(repo, "part.txt"), "utf-8")).toBe("base\n");
  }, GIT_TEST_TIMEOUT_MS);

  it("discards a staged addition edited afterwards without failing the batch", () => {
    // "AM": the unstaged entry must not reach `git checkout`, where the
    // now-untracked path would make git reject every other path too.
    write("new.txt", "new\n");
    git(["add", "new.txt"]);
    write("new.txt", "new, edited\n");
    write("mod.txt", "changed\n");
    apply([
      { path: "new.txt", status: "added", section: "staged" },
      { path: "new.txt", status: "modified", section: "unstaged" },
      { path: "mod.txt", status: "modified", section: "unstaged" },
    ]);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("discards an untracked file", () => {
    write("scratch.txt", "tmp\n");
    apply([{ path: "scratch.txt", status: "added", section: "untracked" }]);
    expect(git(["status", "--porcelain"])).toBe("");
  }, GIT_TEST_TIMEOUT_MS);
});

describe("selectDiscardEntries — discarding the Changes section", () => {
  it("keeps staged changes, including the staged half of a partially staged file", () => {
    write("mod.txt", "staged\n");
    git(["add", "mod.txt"]);
    write("part.txt", "staged\n");
    git(["add", "part.txt"]);
    write("part.txt", "staged\nunstaged\n");
    write("del.txt", "unstaged\n");
    write("untracked.txt", "new\n");

    const entries: RepoFileEntry[] = [
      { path: "mod.txt", status: "modified", section: "staged" },
      { path: "part.txt", status: "modified", section: "staged" },
      { path: "part.txt", status: "modified", section: "unstaged" },
      { path: "del.txt", status: "modified", section: "unstaged" },
      { path: "untracked.txt", status: "added", section: "untracked" },
    ];
    const changesPaths = ["part.txt", "del.txt", "untracked.txt"];
    apply(selectDiscardEntries(entries, "changes", changesPaths));

    expect(git(["status", "--porcelain"]).split("\n").filter(Boolean).sort())
      .toEqual(["M  mod.txt", "M  part.txt"]);
    expect(readFileSync(join(repo, "part.txt"), "utf-8")).toBe("staged\n");
    expect(existsSync(join(repo, "untracked.txt"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("'all' discards every confirmed path, staged or not", () => {
    write("mod.txt", "staged\n");
    git(["add", "mod.txt"]);
    write("del.txt", "unstaged\n");
    const entries: RepoFileEntry[] = [
      { path: "mod.txt", status: "modified", section: "staged" },
      { path: "del.txt", status: "modified", section: "unstaged" },
    ];
    apply(selectDiscardEntries(entries, "all", ["mod.txt", "del.txt"]));
    expect(git(["status", "--porcelain"])).toBe("");
  }, GIT_TEST_TIMEOUT_MS);
});
