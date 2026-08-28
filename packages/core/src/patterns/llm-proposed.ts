import type { ClassifyInput, ConfidenceScore, PatternPlugin } from "../types.js";
import { makeScore } from "./utils.js";

/**
 * v2.5 — Pattern de fallback LLM (priority 998, juste avant `complex` à 999).
 *
 * Ce plugin est désactivé par défaut : `detect()` retourne toujours `false`
 * sauf quand le flag interne `_llmFallbackEnabled` est activé par `resolveAsync()`
 * avant de lancer la classification.
 *
 * ## Design
 *
 * Le `PatternPlugin.detect()` ne reçoit pas les options (contrainte du registre).
 * L'activation se fait via un flag module-level positionné par `resolveAsync()` :
 *
 * ```ts
 * // Dans resolveAsync() :
 * setLlmFallbackEnabled(true);
 * const result = classifyConflict(hunk);
 * setLlmFallbackEnabled(false);
 * ```
 *
 * La résolution effective (appel LLM) a lieu en phase 5 de `resolveAsync()`,
 * après la classification. Le score initial (`dataRisk: 60, typeClassification: 50`)
 * est volontairement médiocre — la décision finale dépend de la validation post-merge.
 */

/** Flag interne — positionné par `resolveAsync()` avant classification */
let _llmFallbackEnabled = false;

/** Active ou désactive le pattern llm_proposed pour la prochaine classification. */
export function setLlmFallbackEnabled(enabled: boolean): void {
  _llmFallbackEnabled = enabled;
}

/** Retourne l'état actuel du flag (utile pour les tests). */
export function isLlmFallbackEnabled(): boolean {
  return _llmFallbackEnabled;
}

const llmProposed: PatternPlugin = {
  type: "llm_proposed",
  priority: 998,
  requires: "both",

  detect(_h: ClassifyInput): boolean {
    // OFF par défaut. Activé uniquement par resolveAsync() via setLlmFallbackEnabled(true).
    return _llmFallbackEnabled;
  },

  confidence(_h: ClassifyInput): ConfidenceScore {
    // Score initial volontairement médiocre (dataRisk élevé, typeClassification moyen).
    // La résolution sera acceptée ou rejetée selon la validation post-merge stricte.
    return makeScore(
      50,   // typeClassification : incertitude sur la qualité de la résolution LLM
      60,   // dataRisk : risque non nul d'hallucination
      0,    // scopeImpact : inconnu à ce stade
      [],   // boosters
      [
        "Non-deterministic resolution (LLM)",
        "Strict post-merge validation required before acceptance",
      ],
    );
  },

  explanation(_h: ClassifyInput): string {
    return "Resolution proposed by the LLM fallback. The hunk is sent to the configured LLM endpoint for an assisted resolution, which is validated (parse tree plus tsc/eslint) before it can be accepted.";
  },

  passReason(_h: ClassifyInput): string {
    return "No deterministic pattern applies; delegating to the LLM fallback (opt-in).";
  },

  failReason(_h: ClassifyInput): string {
    return "LLM fallback disabled (options.llmFallback.enabled !== true).";
  },
};

export default llmProposed;
