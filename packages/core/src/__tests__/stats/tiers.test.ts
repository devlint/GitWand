/**
 * summarizeTiers() — "recoverable-before-model" metric (v2.7).
 *
 * Design: docs/superpowers/specs/2026-07-07-recoverable-before-model-metric-design.md §4.B
 *
 * Pure derived summary over `MergeStats.byType` — not a change to resolution
 * logic. Tiers:
 *   trivial              — same_change, delete_no_change, one_side_change,
 *                           non_overlapping, whitespace_only, reorder_only,
 *                           insertion_at_boundary, value_only_change, generated_file
 *   advancedDeterministic — refactoring_aware_merge, token_level_merge
 *   model                 — llm_proposed
 *   unresolved            — complex
 */

import { describe, it, expect } from "vitest";
import { summarizeTiers } from "../../stats/tiers.js";
import type { ConflictType } from "../../types.js";

/** Build a `byType` map with all ConflictTypes defaulted to 0, overridden by `counts`. */
function byType(counts: Partial<Record<ConflictType, number>>): Record<ConflictType, number> {
  const ALL: ConflictType[] = [
    "one_side_change", "same_change", "non_overlapping", "whitespace_only",
    "delete_no_change", "generated_file", "value_only_change", "reorder_only",
    "insertion_at_boundary", "token_level_merge", "llm_proposed",
    "refactoring_aware_merge", "complex",
  ];
  const base = Object.fromEntries(ALL.map((t) => [t, 0])) as Record<ConflictType, number>;
  return { ...base, ...counts };
}

describe("summarizeTiers — mapping des tiers", () => {
  it("classe les types triviaux dans 'trivial'", () => {
    const s = summarizeTiers(byType({
      same_change: 3, delete_no_change: 1, one_side_change: 2, non_overlapping: 1,
      whitespace_only: 1, reorder_only: 1, insertion_at_boundary: 1, value_only_change: 1,
      generated_file: 1,
    }));
    expect(s.byTier.trivial).toBe(12);
    expect(s.byTier.advancedDeterministic).toBe(0);
    expect(s.byTier.model).toBe(0);
    expect(s.byTier.unresolved).toBe(0);
  });

  it("classe refactoring_aware_merge et token_level_merge dans 'advancedDeterministic'", () => {
    const s = summarizeTiers(byType({ refactoring_aware_merge: 2, token_level_merge: 3 }));
    expect(s.byTier.advancedDeterministic).toBe(5);
  });

  it("classe llm_proposed dans 'model'", () => {
    const s = summarizeTiers(byType({ llm_proposed: 4 }));
    expect(s.byTier.model).toBe(4);
  });

  it("classe complex dans 'unresolved'", () => {
    const s = summarizeTiers(byType({ complex: 7 }));
    expect(s.byTier.unresolved).toBe(7);
  });
});

describe("summarizeTiers — calcul residual / aiReachable / recoverableBeforeModel", () => {
  it("residual = advancedDeterministic + model + unresolved (exclut trivial)", () => {
    const s = summarizeTiers(byType({
      same_change: 100, // trivial — hors résidu
      refactoring_aware_merge: 3,
      token_level_merge: 2,
      llm_proposed: 4,
      complex: 1,
    }));
    expect(s.residual).toBe(10); // 3 + 2 + 4 + 1
  });

  it("aiReachable = model + unresolved", () => {
    const s = summarizeTiers(byType({ llm_proposed: 4, complex: 1, refactoring_aware_merge: 3 }));
    expect(s.aiReachable).toBe(5);
  });

  it("recoverableBeforeModel = advancedDeterministic / residual", () => {
    const s = summarizeTiers(byType({
      refactoring_aware_merge: 6,
      token_level_merge: 5, // advancedDeterministic = 11
      llm_proposed: 6,
      complex: 5, // aiReachable = 11 → residual = 22
    }));
    expect(s.recoverableBeforeModel).toBeCloseTo(11 / 22, 10);
  });

  it("residual === 0 → recoverableBeforeModel vaut 0 (pas NaN/Infinity)", () => {
    const s = summarizeTiers(byType({ same_change: 5 })); // tout trivial, rien dans le résidu
    expect(s.residual).toBe(0);
    expect(s.recoverableBeforeModel).toBe(0);
    expect(Number.isNaN(s.recoverableBeforeModel)).toBe(false);
  });

  it("byType vide (aucun conflit) → tout à 0, pas de crash", () => {
    const s = summarizeTiers(byType({}));
    expect(s.byTier).toEqual({ trivial: 0, advancedDeterministic: 0, model: 0, unresolved: 0 });
    expect(s.residual).toBe(0);
    expect(s.aiReachable).toBe(0);
    expect(s.recoverableBeforeModel).toBe(0);
  });

  it("types absents de byType sont traités comme 0 (pas de crash sur objet partiel)", () => {
    const partial = { same_change: 2 } as Record<ConflictType, number>;
    const s = summarizeTiers(partial);
    expect(s.byTier.trivial).toBe(2);
    expect(s.residual).toBe(0);
  });
});
