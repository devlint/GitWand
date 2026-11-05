/**
 * Parity tests — `worktree_guard` (Rust) vs `/api/worktree-guard` (Node
 * dev-server). Spec §12: what GitWand may do to a worktree before removing
 * it must be the same in `dev:web` and in the app.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureClean } from "./fixtures.mjs";

function linked(cwd, name, branch) {
  const path = `${cwd}.wt/${name}`;
  execFileSync("git", ["-C", cwd, "worktree", "add", "-q", "-b", branch, path]);
  return realpathSync(path);
}

describe("parity: worktree-guard", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  const check = (cwd, path) =>
    assertParity(dev, {
      command: "worktree-guard",
      args: { cwd, path },
      httpPath: "/api/worktree-guard",
      method: "POST",
      body: { cwd, path },
    });

  it("plain linked worktree → touchable, not owned", async () => {
    const cwd = fixtureClean();
    await check(cwd, linked(cwd, "plain", "plain"));
  });

  it("locked with a reason and a keep file → untouchable", async () => {
    const cwd = fixtureClean();
    const path = linked(cwd, "locked", "locked");
    execFileSync("git", ["-C", cwd, "worktree", "lock", "--reason", "busy", path]);
    writeFileSync(join(path, ".worktree-keep"), "");
    await check(cwd, path);
  });

  it("legacy scratch → owned", async () => {
    const cwd = fixtureClean();
    await check(cwd, linked(cwd, "gitwand-scratch-1", "gitwand-scratch-1"));
  });
});
