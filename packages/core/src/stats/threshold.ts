/**
 * v3.11.0 — "would this hunk apply at threshold X?", answered without
 * re-running the engine.
 *
 * Design: docs/superpowers/specs/2026-09-12-v3.11.0-preview-to-apply-design.md §3.4
 *
 * Why this exists rather than an exported `resolveHunk`: `resolveHunk` takes
 * `Required<GitWandOptions>` plus a generated-file probe, and it sits *inside*
 * the orchestration that provides the v3.9 guarantees (the file-frequency
 * penalty, `reclassifyIfGenerated`, the invariant-violation retraction, and
 * `resolveAsync`'s parse-tree retraction). Exporting it would invite callers
 * to reimplement all of that, badly.
 *
 * Everything needed to answer the threshold question is already present in a
 * `MergeResult` the caller has in hand, so this is a pure read over it. That
 * matters for the desktop: an interactive confidence control re-filters on
 * every tick, and re-running `resolve()` per tick is not viable.
 *
 * The agreement with the engine is not a coincidence to be maintained by
 * hand, it is structural. `minConfidenceScore` is ANDed with the label gate
 * and can only ever subtract, so:
 *
 *     engine applies at X   <=>   engine applies at 0   AND   score >= X
 *
 * `wouldApplyAtThreshold` is exactly the right-hand side, reading
 * `autoResolved` (which already encodes "applies with the bar off"). The
 * equivalence is pinned by `__tests__/threshold-query.test.ts`.
 */

import type { HunkResolution, MergeResult } from "../types.js";

/**
 * Would this already-computed resolution still be applied with a numeric
 * confidence bar of `minScore`?
 *
 * Reads `autoResolved`, so every reason the engine declined a hunk (policy,
 * label gate, `assembleResolution` returning null for `complex` /
 * `token_level_merge` / `generated_file` / `llm_proposed`) is already
 * accounted for. A bar of 0 is therefore exactly the engine's own verdict.
 */
export function wouldApplyAtThreshold(r: HunkResolution, minScore: number): boolean {
  return (
    r.autoResolved && r.resolvedLines !== null && r.hunk.confidence.score >= minScore
  );
}

export interface ThresholdSummary {
  /** Resolutions that still apply at this bar. */
  applied: number;
  /** Resolutions the engine would have applied, held back by the bar alone. */
  heldByThreshold: number;
  /** Resolutions the engine already declined, whatever the bar. */
  manual: number;
}

/**
 * Split a `MergeResult`'s resolutions three ways at a given bar.
 *
 * `heldByThreshold` is the number the UI needs in order to say something
 * honest: it is the cost of the bar, not the size of the problem.
 */
export function summarizeAtThreshold(
  result: MergeResult,
  minScore: number,
): ThresholdSummary {
  let applied = 0;
  let heldByThreshold = 0;
  let manual = 0;

  for (const r of result.resolutions) {
    const engineApplied = r.autoResolved && r.resolvedLines !== null;
    if (!engineApplied) {
      manual++;
    } else if (wouldApplyAtThreshold(r, minScore)) {
      applied++;
    } else {
      heldByThreshold++;
    }
  }

  return { applied, heldByThreshold, manual };
}
