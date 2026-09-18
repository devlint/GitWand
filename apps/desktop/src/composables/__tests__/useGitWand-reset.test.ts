// @vitest-environment jsdom
//
// `useGitWand` reaches modules that read `window` at import time, so the
// default `node` environment cannot load it (repo convention: opt in
// per-file — apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * useGitWand.reset() — clearing resolution state once the merge it belonged to
 * is gone. See docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md
 * §3.5: without it, `canUndo` stays true after a successful abort and points at
 * resolutions for a merge that no longer exists.
 */
import { describe, it, expect } from "vitest";

import { useGitWand } from "../useGitWand";

const CONFLICTED = [
  "line one",
  "<<<<<<< HEAD",
  "ours",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "line last",
  "",
].join("\n");

/**
 * A composable seeded the way a half-resolved merge leaves it: one conflicted
 * file, one hunk already resolved. `resolveHunkManual` is what pushes the undo
 * snapshot, and it touches no backend — it rewrites `files` in memory — so
 * `canUndo` here is true for the same reason it is true in the app.
 */
async function seededGitWand() {
  const gw = useGitWand();
  (gw.files as any).value = [
    {
      path: "a.txt",
      content: CONFLICTED,
      result: { resolutions: [], mergedContent: CONFLICTED },
    },
  ];
  await gw.resolveHunkManual("a.txt", 0, "ours");
  return gw;
}

describe("useGitWand.reset", () => {
  it("clears files, the selection and both history stacks", async () => {
    const gw = await seededGitWand();
    gw.selectFile("a.txt");
    expect(gw.files.value.length).toBe(1);
    expect(gw.canUndo.value).toBe(true);

    gw.reset();

    expect(gw.files.value).toEqual([]);
    expect(gw.selectedFile.value).toBeNull();
    expect(gw.canUndo.value).toBe(false);
    expect(gw.canRedo.value).toBe(false);
  });

  it("clears the redo stack too", async () => {
    const gw = await seededGitWand();
    gw.undo();
    expect(gw.canRedo.value).toBe(true);

    gw.reset();

    expect(gw.canRedo.value).toBe(false);
  });

  it("is safe to call on an already-empty state", () => {
    const gw = useGitWand();
    gw.reset();
    gw.reset();

    expect(gw.files.value).toEqual([]);
    expect(gw.canUndo.value).toBe(false);
  });
});
