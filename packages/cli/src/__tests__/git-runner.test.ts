/**
 * v3.11.1 — `GitRunner` for the CLI: `execFile`-based, discrete args, env
 * stripped of secret-bearing vars (AGENTS.md — never pass secrets to spawned
 * processes). Real temporary git repo, no mocking of the git layer.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCliGitRunner, gitEnv } from "../git-runner.js";

// Hermetic git env (fix round 1 — same rationale as merge-context-detect.test.ts's
// HERMETIC_GIT_ENV): without it, the host's global/system git config (hooks, GPG
// signing, a configured editor…) can leak into this temp repo. `makeCliGitRunner`
// reads `process.env` at construction time, so these are stubbed via `vi.stubEnv`
// before building the runner rather than passed through its API.
const HERMETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
};

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllEnvs();
});

describe("gitEnv", () => {
  it("strips secret-bearing variables and keeps the rest", () => {
    const env = gitEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", GITHUB_TOKEN: "z", DB_PASSWORD: "p", MY_SECRET: "s" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("makeCliGitRunner", () => {
  it("resolves stdout and exit code 0 on success, non-zero on failure, never rejecting", async () => {
    for (const [k, v] of Object.entries(HERMETIC_GIT_ENV)) vi.stubEnv(k, v);
    dir = mkdtempSync(join(tmpdir(), "gitwand-cli-runner-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, env: { ...process.env, ...HERMETIC_GIT_ENV } });
    const run = makeCliGitRunner(dir);
    const ok = await run(["rev-parse", "--is-inside-work-tree"]);
    expect(ok).toEqual({ stdout: "true\n", exitCode: 0 });
    const bad = await run(["rev-parse", "--verify", "no-such-ref"]);
    expect(bad.exitCode).not.toBe(0);
  });
});
