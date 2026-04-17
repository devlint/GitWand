/**
 * GitWand — Utilitaires partagés entre les patterns
 *
 * Contient les fonctions de scoring, de normalisation et de détection
 * de valeurs volatiles utilisées par plusieurs PatternPlugin.
 */

import type { Confidence, ConfidenceScore } from "../types.js";

// ─── Scoring ─────────────────────────────────────────────────

/**
 * Calcule le scopeImpact à partir du nombre total de lignes concernées.
 * 1–2 lignes → 0, 3–10 → 15, 11–30 → 35, >30 → 55
 */
export function scopeImpact(lines: number): number {
  if (lines <= 2) return 0;
  if (lines <= 10) return 15;
  if (lines <= 30) return 35;
  return 55;
}

/**
 * Dérive le label Confidence depuis un score numérique 0–100.
 * - score ≥ 92 → "certain"
 * - score ≥ 68 → "high"
 * - score ≥ 44 → "medium"
 * - score <  44 → "low"
 */
export function labelFromScore(score: number): Confidence {
  if (score >= 92) return "certain";
  if (score >= 68) return "high";
  if (score >= 44) return "medium";
  return "low";
}

/**
 * Construit un ConfidenceScore à partir des dimensions et des justifications.
 *
 * Formule v1.4 :
 *   `score = typeClassification
 *           − dataRisk        × 0.40
 *           − scopeImpact     × 0.15
 *           − fileFrequency   × 0.10
 *           + baseAvailability × 0.05`
 *
 * `fileFrequency` et `baseAvailability` sont optionnels (défaut 0) pour
 * la compatibilité ascendante avec les patterns existants.
 */
export function makeScore(
  typeClassification: number,
  dataRisk: number,
  si: number,
  boosters: string[],
  penalties: string[],
  fileFrequency = 0,
  baseAvailability = 0,
): ConfidenceScore {
  const raw =
    typeClassification
    - dataRisk        * 0.40
    - si              * 0.15
    - fileFrequency   * 0.10
    + baseAvailability * 0.05;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  return {
    score,
    label: labelFromScore(score),
    dimensions: { typeClassification, dataRisk, scopeImpact: si, fileFrequency, baseAvailability },
    boosters,
    penalties,
  };
}

// ─── Normalisation whitespace ─────────────────────────────────

/**
 * Normalise les lignes d'un bloc pour la comparaison whitespace-only.
 *
 * Étapes :
 *  1. Tabs → 2 espaces
 *  2. Trim leading/trailing sur chaque ligne
 *  3. Strip des lignes vides en tête et queue du bloc
 *  4. Collapse des espaces internes multiples → un seul espace
 */
export function normalizeForWhitespaceCheck(lines: string[]): string {
  let normalized = lines.map((l) => l.replace(/\t/g, "  "));
  normalized = normalized.map((l) => l.trim());
  while (normalized.length > 0 && normalized[0] === "") normalized.shift();
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") normalized.pop();
  normalized = normalized.map((l) => l.replace(/  +/g, " "));
  return normalized.join("\n");
}

/**
 * Normalise une ligne individuelle pour les comparaisons de patterns
 * (reorder_only, insertion_at_boundary).
 * Tabs → espaces, trim, collapse.
 */
export function normalizeLine(line: string): string {
  return line.replace(/\t/g, "  ").trim().replace(/  +/g, " ");
}

// ─── Détection de valeurs volatiles ──────────────────────────

/** Regex qui matche les tokens "volatiles" : hashes, UUIDs, semver, timestamps, URLs */
export const VOLATILE_PATTERNS = [
  /^[a-f0-9]{7,64}$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d]{6,20}$/,
  /^[~^>=<]*\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/,
  /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?([Z+\-]\S*)?$/,
  /^(https?:)?\/\/\S+$/,
  /^[a-z][a-z0-9]{1,9}-[A-Za-z0-9+/=]{8,}$/,
];

/**
 * Vérifie si deux tokens diffèrent uniquement par une sous-chaîne "hash-like".
 */
