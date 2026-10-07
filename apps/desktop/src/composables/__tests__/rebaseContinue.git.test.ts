/**
 * Real-git tests for `rebaseContinue()` / `rebaseSkip()` at a conflict stop
 * (#223).
 *
 * `git rebase --continue` with conflicts still unresolved does not print
 * `CONFLICT` or `could not apply` — it prints `<file>: needs merge` and
 * "You must edit all merge conflicts…". That used to be reported as a plain
 * failure, so RebaseEditor neither finished nor handed off to the conflict
 * banner, and with no error visible in its in-progress view the Continue
 * button looked dead. These tests pin that the halt is reported as a
 * conflict, from git's real output rather than a mocked string.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    GIT_EDITOR: "true",
    EDITOR: "true",
    LC_ALL: "C",
  };
}

// Route the composable's gitExec to real git.
vi.mock("../../utils/backend", () => ({
  gitExec: vi.fn(async (cwd: string, args: string[]) => {
    const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1 };
  }),
  gitInteractiveRebase: vi.fn(),
}));

import { useInteractiveRebase } from "../useInteractiveRebase";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
}

function commitFile(cwd: string, content: string, message: string) {
  writeFileSync(join(cwd, "f.txt"), content);
  git(cwd, ["add", "f.txt"]);
  git(cwd, ["commit", "-q", "-m", message]);
}

let repo = "";

/** `topic` (two commits) rebased onto a `main` that rewrote the same line. */
function haltOnConflict() {
  repo = mkdtempSync(join(tmpdir(), "gitwand-rebase-continue-"));
  git(repo, ["init", "-q", "-b", "main"]);
  commitFile(repo, "base\n", "base");
  git(repo, ["switch", "-q", "-c", "topic"]);
  commitFile(repo, "topic\n", "topic 1");
  writeFileSync(join(repo, "g.txt"), "second\n");
  git(repo, ["add", "g.txt"]);
  git(repo, ["commit", "-q", "-m", "topic 2"]);
  git(repo, ["switch", "-q", "main"]);
  commitFile(repo, "main\n", "main");
  git(repo, ["switch", "-q", "topic"]);
  const r = spawnSync("git", ["rebase", "main"], { cwd: repo, env: gitEnv() });
  expect(r.status).not.toBe(0); // halted on the f.txt conflict
}

function isRebasing(): boolean {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"], { cwd: repo, env: gitEnv() }).status === 0;
}

beforeEach(haltOnConflict);
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = "";
});

describe("rebaseContinue at a conflict stop", () => {
  it("reports unresolved conflicts as a conflict halt, not a failure", async () => {
    const rebase = useInteractiveRebase();
    const result = await rebase.rebaseContinue(repo);
    expect(result).toMatchObject({ conflict: true, inProgress: true });
    expect(rebase.progress.value?.hasConflict).toBe(true);
    expect(isRebasing()).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("continues normally once the conflict is resolved", async () => {
    writeFileSync(join(repo, "f.txt"), "resolved\n");
    git(repo, ["add", "f.txt"]);
    const rebase = useInteractiveRebase();
    const result = await rebase.rebaseContinue(repo);
    expect(result).toMatchObject({ success: true, inProgress: false });
    expect(isRebasing()).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("rebaseSkip at a conflict stop", () => {
  it("skips the conflicting commit and finishes the rebase", async () => {
    const rebase = useInteractiveRebase();
    const result = await rebase.rebaseSkip(repo);
    expect(result).toMatchObject({ success: true, inProgress: false });
    expect(isRebasing()).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});
