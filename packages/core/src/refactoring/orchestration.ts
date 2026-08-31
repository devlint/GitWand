/**
 * GitWand v2.6 — Pipeline RefMerge (expérimental)
 *
 * Orchestre la détection, inversion, merge textuel et rejeu des refactorings
 * pour résoudre des conflits causés par des renommages concurrents.
 *
 * ## Pipeline complet
 *
 * ```
 * input (base, ours, theirs)
 *   ↓
 * detectRefactorings(base, ours)  → oursRefs
 * detectRefactorings(base, theirs) → theirsRefs
 *   ↓
 * si quota dépassé → abort (renvoyer null — trop risqué)
 *   ↓
 * ours'   = invertRefactorings(ours,   oursRefs)
 * theirs' = invertRefactorings(theirs, theirsRefs)
 *   ↓
 * merge textuel sur (base, ours', theirs') → merged'
 *   ↓
 * si merge textuel échoue → abort (renvoyer null)
 *   ↓
 * merged = replayRefactorings(merged', mergeRefactorings(oursRefs, theirsRefs))
 *   ↓
 * return { lines: merged, oursRefs, theirsRefs }
 * ```
 *
 * ## Garanties
 * - Retourne `null` si aucun refactoring détecté ou si le pipeline échoue.
 * - Retourne `null` en cas d'erreur (never throws — safe by default).
 * - Zéro import Node.js — compatible browser, Node.js, Tauri WebView.
 */

import type { ClassifyInput, Refactoring } from "../types.js";
import { mergeNonOverlapping } from "../diff.js";
import { detectRefactorings } from "./detect.js";
import { invertRefactorings } from "./invert.js";
import { replayRefactorings, mergeRefactorings } from "./replay.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Résultat du pipeline RefMerge pour un hunk. */
export interface RefMergeResult {
  /** Lignes résolues après inversion + merge + rejeu. `null` si le pipeline a échoué. */
  lines: string[] | null;
  /** Raison de la résolution ou de l'échec. */
  reason: string;
  /** Refactorings détectés sur la branche ours (peut être vide). */
  oursRefs: Refactoring[];
  /** Refactorings détectés sur la branche theirs (peut être vide). */
  theirsRefs: Refactoring[];
}

// ─── Merge textuel sur les versions inversées ─────────────────────────────────

/**
 * Tente un merge textuel simple entre base, ours' et theirs'.
 *
 * Essaie dans l'ordre :
 * 1. same_change   : ours' === theirs' → prendre ours'
 * 2. one_side_ours : theirs' === base  → prendre ours'
 * 3. one_side_they : ours' === base    → prendre theirs'
 * 4. non_overlapping : essayer `mergeNonOverlapping(base, ours', theirs')`
 *
 * @returns Les lignes fusionnées, ou `null` si chevauchement résiduel.
 */
