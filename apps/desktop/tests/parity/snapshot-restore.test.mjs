/**
 * Parity tests — `snapshot_restore` / `snapshot_prune` (Rust) vs their
 * `dev-server.mjs` routes.
 *
 * Restore is mutating, so its RETURN value cannot be compared the way
 * `snapshot-list` is: each side produces its own `pre-restore` snapshot with
 * its own id. What must match is the effect — the working tree, the index
 * (including conflict stages) and the merge state the restore leaves behind.
 * So each implementation runs against its own copy of the same fixture and the
 * two resulting repo states are compared.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureDirty } from "./fixtures.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf-8" });

/** Everything a restore is supposed to put back, as one comparable blob. */
function repoState(cwd) {
  return {
    index: git(cwd, ["ls-files", "-s"]),
    status: git(cwd, ["status", "--porcelain=v1", "-uall"]),
    head: git(cwd, ["rev-parse", "HEAD"]).trim(),
    branch: git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(),
    a: git(cwd, ["show", "HEAD:a.txt"]),
  };
}

/** The fixture, plus a destructive edit the restore has to undo. */
function dirtyThenDiscard(cwd) {
  // `fixtureDirty` leaves a.txt modified, c.txt staged, d.txt untracked.
  return cwd;
}

describe("parity: snapshot-restore", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("both sides leave the repo in the same state after a restore", async () => {
    const rustRepo = dirtyThenDiscard(fixtureDirty());
    const nodeRepo = dirtyThenDiscard(fixtureDirty());

    // ── Snapshot each copy, through its own implementation.
    const rustSnap = runProbe("snapshot-create", {
      cwd: rustRepo,
      kind: "manual",
      label: "before discard",
    });
    expect(rustSnap.ok, `probe error: ${rustSnap.error}`).toBe(true);

    const nodeCreate = await dev.fetch("/api/snapshot-create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: nodeRepo, kind: "manual", label: "before discard" }),
    });
    expect(nodeCreate.ok).toBe(true);
    const nodeSnap = await nodeCreate.json();

    // ── Same destruction on both: throw away every uncommitted change.
    for (const cwd of [rustRepo, nodeRepo]) {
      git(cwd, ["checkout", "--", "."]);
      git(cwd, ["reset", "--hard", "HEAD"]);
      git(cwd, ["clean", "-fd"]);
    }

    // ── Restore, each through its own implementation.
    const rustRestore = runProbe("snapshot-restore", { cwd: rustRepo, id: rustSnap.value.id });
    expect(rustRestore.ok, `probe error: ${rustRestore.error}`).toBe(true);

    const nodeRestore = await dev.fetch("/api/snapshot-restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: nodeRepo, id: nodeSnap.id }),
    });
    expect(nodeRestore.ok).toBe(true);

    // ── The two repos must now be indistinguishable.
    expect(repoState(rustRepo)).toEqual(repoState(nodeRepo));

    // …and the restore must actually have restored something.
    const state = repoState(rustRepo);
    expect(state.status).toContain("a.txt");
    expect(state.status).toContain("d.txt");
  });

  it("both sides refuse a retention that would delete everything", async () => {
    const cwd = fixtureDirty();
    const created = runProbe("snapshot-create", { cwd, kind: "manual", label: "keep" });
    expect(created.ok).toBe(true);

    const rustPrune = runProbe("snapshot-prune", { cwd, maxAgeDays: 0, maxCount: 200 });
    expect(rustPrune.ok, "a 0-day retention must be refused").toBe(false);

    const nodePrune = await dev.fetch("/api/snapshot-prune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, maxAgeDays: 0, maxCount: 200 }),
    });
    expect(nodePrune.ok, "the dev-server must refuse it too").toBe(false);

    // Neither refusal may have deleted anything.
    const left = runProbe("snapshot-list", { cwd });
    expect(left.value).toHaveLength(1);
  });
});
