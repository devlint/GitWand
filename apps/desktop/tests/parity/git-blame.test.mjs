/**
 * Parity tests, `git_blame` (Rust, libgit2 fast path) vs `/api/git-blame` (Node).
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureBlame } from "./fixtures.mjs";

describe("parity: git-blame", () => {
  let dev;
  beforeAll(async () => { dev = await startDevServer(); }, 15_000);
  afterAll(async () => { await dev?.stop(); });

  it("attributes every line identically across backends", async () => {
    const cwd = fixtureBlame();
    await assertParity(dev, {
      command: "git-blame",
      args: { cwd, path: "a.txt", algorithm: "histogram" },
      httpPath: `/api/git-blame?cwd=${encodeURIComponent(cwd)}&path=a.txt&algorithm=histogram`,
    });
  });
});
