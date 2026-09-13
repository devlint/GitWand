/**
 * Parity tests: `preview_merge` (Rust) vs `/api/preview-merge` (dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * Why this file exists:
 *
 * Until v3.11.0 the dev-server had no route for any of the three Conflict
 * Predictor commands. `previewMerge` POSTed to a path that did not exist and
 * swallowed the failure into `[]`; `previewRebase` and `previewCherryPick`
 * were Tauri-only stubs that returned `[]` outright. So under `pnpm dev:web`,
 * the environment used for manual QA, the predictor reported every merge as
 * conflict-free. Not drift between two implementations: one of them was absent.
 *
 * These tests also pin two real bugs fixed alongside the routes. The scratch
 * files `git merge-file` reads were named after the file path in the shared
 * temp dir, so two previews at once raced on the same three files; and the
 * merge was run without `-L`, so the absolute scratch path leaked into the
 * conflict markers the user reads.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixturePreviewMerge } from "./fixtures.mjs";

/** POST /api/preview-merge in the {ok, value, error} shape runProbe returns. */
async function nodePreviewMerge(dev, cwd, sourceBranch) {
  const res = await dev.fetch("/api/preview-merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, sourceBranch }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

/** Find one file's entry, failing loudly when the preview omitted it. */
function entry(previews, path) {
  const found = previews.find((p) => p.file_path === path);
  if (!found) throw new Error(`no preview entry for ${path} in ${previews.map((p) => p.file_path).join(", ")}`);
  return found;
}

describe("parity: preview-merge", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  /** @type {string} */
  let cwd;

  beforeAll(async () => {
    dev = await startDevServer();
    cwd = fixturePreviewMerge();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("both backends return byte-identical previews for the whole merge", async () => {
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "topic" });
    const node = await nodePreviewMerge(dev, cwd, "topic");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    // Ordering is part of the contract: conflicts first, then path.
    expect(node.value).toEqual(rust.value);
  });

  it("a file modified on one side only is reported clean", async () => {
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "topic" });
    const node = await nodePreviewMerge(dev, cwd, "topic");

    for (const side of [rust.value, node.value]) {
      const own = entry(side, "topic-only.txt");
      expect(own.has_conflicts).toBe(false);
      expect(own.is_add_delete).toBe(false);
      expect(own.conflict_content).toBe("");
    }
  });

  it("a both-modified file conflicts with identical content on both sides", async () => {
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "topic" });
    const node = await nodePreviewMerge(dev, cwd, "topic");

    const r = entry(rust.value, "shared.txt");
    const n = entry(node.value, "shared.txt");
    expect(r.has_conflicts).toBe(true);
    expect(n.has_conflicts).toBe(true);
    expect(n.conflict_content).toBe(r.conflict_content);
    expect(r.conflict_content).toContain("main line");
    expect(r.conflict_content).toContain("topic line");
  });

  it("conflict markers are labelled and leak no scratch path", async () => {
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "topic" });
    const node = await nodePreviewMerge(dev, cwd, "topic");

    for (const [label, side] of [["rust", rust.value], ["node", node.value]]) {
      const content = entry(side, "shared.txt").conflict_content;
      expect(content, `${label} ours label`).toContain("<<<<<<< ours");
      expect(content, `${label} base label`).toContain("||||||| base");
      expect(content, `${label} theirs label`).toContain(">>>>>>> theirs");
      // The old bug: markers read `<<<<<<< /var/folders/.../shared_txt_ours.tmp`.
      expect(content, `${label} leaked a scratch filename`).not.toMatch(/\.tmp\b/);
      expect(content, `${label} leaked a scratch dir`).not.toMatch(/gitwand-preview/);
    }
  });

  it("a file added on one side and deleted on the other is add/delete", async () => {
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "topic" });
    const node = await nodePreviewMerge(dev, cwd, "topic");

    const r = entry(rust.value, "doomed.txt");
    const n = entry(node.value, "doomed.txt");
    expect(r.is_add_delete).toBe(true);
    expect(n.is_add_delete).toBe(true);
    expect(r.has_conflicts).toBe(true);
    expect(n.has_conflicts).toBe(true);
  });

  it("paths that mangle to the same scratch prefix stay independent", async () => {
    // `a/b.ts` and `a.b.ts` both became `a_b_ts` under the old naming scheme.
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "topic" });
    const node = await nodePreviewMerge(dev, cwd, "topic");

    for (const [label, side] of [["rust", rust.value], ["node", node.value]]) {
      const slashed = entry(side, "a/b.ts").conflict_content;
      const dotted = entry(side, "a.b.ts").conflict_content;
      expect(slashed, `${label} a/b.ts`).toContain("slashed");
      expect(slashed, `${label} a/b.ts bled from a.b.ts`).not.toContain("dotted");
      expect(dotted, `${label} a.b.ts`).toContain("dotted");
      expect(dotted, `${label} a.b.ts bled from a/b.ts`).not.toContain("slashed");
    }
  });

  it("concurrent previews do not read each other's scratch files", async () => {
    // Two independent repos, same paths, previewed at the same time. Before the
    // per-call scratch directory this returned a merge assembled from both.
    const a = fixturePreviewMerge();
    const b = fixturePreviewMerge();
    const results = await Promise.all([
      nodePreviewMerge(dev, a, "topic"),
      nodePreviewMerge(dev, b, "topic"),
      nodePreviewMerge(dev, a, "topic"),
      nodePreviewMerge(dev, b, "topic"),
    ]);
    for (const r of results) {
      expect(r.ok, `concurrent preview failed: ${r.error}`).toBe(true);
      const content = entry(r.value, "shared.txt").conflict_content;
      expect(content).toContain("<<<<<<< ours");
      expect(content).toContain("main line");
      expect(content).toContain("topic line");
    }
  });

  it("an unknown source branch is refused by both sides", async () => {
    const rust = runProbe("preview-merge", { cwd, sourceBranch: "no-such-branch" });
    const node = await nodePreviewMerge(dev, cwd, "no-such-branch");

    expect(rust.ok, "rust accepted an unknown branch").toBe(false);
    expect(node.ok, "node accepted an unknown branch").toBe(false);
    expect(node.error).toBe(rust.error);
  });
});
