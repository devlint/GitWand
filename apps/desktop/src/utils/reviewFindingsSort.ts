/**
 * reviewFindingsSort.ts
 *
 * Pure sort order for Commit Review findings — severity-sorted (risk >
 * suggestion > nit), then confidence descending. The single source of
 * truth for "finding order" shared by `CommitReviewModal.vue`'s list,
 * `useCommitReviewNav`'s `N`/`P` cycling cursor, and `reviewFixPrompt.ts`'s
 * agent-prompt ordering, so all three always agree.
 *
 * Lives in `utils/` (not `composables/`) — mirrors Task 0's
 * `unifiedDiff.ts`/`editableTarget.ts` precedent: a pure, Vue-free,
 * backend-free module so `utils/reviewFixPrompt.ts` (also pure) doesn't
 * have to import from `composables/` to get it (verifier low-priority item
 * — utils importing from composables inverts the established dependency
 * direction). `useCommitReviewNav.ts` re-exports it verbatim for back-compat.
 */
import type { ReviewFinding } from "../composables/usePrPreReview";

/** Lower rank = more severe. */
const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = { risk: 0, suggestion: 1, nit: 2 };

export function sortFindingsForReview(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return rankDiff !== 0 ? rankDiff : b.confidence - a.confidence;
  });
}
