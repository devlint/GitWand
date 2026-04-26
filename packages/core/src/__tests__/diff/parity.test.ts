/**
 * Tests de parité Histogram ↔ legacy (v2.1).
 *
 * Histogram est une **heuristique** : elle ne garantit pas la longueur de LCS
 * optimale sur de l'input aléatoire avec un alphabet réduit (les ancres rares
 * peuvent y être mal placées). En revanche, sur les patterns du code source
 * (lignes uniques fréquentes), Histogram doit matcher la longueur du LCS legacy.
 *
 * Ce fichier vérifie :
 *  1. Parité **stricte** sur les patterns réalistes (identité, insertion pure,
 *     suppression pure, refactor d'imports).
 *  2. Parité **soft** sur l'aléatoire : Histogram peut être plus court que
 *     legacy, mais les paires retournées doivent rester valides et
 *     strictement croissantes (contrat de correctness, pas d'optimalité).
 */

import { describe, it, expect } from "vitest";
import { histogramDiff } from "../../diff/histogram.js";
import { lcsLegacy } from "../../diff/lcs.js";

/** PRNG déterministe (mulberry32). */
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

function expectValidLcs(
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

describe("Parité — patterns réalistes", () => {
  it("séquences identiques — parité longueur stricte", () => {
    // 50 lignes uniques (typique d'un fichier source). Toute paire d'ancrage
    // est unique-unique, donc Histogram trouve l'alignement optimal.
    const a = Array.from({ length: 50 }, (_, i) => `line_${i}`);
    expect(histogramDiff(a, a).length).toBe(lcsLegacy(a, a).length);
  });

  it("insertion pure au milieu", () => {
    const a = Array.from({ length: 30 }, (_, i) => `line_${i}`);
    const b = [...a.slice(0, 15), "INSERTED_X", "INSERTED_Y", ...a.slice(15)];
    expect(histogramDiff(a, b).length).toBe(lcsLegacy(a, b).length);
  });

  it("suppression pure au milieu", () => {
    const a = Array.from({ length: 30 }, (_, i) => `line_${i}`);
    const b = [...a.slice(0, 10), ...a.slice(15)];
    expect(histogramDiff(a, b).length).toBe(lcsLegacy(a, b).length);
  });

  it("refactor d'imports — typique TS", () => {
    const a = [
      `import { foo } from "./foo";`,
      `import { bar } from "./bar";`,
      ``,
      `export function handler() {`,
      `  return foo() + bar();`,
      `}`,
    ];
    const b = [
      `import { bar } from "./bar";`,
      `import { foo } from "./foo";`,
      `import { baz } from "./baz";`,
      ``,
      `export function handler() {`,
      `  return foo() + bar() + baz();`,
      `}`,
    ];
    expect(histogramDiff(a, b).length).toBe(lcsLegacy(a, b).length);
  });

  it("ajout d'une fonction à la fin", () => {
    const a = [
      `export function alpha() { return 1; }`,
      ``,
      `export function beta() { return 2; }`,
    ];
    const b = [
      `export function alpha() { return 1; }`,
      ``,
      `export function beta() { return 2; }`,
      ``,
      `export function gamma() { return 3; }`,
    ];
    expect(histogramDiff(a, b).length).toBe(lcsLegacy(a, b).length);
  });
});

describe("Parité — propriétés de correctness sur input aléatoire", () => {
  it("200 paires — paires retournées toujours valides et croissantes", () => {
    // Ne teste pas l'optimalité (Histogram est heuristique sur du bruit),
    // mais la *correctness* : le résultat doit être un LCS valide même s'il
    // n'est pas le plus long.
    const rng = mulberry32(2026);
    const alphabet = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (let run = 0; run < 200; run++) {
      const n = 3 + Math.floor(rng() * 30);
      const m = 3 + Math.floor(rng() * 30);
      const a = Array.from({ length: n }, () => alphabet[Math.floor(rng() * alphabet.length)]);
      const b = Array.from({ length: m }, () => alphabet[Math.floor(rng() * alphabet.length)]);
      const result = histogramDiff(a, b);
      expectValidLcs(result, a, b);
    }
  });

  it("simulation de merge réaliste — parité stricte", () => {
    // Modèle plus fidèle au cas "merge Git" : on part d'une base de lignes
    // uniques, puis chaque branche applique des edits ponctuels (insertions,
    // suppressions). C'est le régime où Histogram doit matcher LCS — l'analyse
    // ConGra montre que le gain visible vs LCS est ailleurs (qualité du diff,
    // pas longueur), mais la longueur reste préservée.
    const rng = mulberry32(7);
    let mismatches = 0;
    for (let run = 0; run < 50; run++) {
      const baseLen = 30 + Math.floor(rng() * 30);
      const base = Array.from({ length: baseLen }, (_, i) => `base_line_${i}`);

      // ours : 90 % de lignes de base + quelques insertions/edits
      const ours: string[] = [];
      for (let i = 0; i < base.length; i++) {
        if (rng() < 0.1) continue; // skip (suppression)
        ours.push(base[i]);
        if (rng() < 0.05) ours.push(`ours_added_${i}`); // insertion
      }

      // theirs : 90 % de lignes de base + d'autres edits
      const theirs: string[] = [];
      for (let i = 0; i < base.length; i++) {
        if (rng() < 0.1) continue;
        theirs.push(base[i]);
        if (rng() < 0.05) theirs.push(`theirs_added_${i}`);
      }

      const histo = histogramDiff(ours, theirs);
      const legacy = lcsLegacy(ours, theirs);
      if (histo.length !== legacy.length) mismatches++;
      expectValidLcs(histo, ours, theirs);
    }
    // Tolérance : 0 mismatch attendu — sur du « code-like » réaliste avec des
    // lignes uniques de chaque côté, Histogram doit toujours retrouver le LCS
    // optimal grâce à l'extension forward/backward des ancres.
    expect(mismatches).toBe(0);
  });
});
