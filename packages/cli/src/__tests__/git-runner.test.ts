/**
 * v3.11.1 — `GitRunner` for the CLI: `execFile`-based, discrete args, env
 * stripped of secret-bearing vars (AGENTS.md — never pass secrets to spawned
 * processes). Real temporary git repo, no mocking of the git layer.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCliGitRunner, gitEnv, repoRelativePath } from "../git-runner.js";

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

describe("makeCliGitRunner — spawn failures", () => {
  it("reports a spawn failure as -1, never as git's exit 1 (read by core as 'no merge base')", async () => {
    const run = makeCliGitRunner(join(tmpdir(), "gitwand-cli-runner-does-not-exist"));
    const r = await run(["merge-base", "HEAD", "HEAD"]);
    expect(r.exitCode).toBe(-1);
  });
});

describe("repoRelativePath", () => {
  it("turns a file path into the repo-root-relative, forward-slash path git stages use", () => {
    const root = join(tmpdir(), "repo");
    expect(repoRelativePath(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(repoRelativePath(root, join(root, "a.ts"))).toBe("a.ts");
  });
  it("returns null outside the repository", () => {
    const root = join(tmpdir(), "repo");
    expect(repoRelativePath(root, join(tmpdir(), "elsewhere", "a.ts"))).toBeNull();
    expect(repoRelativePath(root, root)).toBeNull();
  });
});

describe("makeCliGitRunner — from the repository root", () => {
  it("reads a subdirectory file's stage with the root-relative path", async () => {
    for (const [k, v] of Object.entries(HERMETIC_GIT_ENV)) vi.stubEnv(k, v);
    dir = mkdtempSync(join(tmpdir(), "gitwand-cli-runner-"));
    const env = { ...process.env, ...HERMETIC_GIT_ENV };
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, env });
    g(["init", "-q"]);
    g(["config", "user.email", "t@e"]);
    g(["config", "user.name", "T"]);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "f.txt"), "hello\n");
    g(["add", "."]);
    // A runner built at the root resolves `:0:<root-relative>` even though the
    // file lives in a subdirectory the user may be running the CLI from.
    const run = makeCliGitRunner(dir);
    const path = repoRelativePath(dir, join(dir, "sub", "f.txt"));
    expect(await run(["show", `:0:${path}`])).toEqual({ stdout: "hello\n", exitCode: 0 });
  });
});
