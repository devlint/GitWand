/**
 * Moteur textuel d'assemblage — switch par type de conflit.
 *
 * Appelé par `resolveHunk` après que :
 * 1. le mode `explainOnly` ait été écarté,
 * 2. le dispatch format-aware ait échoué (ou ne s'applique pas),
 * 3. le seuil de confiance effectif ait été validé.
 *
 * Chaque `case` produit soit un tableau de lignes résolues, soit `null` avec
 * une raison de refus. La stratégie par type est documentée individuellement.
 *
 * Extrait de `resolver.ts` lors du split P1.1.
 */

import type { ConflictHunk, GitWandOptions } from "../types.js";
import type { MergePolicy, PolicyConfig } from "../config.js";
import { mergeNonOverlapping } from "../diff.js";
import { stripVolatileValues } from "./generated-detection.js";
import { getLastRefMergeResult } from "../patterns/refactoring-aware-merge.js";

/**
 * Applique la stratégie textuelle correspondant au type de hunk.
 * Les vérifications amont (explainOnly, format-dispatch, minConfidence)
 * sont supposées déjà faites par l'appelant.
 */
export function assembleResolution(
  hunk: ConflictHunk,
  options: Required<GitWandOptions>,
  effectivePolicy: MergePolicy,
  policyCfg: PolicyConfig,
): { lines: string[] | null; reason: string } {
  switch (hunk.type) {
    case "same_change":
      return {
        lines: [...hunk.oursLines],
        reason: "Même modification des deux côtés — résolution triviale (ours = theirs).",
      };

    case "one_side_change": {
      const baseText = hunk.baseLines.join("\n");
      const oursText = hunk.oursLines.join("\n");
      if (oursText === baseText) {
        return {
          lines: [...hunk.theirsLines],
          reason: "Ours = base → seul theirs a changé. Résolution : accepter theirs.",
        };
      } else {
        return {
          lines: [...hunk.oursLines],
          reason: "Theirs = base → seul ours a changé. Résolution : accepter ours.",
        };
      }
    }

    case "delete_no_change":
      return {
        lines: [],
        reason: "Un côté a supprimé le bloc, l'autre n'a pas touché. Résolution : supprimer (0 lignes).",
      };

    case "reorder_only": {
      // Résolution : accepter theirs (intent de réordonnancement le plus récent).
      // Exception : si la base est disponible et que son ordre correspond à theirs,
      // c'est ours qui a réordonné → accepter ours.
      const hasBase = hunk.baseLines.length > 0;
      let preferred: string[];
      let side: string;
      if (hasBase && hunk.baseLines.join("\n") === hunk.theirsLines.join("\n")) {
        preferred = [...hunk.oursLines];
        side = "ours";
      } else {
        preferred = [...hunk.theirsLines];
        side = "theirs";
      }
      return {
        lines: preferred,
        reason: `Permutation pure — mêmes lignes, ordre différent. Résolution : accepter ${side}.`,
      };
    }

    case "insertion_at_boundary": {
      // Résolution : base + insertions ours + insertions theirs (diff3)
      //              ou ours + lignes de theirs absentes de ours (diff2)
      const hasBase = hunk.baseLines.length > 0;
      let merged: string[];
      if (hasBase) {
        // Trouver les lignes ajoutées par chaque côté. Comptage MULTISET, pas
        // Set : une insertion textuellement identique à une ligne de base (un
        // `}` dupliqué, une ligne répétée) est une vraie insertion — un simple
        // Set(baseLines) la filtrait et la PERDAIT silencieusement du résultat.
        const baseCount = new Map<string, number>();
        for (const l of hunk.baseLines) baseCount.set(l, (baseCount.get(l) ?? 0) + 1);
        const insertionsOf = (lines: string[]): string[] => {
          const remaining = new Map(baseCount);
          const out: string[] = [];
          for (const l of lines) {
            const n = remaining.get(l) ?? 0;
            if (n > 0) remaining.set(l, n - 1);
            else out.push(l);
          }
          return out;
        };
        const oursInsertions = insertionsOf(hunk.oursLines);
        const theirsInsertions = insertionsOf(hunk.theirsLines);
        merged = [...hunk.baseLines, ...oursInsertions, ...theirsInsertions];
      } else {
        // Heuristique diff2 : union (ours ordre préservé, on ajoute ce qui manque de theirs)
        const oursSet = new Set(hunk.oursLines);
        const theirsOnly = hunk.theirsLines.filter((l) => !oursSet.has(l));
        merged = [...hunk.oursLines, ...theirsOnly];
      }
      return {
        lines: merged,
        reason: `Insertions pures — union des ${hasBase ? "insertions (base + ours + theirs)" : "lignes (heuristique diff2)"}. ${merged.length} lignes dans le résultat.`,
      };
    }

    case "whitespace_only": {
      if (!options.resolveWhitespace || !policyCfg.allowWhitespace) {
        return {
          lines: null,
          reason: !policyCfg.allowWhitespace
            ? `Résolution whitespace désactivée par la politique "${effectivePolicy}".`
            : "Résolution whitespace désactivée par options (resolveWhitespace: false).",
        };
      }
      const wsSide = policyCfg.preferOurs ? "ours" : "theirs";
      return {
        lines: policyCfg.preferOurs ? [...hunk.oursLines] : [...hunk.theirsLines],
        reason: `Seul le whitespace diffère. Résolution : préférer ${wsSide} (politique : ${effectivePolicy}).`,
      };
    }

    case "non_overlapping": {
      if (!options.resolveNonOverlapping || !policyCfg.allowNonOverlapping) {
        return {
          lines: null,
          reason: !policyCfg.allowNonOverlapping
            ? `Résolution non-overlapping désactivée par la politique "${effectivePolicy}".`
            : "Résolution non-overlapping désactivée par options (resolveNonOverlapping: false).",
        };
      }
      const merged = mergeNonOverlapping(
        hunk.baseLines,
        hunk.oursLines,
        hunk.theirsLines,
      );
      if (merged !== null) {
        return {
          lines: merged,
          reason: `Merge LCS 3-way réussi — ${merged.length} lignes dans le résultat fusionné.`,
        };
      }
      return {
        lines: null,
        reason: "Le merge LCS 3-way a échoué (chevauchement détecté au moment de la résolution).",
      };
    }

    case "value_only_change": {
      if (!policyCfg.allowValueOnly) {
        return {
          lines: null,
          reason: `Résolution value_only_change désactivée par la politique "${effectivePolicy}".`,
        };
      }
      const preferred = policyCfg.preferOurs ? hunk.oursLines : hunk.theirsLines;
      const side = policyCfg.preferOurs ? "ours" : "theirs";
      return {
        lines: [...preferred],
        reason: `Même structure, valeur(s) volatile(s) différente(s). Résolution : accepter ${side} (politique : ${effectivePolicy}).`,
      };
    }

    case "token_level_merge":
      // v2.7 — Résolution toujours différée à la confirmation utilisateur (frontend).
      // La proposition calculée est disponible dans hunk.trace.tokenMergeTrace.
      return {
        lines: null,
        reason: "token_level_merge : fusion proposée, confirmation utilisateur requise avant application.",
      };

    case "generated_file": {
      // Smart resolution : si les deux côtés sont identiques après suppression
      // des valeurs volatiles (hashes, timestamps), le conflit est cosmétique
      const oursStripped = stripVolatileValues(hunk.oursLines);
      const theirsStripped = stripVolatileValues(hunk.theirsLines);

      if (oursStripped === theirsStripped) {
        return {
          lines: [...hunk.theirsLines],
          reason: "Fichier auto-généré — contenu structurel identique (seules les valeurs volatiles diffèrent). Résolution : accepter theirs. Suggestion : relancer le build/install.",
        };
      }

      return {
        lines: [...hunk.theirsLines],
        reason: "Fichier auto-généré — le fichier sera régénéré après merge. Résolution : accepter theirs. Suggestion : relancer le build/install.",
      };
    }

    case "refactoring_aware_merge": {
      // v2.6 — Récupérer le résultat RefMerge mis en cache par detect()
      // (évite de recalculer la détection + merge + rejeu une deuxième fois)
      const cached = getLastRefMergeResult();
      if (cached?.lines !== null && cached?.lines !== undefined) {
        return { lines: cached.lines, reason: cached.reason };
      }
      // Fallback si le cache est invalide (ne devrait pas arriver)
      return {
        lines: null,
        reason: "RefMerge : résultat non disponible en cache — résolution manuelle requise.",
      };
    }

    case "llm_proposed":
      // La résolution effective est gérée par runLlmFallbackPhase() dans resolveAsync().
      // assembleResolution() n'est pas censé être appelé directement pour llm_proposed.
      return {
        lines: null,
        reason: "llm_proposed : résolution différée au pipeline LLM asynchrone.",
      };

    case "complex":
      return {
        lines: null,
        reason: "Conflit complexe — aucune heuristique automatique applicable. Résolution manuelle requise.",
      };

    default:
      return {
        lines: null,
        reason: `Type de conflit inconnu : ${hunk.type}.`,
      };
  }
}
