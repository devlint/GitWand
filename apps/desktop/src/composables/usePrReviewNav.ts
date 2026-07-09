/**
 * usePrReviewNav.ts
 *
 * Keyboard-nav dispatch for the PR review Diff tab (B1, v3.6.0) — extracted
 * out of `PrDetailView.vue` so the hunk/file cursor logic is unit-testable
 * without mounting the (very large) host component, per AGENTS.md's
 * "business logic belongs in composables" rule.
 *
 * The host still owns the `keydown` listener and `resolvePrReviewShortcut`
 * call (focus-guarding, `preventDefault`); this composable only reacts to
 * the resolved `PrReviewAction`.
 */
import { ref, nextTick, type Ref } from "vue";
import type { GitDiff } from "../utils/backend";
import type { PrReviewAction } from "./usePrReviewKeymap";

export interface PrInlineDiffHandle {
  scrollToHunk(hunkIdx: number): void;
  openComposeAtHunk(hunkIdx: number): void;
}

export interface UsePrReviewNavOptions {
  prDiffFiles: Ref<GitDiff[]>;
  selectedDiffFile: Ref<string | null>;
  /** The currently-selected file's parsed diff (hunks), or null. */
  selectedDiff: Ref<GitDiff | null>;
  /** Ref to the mounted `PrInlineDiff` instance (or null before mount). */
  diffHandle: Ref<PrInlineDiffHandle | null>;
  onHelp: () => void;
  /** B2 — toggle the current file's viewed state / the hide-viewed filter. */
  onToggleViewed: (path: string) => void;
  hideViewed: Ref<boolean>;
  /** B3 — `⌘Enter` opens the review modal (never submits directly — the
   *  event/body choice still lives in `PrReviewModal`). No-op mid-submit. */
  onSubmitReview: () => void;
  submittingReview: Ref<boolean>;
}

export function usePrReviewNav(opts: UsePrReviewNavOptions) {
  /** Which hunk `J`/`K` currently point at, in the selected file. */
  const currentHunkIdx = ref(0);

  function currentFileIndex(): number {
    return opts.prDiffFiles.value.findIndex((f) => f.path === opts.selectedDiffFile.value);
  }

  /** `⇧J`/`⇧K` — move to the next/prev file in the sidebar, wrapping around. */
  function goToFile(delta: 1 | -1) {
    const files = opts.prDiffFiles.value;
    if (!files.length) return;
    const idx = currentFileIndex();
    const next = ((idx === -1 ? 0 : idx) + delta + files.length) % files.length;
    opts.selectedDiffFile.value = files[next].path;
    currentHunkIdx.value = 0;
  }

  /** `J`/`K` — move to the next/prev hunk, crossing into the next/prev file
   *  once past the last/first hunk of the current one (per spec B1). */
  function goToHunk(delta: 1 | -1) {
    const hunkCount = opts.selectedDiff.value?.hunks.length ?? 0;
    if (!hunkCount) {
      goToFile(delta);
      return;
    }
    const next = currentHunkIdx.value + delta;
    if (next < 0 || next >= hunkCount) {
      goToFile(delta);
      nextTick(() => {
        const newCount = opts.selectedDiff.value?.hunks.length ?? 0;
        currentHunkIdx.value = delta > 0 ? 0 : Math.max(0, newCount - 1);
        opts.diffHandle.value?.scrollToHunk(currentHunkIdx.value);
      });
      return;
    }
    currentHunkIdx.value = next;
    opts.diffHandle.value?.scrollToHunk(next);
  }

  /**
   * Dispatch a resolved PR-review action. `next-finding` / `prev-finding`
   * (C4) are wired by that task — until then they are safe no-ops rather
   * than throwing on an unmapped case.
   */
  function dispatch(action: PrReviewAction) {
    switch (action) {
      case "next-hunk": goToHunk(1); break;
      case "prev-hunk": goToHunk(-1); break;
      case "next-file": goToFile(1); break;
      case "prev-file": goToFile(-1); break;
      case "comment-hunk": opts.diffHandle.value?.openComposeAtHunk(currentHunkIdx.value); break;
      case "help": opts.onHelp(); break;
      case "toggle-viewed":
        if (opts.selectedDiffFile.value) opts.onToggleViewed(opts.selectedDiffFile.value);
        break;
      case "toggle-hide-viewed":
        opts.hideViewed.value = !opts.hideViewed.value;
        break;
      case "submit-review":
        if (!opts.submittingReview.value) opts.onSubmitReview();
        break;
      case "next-finding":
      case "prev-finding":
        break; // wired by C4
    }
  }

  return { currentHunkIdx, goToFile, goToHunk, dispatch };
}
