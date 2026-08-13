/**
 * useCommitReviewNav.ts
 *
 * Task 2 (v3.7.0) — finding-to-finding cycling across staged files. Port of
 * `usePrReviewNav.ts`'s `jumpToFinding` (`N`/`P` cycling the PR's
 * confidence-sorted findings, wrapping, switching file, scrolling into
 * view), adapted so the "file" being switched is a staged file in the
 * Changes view rather than a PR's diff sidebar — the host injects
 * `selectFile` instead of this composable owning a `selectedDiffFile` ref.
 */
import { ref, computed, nextTick, type ComputedRef, type Ref } from "vue";
import type { ReviewFinding } from "./usePrPreReview";
import type { CommitReviewAction } from "./commitReviewKeymap";

/** Lower rank = more severe, matching `CommitReviewModal.vue`'s sort. */
const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = { risk: 0, suggestion: 1, nit: 2 };

/** Severity-sorted (risk > suggestion > nit), then confidence descending —
 *  the single source of truth for "finding order" shared by the modal's
 *  list and this composable's `N`/`P` cycling, so what you see in the
 *  modal is exactly what `N`/`P` steps through. */
export function sortFindingsForReview(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return rankDiff !== 0 ? rankDiff : b.confidence - a.confidence;
  });
}

/** Minimal duck-typed handle for the mounted `DiffViewer` instance — just
 *  enough to scroll to a finding, without this composable depending on the
 *  component's full instance type. */
export interface CommitReviewDiffHandle {
  scrollToFinding(line: number, side: "LEFT" | "RIGHT"): void;
}

export interface UseCommitReviewNavOptions {
  /** The (unsorted) active findings — this composable sorts them itself so
   *  the cycling order always matches the modal's severity/confidence order. */
  findings: Ref<ReviewFinding[]>;
  /** Switch the selected file in the Changes view. Findings are index-scoped,
   *  so `staged` is always `true` here. */
  selectFile: (path: string, staged: boolean) => void;
  /** Ref to the mounted `DiffViewer` instance (or null before mount / when a
   *  non-diff view is showing). */
  diffHandle: Ref<CommitReviewDiffHandle | null>;
  /** Dismiss the finding at the cursor (session-only, class-normalized —
   *  same contract as `useCommitReview.dismiss`). */
  onDismiss: (id: string) => void;
  onHelp: () => void;
}

export interface UseCommitReviewNavResult {
  currentFindingIdx: Ref<number>;
  current: ComputedRef<ReviewFinding | null>;
  jumpToFinding: (delta: 1 | -1) => void;
  dismissCurrent: () => void;
  dispatch: (action: CommitReviewAction) => void;
}

export function useCommitReviewNav(opts: UseCommitReviewNavOptions): UseCommitReviewNavResult {
  /** -1 means "none yet" — the first `N` press lands on index 0 (or the
   *  last index on the first `P`). */
  const currentFindingIdx = ref(-1);

  const sortedFindings = computed(() => sortFindingsForReview(opts.findings.value));

  const current = computed<ReviewFinding | null>(() => sortedFindings.value[currentFindingIdx.value] ?? null);

  /** `N`/`P` — cycle through the severity/confidence-sorted findings list,
   *  wrapping around, switching file and scrolling to the finding's line. */
  function jumpToFinding(delta: 1 | -1) {
    const list = sortedFindings.value;
    if (!list.length) return;
    const base = currentFindingIdx.value === -1 ? (delta > 0 ? -1 : 0) : currentFindingIdx.value;
    const idx = ((base + delta) % list.length + list.length) % list.length;
    currentFindingIdx.value = idx;
    const target = list[idx];
    opts.selectFile(target.path, true);
    void nextTick(() => {
      opts.diffHandle.value?.scrollToFinding(target.line, target.side);
    });
  }

  /** `X` — dismiss the finding at the cursor. The list shrinks by one right
   *  after (session-only dismissal filters it out), so the cursor is
   *  clamped against the *post*-dismiss list — it must never land out of
   *  range (regression guard: an off-by-one here would point past the end
   *  of a shrunk list). */
  function dismissCurrent() {
    const before = sortedFindings.value;
    if (!before.length || currentFindingIdx.value === -1) return;
    const idxBefore = currentFindingIdx.value;
    const target = before[idxBefore];
    opts.onDismiss(target.id);
    const after = sortedFindings.value;
    currentFindingIdx.value = after.length === 0 ? -1 : Math.min(idxBefore, after.length - 1);
  }

  function dispatch(action: CommitReviewAction) {
    switch (action) {
      case "next-finding": jumpToFinding(1); break;
      case "prev-finding": jumpToFinding(-1); break;
      case "dismiss-finding": dismissCurrent(); break;
      case "help": opts.onHelp(); break;
      case "open-findings": break; // Not wired in this phase — reserved.
    }
  }

  return { currentFindingIdx, current, jumpToFinding, dismissCurrent, dispatch };
}
