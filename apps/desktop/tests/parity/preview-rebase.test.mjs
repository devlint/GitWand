/**
 * Parity tests: `preview_rebase` (Rust) vs `/api/preview-rebase` (dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * `previewRebase` had no dev-server route at all before v3.11.0: the wrapper
 * was a Tauri-only stub returning `[]`, so under `pnpm dev:web` a rebase
 * preview always looked clean.
 *
 * The interesting part of this command is the deduplication. A rebase replays
 * each commit separately, so a file touched by several commits in the stack
 * yields several entries; they collapse to one per path, keeping the strongest
 * conflict signal (add/delete > conflicted > clean). The fixture's `shared.txt`
 * is edited by two of the three topic commits precisely to exercise that.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixturePreviewRebase } from "./fixtures.mjs";

async function nodePreviewRebase(dev, cwd, onto) {
  const res = await dev.fetch("/api/preview-rebase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, onto }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

describe("parity: preview-rebase", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  /** @type {string} */
  let cwd;

  beforeAll(async () => {
    dev = await startDevServer();
    cwd = fixturePreviewRebase();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("both backends return byte-identical previews", async () => {
    const rust = runProbe("preview-rebase", { cwd, onto: "main" });
    const node = await nodePreviewRebase(dev, cwd, "main");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(node.value).toEqual(rust.value);
  });

  it("a file touched by two replayed commits appears exactly once", async () => {
    const rust = runProbe("preview-rebase", { cwd, onto: "main" });
    const node = await nodePreviewRebase(dev, cwd, "main");

    for (const [label, side] of [["rust", rust.value], ["node", node.value]]) {
      const hits = side.filter((p) => p.file_path === "shared.txt");
      expect(hits.length, `${label} deduplicated shared.txt`).toBe(1);
      expect(hits[0].has_conflicts, `${label} kept the conflict signal`).toBe(true);
    }
  });

  it("markers are labelled on both sides", async () => {
    const rust = runProbe("preview-rebase", { cwd, onto: "main" });
    const node = await nodePreviewRebase(dev, cwd, "main");

    for (const [label, side] of [["rust", rust.value], ["node", node.value]]) {
      const content = side.find((p) => p.file_path === "shared.txt").conflict_content;
      expect(content, `${label} ours label`).toContain("<<<<<<< ours");
      expect(content, `${label} theirs label`).toContain(">>>>>>> theirs");
      expect(content, `${label} leaked a scratch filename`).not.toMatch(/\.tmp\b/);
    }
  });

  it("an unknown onto ref is refused identically by both sides", async () => {
    const rust = runProbe("preview-rebase", { cwd, onto: "no-such-ref" });
    const node = await nodePreviewRebase(dev, cwd, "no-such-ref");

    expect(rust.ok, "rust accepted an unknown ref").toBe(false);
    expect(node.ok, "node accepted an unknown ref").toBe(false);
    // The wording is part of the contract: callers surface it verbatim.
    expect(rust.error).toBe("Unknown or invalid ref: no-such-ref");
    expect(node.error).toBe(rust.error);
  });
});
