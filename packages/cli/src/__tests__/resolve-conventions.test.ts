/**
 * Task 3 (accuracy lot D, "regenerate tier" plan) — conventions/`.gitwandrc`
 * wiring into `cmdResolve`, plus the default-output regenerate offer.
 *
 * Covers the two prerequisite bugs identified by the controller's pre-flight
 * scan (see task-3-brief.md) and the checklist items that depend on them:
 *
 *  - Bug A: `resolveGeneratedFiles` reaching `resolve()`/`resolveAsync()` as
 *    `undefined` (not a concrete `false`) whenever `--resolve-generated` is
 *    not passed, so core's own convention-precedence logic can engage.
 *  - Bug B: `.git/gitwand/conventions.json` (written by `gitwand conventions`)
 *    actually being loaded into `options.conventions` on both calls.
 *  - Checklist 1: the default (non-verbose) summary offers `--regenerate`
 *    whenever an ecosystem match exists on a declined `generated_file`.
 *  - Checklist 2: a "merge" verdict flips the textual path end-to-end (no
 *    regeneration offer printed) — this only happens because of the Bug A/B
 *    fixes above.
 *  - Checklist 3: an explicit `.gitwandrc` `resolveGeneratedFiles` beats the
 *    measured convention in both directions.
 *
 * Real temp git repos throughout — no mocking of the git layer (AGENTS.md).
 * None of these scenarios need an actual npm/toolchain: the lockfile content
 * doesn't need to be valid npm output, only the *filename* needs to match the
 * `package-lock.json` pattern (`isGeneratedFile` matches by path, not by
 * content) — mirrors the technique already used by `conventions-derive.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cmdResolve } from "../commands/resolve.js";
import { conventionsPath } from "../commands/conventions.js";

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

const LOCK = "package-lock.json";

function lockContent(shared: string): string {
  return `{\n  "name": "e2e",\n  "lockfileVersion": 3,\n  "shared": "${shared}"\n}\n`;
}

/**
 * Builds a repo with exactly one conflicted file: `package-lock.json`, whose
 * only diverging line changed on BOTH branches (relative to base) — this is
 * the shape that classifies as "complex" then gets reclassified to
 * "generated_file" by `reclassifyIfGenerated` (matched on filename alone).
 */
function buildConflictedLockRepo(cwd: string): void {
  initRepo(cwd);
  writeFileSync(join(cwd, LOCK), lockContent("base"), "utf-8");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "init"]);

  git(cwd, ["checkout", "-b", "feature"]);
  writeFileSync(join(cwd, LOCK), lockContent("feature"), "utf-8");
  git(cwd, ["commit", "-a", "-m", "feature: bump lock"]);

  git(cwd, ["checkout", "main"]);
  writeFileSync(join(cwd, LOCK), lockContent("main"), "utf-8");
  git(cwd, ["commit", "-a", "-m", "main: bump lock"]);

  try {
    git(cwd, ["merge", "feature"]);
  } catch {
    // conflict expected
  }
}

