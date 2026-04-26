/**
 * Tests directs de l'algorithme Histogram diff (v2.1).
 *
 * Vérifie le contrat de longueur (parité avec lcsLegacy), la validité des paires
 * retournées, et les cas limites (récursion profonde, petits inputs, pas d'ancre).
 */

import { describe, it, expect } from "vitest";
import { histogramDiff } from "../../diff/histogram.js";
import { lcsLegacy } from "../../diff/lcs.js";

/** Vérifie que les paires retournées sont valides et strictement croissantes. */
function expectValidLcsPairs(
  result: Array<[number, number]>,
  a: string[],
  b: string[],
): void {
  for (const [i, j] of result) {
    expect(a[i]).toBe(b[j]);
  }
  for (let k = 1; k < result.length; k++) {
    expect(result[k][0]).toBeGreaterThan(result[k - 1][0]);
    expect(result[k][1]).toBeGreaterThan(result[k - 1][1]);
  }
}

describe("histogramDiff — cas triviaux", () => {
  it("deux tableaux vides", () => {
    expect(histogramDiff([], [])).toEqual([]);
  });

  it("un tableau vide", () => {
    expect(histogramDiff(["a"], [])).toEqual([]);
    expect(histogramDiff([], ["a"])).toEqual([]);
  });

  it("séquences identiques — toutes les lignes communes", () => {
    const a = ["a", "b", "c"];
    const result = histogramDiff(a, a);
    expect(result.length).toBe(3);
    expectValidLcsPairs(result, a, a);
  });

  it("aucune ligne commune", () => {
    expect(histogramDiff(["a", "b"], ["c", "d"])).toEqual([]);
  });

  it("une seule ligne commune", () => {
    const a = ["a", "b"];
    const b = ["b"];
    const result = histogramDiff(a, b);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual([1, 0]);
  });
});

describe("histogramDiff — ancres rares", () => {
  it("préfère l'ancre unique sur l'ancre fréquente", () => {
    // 'unique' apparaît une seule fois des deux côtés ; 'common' apparaît 3×3.
    // Histogram doit ancrer sur 'unique' en premier.
    const a = ["common", "common", "unique", "common"];
    const b = ["common", "unique", "common", "common"];
    const result = histogramDiff(a, b);
    // Doit contenir la paire [2, 1] (les deux 'unique')
    expect(result.some(([i, j]) => i === 2 && j === 1)).toBe(true);
    expectValidLcsPairs(result, a, b);
  });

  it("ABCBDAB vs BDCAB — longueur LCS = 4", () => {
    const a = ["A", "B", "C", "B", "D", "A", "B"];
    const b = ["B", "D", "C", "A", "B"];
    const result = histogramDiff(a, b);
    expect(result.length).toBe(4);
    expectValidLcsPairs(result, a, b);
  });
});

describe("histogramDiff — fallback no-anchor", () => {
  it("aucune ligne commune sur la sous-fenêtre → []", () => {
    // Force à entrer dans diffWindow avec n>1, m>1 et 0 ancre.
    const a = ["a1", "a2", "a3", "a4", "a5"];
    const b = ["b1", "b2", "b3", "b4", "b5"];
    expect(histogramDiff(a, b)).toEqual([]);
  });
});

describe("histogramDiff — petits inputs (court-circuit DP)", () => {
  it("respecte le seuil smallInputThreshold (200 par défaut)", () => {
    // 5×5 = 25 ≤ 200 → court-circuit sur lcsLegacy. Comportement observable
    // identique au LCS legacy.
    const a = ["a", "b", "c", "d", "e"];
    const b = ["a", "x", "c", "y", "e"];
    const histogram = histogramDiff(a, b);
    const legacy = lcsLegacy(a, b);
    expect(histogram).toEqual(legacy);
  });
});

describe("histogramDiff — récursion profonde", () => {
  it("alternance dense de 200 lignes converge sans stack overflow", () => {
    // 200 lignes alternées : tout le travail est dans la récursion.
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 200; i++) {
      a.push(`L${i}`);
      b.push(i % 2 === 0 ? `L${i}` : `X${i}`);
    }
    const result = histogramDiff(a, b);
    // Les 100 lignes paires sont communes
    expect(result.length).toBe(100);
    expectValidLcsPairs(result, a, b);
  });

  it("garde-fou maxDepth → fallback DP", () => {
    const a = ["x", "a", "b", "c", "d", "y"];
    const b = ["y", "a", "b", "c", "d", "x"];
    // Avec maxDepth=0, on retombe immédiatement sur lcsLegacy.
    const result = histogramDiff(a, b, { maxDepth: 0 });
    const legacy = lcsLegacy(a, b);
    expect(result.length).toBe(legacy.length);
  });
});

describe("histogramDiff — code source réaliste", () => {
  it("imports + fonctions — typique TS", () => {
    const a = [
      `import { foo } from "./foo";`,
      `import { bar } from "./bar";`,
      ``,
      `export function handler(req: Request) {`,
      `  return foo(req);`,
      `}`,
    ];
    const b = [
      `import { foo } from "./foo";`,
      `import { baz } from "./baz";`,
      `import { bar } from "./bar";`,
      ``,
      `export function handler(req: Request) {`,
      `  return foo(req);`,
      `}`,
    ];
    const result = histogramDiff(a, b);
    expect(result.length).toBe(6); // toutes sauf le nouvel import baz
    expectValidLcsPairs(result, a, b);
  });

  it("réordonnancement de fonctions — parité LCS sur cas hostile", () => {
    // Permutation pure : [alpha, '', beta] vs [beta, '', alpha]. Aucune
    // sous-séquence commune de longueur > 1 ne respecte l'ordre des deux côtés
    // (tout match étend forcément un début et un fin qui s'excluent). Histogram
    // doit retourner exactement la même longueur que le LCS legacy — c'est le
    // contrat de parité v2.1.
    const a = [
      `function alpha() { return 1; }`,
      ``,
      `function beta() { return 2; }`,
    ];
    const b = [
      `function beta() { return 2; }`,
      ``,
      `function alpha() { return 1; }`,
    ];
    const result = histogramDiff(a, b);
    expect(result.length).toBe(lcsLegacy(a, b).length);
    expectValidLcsPairs(result, a, b);
  });
});
