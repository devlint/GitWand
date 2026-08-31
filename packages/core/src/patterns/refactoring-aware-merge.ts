/**
 * v2.6 — Pattern refactoring-aware-merge (priority 25, expérimental, opt-in).
 *
 * Détecte les conflits causés par des refactorings concurrents (renommages,
 * déplacements de méthode) et délègue la résolution au pipeline RefMerge.
 *
 * ## Position dans la hiérarchie
 *
 * Priority 25 — après les patterns trivials (1–10) mais avant les patterns
 * heuristiques (whitespace: 5, value_only: 8, non_overlapping: 4). En pratique,
 * ce pattern n'est évalué que sur les hunks qui ont déjà résisté aux patterns
 * plus simples, car ceux-ci ont une priorité inférieure (numéro plus petit).
 *
 * Attendez — la convention est : **plus petit = évalué en premier**. Donc 25
 * signifie évalué AVANT whitespace_only (5) ? Non — whitespace (5) est évalué
 * avant RefMerge (25). Les patterns à faible numéro sont prioritaires.
 *
 * RefMerge à priority 25 est évalué :
 * - APRÈS non_overlapping (4), whitespace_only (5), reorder_only (6),
 *   insertion_at_boundary (7), value_only_change (8)
 * - AVANT complex (999) et llm_proposed (998)
 *
 * C'est intentionnel : on ne tente RefMerge que si les patterns textuels simples
 * n'ont pas suffi, car RefMerge est plus coûteux (tokenisation + détection).
 *
 * ## Activation
 *
 * Ce pattern est désactivé par défaut. Il s'active via `setRefMergeEnabled(true)`
 * appelé par `resolve()` quand `options.refactoringAware.enabled === true`.
 * Le flag est réinitialisé après chaque appel à `resolve()`.
 *
 * ## Résolution
 *
 * `detect()` exécute le pipeline RefMerge complet et cache le résultat dans
 * `_lastResult`. Si le pipeline réussit (`lines !== null`), detect retourne `true`
 * et `assembleResolution()` peut récupérer les lignes via `getLastRefMergeResult()`.
 */

import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { makeScore, scopeImpact } from "./utils.js";
import { tryRefMerge } from "../refactoring/orchestration.js";
import type { RefMergeResult } from "../refactoring/orchestration.js";

// ─── État module ──────────────────────────────────────────────────────────────

/** Flag d'activation — positionné par `resolve()` */
let _refMergeEnabled = false;
/** Quota maximum de refactorings par branche */
let _maxRefactoringsPerSide = 10;
/** Dernier résultat RefMerge (cache pour éviter un double calcul detect+assemble) */
let _lastResult: RefMergeResult | null = null;

// ─── API d'activation (consommée par resolver/index.ts) ──────────────────────

/** Active ou désactive le pattern RefMerge pour la prochaine résolution. */
export function setRefMergeEnabled(enabled: boolean, max = 10): void {
  _refMergeEnabled = enabled;
  _maxRefactoringsPerSide = max;
  _lastResult = null; // reset cache
}

/** Retourne l'état d'activation courant (utile pour les tests). */
export function isRefMergeEnabled(): boolean {
  return _refMergeEnabled;
}

/**
 * Retourne le dernier résultat RefMerge mis en cache par `detect()`.
 * Appelé par `assembleResolution()` pour récupérer les lignes sans recalcul.
 * Retourne `null` si `detect()` n'a pas encore été appelé ou si le résultat a été reset.
 */
export function getLastRefMergeResult(): RefMergeResult | null {
  return _lastResult;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const refactoringAwareMerge: PatternPlugin = {
  type: "refactoring_aware_merge",

  /**
   * Priority 970 — évalué après tous les patterns textuels (10–60) mais avant
   * llm_proposed (998) et complex (999). RefMerge est un recours pour les hunks
   * que tous les patterns simples ont échoué à résoudre.
   */
  priority: 970,

  /**
   * Nécessite la base (diff3) pour détecter correctement les refactorings.
   * Sans base, impossible de calculer ce qui a changé de chaque côté.
   */
  requires: "diff3",

  detect(h: ClassifyInput): boolean {
    if (!_refMergeEnabled) return false;
    if (h.baseLines.length === 0) return false;

    // Exécuter le pipeline RefMerge complet et cacher le résultat
    const result = tryRefMerge(h, _maxRefactoringsPerSide);
    _lastResult = result;

    return result.lines !== null;
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    return makeScore(
      82,           // typeClassification : refactoring bijectivement vérifié + merge réussi
      12,           // dataRisk : faible — merge déterministe, pas génératif
      scopeImpact(h.oursLines.length + h.theirsLines.length),
      [
        "Refactoring verified bijectively (simulated substitution)",
        "Textual merge succeeded on the inverted versions",
      ],
      [],
    );
  },

  explanation(_h: ClassifyInput): string {
    if (_lastResult) {
      const refs = [..._lastResult.oursRefs, ..._lastResult.theirsRefs];
      const renames = refs.filter((r) => r.kind !== "move-method");
      const moves = refs.filter((r) => r.kind === "move-method");
      const parts: string[] = [];
      if (renames.length > 0) {
        parts.push(`${renames.length} rename(s) detected and inverted`);
      }
      if (moves.length > 0) {
        parts.push(`${moves.length} method move(s)`);
      }
      return `Refactoring conflict: ${parts.join(", ") || "refactoring detected"}. Resolved through the RefMerge pipeline (invert, merge, replay).`;
    }
    return "Conflict caused by a concurrent refactoring, resolved through the RefMerge pipeline.";
  },

  passReason(_h: ClassifyInput): string {
    if (_lastResult?.oursRefs.length || _lastResult?.theirsRefs.length) {
      return `Refactoring(s) detected: ours=${_lastResult!.oursRefs.length}, theirs=${_lastResult!.theirsRefs.length}. Textual merge succeeded after inversion.`;
    }
    return "Refactoring detected bijectively; merge succeeded after inversion.";
  },

  failReason(_h: ClassifyInput): string {
    if (!_refMergeEnabled) {
      return "RefMerge disabled (options.refactoringAware.enabled !== true).";
    }
    if (_lastResult && _lastResult.lines === null) {
      return `RefMerge failed: ${_lastResult.reason}`;
    }
    return "No bijectively detectable refactoring in this hunk.";
  },
};

export default refactoringAwareMerge;