function writeConventions(repo: string, verdict: "merge" | "regenerate"): void {
  const path = conventionsPath(repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        evidence: {
          mergesReplayed: 20,
          conflictedFiles: 20,
          derivedAt: new Date().toISOString(),
          engineVersion: "test",
        },
        generatedFiles: { verdict, samples: 20, agreement: 0.95 },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

function writeGitwandrc(repo: string, resolveGeneratedFiles: boolean): void {
  writeFileSync(
    join(repo, ".gitwandrc"),
    JSON.stringify({ resolveGeneratedFiles }, null, 2) + "\n",
    "utf-8",
  );
}

const IT_TIMEOUT = { timeout: 30_000 };

describe("cmdResolve — conventions & .gitwandrc wiring (task 3)", () => {
  let repo: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "gw-resolve-conv-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  function output(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it(
    // Bug A + Bug B + checklist item 2, combined: this is the only way a
    // "merge" verdict can visibly take effect — if Bug A were still present
    // (resolveGeneratedFiles forced to a concrete `false`), core's
    // `userOptions.resolveGeneratedFiles === undefined` precedence gate would
    // never let the convention engage, no matter what Bug B loads.
    "verdict 'merge' + no flag + no .gitwandrc → auto-resolves via the textual path, no regeneration offer",
    IT_TIMEOUT,
    async () => {
      buildConflictedLockRepo(repo);
      writeConventions(repo, "merge");

      process.chdir(repo);
      await cmdResolve([], {});

      const lock = readFileSync(join(repo, LOCK), "utf-8");
      // "accept theirs" is the textual path's behavior for generated_file
      // once resolveGeneratedFiles resolves to true (assemble.ts).
      expect(JSON.parse(lock).shared).toBe("feature");
      expect(lock).not.toContain("<<<<<<<");

      const out = output();
      expect(out).toContain("conflict(s) auto-resolved out of");
      expect(out).toContain("All conflicts resolved!");
      expect(out).not.toContain("--regenerate");
    },
  );

  it(
    // Checklist item 1: default (non-verbose) output must surface the offer
    // whenever an ecosystem match exists on a declined generated_file — no
    // conventions and no flags at all is the minimal case.
    "no conventions, ecosystem match, declined → default summary offers --regenerate",
    IT_TIMEOUT,
    async () => {
      buildConflictedLockRepo(repo);

      process.chdir(repo);
      await cmdResolve([], {});

      const lock = readFileSync(join(repo, LOCK), "utf-8");
      expect(lock).toContain("<<<<<<<"); // declined — still conflicted on disk

      const out = output();
      expect(out).toContain("1 conflict(s) remaining");
      expect(out).toContain("--regenerate");
    },
  );

  it(
    "verdict 'regenerate' → default summary offers --regenerate (per-file provenance stays verbose-only)",
    IT_TIMEOUT,
    async () => {
      buildConflictedLockRepo(repo);
      writeConventions(repo, "regenerate");

      process.chdir(repo);
      await cmdResolve([], {});

      const out = output();
      expect(out).toContain("--regenerate");
      // Convention provenance text is only surfaced via --verbose (see
      // resolve.ts's `if (verbose)` block) — a default run must not print it.
      expect(out).not.toContain("convention mesurée");
    },
  );

  it(
    // Checklist item 3a: .gitwandrc explicit `true` beats a "regenerate" verdict.
    ".gitwandrc resolveGeneratedFiles: true overrides a 'regenerate' convention verdict",
    IT_TIMEOUT,
    async () => {
      buildConflictedLockRepo(repo);
      writeConventions(repo, "regenerate");
      writeGitwandrc(repo, true);

      process.chdir(repo);
      await cmdResolve([], {});

      const lock = readFileSync(join(repo, LOCK), "utf-8");
      expect(JSON.parse(lock).shared).toBe("feature");
      expect(lock).not.toContain("<<<<<<<");

      const out = output();
      expect(out).toContain("conflict(s) auto-resolved out of");
      expect(out).toContain("All conflicts resolved!");
      expect(out).not.toContain("--regenerate");
    },
  );

  it(
    // Checklist item 3b: .gitwandrc explicit `false` beats a "merge" verdict.
    ".gitwandrc resolveGeneratedFiles: false overrides a 'merge' convention verdict",
    IT_TIMEOUT,
    async () => {
      buildConflictedLockRepo(repo);
      writeConventions(repo, "merge");
      writeGitwandrc(repo, false);

      process.chdir(repo);
      await cmdResolve([], {});

      const lock = readFileSync(join(repo, LOCK), "utf-8");
      expect(lock).toContain("<<<<<<<"); // declined despite the "merge" verdict

      const out = output();
      expect(out).toContain("1 conflict(s) remaining");
      expect(out).toContain("--regenerate");
    },
  );
});
