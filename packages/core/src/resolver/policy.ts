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

import type { ConflictHunk, Confidence, ConfidenceScore, GitWandOptions } from "../types.js";
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
  // v3.11 — barre numérique désactivée par défaut (cf. GitWandOptions)
  minConfidenceScore: null,
  verbose: false,
  explainOnly: false,
  policy: DEFAULT_POLICY,
  patternOverrides: {},
  generatedFiles: [],
  // accuracy lot 1 — les fichiers générés déclinent par défaut (voir GitWandOptions)
  resolveGeneratedFiles: false,
  // accuracy lot C — contexte de merge inconnu par défaut ; fourni par les appelants
  mergeContext: null,
  // accuracy lot D — pas de contexte de régénération par défaut ; fourni par les appelants
  regenerationContext: null,
  // accuracy lot F — pas de conventions dérivées par défaut
  conventions: null,
  // v2.2 — profils de format actifs par défaut
  disableFormatProfiles: false,
  // v2.4 — validation post-merge
  validationLevel: "balanced",
  validationTools: ["tsc"],
  // v2.5 — LLM fallback (désactivé par défaut)
  llmFallback: { enabled: false },
  // v2.6 — RefMerge (désactivé par défaut)
  refactoringAware: { enabled: false },
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
 * v3.11 — Normalise la barre numérique : seul un nombre fini dans [0, 100]
 * est retenu, tout le reste désactive la barre. Une valeur hors bornes ou
 * `NaN` ne doit jamais durcir *ni* relâcher le comportement par défaut.
 */
export function normalizeMinScore(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/** Résultat de la double barrière (label puis score). */
export type ConfidenceGateResult =
  | { passed: true }
  | { passed: false; failedOn: "label"; required: Confidence }
  | { passed: false; failedOn: "score"; required: number };

/**
 * v3.11 — Barrière de confiance unique, partagée par les deux sites d'appel
 * de `resolveHunk` (chemin format-aware et chemin textuel).
 *
 * Les deux critères sont combinés en ET, et le label est évalué en premier :
 * la barre numérique ne peut que *retirer* des hunks de l'ensemble appliqué,
 * jamais en ajouter. Voir `GitWandOptions.minConfidenceScore` pour pourquoi
 * c'est structurel et non un détail d'implémentation.
 */
export function checkConfidenceGate(
  confidence: ConfidenceScore,
  minLabel: Confidence,
  minScore: number | null,
): ConfidenceGateResult {
  if (CONFIDENCE_ORDER[confidence.label] < CONFIDENCE_ORDER[minLabel]) {
    return { passed: false, failedOn: "label", required: minLabel };
  }
  const bar = normalizeMinScore(minScore);
  if (bar !== null && confidence.score < bar) {
    return { passed: false, failedOn: "score", required: bar };
  }
  return { passed: true };
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
        `Hot spot: ${priorComplexHunks} complex hunk${priorComplexHunks > 1 ? "s" : ""} already seen in this file (−${(ff * 0.10).toFixed(1)} pts)`,
      ],
    },
  };
}
