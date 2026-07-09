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
  const onToggleViewed = vi.fn();

  beforeEach(() => {
    scrollToHunk.mockReset();
    openComposeAtHunk.mockReset();
    onHelp.mockReset();
    onToggleViewed.mockReset();
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
    const hideViewed = ref(false);
    const nav = usePrReviewNav({
      prDiffFiles, selectedDiffFile, selectedDiff, diffHandle, onHelp, onToggleViewed, hideViewed,
    });
    return { nav, prDiffFiles, selectedDiffFile, selectedDiff, hideViewed };
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

  it("toggle-viewed (V) calls onToggleViewed with the selected file's path", () => {
    const { nav } = setup([file("a.ts", 1)], "a.ts");
    nav.dispatch("toggle-viewed");
    expect(onToggleViewed).toHaveBeenCalledWith("a.ts");
  });

  it("toggle-viewed (V) is a no-op with no file selected", () => {
    const { nav } = setup([file("a.ts", 1)], null);
    nav.dispatch("toggle-viewed");
    expect(onToggleViewed).not.toHaveBeenCalled();
  });

  it("toggle-hide-viewed (⇧V) flips the hideViewed ref", () => {
    const { nav, hideViewed } = setup([file("a.ts", 1)], "a.ts");
    nav.dispatch("toggle-hide-viewed");
    expect(hideViewed.value).toBe(true);
    nav.dispatch("toggle-hide-viewed");
    expect(hideViewed.value).toBe(false);
  });

  it("unwired actions (B3/C4) are safe no-ops", () => {
    const { nav } = setup([file("a.ts", 1)], "a.ts");
    for (const action of ["submit-review", "next-finding", "prev-finding"] as const) {
      expect(() => nav.dispatch(action)).not.toThrow();
    }
    expect(scrollToHunk).not.toHaveBeenCalled();
    expect(openComposeAtHunk).not.toHaveBeenCalled();
  });
});
