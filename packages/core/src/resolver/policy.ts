/**
 * Politique de merge effective + helpers de scoring.
 *
 * Regroupe :
 * - `DEFAULT_OPTIONS` — valeurs par défaut des `GitWandOptions`
 * - `CONFIDENCE_ORDER` — ordre total sur les labels de confiance
 * - `computeEffectivePolicy` — résout la politique applicable à un fichier
 *   (glob overrides > politique globale) et sa `PolicyConfig` dérivée
 * - `computeEffectiveMinConfidence` — seuil de confiance effectif (min entre
 *   option globale et politique, donc le plus permissif des deux)
 * - `applyFileFrequencyPenalty` — v1.4 « zone chaude » : pénalise la confiance
 *   d'un hunk si le même fichier contient déjà des hunks complexes non résolus
 *
 * Extrait de `resolver.ts` lors du split P1.1.
 */

import type { ConflictHunk, Confidence, GitWandOptions } from "../types.js";
import {
  DEFAULT_POLICY,
  effectivePolicyForFile,
  policyToConfig,
  type MergePolicy,
  type PolicyConfig,
} from "../config.js";

/** Options par défaut. */
export const DEFAULT_OPTIONS: Required<GitWandOptions> = {
  resolveWhitespace: true,
  resolveNonOverlapping: true,
  minConfidence: "high",
  verbose: false,
  explainOnly: false,
  policy: DEFAULT_POLICY,
  patternOverrides: {},
  generatedFiles: [],
  // v2.2 — profils de format actifs par défaut
  disableFormatProfiles: false,
};

/** Ordre de confiance pour comparaison. */
export const CONFIDENCE_ORDER: Record<Confidence, number> = {
  certain: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Résout la politique effective pour un fichier donné.
 *
 * La priorité est : pattern-override le plus spécifique → politique globale.
 * Retourne à la fois la politique et sa `PolicyConfig` dérivée, afin de ne
 * pas recalculer la conversion chez les appelants.
 */
export function computeEffectivePolicy(
  filePath: string,
  options: Required<GitWandOptions>,
): { policy: MergePolicy; cfg: PolicyConfig } {
  const policy = effectivePolicyForFile(
    filePath,
    options.policy,
    options.patternOverrides,
  );
  return { policy, cfg: policyToConfig(policy) };
}

/**
 * Calcule le seuil de confiance effectif : le `min` entre la politique et
 * l'option globale. Motivation : la politique peut abaisser le seuil, et
 * une option explicite peut aussi l'abaisser en dessous du défaut de la
 * politique — on prend donc toujours le plus permissif.
 */
export function computeEffectiveMinConfidence(
  policyCfg: PolicyConfig,
  options: Required<GitWandOptions>,
): Confidence {
  return CONFIDENCE_ORDER[policyCfg.minConfidence] < CONFIDENCE_ORDER[options.minConfidence]
    ? policyCfg.minConfidence
    : options.minConfidence;
}

/**
 * v1.4 — Applique la pénalité « zone chaude » sur la confiance d'un hunk si
 * `priorComplexHunks > 0` hunks complexes non résolus ont déjà été vus dans
 * le même fichier. Ne s'applique pas aux hunks `complex` eux-mêmes.
 *
 * La formule recalcule `score` à partir des dimensions, avec :
 *   `fileFrequency = min(100, priorComplexHunks × 20)`
 *   `score = typeClassification − 0.40·dataRisk − 0.15·scopeImpact
 *            − 0.10·fileFrequency + 0.05·baseAvailability`
 *
 * Les labels sont re-dérivés via les seuils : 92 / 68 / 44.
 */
export function applyFileFrequencyPenalty(
  hunk: ConflictHunk,
  priorComplexHunks: number,
): ConflictHunk {
  if (priorComplexHunks <= 0 || hunk.type === "complex") {
    return hunk;
  }

  const ff = Math.min(100, priorComplexHunks * 20);
  const d = hunk.confidence.dimensions;
  const raw =
    d.typeClassification
    - d.dataRisk        * 0.40
    - d.scopeImpact     * 0.15
    - ff                * 0.10
    + (d.baseAvailability ?? 0) * 0.05;
  const newScore = Math.round(Math.max(0, Math.min(100, raw)));
  const newLabel: Confidence =
    newScore >= 92 ? "certain"
    : newScore >= 68 ? "high"
    : newScore >= 44 ? "medium"
    : "low";

  return {
    ...hunk,
    confidence: {
      ...hunk.confidence,
      score: newScore,
      label: newLabel,
      dimensions: { ...d, fileFrequency: ff },
      penalties: [
        ...hunk.confidence.penalties,
        `Zone chaude — ${priorComplexHunks} hunk${priorComplexHunks > 1 ? "s" : ""} complexe${priorComplexHunks > 1 ? "s" : ""} déjà vus dans ce fichier (−${(ff * 0.10).toFixed(1)} pts)`,
      ],
    },
  };
}
