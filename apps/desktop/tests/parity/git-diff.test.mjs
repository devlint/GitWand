/**
 * Parity tests, `git_diff` (Rust, libgit2 fast path) vs `/api/git-diff` (Node).
 *
 * This is the guard on the v3.10.0 libgit2 migration: the fast path must be
 * indistinguishable from the CLI output the dev-server produces.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureDiff } from "./fixtures.mjs";

describe("parity: git-diff", () => {
  let dev;
  beforeAll(async () => { dev = await startDevServer(); }, 15_000);
  afterAll(async () => { await dev?.stop(); });

  it("unstaged edit produces identical hunks", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "a.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=a.txt&staged=false`,
    });
  });

  it("staged edit produces identical hunks", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "b.txt", staged: true },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=b.txt&staged=true`,
    });
  });

  it("clean file produces no hunks on either side", async () => {
    const cwd = fixtureDiff();
    await assertParity(dev, {
      command: "git-diff",
      args: { cwd, path: "b.txt", staged: false },
      httpPath: `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=b.txt&staged=false`,
    });
  });
});
