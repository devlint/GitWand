/**
 * Dispatch vers les résolveurs format-aware (Phase 7.3).
 *
 * Avant de passer au moteur textuel, on tente un résolveur spécialisé par
 * format (JSON/JSONC, Markdown, YAML, Vue, CSS, Dockerfile, Dotenv, Cargo,
 * imports…). Ces résolveurs effectuent une validation sémantique, ce qui
 * justifie de bypasser le filtre de confiance textuel.
 *
 * Exception : le résolveur `imports` est sémantiquement équivalent à
 * `non_overlapping` — il doit respecter la politique `allowNonOverlapping`
 * ainsi que l'option globale `resolveNonOverlapping`.
 *
 * Ce module encapsule à la fois l'appel au dispatcher et la politique
 * appliquée aux imports, et retourne un résultat tagué (`status`) que le
 * moteur principal sait consommer.
 */

import type { ConflictHunk, GitWandOptions } from "../types.js";
import { tryFormatAwareResolve } from "../resolvers/dispatcher.js";
import { computeEffectivePolicy } from "./policy.js";

export type FormatDispatchResult =
  /** Le résolveur format-aware a produit une résolution. */
  | { status: "resolved"; lines: string[]; reason: string }
  /** Le résolveur a résolu mais la politique rejette le résultat (ex: imports/non_overlapping off). */
  | { status: "rejected-policy"; reason: string }
  /** Aucun résolveur format-aware n'a traité ce hunk — continuer vers le moteur textuel. */
  | { status: "not-applicable"; note: string };

/**
 * Essaie les résolveurs format-aware pour ce hunk. Retourne le résultat
 * tagué que le moteur principal sait router.
 */
export function dispatchFormatAware(
  hunk: ConflictHunk,
  filePath: string,
  options: Required<GitWandOptions>,
): FormatDispatchResult {
  const formatResult = tryFormatAwareResolve(hunk, filePath, {
    disableFormatProfiles: options.disableFormatProfiles,
  });
  if (formatResult.resolverUsed === "none") {
    return { status: "not-applicable", note: "" };
  }

  if (formatResult.lines === null) {
    // Le résolveur spécialisé a échoué — pas de résolution, mais on garde
    // le reason pour l'annoter dans le refus final du moteur textuel.
    return { status: "not-applicable", note: formatResult.reason };
  }

  // Gate politique pour le résolveur d'imports (≈ non_overlapping)
  if (formatResult.resolverUsed === "imports") {
    if (!options.resolveNonOverlapping) {
      return {
        status: "rejected-policy",
        reason: "Résolution d'imports (non-overlapping) désactivée par options (resolveNonOverlapping: false).",
      };
    }
    const { policy, cfg } = computeEffectivePolicy(filePath, options);
    if (!cfg.allowNonOverlapping) {
      return {
        status: "rejected-policy",
        reason: `Résolution d'imports (non-overlapping) désactivée par la politique "${policy}".`,
      };
    }
  }

  return { status: "resolved", lines: formatResult.lines, reason: formatResult.reason };
}
