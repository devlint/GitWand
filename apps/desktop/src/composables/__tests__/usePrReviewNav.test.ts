import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed, nextTick } from "vue";
import { usePrReviewNav } from "../usePrReviewNav";
import type { GitDiff } from "../../utils/backend";

function file(path: string, hunkCount: number): GitDiff {
  return {
    path,
    hunks: Array.from({ length: hunkCount }, (_, i) => ({
      header: `@@ hunk ${i} @@`, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [],
    })),
  };
}

describe("usePrReviewNav", () => {
  const scrollToHunk = vi.fn();
  const openComposeAtHunk = vi.fn();
  const onHelp = vi.fn();

  beforeEach(() => {
    scrollToHunk.mockReset();
    openComposeAtHunk.mockReset();
    onHelp.mockReset();
  });

  function setup(files: GitDiff[], selectedPath: string | null) {
    const prDiffFiles = ref(files);
    const selectedDiffFile = ref<string | null>(selectedPath);
    // Mirrors `PrDetailView`'s real `selectedDiff` — a computed derived from
    // `selectedDiffFile`, so switching files reactively updates the hunk
    // count `goToHunk`'s boundary-crossing reads (not a manually-set ref).
    const selectedDiff = computed<GitDiff | null>(
      () => prDiffFiles.value.find((f) => f.path === selectedDiffFile.value) ?? null,
    );
    const diffHandle = ref({ scrollToHunk, openComposeAtHunk });
    const nav = usePrReviewNav({ prDiffFiles, selectedDiffFile, selectedDiff, diffHandle, onHelp });
    return { nav, prDiffFiles, selectedDiffFile, selectedDiff };
  }

  it("next-hunk advances the cursor within the file and scrolls to it", () => {
    const { nav } = setup([file("a.ts", 3)], "a.ts");
    nav.dispatch("next-hunk");
    expect(nav.currentHunkIdx.value).toBe(1);
    expect(scrollToHunk).toHaveBeenCalledWith(1);
  });

  it("prev-hunk at the first hunk crosses into the previous file's last hunk", async () => {
    const { nav, selectedDiffFile } = setup([file("a.ts", 2), file("b.ts", 3)], "b.ts");
    nav.dispatch("prev-hunk");
    await nextTick();
    expect(selectedDiffFile.value).toBe("a.ts");
    await nextTick();
    expect(nav.currentHunkIdx.value).toBe(1); // last hunk of a.ts (0-indexed, count 2)
    expect(scrollToHunk).toHaveBeenCalledWith(1);
  });

  it("next-file (⇧J) wraps around and resets the hunk cursor", () => {
    const { nav, selectedDiffFile } = setup([file("a.ts", 1), file("b.ts", 1)], "b.ts");
    nav.currentHunkIdx.value = 5;
    nav.dispatch("next-file");
    expect(selectedDiffFile.value).toBe("a.ts");
    expect(nav.currentHunkIdx.value).toBe(0);
  });

  it("comment-hunk opens the compose box at the current hunk", () => {
    const { nav } = setup([file("a.ts", 2)], "a.ts");
    nav.dispatch("comment-hunk");
    expect(openComposeAtHunk).toHaveBeenCalledWith(0);
  });

  it("help calls the onHelp callback", () => {
    const { nav } = setup([file("a.ts", 1)], "a.ts");
    nav.dispatch("help");
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it("unwired actions (B2/B3/C4) are safe no-ops", () => {
    const { nav } = setup([file("a.ts", 1)], "a.ts");
    for (const action of ["toggle-viewed", "toggle-hide-viewed", "submit-review", "next-finding", "prev-finding"] as const) {
      expect(() => nav.dispatch(action)).not.toThrow();
    }
    expect(scrollToHunk).not.toHaveBeenCalled();
    expect(openComposeAtHunk).not.toHaveBeenCalled();
  });
});
