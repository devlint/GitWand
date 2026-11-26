/**
 * Parity tests — `git_bisect_status` (Rust) vs `/api/git-bisect-status`
 * (Node dev-server, `dev-bisect.mjs`): two ports of the same range, skip,
 * candidate and scope logic.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureBisect, fixtureClean } from "./fixtures.mjs";

describe("parity: git-bisect-status", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  const check = (cwd) =>
    assertParity(dev, {
      command: "git-bisect-status",
      args: { cwd },
      httpPath: `/api/git-bisect-status?cwd=${encodeURIComponent(cwd)}`,
    });

  it("a bisect with a skip and a good mark", async () => {
    const { rust } = await check(fixtureBisect());
    expect(rust.active).toBe(true);
    expect(rust.skipped).toHaveLength(1);
    expect(rust.good.length).toBeGreaterThanOrEqual(2);
  });

  it("a bisect limited to a path", async () => {
    const { rust } = await check(fixtureBisect(true));
    expect(rust.active).toBe(true);
    // c3 and c6 touch b.txt; c8 is the bad end: c3 and c6 are left.
    expect(rust.remaining).toBe(2);
  });

  it("no bisect in progress", async () => {
    const { rust } = await check(fixtureClean());
    expect(rust.active).toBe(false);
  });
});
