/**
 * GitWand — Tests sur le corpus de référence (Phase 7.5)
 *
 * Ce fichier sert à la fois de suite de régression (chaque fixture doit
 * continuer à produire le résultat attendu) et de générateur de métriques
 * (taux de résolution par type, par catégorie, faux positifs / négatifs).
 *
 * ## Métriques produites
 *
 * - Taux global d'auto-résolution
 * - Taux par ConflictType
 * - Faux positifs  : fixture avec expectedResolved=false mais résolue
 * - Faux négatifs  : fixture avec expectedResolved=true mais non résolue
 * - Score de confiance moyen par type
 */

import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "../resolver.js";
import { CORPUS, CORPUS_CATEGORIES, type CorpusFixture } from "./corpus.js";
import type { ConflictType } from "../types.js";

// ─── Helpers ───────────────────────────────────────────────

interface FixtureResult {
  fixture: CorpusFixture;
  actualType: ConflictType | undefined;
  actualResolved: boolean;
  actualScore: number | undefined;
  typeMatch: boolean;
  resolvedMatch: boolean;
  outputMatch: boolean | null; // null = pas vérifié
  falsePositive: boolean;
  falseNegative: boolean;
}

function runFixture(f: CorpusFixture): FixtureResult {
  const result = resolve(f.input, f.filePath, f.options ?? {});

  const actualType = result.hunks[0]?.type;
  const actualResolved = result.stats.autoResolved > 0;
  const actualScore = result.hunks[0]?.confidence.score;

  const typeMatch = actualType === f.expectedType;
  const resolvedMatch = actualResolved === f.expectedResolved;

  let outputMatch: boolean | null = null;
  if (f.expectedOutput !== undefined && f.expectedOutput !== null) {
    outputMatch = result.mergedContent === f.expectedOutput;
  } else if (f.expectedOutput === null) {
    outputMatch = result.mergedContent === null;
  }

  const falsePositive = !f.expectedResolved && actualResolved;
  const falseNegative = f.expectedResolved && !actualResolved;

  return {
    fixture: f,
    actualType,
    actualResolved,
    actualScore,
    typeMatch,
    resolvedMatch,
    outputMatch,
    falsePositive,
    falseNegative,
  };
}

// ─── Collecte globale pour les métriques ──────────────────

const allResults: FixtureResult[] = [];

// ─── Tests par fixture ────────────────────────────────────

describe("Corpus de référence — régression (Phase 7.5)", () => {
  describe("Trivial", () => {
    for (const fixture of CORPUS_CATEGORIES.trivial) {
      it(`${fixture.id}: ${fixture.description}`, () => {
        const r = runFixture(fixture);
        allResults.push(r);

        expect(r.actualType).toBe(fixture.expectedType);
        expect(r.actualResolved).toBe(fixture.expectedResolved);
        if (r.outputMatch !== null) {
          expect(r.outputMatch).toBe(true);
        }
        // Pas de faux positif toléré dans les cas triviaux
        expect(r.falsePositive).toBe(false);
      });
    }
  });

  describe("Structural", () => {
    for (const fixture of CORPUS_CATEGORIES.structural) {
      it(`${fixture.id}: ${fixture.description}`, () => {
        const r = runFixture(fixture);
        allResults.push(r);

        expect(r.actualType).toBe(fixture.expectedType);
        expect(r.actualResolved).toBe(fixture.expectedResolved);
        if (r.outputMatch !== null) {
          expect(r.outputMatch).toBe(true);
        }
      });
    }
  });

  describe("Semantic", () => {
    for (const fixture of CORPUS_CATEGORIES.semantic) {
      it(`${fixture.id}: ${fixture.description}`, () => {
        const r = runFixture(fixture);
        allResults.push(r);

        expect(r.actualType).toBe(fixture.expectedType);
        expect(r.actualResolved).toBe(fixture.expectedResolved);
      });
    }
  });

  describe("Format-aware", () => {
    for (const fixture of CORPUS_CATEGORIES["format-aware"]) {
      it(`${fixture.id}: ${fixture.description}`, () => {
        const r = runFixture(fixture);
        allResults.push(r);

        // Les résolveurs format-aware peuvent produire un type différent de la
        // classification textuelle → on vérifie seulement la résolution
        expect(r.actualResolved).toBe(fixture.expectedResolved);
      });
    }
  });

  describe("Complex", () => {
    for (const fixture of CORPUS_CATEGORIES.complex) {
      it(`${fixture.id}: ${fixture.description}`, () => {
        const r = runFixture(fixture);
        allResults.push(r);

        // Les conflits complexes ne doivent PAS être résolus automatiquement
        expect(r.actualResolved).toBe(false);
        expect(r.falsePositive).toBe(false);
        if (r.outputMatch !== null) {
          expect(r.outputMatch).toBe(true);
        }
      });
    }
  });
});

