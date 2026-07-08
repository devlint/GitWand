/**
 * useTierStats — agrégat LOCAL cumulatif de la métrique recoverable-before-model.
 *
 * Ferme la question §9.4 du design doc recoverable-before-model : agrégation
 * à travers les résolutions, 100 % locale (localStorage) — pas de réseau,
 * la télémétrie Aptabase étant bloquée par le crash tokio upstream.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTierStats, __resetTierStatsForTests } from "../useTierStats";
import type { MergeStats } from "@gitwand/core";

function stats(byType: Partial<Record<string, number>>, total?: number): MergeStats {
  const totalConflicts = total ?? Object.values(byType).reduce((a: number, b) => a + (b ?? 0), 0);
  return {
    totalConflicts,
    autoResolved: 0,
    remaining: totalConflicts,
    byType: byType as MergeStats["byType"],
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetTierStatsForTests();
});

describe("useTierStats : accumulation", () => {
  it("accumule byType à travers plusieurs fichiers", () => {
    const ts = useTierStats();
    ts.recordFile("/repo", "a.ts", stats({ complex: 2, non_overlapping: 1 }));
    ts.recordFile("/repo", "b.ts", stats({ token_level_merge: 3 }));

    expect(ts.tierStats.value.filesRecorded).toBe(2);
    expect(ts.tierStats.value.totalHunks).toBe(6);
    expect(ts.tierStats.value.tiers.byTier.unresolved).toBe(2);
    expect(ts.tierStats.value.tiers.byTier.advancedDeterministic).toBe(3);
  });

  it("ignore les fichiers sans conflit", () => {
    const ts = useTierStats();
    ts.recordFile("/repo", "clean.ts", stats({}, 0));
    expect(ts.tierStats.value.filesRecorded).toBe(0);
  });

  it("calcule recoverable-before-model via summarizeTiers", () => {
    const ts = useTierStats();
    ts.recordFile("/repo", "a.ts", stats({ token_level_merge: 1, complex: 1 }));
    expect(ts.tierStats.value.tiers.recoverableBeforeModel).toBeCloseTo(0.5, 5);
  });
});

describe("useTierStats : déduplication", () => {
  it("le même fichier avec la même signature n'est compté qu'une fois (refresh)", () => {
    const ts = useTierStats();
    const s = stats({ complex: 2 });
    ts.recordFile("/repo", "a.ts", s);
    ts.recordFile("/repo", "a.ts", s); // refresh de loadRealFiles
    expect(ts.tierStats.value.filesRecorded).toBe(1);
    expect(ts.tierStats.value.totalHunks).toBe(2);
  });

  it("le même fichier avec une signature différente est recompté (nouveau conflit)", () => {
    const ts = useTierStats();
    ts.recordFile("/repo", "a.ts", stats({ complex: 2 }));
    ts.recordFile("/repo", "a.ts", stats({ complex: 1, same_change: 1 }));
    expect(ts.tierStats.value.filesRecorded).toBe(2);
  });
});

describe("useTierStats : persistence localStorage", () => {
  it("persiste et recharge l'agrégat", () => {
    const ts = useTierStats();
    ts.recordFile("/repo", "a.ts", stats({ complex: 4 }));

    __resetTierStatsForTests({ keepStorage: true }); // simule un redémarrage d'app
    const ts2 = useTierStats();
    expect(ts2.tierStats.value.totalHunks).toBe(4);
    expect(ts2.tierStats.value.since).not.toBeNull();
  });

  it("reset() vide l'agrégat et le storage", () => {
    const ts = useTierStats();
    ts.recordFile("/repo", "a.ts", stats({ complex: 4 }));
    ts.reset();
    expect(ts.tierStats.value.totalHunks).toBe(0);
    expect(ts.tierStats.value.filesRecorded).toBe(0);

    __resetTierStatsForTests({ keepStorage: true });
    expect(useTierStats().tierStats.value.totalHunks).toBe(0);
  });

  it("survit à un localStorage corrompu", () => {
    localStorage.setItem("gitwand-tier-stats", "{not json");
    __resetTierStatsForTests({ keepStorage: true });
    const ts = useTierStats();
    expect(ts.tierStats.value.totalHunks).toBe(0);
    ts.recordFile("/repo", "a.ts", stats({ complex: 1 }));
    expect(ts.tierStats.value.totalHunks).toBe(1);
  });
});
