/**
 * Test de régression — `withBaseAvailability` (parser.ts) vs `makeScore` (patterns/utils.ts)
 *
 * Bug : `withBaseAvailability` recalculait le score avec sa propre copie de la
 * formule, restée bloquée en v1.4 — elle ignorait `algorithmStability` (v2.1)
 * et `postMergeRisk` (v2.4). Tant que ces dimensions valent 0 partout, rien ne
 * casse numériquement ; le jour où un pattern les renseigne, le score devient
 * silencieusement faux sur le chemin zdiff3.
 *
 * Les deux fonctions délèguent maintenant à `scoreFromDimensions` — ces tests
 * verrouillent qu'elles restent en phase pour toute combinaison de dimensions.
 */

import { describe, it, expect } from "vitest";
import { withBaseAvailability } from "../parser.js";
import { makeScore } from "../patterns/utils.js";

describe("withBaseAvailability — reste en phase avec makeScore", () => {
  it("applique la pénalité algorithmStability (auparavant ignorée)", () => {
    const cs = makeScore(90, 20, 15, [], [], 0, 0, 100 /* algorithmStability */);
    const adjusted = withBaseAvailability(cs, 100 /* baseAvailability */);

    // Équivalent à makeScore(90, 20, 15, ..., fileFrequency=0, baseAvailability=100, algorithmStability=100)
    const expected = makeScore(90, 20, 15, [], [], 0, 100, 100);
    expect(adjusted.score).toBe(expected.score);
    expect(adjusted.label).toBe(expected.label);
    expect(adjusted.dimensions.algorithmStability).toBe(100);
  });

  it("applique la pénalité postMergeRisk (auparavant ignorée)", () => {
    const cs = makeScore(90, 20, 15, [], [], 0, 0, 0, 100 /* postMergeRisk */);
    const adjusted = withBaseAvailability(cs, 100 /* baseAvailability */);

    const expected = makeScore(90, 20, 15, [], [], 0, 100, 0, 100);
    expect(adjusted.score).toBe(expected.score);
    expect(adjusted.label).toBe(expected.label);
    expect(adjusted.dimensions.postMergeRisk).toBe(100);
  });

  it("reste rétro-compatible quand les deux dimensions sont à 0", () => {
    const cs = makeScore(90, 20, 15, [], []);
    const adjusted = withBaseAvailability(cs, 100, "zdiff3: base truncated to the diverging sections");

    const expected = makeScore(90, 20, 15, [], [], 0, 100);
    expect(adjusted.score).toBe(expected.score);
    expect(adjusted.label).toBe(expected.label);
    expect(adjusted.boosters).toContain("zdiff3: base truncated to the diverging sections");
  });
});