// ─── Métriques globales ───────────────────────────────────

describe("Métriques du corpus (Phase 7.5)", () => {
  it("taux global d'auto-résolution ≥ 60%", () => {
    const resolved = allResults.filter(r => r.actualResolved).length;
    const total = allResults.length;
    const rate = resolved / total;
    expect(rate).toBeGreaterThanOrEqual(0.6);
  });

  it("0 faux positif (complex non auto-résolu)", () => {
    const falsePositives = allResults.filter(r => r.falsePositive);
    expect(falsePositives).toHaveLength(0);
  });

  it("classification correcte ≥ 75% des fixtures", () => {
    const typeMatches = allResults.filter(r => r.typeMatch).length;
    const rate = typeMatches / allResults.length;
    expect(rate).toBeGreaterThanOrEqual(0.75);
  });

  it("score de confiance certain/high pour les cas triviaux résolus", () => {
    const trivialResolved = allResults.filter(
      r => r.fixture.category === "trivial" && r.actualResolved,
    );
    for (const r of trivialResolved) {
      const label = resolve(r.fixture.input, r.fixture.filePath, r.fixture.options ?? {})
        .hunks[0]?.confidence.label;
      expect(["certain", "high"]).toContain(label);
    }
  });

  // ─── Rapport console (affiché seulement si CORPUS_METRICS=1) ──
  afterAll(() => {
    if (process.env["CORPUS_METRICS"] !== "1") return;

    const total = allResults.length;
    const resolved = allResults.filter(r => r.actualResolved).length;
    const fps = allResults.filter(r => r.falsePositive).length;
    const fns = allResults.filter(r => r.falseNegative).length;

    // Par type
    const byType = new Map<ConflictType, { total: number; resolved: number; scores: number[] }>();
    for (const r of allResults) {
      const key = r.fixture.expectedType;
      if (!byType.has(key)) byType.set(key, { total: 0, resolved: 0, scores: [] });
      const entry = byType.get(key)!;
      entry.total++;
      if (r.actualResolved) entry.resolved++;
      if (r.actualScore !== undefined) entry.scores.push(r.actualScore);
    }

    console.log("\n┌─────────────────────────────────────────────────────────┐");
    console.log(`│  GitWand Corpus Metrics — ${total} fixtures                   │`);
    console.log("├─────────────────────────────────────────────────────────┤");
    console.log(`│  Auto-résolution : ${resolved}/${total} (${Math.round(resolved / total * 100)}%)                          │`);
    console.log(`│  Faux positifs   : ${fps}                                      │`);
    console.log(`│  Faux négatifs   : ${fns}                                      │`);
    console.log("├─────────────────────────────────────────────────────────┤");
    console.log("│  Par type :                                             │");
    for (const [type, entry] of [...byType].sort((a, b) => b[1].total - a[1].total)) {
      const rate = Math.round(entry.resolved / entry.total * 100);
      const avgScore = entry.scores.length
        ? Math.round(entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length)
        : 0;
      console.log(`│    ${type.padEnd(22)} ${String(entry.resolved).padStart(2)}/${entry.total}  (${String(rate).padStart(3)}%)  avg score: ${avgScore} │`);
    }
    console.log("└─────────────────────────────────────────────────────────┘\n");
  });
});
