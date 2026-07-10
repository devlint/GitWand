import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed, nextTick } from "vue";
import { usePrReviewNav, type DiffRowLike } from "../usePrReviewNav";
import type { GitDiff } from "../../utils/backend";
import type { ReviewFinding } from "../usePrPreReview";

function file(path: string, hunkCount: number): GitDiff {
  return {
    path,
    hunks: Array.from({ length: hunkCount }, (_, i) => ({
      header: `@@ hunk ${i} @@`, oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [],
    })),
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { id: "1", path: "a.ts", line: 1, side: "RIGHT", severity: "suggestion", confidence: 80, title: "t", detail: "", ...overrides };
}

describe("usePrReviewNav", () => {
  const scrollToHunk = vi.fn();
  const scrollToLine = vi.fn();
  const openComposeAtHunk = vi.fn();
  const onHelp = vi.fn();
  const onToggleViewed = vi.fn();
  const onSubmitReview = vi.fn();

  beforeEach(() => {
    scrollToHunk.mockReset();
    scrollToLine.mockReset();
    openComposeAtHunk.mockReset();
    onHelp.mockReset();
    onToggleViewed.mockReset();
    onSubmitReview.mockReset();
  });

  function setup(files: GitDiff[], selectedPath: string | null, findings: ReviewFinding[] = [], rows: DiffRowLike[] = []) {
    const prDiffFiles = ref(files);
    const selectedDiffFile = ref<string | null>(selectedPath);
    // Mirrors `PrDetailView`'s real `selectedDiff` — a computed derived from
    // `selectedDiffFile`, so switching files reactively updates the hunk
    // count `goToHunk`'s boundary-crossing reads (not a manually-set ref).
    const selectedDiff = computed<GitDiff | null>(
      () => prDiffFiles.value.find((f) => f.path === selectedDiffFile.value) ?? null,
    );
    const diffHandle = ref({ scrollToHunk, scrollToLine, openComposeAtHunk, rows });
    const hideViewed = ref(false);
    const submittingReview = ref(false);
    const findingsRef = ref(findings);
    const nav = usePrReviewNav({
      prDiffFiles, selectedDiffFile, selectedDiff, diffHandle, onHelp, onToggleViewed, hideViewed,
      onSubmitReview, submittingReview, findings: findingsRef,
    });
    return { nav, prDiffFiles, selectedDiffFile, selectedDiff, hideViewed, submittingReview, findingsRef };
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

  it("submit-review (⌘Enter) opens the review modal", () => {
    const { nav } = setup([file("a.ts", 1)], "a.ts");
    nav.dispatch("submit-review");
    expect(onSubmitReview).toHaveBeenCalledTimes(1);
  });

  it("submit-review is a no-op while a submit is already in flight", () => {
    const { nav, submittingReview } = setup([file("a.ts", 1)], "a.ts");
    submittingReview.value = true;
    nav.dispatch("submit-review");
    expect(onSubmitReview).not.toHaveBeenCalled();
  });

  it("next-finding (N) with no findings is a safe no-op", () => {
    const { nav } = setup([file("a.ts", 1)], "a.ts");
    expect(() => nav.dispatch("next-finding")).not.toThrow();
    expect(scrollToHunk).not.toHaveBeenCalled();
    expect(openComposeAtHunk).not.toHaveBeenCalled();
  });

  it("next-finding (N) lands on the first finding, switching file and scrolling to its row", async () => {
    const findings = [finding({ id: "1", path: "b.ts", line: 5 })];
    const rows = [{ kind: "line", dl: { type: "add", newLineNo: 5 } }];
    const { nav, selectedDiffFile } = setup([file("a.ts", 1), file("b.ts", 1)], "a.ts", findings, rows);
    nav.dispatch("next-finding");
    await nextTick();
    expect(selectedDiffFile.value).toBe("b.ts");
    expect(scrollToLine).toHaveBeenCalledWith(0);
    expect(nav.currentFindingIdx.value).toBe(0);
  });

  it("next-finding (N) then prev-finding (P) returns to the same finding", async () => {
    const findings = [finding({ id: "1", line: 1 }), finding({ id: "2", line: 2 })];
    const { nav } = setup([file("a.ts", 1)], "a.ts", findings, []);
    nav.dispatch("next-finding");
    await nextTick();
    expect(nav.currentFindingIdx.value).toBe(0);
    nav.dispatch("next-finding");
    await nextTick();
    expect(nav.currentFindingIdx.value).toBe(1);
    nav.dispatch("prev-finding");
    await nextTick();
    expect(nav.currentFindingIdx.value).toBe(0);
  });

  it("next-finding (N) wraps around past the last finding", async () => {
    const findings = [finding({ id: "1" }), finding({ id: "2" })];
    const { nav } = setup([file("a.ts", 1)], "a.ts", findings, []);
    nav.dispatch("next-finding");
    nav.dispatch("next-finding");
    await nextTick();
    nav.dispatch("next-finding");
    await nextTick();
    expect(nav.currentFindingIdx.value).toBe(0);
  });
});
