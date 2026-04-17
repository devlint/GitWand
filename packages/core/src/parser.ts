/**
 * GitWand Conflict Parser
 *
 * Parse les fichiers contenant des marqueurs de conflit Git
 * et extrait les hunks structurés.
 *
 * v1.4 : classifyConflict() est maintenant implémenté dans classifier.ts
 * via un registre de PatternPlugin. Ce fichier re-exporte classifyConflict
 * pour la compatibilité ascendante — toutes les signatures publiques sont inchangées.
 */

import type { ConflictHunk, ClassifyInput, ConfidenceScore } from "./types.js";
import { classifyConflict } from "./classifier.js";

export { classifyConflict };

/** Alias backward-compatible — identique à ClassifyInput */
export type RawConflict = ClassifyInput;

// ─── zdiff3 detection ─────────────────────────────────────────

/**
 * Détecte si un conflit a été généré par `git merge --diff3` en style zdiff3.
 *
 * En zdiff3 (Git 2.35+), la section base ne montre que les lignes qui divergent
 * des deux côtés — c'est une version tronquée de la vraie base.
 *
 * Heuristique : la base non-vide est un sous-ensemble strict de ours OU de theirs.
 * (Si la base était complète, elle contiendrait toutes les lignes communes.)
 *
 * @param conflict - Le conflit brut parsé
 * @returns true si le conflit ressemble à du zdiff3
 */
function detectZdiff3(conflict: RawConflict): boolean {
  const { baseLines, oursLines, theirsLines } = conflict;
  if (baseLines.length === 0) return false; // diff2 — pas de base du tout

  const oursSet   = new Set(oursLines);
  const theirsSet = new Set(theirsLines);

  const baseSubsetOfOurs   = baseLines.every((l) => oursSet.has(l));
  const baseSubsetOfTheirs = baseLines.every((l) => theirsSet.has(l));

  return baseSubsetOfOurs || baseSubsetOfTheirs;
}

/**
 * Applique la dimension `baseAvailability` à un ConfidenceScore existant.
 *
 * Recompute le score avec la formule v1.4 complète.
 * Utilisé quand zdiff3 est détecté après la classification (baseAvailability = 100).
 */
function withBaseAvailability(cs: ConfidenceScore, baseAvailability: number, booster?: string): ConfidenceScore {
  const { typeClassification, dataRisk, scopeImpact, fileFrequency = 0 } = cs.dimensions;
  const raw =
    typeClassification
    - dataRisk        * 0.40
    - scopeImpact     * 0.15
    - fileFrequency   * 0.10
    + baseAvailability * 0.05;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  const boosters = booster ? [...cs.boosters, booster] : cs.boosters;
  return {
    ...cs,
    score,
    label: score >= 92 ? "certain" : score >= 68 ? "high" : score >= 44 ? "medium" : "low",
    dimensions: { ...cs.dimensions, baseAvailability },
    boosters,
  };
}

/** Marqueurs de conflit Git standard */
const MARKER_OURS = /^<{7}\s/;
const MARKER_BASE = /^\|{7}\s/;
const MARKER_SEPARATOR = /^={7}$/;
const MARKER_THEIRS = /^>{7}\s/;

/**
 * Parse un fichier avec des marqueurs de conflit Git.
 *
 * Supporte les formats diff2 (sans base) et diff3 (avec base).
 *
 * @param content - Le contenu du fichier avec marqueurs de conflit
 * @returns Les segments (texte résolu + conflits bruts) dans l'ordre
 */
export function parseConflictMarkers(content: string): {
  segments: Array<{ type: "text"; lines: string[] } | { type: "conflict"; conflict: RawConflict }>;
} {
  const lines = content.split("\n");
  const segments: Array<
    { type: "text"; lines: string[] } | { type: "conflict"; conflict: RawConflict }
  > = [];

  let currentText: string[] = [];
  let inConflict = false;
  let section: "ours" | "base" | "theirs" = "ours";
  let conflictStart = 0;
  let oursLines: string[] = [];
  let baseLines: string[] = [];
  let theirsLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (MARKER_OURS.test(line)) {
      if (currentText.length > 0) {
        segments.push({ type: "text", lines: [...currentText] });
        currentText = [];
      }
      inConflict = true;
      section = "ours";
      conflictStart = i + 1; // 1-indexed
      oursLines = [];
      baseLines = [];
      theirsLines = [];
      continue;
    }

    if (inConflict && MARKER_BASE.test(line)) {
      section = "base";
      continue;
    }

    if (inConflict && MARKER_SEPARATOR.test(line)) {
      section = "theirs";
      continue;
    }

    if (inConflict && MARKER_THEIRS.test(line)) {
      segments.push({
        type: "conflict",
        conflict: {
          oursLines: [...oursLines],
          baseLines: [...baseLines],
          theirsLines: [...theirsLines],
          startLine: conflictStart,
          endLine: i + 1,
        },
      });
      inConflict = false;
      continue;
    }

    if (inConflict) {
      switch (section) {
        case "ours":   oursLines.push(line); break;
        case "base":   baseLines.push(line); break;
        case "theirs": theirsLines.push(line); break;
      }
    } else {
      currentText.push(line);
    }
  }

  if (currentText.length > 0) {
    segments.push({ type: "text", lines: currentText });
  }

  return { segments };
}

/**
 * Convertit un conflit brut en ConflictHunk typé avec trace.
 *
 * v1.4 : détecte automatiquement zdiff3 et ajuste `baseAvailability` en conséquence.
 */
export function toConflictHunk(conflict: RawConflict): ConflictHunk {
  const { type, confidence, explanation, trace } = classifyConflict(conflict);

  const isZdiff3 = detectZdiff3(conflict);
  const adjustedConfidence = isZdiff3
    ? withBaseAvailability(confidence, 100, "zdiff3 — base tronquée aux sections divergentes")
    : confidence;

  return {
    baseLines: conflict.baseLines,
    oursLines: conflict.oursLines,
    theirsLines: conflict.theirsLines,
    startLine: conflict.startLine,
    type,
    confidence: adjustedConfidence,
    explanation,
    trace,
    ...(isZdiff3 ? { zdiff3: true } : {}),
  };
}
