/**
 * v3.11.1 — `GitRunner` for the CLI: `execFile`-based, discrete args, env
 * stripped of secret-bearing vars (AGENTS.md — never pass secrets to spawned
 * processes). Real temporary git repo, no mocking of the git layer.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCliGitRunner, gitEnv } from "../git-runner.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("gitEnv", () => {
  it("strips secret-bearing variables and keeps the rest", () => {
    const env = gitEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y", GITHUB_TOKEN: "z", DB_PASSWORD: "p", MY_SECRET: "s" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("makeCliGitRunner", () => {
  it("resolves stdout and exit code 0 on success, non-zero on failure, never rejecting", async () => {
    dir = mkdtempSync(join(tmpdir(), "gitwand-cli-runner-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const run = makeCliGitRunner(dir);
    const ok = await run(["rev-parse", "--is-inside-work-tree"]);
    expect(ok).toEqual({ stdout: "true\n", exitCode: 0 });
    const bad = await run(["rev-parse", "--verify", "no-such-ref"]);
    expect(bad.exitCode).not.toBe(0);
  });
});
