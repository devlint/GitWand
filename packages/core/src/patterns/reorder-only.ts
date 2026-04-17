/**
 * Pattern `reorder_only` — v1.4
 *
 * Détecte les conflits où les deux branches contiennent exactement les mêmes
 * lignes mais dans un ordre différent. Cas typiques : imports triés
 * alphabétiquement, clés de config réorganisées, listes d'exports réordonnées.
 *
 * Priority : 55 (après whitespace_only, avant value_only_change)
 * Requires : both (fonctionne avec ou sans base)
 */

import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { scopeImpact, makeScore, normalizeLine } from "./utils.js";

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Vérifie si deux tableaux sont des multisets égaux (même éléments, peu importe l'ordre).
 * Gère correctement les lignes dupliquées.
 */
function isMultisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const freq = new Map<string, number>();
  for (const l of a) freq.set(l, (freq.get(l) ?? 0) + 1);
  for (const l of b) {
    const n = freq.get(l);
    if (!n) return false;
    n === 1 ? freq.delete(l) : freq.set(l, n - 1);
  }
  return freq.size === 0;
}

/**
 * Compte les lignes dupliquées dans un tableau normalisé.
 * Retourne vrai si au moins une ligne apparaît plus d'une fois.
 */
function hasDuplicates(lines: string[]): boolean {
  return new Set(lines).size !== lines.length;
}

// ─── Plugin ──────────────────────────────────────────────────

const reorderOnly: PatternPlugin = {
  type: "reorder_only",
  priority: 55,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    const ours = h.oursLines.map(normalizeLine).filter((l) => l.length > 0);
    const theirs = h.theirsLines.map(normalizeLine).filter((l) => l.length > 0);
    if (ours.length === 0 || theirs.length === 0) return false;
    // Les deux listes doivent être des permutations l'une de l'autre
    // mais pas identiques (same_change aurait déjà matchéi)
    if (ours.join("\n") === theirs.join("\n")) return false;
    return isMultisetEqual(ours, theirs);
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    const ours = h.oursLines.map(normalizeLine).filter((l) => l.length > 0);
    const duplicates = hasDuplicates(ours);
    const si = scopeImpact(h.oursLines.length);

    const boosters = ["Permutation pure — mêmes lignes, ordre différent"];
    const penalties: string[] = [];

    if (duplicates) {
      penalties.push("Lignes dupliquées — ordre ambigu (−10)");
    }

    // typeClassification 92 sauf si doublons (−10 → 82)
    const tc = duplicates ? 82 : 92;
    return makeScore(tc, 5, si, boosters, penalties);
  },

  explanation(h: ClassifyInput): string {
    const hasBase = h.baseLines.length > 0;
    return hasBase
      ? "Les deux branches contiennent les mêmes lignes dans un ordre différent. Résolution : accepter l'ordre theirs (ou ours si la base correspond à theirs)."
      : "Les deux branches contiennent les mêmes lignes dans un ordre différent. Résolution : accepter l'ordre theirs.";
  },

  passReason(_h: ClassifyInput): string {
    return "Les deux côtés sont des permutations l'un de l'autre — mêmes lignes, ordre différent.";
  },

  failReason(_h: ClassifyInput): string {
    return "Les lignes ne sont pas une simple permutation — des ajouts ou suppressions sont présents.";
  },
};

export default reorderOnly;
