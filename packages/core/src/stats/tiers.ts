/**
 * "Recoverable-before-model" metric (v2.7).
 *
 * Design: docs/superpowers/specs/2026-07-07-recoverable-before-model-metric-design.md §4.B
 *
 * Pure, derived summary over `MergeStats.byType` — NOT a change to resolution
 * logic. Answers: of the residual left after the cheap deterministic passes,
 * how much is still recoverable deterministically before the model is ever
 * invoked?
 *
 * Parity note (critical): these fields must NOT be added to `MergeStats` —
 * that struct is compared by the Rust↔TS parity-probe. `summarizeTiers` stays
 * a TS-side derived helper consumed separately by CLI/desktop/MCP.
 */

import type { ConflictType } from "../types.js";

export type ResolutionTier = "trivial" | "advancedDeterministic" | "model" | "unresolved";

export interface TierSummary {
  byTier: Record<ResolutionTier, number>;
  /** advancedDeterministic + model + unresolved — everything past the cheap trivial passes. */
  residual: number;
  /** model + unresolved — the bucket a new deterministic pattern must shrink. */
  aiReachable: number;
  /** advancedDeterministic / residual, 0 when residual === 0 (never NaN/Infinity). */
  recoverableBeforeModel: number;
}

/**
 * ConflictType → tier. Exhaustive over the `ConflictType` union — a future
 * addition to that union fails to compile here until classified.
 *
 * `token_level_merge` sits in `advancedDeterministic` even though it never
 * auto-applies without user confirmation (see packages/core/CLAUDE.md) —
 * "recoverable deterministically" means "doesn't need the model", not
 * "applied without a human in the loop".
 */
const TIER_BY_TYPE: Record<ConflictType, ResolutionTier> = {
  same_change: "trivial",
  delete_no_change: "trivial",
  one_side_change: "trivial",
  non_overlapping: "trivial",
  whitespace_only: "trivial",
  reorder_only: "trivial",
  insertion_at_boundary: "trivial",
  value_only_change: "trivial",
  generated_file: "trivial",
  refactoring_aware_merge: "advancedDeterministic",
  token_level_merge: "advancedDeterministic",
  llm_proposed: "model",
  complex: "unresolved",
};

export function summarizeTiers(byType: Record<ConflictType, number>): TierSummary {
  const byTier: Record<ResolutionTier, number> = {
    trivial: 0,
    advancedDeterministic: 0,
    model: 0,
    unresolved: 0,
  };

  for (const [type, tier] of Object.entries(TIER_BY_TYPE) as [ConflictType, ResolutionTier][]) {
    byTier[tier] += byType[type] ?? 0;
  }

  const residual = byTier.advancedDeterministic + byTier.model + byTier.unresolved;
  const aiReachable = byTier.model + byTier.unresolved;
  const recoverableBeforeModel = residual === 0 ? 0 : byTier.advancedDeterministic / residual;

  return { byTier, residual, aiReachable, recoverableBeforeModel };
}
