/**
 * GitWand — Histogram diff
 *
 * Implémentation récursive inspirée de l'algorithme Histogram (Git, JGit) :
 * trouver une **ancre rare** (ligne dont la somme des fréquences `freqA + freqB`
 * est minimale, idéalement 1 + 1), splitter récursivement autour de l'ancre.
 *
 * Vs LCS pur :
 * - LCS aligne sur n'importe quelle ligne commune ; sur du code source, les
 *   ancres faibles (`}`, `return;`, lignes vides) produisent des splits hostiles.
 * - Histogram s'ancre sur les lignes uniques d'abord, ce qui produit des diffs
 *   plus stables et plus lisibles, et augmente le taux de succès de
 *   `non_overlapping` / `insertion_at_boundary` qui dépendent de l'alignement.
 *
 * Référence : Nugroho et al., « How different are different diff algorithms in
 * Git? » Springer EMSE 2019. Histogram domine Myers et LCS sur le code source.
 *
 * @module
 */

import { lcsLegacy } from "./lcs.js";

/** Options pour `histogramDiff`. */
export interface HistogramOptions {
  /** Profondeur max de récursion (défaut 100, garde-fou stack overflow). */
  maxDepth?: number;
  /**
   * Court-circuit DP plein si `(aEnd-aStart) * (bEnd-bStart) ≤ smallInputThreshold`.
   * L'overhead d'indexation Histogram domine sur les petits inputs ; le LCS
   * legacy DP est plus rapide. Défaut 200 (≈ 14×14 cellules).
   */
  smallInputThreshold?: number;
}

const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_SMALL_INPUT_THRESHOLD = 200;

/**
 * Calcule la Longest Common Subsequence entre deux tableaux de lignes via
 * l'algorithme **Histogram**. Retourne les indices des lignes communes dans
 * chaque tableau, en ordre strictement croissant.
 *
 * Contrat : `histogramDiff(a, b).length === lcsLegacy(a, b).length` sur tous
 * les inputs (les paires retournées peuvent différer sur les tie-breaks).
 *
 * @param a - premier tableau de lignes
 * @param b - second tableau de lignes
 * @param opts - options optionnelles
 * @returns paires `[i, j]` telles que `a[i] === b[j]`, ordre croissant
 */
export function histogramDiff(
  a: string[],
  b: string[],
  opts?: HistogramOptions,
): Array<[number, number]> {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const smallInputThreshold = opts?.smallInputThreshold ?? DEFAULT_SMALL_INPUT_THRESHOLD;
  return diffWindow(a, 0, a.length, b, 0, b.length, 0, maxDepth, smallInputThreshold);
}

/**
 * Coeur récursif. Opère sur les fenêtres `a[aStart..aEnd], b[bStart..bEnd]`.
 * Retourne les paires `[i, j]` en coordonnées **absolues** (par rapport aux
 * tableaux d'origine), pas relatives à la fenêtre.
 */
