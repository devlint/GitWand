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
import { pickNewerSemverSide, hasUnorderableVersionPair } from "../patterns/utils.js";

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
        reason: "Same edit on both sides, so the resolution is trivial (ours = theirs).",
      };

    case "one_side_change": {
      const baseText = hunk.baseLines.join("\n");
      const oursText = hunk.oursLines.join("\n");
      if (oursText === baseText) {
        return {
          lines: [...hunk.theirsLines],
          reason: "Ours = base, so only theirs changed. Resolution: take theirs.",
        };
      } else {
        return {
          lines: [...hunk.oursLines],
          reason: "Theirs = base, so only ours changed. Resolution: take ours.",
        };
      }
    }

    case "delete_no_change":
      return {
        lines: [],
        reason: "One side deleted the block and the other left it untouched. Resolution: delete (0 lines).",
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
        reason: `Pure permutation: same lines, different order. Resolution: take ${side}.`,
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
        reason: `Pure insertions: union of the ${hasBase ? "insertions (base + ours + theirs)" : "lines (diff2 heuristic)"}. ${merged.length} lines in the result.`,
      };
    }

    case "whitespace_only": {
      if (!options.resolveWhitespace || !policyCfg.allowWhitespace) {
        return {
          lines: null,
          reason: !policyCfg.allowWhitespace
            ? `Whitespace resolution disabled by the "${effectivePolicy}" policy.`
            : "Whitespace resolution disabled by options (resolveWhitespace: false).",
        };
      }
      const wsSide = policyCfg.preferOurs ? "ours" : "theirs";
      return {
        lines: policyCfg.preferOurs ? [...hunk.oursLines] : [...hunk.theirsLines],
        reason: `Only whitespace differs. Resolution: prefer ${wsSide} (policy: ${effectivePolicy}).`,
      };
    }

    case "non_overlapping": {
      if (!options.resolveNonOverlapping || !policyCfg.allowNonOverlapping) {
        return {
          lines: null,
          reason: !policyCfg.allowNonOverlapping
            ? `Non-overlapping resolution disabled by the "${effectivePolicy}" policy.`
            : "Non-overlapping resolution disabled by options (resolveNonOverlapping: false).",
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
          reason: `3-way LCS merge succeeded: ${merged.length} lines in the merged result.`,
        };
      }
      return {
        lines: null,
        reason: "The 3-way LCS merge failed (an overlap was detected at resolution time).",
      };
    }

    case "value_only_change": {
      if (!policyCfg.allowValueOnly) {
        return {
          lines: null,
          reason: `value_only_change resolution disabled by the "${effectivePolicy}" policy.`,
        };
      }
      const semverSide = pickNewerSemverSide(hunk.oursLines, hunk.theirsLines);
      const versionish = hasUnorderableVersionPair(hunk.oursLines, hunk.theirsLines);
      const ctx = options.mergeContext;

      // accuracy lot C — Un scalaire de version NON ordonnable fixé différemment des
      // deux côtés ('13.x-dev' vs '12.54.1', '2.9.0-dev'…) est l'identité de
      // version du fichier sur la branche cible : avec le contexte, la cible
      // garde sa valeur. Mesuré sur benchmark/ : laravel 36,6 % → 81,5 %
      // d'accord. Les paires ORDONNABLES (deps bumpées des deux côtés) gardent
      // en revanche « la plus récente gagne » même avec contexte — la première
      // version de cette règle les basculait aussi vers la cible, et l'accord
      // régressait sur prettier/vue/express (les humains prennent bien la dep
      // la plus récente apportée par la branche source).
      if (ctx && versionish && semverSide === null) {
        const side = ctx.targetSide;
        const refs = ctx.oursRef && ctx.theirsRef ? ` (${ctx.theirsRef} → ${ctx.oursRef})` : "";
        return {
          lines: side === "ours" ? [...hunk.oursLines] : [...hunk.theirsLines],
          reason: `Version changed on both sides during a ${ctx.operation}${refs} — the target branch keeps its value. Resolution: take ${side}.`,
        };
      }

      // Sans contexte : les paires semver/datetime ordonnables gardent la règle
      // historique « la plus récente gagne » (déterministe et testée)…
      if (semverSide !== null) {
        return {
          lines: semverSide === "ours" ? [...hunk.oursLines] : [...hunk.theirsLines],
          reason: `Same structure, differing semver version(s). Resolution: take ${semverSide} (the higher version).`,
        };
      }
      // …mais une paire version NON ordonnable ('13.x-dev' vs '12.54.1') ne
      // retombe plus sur la politique : mesurée fausse ~3 fois sur 4, c'est une
      // proposition, pas une application.
      if (versionish) {
        return {
          lines: null,
          reason: "Version changed on both sides with non-comparable values — this is a merge decision, not volatility. The target branch wins when context is known (auto-detected by the CLI and desktop); here it isn't, so GitWand proposes instead of applying.",
        };
      }
      const preferred = policyCfg.preferOurs ? hunk.oursLines : hunk.theirsLines;
      const side = policyCfg.preferOurs ? "ours" : "theirs";
      return {
        lines: [...preferred],
        reason: `Same structure, differing volatile value(s). Resolution: take ${side} (policy: ${effectivePolicy}).`,
      };
    }

    case "token_level_merge":
      // v3.4 — Résolution toujours différée à la confirmation utilisateur (frontend).
      // La proposition calculée est disponible dans hunk.trace.tokenMergeTrace.
      return {
        lines: null,
        reason: "token_level_merge: merge proposed, user confirmation required before it is applied.",
      };

    case "generated_file": {
      // accuracy lot 1 — Par défaut, on DÉCLINE : la version commitée d'un fichier
      // généré est la sortie d'un outil, pas la fusion de deux textes.
      // Mesuré sur le corpus benchmark/ : « accepter theirs » divergeait de
      // ce que les équipes livrent dans ~100 % des cas. Décliner avec un
      // message actionnable vaut mieux qu'une fusion silencieusement fausse.
      const oursStripped = stripVolatileValues(hunk.oursLines);
      const theirsStripped = stripVolatileValues(hunk.theirsLines);
      const cosmetic = oursStripped === theirsStripped;

      if (!options.resolveGeneratedFiles) {
        return {
          lines: null,
          reason: cosmetic
            ? "Generated file — only volatile differences (hashes/timestamps). Resolve the source file (e.g. package.json) then regenerate this one with its tool (install/build). Auto-resolution available via resolveGeneratedFiles: true."
            : "Generated file — not merged, regenerated. Resolve the source file (e.g. package.json) then re-run the tool that produces this one (install/build). Auto-resolution (take theirs) available via resolveGeneratedFiles: true.",
        };
      }

      // Opt-in resolveGeneratedFiles: true — comportement historique.
      if (cosmetic) {
        return {
          lines: [...hunk.theirsLines],
          reason: "Generated file with identical structure (only volatile values differ). Resolution: take theirs. Suggestion: re-run the build or install.",
        };
      }
      return {
        lines: [...hunk.theirsLines],
        reason: "Generated file: it will be rebuilt after the merge. Resolution: take theirs (opt-in resolveGeneratedFiles). Suggestion: re-run the build or install.",
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
        reason: "RefMerge: no cached result available, so manual resolution is required.",
      };
    }

    case "llm_proposed":
      // La résolution effective est gérée par runLlmFallbackPhase() dans resolveAsync().
      // assembleResolution() n'est pas censé être appelé directement pour llm_proposed.
      return {
        lines: null,
        reason: "llm_proposed: resolution deferred to the asynchronous LLM pipeline.",
      };

    case "complex":
      return {
        lines: null,
        reason: "Complex conflict: no automatic heuristic applies. Manual resolution required.",
      };

    default:
      return {
        lines: null,
        reason: `Unknown conflict type: ${hunk.type}.`,
      };
  }
}
