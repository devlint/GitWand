/**
 * Final review Finding 1 — nested (non-root) lockfiles must never come back
 * `runnable` from `--regenerate`.
 *
 * `findEcosystem`/`GENERATED_FILE_PATTERNS` intentionally match nested
 * lockfiles too (e.g. `packages/x/package-lock.json` → npm — see
 * `packages/core/src/__tests__/regenerate/registry.test.ts`). Before this
 * fix, nothing downstream was directory-aware: the CLI's regenerate-runner
 * wrote each resolved source of truth at the WORKTREE ROOT and spawned the
 * installer with `cwd` = that root, then read the regenerated lockfile back
 * from its nested path — which the root-level install never touched. In a
 * monorepo where the root `package.json` merges cleanly, that made a nested
 * lockfile conflict come back `runnable: true`, regenerate the ROOT
 * lockfile, and read back a stale/untouched nested one that still parses (a
 * false "regenerated" success that's actually silent take-ours).
 *
 * This test drives `cmdResolve` end to end on a real small-monorepo repo and
 * asserts the nested lockfile conflict is left alone (still conflicted on
 * disk) rather than silently marked resolved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdResolve } from "../commands/resolve.js";

const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: HERMETIC_GIT_ENV,
    timeout: 10_000,
  });
}

function initRepo(cwd: string): void {
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "t@t.t"]);
  git(cwd, ["config", "user.name", "t"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "core.hooksPath", "/dev/null"]);
}

const IT_TIMEOUT = { timeout: 30_000 };
const NESTED_LOCK = "packages/x/package-lock.json";

function bumpNestedLockVersion(repo: string, version: string): void {
  const path = join(repo, NESTED_LOCK);
  const lock = JSON.parse(readFileSync(path, "utf-8"));
  lock.version = version;
  writeFileSync(path, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

describe("cmdResolve --regenerate — nested lockfile regression (Finding 1, final review)", () => {
  let repo: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "gw-resolve-regen-nested-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  it(
    "does NOT mark a nested package-lock.json conflict as regenerated, even though its (root) package.json merges cleanly",
    IT_TIMEOUT,
    async () => {
      initRepo(repo);

      // Root package.json — never touched by either branch, merges cleanly.
      writeFileSync(join(repo, "package.json"), '{"name":"root","private":true,"workspaces":["packages/*"]}\n', "utf-8");

      // Nested workspace package, with its OWN lockfile — the one that
      // actually gets conflicted.
      mkdirSync(join(repo, "packages/x"), { recursive: true });
      writeFileSync(join(repo, "packages/x/package.json"), '{"name":"x","version":"1.0.0"}\n', "utf-8");
      writeFileSync(
        join(repo, NESTED_LOCK),
        JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3 }, null, 2) + "\n",
        "utf-8",
      );

      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);

      git(repo, ["checkout", "-b", "feature"]);
      bumpNestedLockVersion(repo, "1.1.0");
      git(repo, ["commit", "-a", "-m", "feature: bump nested lock version"]);

      git(repo, ["checkout", "main"]);
      bumpNestedLockVersion(repo, "1.0.0-main");
      git(repo, ["commit", "-a", "-m", "main: bump nested lock version"]);

      try {
        git(repo, ["merge", "feature"]);
      } catch {
        // conflit attendu
      }

      // Precondition: only the nested lockfile is conflicted; root
      // package.json merged cleanly (never appears in the conflicted set).
      const conflicted = git(repo, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n");
      expect(conflicted).toEqual([NESTED_LOCK]);

      process.chdir(repo);
      await cmdResolve([], { regenerate: true, verbose: true });

      // Not a false success: the printed line for this file must NOT read
      // "success" for a regeneration that never should have run.
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).not.toContain("regenerated via");
      expect(output).not.toMatch(/regenerate:.*success/);

      // The nested lockfile must be left exactly as the merge left it —
      // still carrying conflict markers, never silently overwritten with
      // regenerated (actually stale/untouched) content.
      const nestedContent = readFileSync(join(repo, NESTED_LOCK), "utf-8");
      expect(nestedContent).toContain("<<<<<<<");

      // Root package.json must never have been touched by gitwand either —
      // it was clean, and the nested file's plan must be blocked before any
      // write to sources of truth happens.
      const status = git(repo, ["status", "--short"]).trim();
      expect(status).not.toContain(" packages/x/package.json");
    },
  );
});