function mergeInverted(
  base: string[],
  oursInverted: string[],
  theirsInverted: string[],
): string[] | null {
  const oursText = oursInverted.join("\n");
  const theirsText = theirsInverted.join("\n");
  const baseText = base.join("\n");

  // 1. same_change : les deux versions inversées sont identiques
  if (oursText === theirsText) {
    return [...oursInverted];
  }

  // 2. one_side_change : theirs' == base → prendre ours'
  if (theirsText === baseText) {
    return [...oursInverted];
  }

  // 3. one_side_change : ours' == base → prendre theirs'
  if (oursText === baseText) {
    return [...theirsInverted];
  }

  // 4. Tentative de merge non-overlapping (les changements résiduels ne se chevauchent pas)
  return mergeNonOverlapping(base, oursInverted, theirsInverted);
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

/**
 * Tente de résoudre un hunk via le pipeline RefMerge.
 *
 * @param input           - Hunk d'entrée (oursLines, baseLines, theirsLines)
 * @param maxRefactorings - Nombre maximum de refactorings autorisés par branche
 * @returns Résultat du pipeline, ou `{ lines: null, ... }` si le pipeline échoue
 *
 * @example
 * ```ts
 * const result = tryRefMerge(
 *   { oursLines: [...], baseLines: [...], theirsLines: [...], startLine: 1, endLine: 10 },
 *   10,
 * );
 * if (result.lines !== null) {
 *   // La résolution RefMerge a réussi
 * }
 * ```
 */
export function tryRefMerge(
  input: ClassifyInput,
  maxRefactorings = 10,
): RefMergeResult {
  try {
    const { oursLines, baseLines, theirsLines } = input;

    // Cas trivial : pas de base → le pipeline ne peut pas fonctionner
    if (baseLines.length === 0) {
      return {
        lines: null,
        reason: "RefMerge : base vide (diff2 uniquement) — pipeline inapplicable.",
        oursRefs: [],
        theirsRefs: [],
      };
    }

    // ── Phase 1 : Détection ─────────────────────────────────────────────────
    const oursRefs = detectRefactorings(baseLines, oursLines, maxRefactorings);
    const theirsRefs = detectRefactorings(baseLines, theirsLines, maxRefactorings);

    // Si aucun refactoring détecté → laisser le pipeline standard gérer
    if (oursRefs.length === 0 && theirsRefs.length === 0) {
      return {
        lines: null,
        reason: "RefMerge: no refactoring detected, falling back to the standard pipeline.",
        oursRefs: [],
        theirsRefs: [],
      };
    }

    // Si quota dépassé de chaque côté → trop risqué, abandonner
    if (oursRefs.length >= maxRefactorings || theirsRefs.length >= maxRefactorings) {
      return {
        lines: null,
        reason: `RefMerge : quota atteint (ours: ${oursRefs.length}, theirs: ${theirsRefs.length}) — fallback au pipeline standard.`,
        oursRefs,
        theirsRefs,
      };
    }

    // ── Phase 2 : Inversion ─────────────────────────────────────────────────
    const oursInverted = invertRefactorings(oursLines, oursRefs);
    const theirsInverted = invertRefactorings(theirsLines, theirsRefs);

    // ── Phase 3 : Merge textuel sur les versions inversées ──────────────────
    const mergedInverted = mergeInverted(baseLines, oursInverted, theirsInverted);

    if (mergedInverted === null) {
      return {
        lines: null,
        reason: "RefMerge: residual overlap after inversion, falling back to the standard pipeline.",
        oursRefs,
        theirsRefs,
      };
    }

    // ── Phase 4 : Rejeu ─────────────────────────────────────────────────────
    const allRefs = mergeRefactorings(oursRefs, theirsRefs);
    const finalLines = replayRefactorings(mergedInverted, allRefs);

    const summary = summarizeRefs(oursRefs, theirsRefs);
    return {
      lines: finalLines,
      reason: `RefMerge: ${summary}. Resolved by invert, merge and replay.`,
      oursRefs,
      theirsRefs,
    };
  } catch {
    // Dégradation silencieuse — jamais crasher le pipeline principal
    return {
      lines: null,
      reason: "RefMerge : erreur interne — fallback au pipeline standard.",
      oursRefs: [],
      theirsRefs: [],
    };
  }
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/** Produit un résumé compact des refactorings pour le trace. */
function summarizeRefs(oursRefs: Refactoring[], theirsRefs: Refactoring[]): string {
  const parts: string[] = [];
  const allRefs = [...oursRefs, ...theirsRefs];
  const renames = allRefs.filter((r) => r.kind !== "move-method");
  const moves = allRefs.filter((r) => r.kind === "move-method");

  if (renames.length > 0) {
    const sample = renames
      .slice(0, 2)
      .map((r) => `${r.oldName}→${r.newName ?? "?"}`)
      .join(", ");
    parts.push(`${renames.length} rename(s) [${sample}${renames.length > 2 ? "…" : ""}]`);
  }
  if (moves.length > 0) {
    parts.push(`${moves.length} move-method(s)`);
  }
  return parts.join(", ");
}