function diffWindow(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number,
  depth: number,
  maxDepth: number,
  smallInputThreshold: number,
): Array<[number, number]> {
  const n = aEnd - aStart;
  const m = bEnd - bStart;

  // ─── Cas de base ─────────────────────────────────────────────
  if (n <= 0 || m <= 0) return [];

  if (n === 1) {
    // Première occurrence dans b — même tie-break que `lcsHirschberg`.
    const target = a[aStart];
    for (let j = bStart; j < bEnd; j++) {
      if (b[j] === target) return [[aStart, j]];
    }
    return [];
  }

  if (m === 1) {
    const target = b[bStart];
    for (let i = aStart; i < aEnd; i++) {
      if (a[i] === target) return [[i, bStart]];
    }
    return [];
  }

  // ─── Garde-fous : profondeur + petit input ───────────────────
  if (depth >= maxDepth || n * m <= smallInputThreshold) {
    // Fallback DP plein sur la sous-fenêtre. On copie les sous-tableaux
    // pour rester dans le contrat de `lcsLegacy(string[], string[])`.
    const aSub = a.slice(aStart, aEnd);
    const bSub = b.slice(bStart, bEnd);
    const sub = lcsLegacy(aSub, bSub);
    return sub.map(([i, j]) => [i + aStart, j + bStart] as [number, number]);
  }

  // ─── Histogramme : fréquences sur la fenêtre courante ────────
  const freqA = new Map<string, number>();
  for (let i = aStart; i < aEnd; i++) {
    freqA.set(a[i], (freqA.get(a[i]) ?? 0) + 1);
  }
  const freqB = new Map<string, number>();
  for (let j = bStart; j < bEnd; j++) {
    freqB.set(b[j], (freqB.get(b[j]) ?? 0) + 1);
  }

  // ─── Indexation des positions de chaque ligne dans la fenêtre b ──
  // (sert à étendre le match pour chaque candidat ancre vers la position de b
  // qui maximise la région contiguë alignée — heuristique JGit Histogram.)
  const posB = new Map<string, number[]>();
  for (let j = bStart; j < bEnd; j++) {
    const line = b[j];
    let arr = posB.get(line);
    if (!arr) {
      arr = [];
      posB.set(line, arr);
    }
    arr.push(j);
  }

  // ─── Recherche de l'ancre — variant JGit ─────────────────────
  // Pour chaque ligne candidate (présente dans freqB), parcourir toutes ses
  // positions dans b et étendre le match (forward + backward) tant que les
  // lignes correspondent. Conserver le triplet (i, j, regionLen) qui maximise
  // `regionLen / (freqA + freqB)`. À regionLen + score égaux, conserver le
  // plus petit i (tie-break stable).
  let bestI = -1;
  let bestJ = -1;
  let bestRegionLen = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = aStart; i < aEnd; i++) {
    const line = a[i];
    const positions = posB.get(line);
    if (!positions) continue;
    const fA = freqA.get(line)!;
    const fB = positions.length;
    const score = fA + fB;
    // Si le score est strictement pire que le best courant ET que regionLen
    // ne peut pas le battre, skip (optim).
    if (score > bestScore && bestRegionLen >= 1) continue;

    for (const j of positions) {
      // Étendre forward
      let fwd = 1;
      while (
        i + fwd < aEnd &&
        j + fwd < bEnd &&
        a[i + fwd] === b[j + fwd]
      ) {
        fwd++;
      }
      // Étendre backward (mais en restant dans la fenêtre)
      let bwd = 0;
      while (
        i - bwd - 1 >= aStart &&
        j - bwd - 1 >= bStart &&
        a[i - bwd - 1] === b[j - bwd - 1]
      ) {
        bwd++;
      }
      const regionLen = fwd + bwd;
      // Critère de sélection : prioriser (a) la région la plus longue, (b) à
      // longueur égale le score le plus bas (ancre la plus rare), (c) à score
      // égal le plus petit i (déterminisme).
      if (
        regionLen > bestRegionLen ||
        (regionLen === bestRegionLen && score < bestScore) ||
        (regionLen === bestRegionLen && score === bestScore && i < bestI)
      ) {
        bestI = i - bwd; // début de la région étendue côté a
        bestJ = j - bwd; // début de la région étendue côté b
        bestRegionLen = regionLen;
        bestScore = score;
      }
    }
  }

  // ─── Pas d'ancre commune ─────────────────────────────────────
  if (bestI === -1) {
    // Aucune ligne de a n'apparaît dans b sur cette fenêtre → pas de LCS.
    return [];
  }

  // ─── Récursion gauche + région étendue + récursion droite ────
  // La région étendue couvre [bestI..bestI+bestRegionLen-1] dans a et
  // [bestJ..bestJ+bestRegionLen-1] dans b (toutes paires matchent).
  const left = diffWindow(
    a, aStart, bestI,
    b, bStart, bestJ,
    depth + 1, maxDepth, smallInputThreshold,
  );
  const right = diffWindow(
    a, bestI + bestRegionLen, aEnd,
    b, bestJ + bestRegionLen, bEnd,
    depth + 1, maxDepth, smallInputThreshold,
  );

  const result: Array<[number, number]> = new Array(left.length + bestRegionLen + right.length);
  let k = 0;
  for (let i = 0; i < left.length; i++) result[k++] = left[i];
  for (let r = 0; r < bestRegionLen; r++) {
    result[k++] = [bestI + r, bestJ + r];
  }
  for (let i = 0; i < right.length; i++) result[k++] = right[i];
  return result;
}
