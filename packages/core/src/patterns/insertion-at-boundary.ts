/**
 * Pattern `insertion_at_boundary` — v1.4
 *
 * Détecte les conflits où les deux branches ont uniquement ajouté des lignes
 * par rapport à la base — sans suppression ni modification.
 * Inspiré du comportement ORT merge (Git 2.34+).
 *
 * Cas typiques : liste de dépendances, tableau de routes, définitions d'enum,
 * listes d'exports dans des fichiers partagés.
 *
 * Priority : 57 (après reorder_only, avant value_only_change)
 * Requires : both (diff3 = haute confiance, diff2 = heuristique, confiance réduite)
 *
 * Relation avec non_overlapping (priority 40) :
 *   - non_overlapping traite les cas où le LCS 3-way merge réussit directement
 *   - insertion_at_boundary traite les cas où les insertions tombent au MÊME
 *     point de frontière (le LCS échoue) mais l'analyse sémantique réussit
 */

import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { scopeImpact, makeScore, normalizeLine } from "./utils.js";
import { lcs } from "../diff/index.js";

// ─── LCS helpers ─────────────────────────────────────────────
//
// v2.1 : on utilise le backend `lcs` partagé (Histogram par défaut, legacy via
// `GITWAND_DIFF=lcs`) plutôt que le DP plein local. Le code retiré ressemblait
// au DP de `lcs.ts` mais avec une structure de retour différente — on adapte
// donc juste la sortie de `lcs()` (paires `[i, j]`) en un Set d'indices côté
// `modified`.

/**
 * Calcule l'ensemble des indices de `a` qui sont dans le LCS avec `b`.
 * Wrapper sur le backend partagé.
 */
function lcsIndices(a: string[], b: string[]): Set<number> {
  const inLcs = new Set<number>();
  for (const [i] of lcs(a, b)) inLcs.add(i);
  return inLcs;
}

/**
 * Retourne les lignes de `modified` qui ne sont pas dans le LCS avec `base`.
 * Ces lignes sont les "additions" par rapport à la base.
 */
function lcsAdditions(base: string[], modified: string[]): string[] {
  const lcsSet = lcsIndices(modified, base); // indices dans modified qui sont dans le LCS
  return modified.filter((_, i) => !lcsSet.has(i));
}

/**
 * Retourne les lignes de `base` qui ne sont plus dans `modified`.
 * Ces lignes sont les "suppressions" par rapport à la base.
 */
function lcsRemovals(base: string[], modified: string[]): string[] {
  const lcsSet = lcsIndices(base, modified); // indices dans base qui sont dans le LCS
  return base.filter((_, i) => !lcsSet.has(i));
}

/** Vérifie si deux tableaux ont des éléments communs */
function hasOverlap(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  return b.some((l) => setA.has(l));
}

// ─── Heuristique diff2 ────────────────────────────────────────

/**
 * En l'absence de base (diff2), on vérifie que les deux côtés sont
 * des sur-ensembles l'un de l'autre (union sans suppression).
 */
/**
 * Heuristique diff2 stricte : détecte uniquement le cas où un côté est
 * un sous-ensemble de l'autre (tailles différentes).
 * Exemple valide : ours = [A, B, C, NEW] et theirs = [A, B, C]
 * → theirs est un sous-ensemble de ours → ours a inséré NEW.
 *
 * NON applicable quand les deux côtés ont la même taille (cas value_only_change)
 * ou quand les lignes ne sont pas comparables par inclusion.
 */
function detectWithoutBase(h: ClassifyInput): boolean {
  const oursNorm = h.oursLines.map(normalizeLine).filter((l) => l.length > 0);
  const theirsNorm = h.theirsLines.map(normalizeLine).filter((l) => l.length > 0);
  if (oursNorm.length === 0 || theirsNorm.length === 0) return false;
  if (oursNorm.join("\n") === theirsNorm.join("\n")) return false;

  const oursSet = new Set(oursNorm);
  const theirsSet = new Set(theirsNorm);

  // Les tailles doivent différer : un côté a plus de lignes que l'autre
  if (oursSet.size === theirsSet.size) return false;

  // Le plus petit doit être un sous-ensemble du plus grand
  if (oursSet.size < theirsSet.size) {
    return [...oursSet].every((l) => theirsSet.has(l));
  } else {
    return [...theirsSet].every((l) => oursSet.has(l));
  }
}

// ─── Plugin ──────────────────────────────────────────────────

const insertionAtBoundary: PatternPlugin = {
  type: "insertion_at_boundary",
  priority: 57,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    const hasBase = h.baseLines.length > 0;

    if (!hasBase) {
      return detectWithoutBase(h);
    }

    // diff3 : vérifier qu'il n'y a que des ajouts (pas de suppressions)
    const oursRemovals = lcsRemovals(h.baseLines, h.oursLines);
    const theirsRemovals = lcsRemovals(h.baseLines, h.theirsLines);
    const oursAdded = lcsAdditions(h.baseLines, h.oursLines);
    const theirsAdded = lcsAdditions(h.baseLines, h.theirsLines);

    return (
      oursRemovals.length === 0 &&
      theirsRemovals.length === 0 &&
      oursAdded.length > 0 &&
      theirsAdded.length > 0 &&
      !hasOverlap(oursAdded, theirsAdded)
    );
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const hasBase = h.baseLines.length > 0;
    const totalLines = Math.max(h.oursLines.length, h.theirsLines.length);

    if (hasBase) {
      return makeScore(90, 8, scopeImpact(totalLines), [
        "Insertions pures — base intacte des deux côtés",
      ], []);
    }
    return makeScore(68, 20, scopeImpact(totalLines), [], [
      "Sans base (diff2) — heuristique d'union (−22)",
    ]);
  },

  explanation(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    return hasBase
      ? "Les deux branches ont uniquement ajouté des lignes sans modifier la base. Résolution : union des insertions (ours en premier)."
      : "Les deux branches semblent avoir uniquement ajouté des lignes (heuristique diff2). Résolution : union (ours en premier).";
  },

  passReason(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    return hasBase
      ? "Aucune suppression des deux côtés, insertions distinctes — insertions pures confirmées par la base."
      : "Heuristique diff2 : les deux côtés sont des sur-ensembles l'un de l'autre.";
  },

  failReason(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    return hasBase
      ? "Au moins un côté a des suppressions ou des insertions qui se chevauchent."
      : "La heuristique diff2 d'union échoue — des lignes sont présentes d'un côté mais absentes de l'autre de façon asymétrique.";
  },
};

export default insertionAtBoundary;
