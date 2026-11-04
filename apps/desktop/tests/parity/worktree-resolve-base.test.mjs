/**
 * Parity tests — `worktree_resolve_base` (Rust) vs `/api/worktree-resolve-base`
 * (Node dev-server). Spec §12: the base a new worktree starts from, and the
 * default directory, must be the same in `dev:web` and in the app. Offline
 * fixtures only: neither case reaches a network.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureClean, fixtureCursorOriginRemote } from "./fixtures.mjs";

describe("parity: worktree-resolve-base", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("no remote → local HEAD, `no-remote`", async () => {
    const cwd = fixtureClean();
    await assertParity(dev, {
      command: "worktree-resolve-base",
      args: { cwd },
      httpPath: "/api/worktree-resolve-base",
      method: "POST",
      body: { cwd },
    });
  });

  it("remote never fetched → local HEAD, `no-default-branch`", async () => {
    const cwd = fixtureCursorOriginRemote();
    await assertParity(dev, {
      command: "worktree-resolve-base",
      args: { cwd },
      httpPath: "/api/worktree-resolve-base",
      method: "POST",
      body: { cwd },
    });
  });
});
