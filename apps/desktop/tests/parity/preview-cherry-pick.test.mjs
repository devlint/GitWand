/**
 * Parity tests: `preview_cherry_pick` (Rust) vs `/api/preview-cherry-pick`.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * Like `preview_rebase`, this had no dev-server route before v3.11.0.
 *
 * The failure case matters as much as the success one here, which is the
 * lesson `read-file.test.mjs` records: a root commit has no parent, so there
 * is no ancestor to build a three-way merge from. Both backends must refuse
 * it, with the same message, rather than one of them inventing an empty
 * preview that reads as "this cherry-pick is clean".
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixturePreviewCherryPick } from "./fixtures.mjs";

async function nodePreviewCherryPick(dev, cwd, commit) {
  const res = await dev.fetch("/api/preview-cherry-pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, commit }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

describe("parity: preview-cherry-pick", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  /** @type {ReturnType<typeof fixturePreviewCherryPick>} */
  let fx;

  beforeAll(async () => {
    dev = await startDevServer();
    fx = fixturePreviewCherryPick();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a conflicting cherry-pick is identical on both sides", async () => {
    const rust = runProbe("preview-cherry-pick", { cwd: fx.cwd, commit: fx.topic });
    const node = await nodePreviewCherryPick(dev, fx.cwd, fx.topic);

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(node.value).toEqual(rust.value);

    const shared = rust.value.find((p) => p.file_path === "shared.txt");
    expect(shared?.has_conflicts, "shared.txt really does conflict").toBe(true);
    expect(shared.conflict_content).toContain("<<<<<<< ours");
    expect(shared.conflict_content).not.toMatch(/\.tmp\b/);
  });

  it("a cherry-pick touching nothing in common is clean on both sides", async () => {
    const rust = runProbe("preview-cherry-pick", { cwd: fx.cwd, commit: fx.clean });
    const node = await nodePreviewCherryPick(dev, fx.cwd, fx.clean);

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(node.value).toEqual(rust.value);
    expect(rust.value.some((p) => p.has_conflicts)).toBe(false);
  });

  it("a ROOT commit is refused by both sides, for the same reason", async () => {
    // No parent means no ancestor, so there is no three-way merge to simulate.
    // Returning an empty preview here would read as "clean", which is worse
    // than an error: it would be a confident wrong answer.
    const rust = runProbe("preview-cherry-pick", { cwd: fx.cwd, commit: fx.root });
    const node = await nodePreviewCherryPick(dev, fx.cwd, fx.root);

    expect(rust.ok, "rust accepted a root commit").toBe(false);
    expect(node.ok, "node accepted a root commit").toBe(false);
    expect(rust.error).toContain("root commit");
    expect(node.error).toBe(rust.error);
  });

  it("an unknown commit is refused identically by both sides", async () => {
    const rust = runProbe("preview-cherry-pick", { cwd: fx.cwd, commit: "deadbeef" });
    const node = await nodePreviewCherryPick(dev, fx.cwd, "deadbeef");

    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    expect(rust.error).toBe("Unknown or invalid ref: deadbeef");
    expect(node.error).toBe(rust.error);
  });
});
