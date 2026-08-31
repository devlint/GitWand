/**
 * Final review Finding 2 — "not conflicted" must not be conflated with
 * "clean" in the CLI's pass-2 sibling-map seeding either.
 *
 * A yarn-CLASSIC repo (has `yarn.lock`, no `.yarnrc.yml` at all — the berry
 * marker `packages/core/src/regenerate/registry.ts` requires) has
 * `.yarnrc.yml` trivially "not conflicted" simply because it never existed.
 * Before this fix, `cmdResolve`'s pass-2 pre-seed loop
 * (`packages/cli/src/commands/resolve.ts`) marked ANY sourceOfTruth absent
 * from the conflicted-file set as "clean" unconditionally — which would have
 * made the re-derived yarn-berry plan come back `runnable: true` for this
 * repo, directly contradicting the registry's own documented berry-marker
 * guard (only saved in practice by an unrelated `readFile` failure later on,
 * per the final review). This test proves the CLI never marks the yarn.lock
 * conflict as regenerated in this shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
const YARN_LOCK = "yarn.lock";

function bumpLock(repo: string, marker: string): void {
  writeFileSync(join(repo, YARN_LOCK), `# yarn lockfile v1\n# marker: ${marker}\n`, "utf-8");
}

describe("cmdResolve --regenerate — yarn-classic repo regression (Finding 2, final review)", () => {
  let repo: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "gw-resolve-regen-yarn-classic-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  it(
    "does NOT mark a yarn.lock conflict as regenerated when .yarnrc.yml (berry marker) never existed",
    IT_TIMEOUT,
    async () => {
      initRepo(repo);
      writeFileSync(join(repo, "package.json"), '{"name":"e2e","version":"1.0.0"}\n', "utf-8");
      bumpLock(repo, "base");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "init"]);

      git(repo, ["checkout", "-b", "feature"]);
      bumpLock(repo, "feature");
      git(repo, ["commit", "-a", "-m", "feature: bump lock"]);

      git(repo, ["checkout", "main"]);
      bumpLock(repo, "main");
      git(repo, ["commit", "-a", "-m", "main: bump lock"]);

      try {
        git(repo, ["merge", "feature"]);
      } catch {
        // conflit attendu
      }

      // Preconditions: only yarn.lock conflicted, no .yarnrc.yml anywhere.
      const conflicted = git(repo, ["diff", "--name-only", "--diff-filter=U"]).trim().split("\n");
      expect(conflicted).toEqual([YARN_LOCK]);
      expect(existsSync(join(repo, ".yarnrc.yml"))).toBe(false);

      process.chdir(repo);
      await cmdResolve([], { regenerate: true, verbose: true });

      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).not.toContain("regenerated via");

      const lockContent = readFileSync(join(repo, YARN_LOCK), "utf-8");
      expect(lockContent).toContain("<<<<<<<");
    },
  );
});
