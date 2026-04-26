/**
 * GitWand — Sous-arborescence diff
 *
 * Point d'entrée unique pour les algorithmes de diff et leurs helpers.
 *
 * **v2.1 — Histogram par défaut** : `lcs()` route vers `histogramDiff` (ancrage
 * sur lignes rares, splits plus stables sur le code source). Pour rebasculer
 * sur l'algo legacy (DP plein / Hirschberg) :
 *
 *   GITWAND_DIFF=lcs node ...
 *
 * Le contrat de longueur est préservé : `histogramDiff(a, b).length ===
 * lcsLegacy(a, b).length` sur tous les inputs (les paires retournées peuvent
 * différer sur les tie-breaks).
 */

import { lcsLegacy } from "./lcs.js";
import { histogramDiff } from "./histogram.js";

export { lcsLegacy, _lcsHirschberg } from "./lcs.js";
export { histogramDiff, type HistogramOptions } from "./histogram.js";
export {
  detectBlockMove,
  type MovedBlock,
  type BlockMoveOptions,
} from "./block-move.js";

/**
 * Lit le flag d'environnement de manière safe — `process` n'est pas défini
 * dans tous les runtimes (browser pur, certains worklets). Sur Tauri webview
 * et VS Code extension `process` existe, donc le rollback marche partout où
 * `@gitwand/core` est utilisé en pratique.
 */
function shouldUseLegacy(): boolean {
  if (typeof process === "undefined") return false;
  return process.env?.GITWAND_DIFF === "lcs";
}

/**
 * Calcule la Longest Common Subsequence entre deux tableaux de lignes.
 *
 * Backend par défaut : **Histogram** (depuis v2.1). Bascule sur l'algo legacy
 * via `GITWAND_DIFF=lcs`.
 *
 * @returns paires `[i, j]` telles que `a[i] === b[j]`, ordre strictement
 *          croissant dans les deux dimensions.
 */
export function lcs(a: string[], b: string[]): Array<[number, number]> {
  if (shouldUseLegacy()) return lcsLegacy(a, b);
  return histogramDiff(a, b);
}

export {
  computeDiff,
  extractEdits,
  editsOverlap,
  mergeNonOverlapping,
  type DiffOp,
  type Edit,
} from "./shared.js";
