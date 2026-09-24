/**
 * Real temporary git repositories for history tests. Test-only: shipped core
 * code never imports Node modules, but tests may. Hermetic env so the host's
 * global git config (hooks, signing, rerere, color) never leaks in.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GitRunner } from "../../history/types.js";

export const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_AUTHOR_DATE: "2026-09-01T12:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-01T12:00:00Z",
};

export interface Repo {
  dir: string;
  git(args: string[], opts?: { allowFail?: boolean }): string;
  write(path: string, content: string): void;
  runner: GitRunner;
  cleanup(): void;
}

export function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-history-"));
  const git = (args: string[], opts: { allowFail?: boolean } = {}): string => {
    try {
      return execFileSync("git", args, {
        cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: HERMETIC_GIT_ENV, timeout: 10_000,
      });
    } catch (err) {
      if (opts.allowFail) return String((err as { stdout?: string }).stdout ?? "");
      throw err;
    }
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Tester"]);
  git(["config", "commit.gpgsign", "false"]);
  const runner: GitRunner = (args) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd: dir, encoding: "utf-8", env: HERMETIC_GIT_ENV }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ stdout: stdout ?? "", exitCode: code });
      });
    });
  return {
    dir,
    git,
    write(path, content) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    },
    runner,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
