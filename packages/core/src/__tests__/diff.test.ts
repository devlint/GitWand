/**
 * Tests directs de l'algorithme LCS (P2.1).
 *
 * L'objectif est de figer le comportement observable (pairs d'indices retournées)
 * avant et après l'optimisation mémoire (Hirschberg pour gros inputs). Les choix
 * de tie-break doivent rester les mêmes pour ne pas casser les tests d'intégration
 * qui reposent indirectement sur l'ordre des edits dérivés.
 */

import { describe, it, expect } from "vitest";
import { lcs, computeDiff, _lcsHirschberg, lcsLegacy } from "../diff.js";

describe("lcs — cas triviaux", () => {
  it("deux tableaux vides", () => {
    expect(lcs([], [])).toEqual([]);
  });

  it("un tableau vide", () => {
    expect(lcs(["a"], [])).toEqual([]);
    expect(lcs([], ["a"])).toEqual([]);
  });

  it("séquences identiques — toutes les paires", () => {
    expect(lcs(["a", "b", "c"], ["a", "b", "c"])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("aucune ligne commune", () => {
    expect(lcs(["a", "b"], ["c", "d"])).toEqual([]);
  });
});

describe("lcs — cas classiques", () => {
  it("ABCBDAB vs BDCAB (exemple canonique)", () => {
    // LCS length = 4 (BCAB ou BDAB). Vérifier la longueur + validité des indices.
    const result = lcs(
      ["A", "B", "C", "B", "D", "A", "B"],
      ["B", "D", "C", "A", "B"],
    );
    expect(result.length).toBe(4);
    // Chaque paire [i, j] doit matcher a[i] === b[j]
    const a = ["A", "B", "C", "B", "D", "A", "B"];
    const b = ["B", "D", "C", "A", "B"];
    for (const [i, j] of result) {
      expect(a[i]).toBe(b[j]);
    }
    // Indices strictement croissants dans les deux tableaux
    for (let k = 1; k < result.length; k++) {
      expect(result[k][0]).toBeGreaterThan(result[k - 1][0]);
      expect(result[k][1]).toBeGreaterThan(result[k - 1][1]);
    }
  });

  it("insertion au milieu", () => {
    const result = lcs(["a", "b", "c"], ["a", "x", "b", "c"]);
    expect(result).toEqual([
      [0, 0],
      [1, 2],
      [2, 3],
    ]);
  });

  it("suppression au milieu", () => {
    const result = lcs(["a", "b", "c", "d"], ["a", "c", "d"]);
    expect(result).toEqual([
      [0, 0],
      [2, 1],
      [3, 2],
    ]);
  });
});

describe("lcs — stress + intégration computeDiff", () => {
  it("produit une LCS de longueur maximale (propriété)", () => {
    // Test par propriété : la LCS calculée doit avoir la longueur théorique.
    const a = ["a", "b", "c", "d", "e", "f"];
    const b = ["x", "b", "y", "d", "z", "f"];
    // LCS théorique : b, d, f (longueur 3)
    const result = lcs(a, b);
    expect(result.length).toBe(3);
  });

  it("fonctionne sur un input moyennement gros (50x50)", () => {
    const a = Array.from({ length: 50 }, (_, i) => `line_${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `line_${i}`);
    const result = lcs(a, b);
    expect(result.length).toBe(50);
  });

  it("computeDiff reste cohérent après optimisations mémoire", () => {
    // Test d'intégration : computeDiff dépend de lcs. Si lcs change
    // silencieusement, les ops diff seront différentes.
    const base = ["header", "a", "b", "c", "footer"];
    const branch = ["header", "a", "X", "c", "footer"];
    const ops = computeDiff(base, branch);
    // Séquence attendue : keep header, keep a, remove b, add X, keep c, keep footer
    const types = ops.map((op) => op.type);
    expect(types).toEqual(["keep", "keep", "remove", "add", "keep", "keep"]);
  });

  it("gros input (200x200) avec beaucoup de différences — LCS valide", () => {
    // Cible : l'input est assez gros pour exercer le chemin optimisé
    // dans la future implémentation hybride, sans être lent en test.
    const a = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? `a_${i}` : `diff_${i}`));
    const b = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? `a_${i}` : `other_${i}`));
    // LCS théorique : les 100 lignes paires identiques.
    const result = lcs(a, b);
    expect(result.length).toBe(100);
    // Chaque match doit être valide
    for (const [i, j] of result) {
      expect(a[i]).toBe(b[j]);
    }
  });
});

// ─── P2.1 — Hirschberg (variante mémoire O(min(n,m))) ──────

describe("lcs — Hirschberg (P2.1)", () => {
  // Propriété à vérifier : Hirschberg doit produire une LCS de longueur
  // optimale et composée de paires valides. Les indices exacts peuvent
  // différer du DP plein sur les ties, mais la longueur doit être la même.

  it("Hirschberg produit la même longueur de LCS que le DP plein", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g"];
    const b = ["x", "b", "y", "d", "z", "f", "w"];
    const dense = lcs(a, b); // passe par DP plein (petit input)
    const hirsch = _lcsHirschberg(a, b);
    expect(hirsch.length).toBe(dense.length);
  });

  it("Hirschberg sur tableaux identiques → toutes les paires diagonales", () => {
    const a = ["a", "b", "c", "d"];
    const result = _lcsHirschberg(a, a);
    expect(result).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("Hirschberg sur tableau vide à gauche ou à droite", () => {
    expect(_lcsHirschberg([], ["a", "b"])).toEqual([]);
    expect(_lcsHirschberg(["a", "b"], [])).toEqual([]);
  });

  it("Hirschberg sur une seule ligne à gauche — trouve la première occurrence", () => {
    expect(_lcsHirschberg(["x"], ["a", "x", "x", "b"])).toEqual([[0, 1]]);
  });

  it("Hirschberg : paires valides (propriété)", () => {
    const a = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? `k_${i}` : `only_a_${i}`));
    const b = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? `k_${i}` : `only_b_${i}`));
    const result = _lcsHirschberg(a, b);
    // Chaque paire doit être une vraie correspondance
    for (const [i, j] of result) {
      expect(a[i]).toBe(b[j]);
    }
    // Indices strictement croissants dans les deux dimensions
    for (let k = 1; k < result.length; k++) {
      expect(result[k][0]).toBeGreaterThan(result[k - 1][0]);
      expect(result[k][1]).toBeGreaterThan(result[k - 1][1]);
    }
    // Longueur théorique : 10 lignes k_0, k_3, k_6…
    expect(result.length).toBe(10);
  });

  it("Hirschberg et DP plein produisent la même longueur sur des inputs aléatoires", () => {
    // Stress test : 20 runs sur des inputs pseudo-aléatoires reproductibles.
    // v2.1 : on compare `lcsLegacy` (DP plein) à `_lcsHirschberg` directement —
    // `lcs()` route désormais vers Histogram, qui est une heuristique et
    // n'est pas garantie produire un LCS de longueur optimale sur de l'input
    // aléatoire (la parité tient sur le code source, pas sur du bruit).
    const rng = mulberry32(42);
    for (let run = 0; run < 20; run++) {
      const n = 5 + Math.floor(rng() * 20);
      const m = 5 + Math.floor(rng() * 20);
      const alphabet = ["a", "b", "c", "d", "e"];
      const a = Array.from({ length: n }, () => alphabet[Math.floor(rng() * alphabet.length)]);
      const b = Array.from({ length: m }, () => alphabet[Math.floor(rng() * alphabet.length)]);
      const dense = lcsLegacy(a, b);
      const hirsch = _lcsHirschberg(a, b);
      expect(hirsch.length).toBe(dense.length);
      // Validité des paires
      for (const [i, j] of hirsch) {
        expect(a[i]).toBe(b[j]);
      }
    }
  });
});

/** PRNG déterministe (mulberry32) — évite la flakiness des stress-tests. */
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
