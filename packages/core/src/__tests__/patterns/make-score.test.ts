/**
 * Tests directs de `makeScore` — la formule du `ConfidenceScore`.
 *
 * v2.1 ajoute la dimension optionnelle `algorithmStability` (poids −0.10).
 * Ces tests verrouillent la rétro-compat (paramètre par défaut 0 → score
 * identique à v1.4) et la sémantique de la nouvelle pénalité.
 */

import { describe, it, expect } from "vitest";
import { makeScore } from "../../patterns/utils.js";

describe("makeScore — rétro-compat v1.4", () => {
  it("sans algorithmStability, score identique à la formule v1.4", () => {
    // typeClassification=90, dataRisk=20, scopeImpact=15, fileFrequency=0,
    // baseAvailability=100. Score v1.4 = 90 - 8 - 2.25 + 5 = 84.75 → 85.
    const s = makeScore(90, 20, 15, ["B1"], ["P1"], 0, 100);
    expect(s.score).toBe(85);
    expect(s.dimensions.typeClassification).toBe(90);
    expect(s.dimensions.dataRisk).toBe(20);
    expect(s.dimensions.scopeImpact).toBe(15);
    expect(s.dimensions.fileFrequency).toBe(0);
    expect(s.dimensions.baseAvailability).toBe(100);
    // algorithmStability ne doit pas apparaître dans `dimensions` quand zéro,
    // pour ne pas casser les snapshots v1.4 qui asserent l'objet exact.
    expect(s.dimensions.algorithmStability).toBeUndefined();
  });
});

describe("makeScore — algorithmStability (v2.1)", () => {
  it("pénalité de −10 quand algorithmStability=100", () => {
    // Même input que ci-dessus mais avec algorithmStability=100.
    // Score = 85 (v1.4) − 10 = 75.
    const s = makeScore(90, 20, 15, [], [], 0, 100, 100);
    expect(s.score).toBe(75);
    expect(s.dimensions.algorithmStability).toBe(100);
  });

  it("dégrade le label sous le seuil 'high' (68)", () => {
    // Cas où le score v1.4 est juste au-dessus de 68 (high) et la pénalité le
    // fait passer en 'medium'.
    const before = makeScore(80, 20, 0, [], [], 0, 0, 0);
    const after = makeScore(80, 20, 0, [], [], 0, 0, 100);
    expect(before.label).toBe("high");
    expect(after.score).toBe(before.score - 10);
    expect(after.label).toBe("medium");
  });

  it("score saturé à 0 même avec algorithmStability extrême", () => {
    const s = makeScore(0, 100, 100, [], [], 100, 0, 100);
    expect(s.score).toBe(0);
    expect(s.label).toBe("low");
  });
});