export function isPairwiseVolatile(a: string, b: string): boolean {
  if (a === b) return false;

  let prefixLen = 0;
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const aRem = a.length - prefixLen;
  const bRem = b.length - prefixLen;
  while (
    suffixLen < aRem &&
    suffixLen < bRem &&
    a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  if (prefixLen + suffixLen === 0) return false;

  const aMid = a.slice(prefixLen, suffixLen > 0 ? a.length - suffixLen : undefined);
  const bMid = b.slice(prefixLen, suffixLen > 0 ? b.length - suffixLen : undefined);

  if (aMid.length === 0 || bMid.length === 0) return false;

  const isHashLikeMid = (s: string): boolean => {
    if (VOLATILE_PATTERNS.some((p) => p.test(s))) return true;
    if (s.length >= 7 && /^[A-Za-z\d]+$/.test(s)) {
      const upper = (s.match(/[A-Z]/g) ?? []).length;
      const lower = (s.match(/[a-z]/g) ?? []).length;
      if (upper >= 2 && lower >= 2) return true;
    }
    return false;
  };

  return isHashLikeMid(aMid) && isHashLikeMid(bMid);
}

/**
 * Tokenize une ligne en parties structurelles et valeurs.
 */
export function tokenizeLine(line: string): string[] {
  return line.split(/(\s+|[{}[\](),:;"'`=<>])/);
}

/**
 * Détecte si deux ensembles de lignes ne diffèrent que par des valeurs atomiques.
 * Retourne un résultat de classification ou null si non applicable.
 */
export function detectValueOnlyChange(
  oursLines: string[],
  theirsLines: string[],
): { confidenceScore: ConfidenceScore; explanation: string; traceReason: string } | null {
  if (oursLines.length !== theirsLines.length) return null;
  if (oursLines.length === 0) return null;

  let diffCount = 0;
  let totalTokens = 0;
  let allDiffsAreVolatile = true;

  for (let i = 0; i < oursLines.length; i++) {
    const oursTokens = tokenizeLine(oursLines[i]);
    const theirsTokens = tokenizeLine(theirsLines[i]);

    if (oursTokens.length !== theirsTokens.length) {
      allDiffsAreVolatile = false;
      break;
    }

    totalTokens += oursTokens.length;

    for (let j = 0; j < oursTokens.length; j++) {
      if (oursTokens[j] !== theirsTokens[j]) {
        diffCount++;
        const isOursVolatile = VOLATILE_PATTERNS.some((p) => p.test(oursTokens[j]));
        const isTheirsVolatile = VOLATILE_PATTERNS.some((p) => p.test(theirsTokens[j]));
        if (!isOursVolatile && !isTheirsVolatile) {
          if (!isPairwiseVolatile(oursTokens[j], theirsTokens[j])) {
            allDiffsAreVolatile = false;
            break;
          }
        }
      }
    }

    if (!allDiffsAreVolatile) break;
  }

  if (!allDiffsAreVolatile || diffCount === 0) return null;

  const diffRatio = diffCount / Math.max(totalTokens, 1);
  const typeClassification =
    diffRatio <= 0.10 ? 88
    : diffRatio <= 0.20 ? 72
    : diffRatio <= 0.30 ? 55
    : 0;

  if (typeClassification < 55) return null;

  const si = scopeImpact(oursLines.length);
  const confidenceScore = makeScore(typeClassification, 25, si, [
    `${diffCount} token${diffCount > 1 ? "s" : ""} identifié${diffCount > 1 ? "s" : ""} comme volatile${diffCount > 1 ? "s" : ""} (hash, version, timestamp…)`,
    "Même structure de lignes",
  ], [
    `Ratio de différences : ${(diffRatio * 100).toFixed(1)}%`,
    "Sans base (diff2) — heuristique basée sur les patterns volatils",
  ]);

  if (confidenceScore.label === "low") return null;

  const explanation =
    `Même structure avec ${diffCount} valeur${diffCount > 1 ? "s" : ""} volatile${diffCount > 1 ? "s" : ""} différente${diffCount > 1 ? "s" : ""} (hash, version, timestamp…). Résolution proposée : accepter la version la plus récente (theirs).`;

  const traceReason =
    `${diffCount} token${diffCount > 1 ? "s" : ""} différent${diffCount > 1 ? "s" : ""} sur ${totalTokens} — tous identifiés comme volatiles (hash, version, timestamp…). Ratio : ${(diffRatio * 100).toFixed(1)}% → score ${confidenceScore.score} (${confidenceScore.label}).`;

  return { confidenceScore, explanation, traceReason };
}
