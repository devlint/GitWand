/**
 * Parity tests — `snapshot_list` (Rust) vs `/api/snapshot-list` (Node dev-server).
 *
 * Snapshots are created through the Rust probe only, so both implementations
 * then read the exact same `refs/gitwand/snapshots/*` object graph and must
 * agree field-for-field. That is the whole point: the Node port in
 * `dev-server.mjs` and `git/snapshot.rs` write and read one shared format.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureDirty } from "./fixtures.mjs";

describe("parity: snapshot-list", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("two snapshots, newest first, identical on both sides", async () => {
    // Modified, staged and untracked files, plus 3 commits on main.
    const cwd = fixtureDirty();

    const first = runProbe("snapshot-create", { cwd, kind: "manual", label: "one" });
    expect(first.ok, `probe error: ${first.error}`).toBe(true);
    const second = runProbe("snapshot-create", { cwd, kind: "discard", label: "two" });
    expect(second.ok, `probe error: ${second.error}`).toBe(true);

    const { rust, node } = await assertParity(dev, {
      command: "snapshot-list",
      args: { cwd },
      httpPath: `/api/snapshot-list?cwd=${encodeURIComponent(cwd)}`,
    });

    expect(rust).toHaveLength(2);
    expect(rust[0].label).toBe("two");
    expect(rust[0].kind).toBe("discard");
    expect(rust[1].label).toBe("one");
    for (const entry of [...rust, ...node]) {
      expect(entry.id).toMatch(/^\d+-[0-9a-f]{8}$/);
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.headRef).toBe("main");
      expect(entry.mergeHead).toBeNull();
    }
  });

  it("a repo with no snapshots yields an empty list on both sides", async () => {
    const cwd = fixtureDirty();

    const { rust } = await assertParity(dev, {
      command: "snapshot-list",
      args: { cwd },
      httpPath: `/api/snapshot-list?cwd=${encodeURIComponent(cwd)}`,
    });

    expect(rust).toEqual([]);
  });
});
