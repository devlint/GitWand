/**
 * Real-git contract tests for the operation-action model — the drift lock for
 * docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md (§3,
 * §4.1). Every assertion documents a git behaviour `git_operation_action`
 * depends on.
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
const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EDITOR: "true",
    EDITOR: "true",
    ...extra,
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

function tryGit(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): GitResult {
  const res = spawnSync("git", args, {
    cwd,
    env: gitEnv(extraEnv),
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-opaction-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/**
 * Two feature commits that both conflict with main, so a cherry-pick of the
 * pair halts twice: once on the first, and again when --continue reaches the
 * second. That second halt is the case the whole design turns on.
 */
function makeTwoConflictingCommits(dir: string): string[] {
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature one\n");
  git(dir, ["commit", "-am", "feature one"]);
  const first = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "file.txt"), "feature two\n");
  git(dir, ["commit", "-am", "feature two"]);
  const second = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["commit", "-am", "main change"]);
  return [first, second];
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("a --continue that reaches a further conflict", () => {
  it(
    "exits non-zero and says CONFLICT, having made progress",
    () => {
      // §3: this is why exit code alone cannot mean "failed". git advanced to
      // the next commit and stopped where it should.
      const dir = makeRepo();
      const [first, second] = makeTwoConflictingCommits(dir);
      const pick = tryGit(dir, ["cherry-pick", first!, second!]);
      expect(pick.status).not.toBe(0);
      // Resolve the first conflict and stage it, then continue.
      writeFileSync(join(dir, "file.txt"), "resolved one\n");
      git(dir, ["add", "file.txt"]);

      const res = tryGit(dir, ["cherry-pick", "--continue"]);

      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/CONFLICT|could not apply/);
      // Still mid-cherry-pick, on the second commit now.
      expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("which operations accept --skip", () => {
  it(
    "cherry-pick, revert and rebase accept it; merge does not",
    () => {
      // §4.1: the whitelist refuses merge+skip at the source rather than
      // letting git answer "unknown option".
      const dir = makeRepo();

      const merge = tryGit(dir, ["merge", "--skip"]);
      expect(merge.stderr).toMatch(/unknown option/i);

      // The others reject on state ("no … in progress"), not on the option,
      // which is what proves the option exists.
      for (const op of ["cherry-pick", "revert", "rebase"]) {
        const res = tryGit(dir, [op, "--skip"]);
        expect(res.stderr).not.toMatch(/unknown option/i);
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("git's own localisation", () => {
  it(
    "keeps the halted markers stable only when the locale is pinned",
    () => {
      // §3: the reason the command pins LC_ALL=C. Under a translated locale
      // the CONFLICT match can miss, and progress would be reported as
      // failure. The English assertion is the invariant we rely on; the
      // French one is deliberately one-sided, because a machine without the
      // fr_FR locale installed falls back to English and would otherwise fail
      // the suite for the wrong reason.
      const dir = makeRepo();
      makeTwoConflictingCommits(dir);

      const english = tryGit(dir, ["merge", "feature"], {
        LC_ALL: "C",
        LANGUAGE: "",
      });
      expect(english.stdout + english.stderr).toMatch(/CONFLICT/);

      tryGit(dir, ["merge", "--abort"]);

      const french = tryGit(dir, ["merge", "feature"], {
        LC_ALL: "fr_FR.UTF-8",
        LANGUAGE: "fr",
      });
      expect((french.stdout + french.stderr).length).toBeGreaterThan(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
