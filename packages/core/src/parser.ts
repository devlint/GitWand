/**
 * GitWand Conflict Parser
 *
 * Parse les fichiers contenant des marqueurs de conflit Git
 * et extrait les hunks structurés.
 */

import type { ConflictHunk, ConflictType, Confidence } from "./types.js";
import { mergeNonOverlapping } from "./diff.js";

/** Marqueurs de conflit Git standard */
const MARKER_OURS = /^<{7}\s/;
const MARKER_BASE = /^\|{7}\s/;
const MARKER_SEPARATOR = /^={7}$/;
const MARKER_THEIRS = /^>{7}\s/;

/** Représente un conflit brut extrait du fichier */
export interface RawConflict {
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
  startLine: number;
  endLine: number;
}

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
      // Début d'un conflit
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
      // Début de la section base (diff3)
      section = "base";
      continue;
    }

    if (inConflict && MARKER_SEPARATOR.test(line)) {
      // Séparateur entre ours/base et theirs
      section = "theirs";
      continue;
    }

    if (inConflict && MARKER_THEIRS.test(line)) {
      // Fin du conflit
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
        case "ours":
          oursLines.push(line);
          break;
        case "base":
          baseLines.push(line);
          break;
        case "theirs":
          theirsLines.push(line);
          break;
      }
    } else {
      currentText.push(line);
    }
  }

  // Texte restant après le dernier conflit
  if (currentText.length > 0) {
    segments.push({ type: "text", lines: currentText });
  }

  return { segments };
}

/**
 * Classifie un conflit brut en déterminant son type et sa confiance.
 */
export function classifyConflict(conflict: RawConflict): {
  type: ConflictType;
  confidence: Confidence;
  explanation: string;
} {
  const { oursLines, baseLines, theirsLines } = conflict;

  const oursText = oursLines.join("\n");
  const theirsText = theirsLines.join("\n");
  const baseText = baseLines.join("\n");

  // 1. Same change — les deux côtés ont fait la même modification
  if (oursText === theirsText) {
    return {
      type: "same_change",
      confidence: "certain",
      explanation: "Les deux branches ont effectué exactement la même modification.",
    };
  }

  // Si on a la base (diff3), on peut faire des comparaisons plus fines
  if (baseLines.length > 0) {
    const oursMatchesBase = oursText === baseText;
    const theirsMatchesBase = theirsText === baseText;

    // 2. Delete + no change — un côté supprime, l'autre n'a pas touché
    //    (testé AVANT one_side_change car c'est un cas plus spécifique)
    if (oursLines.length === 0 && theirsMatchesBase) {
      return {
        type: "delete_no_change",
        confidence: "certain",
        explanation:
          "La branche courante (ours) a supprimé ce bloc, l'autre ne l'a pas modifié. Résolution : supprimer.",
      };
    }

    if (theirsLines.length === 0 && oursMatchesBase) {
      return {
        type: "delete_no_change",
        confidence: "certain",
        explanation:
          "La branche entrante (theirs) a supprimé ce bloc, l'autre ne l'a pas modifié. Résolution : supprimer.",
      };
    }

    // 3. One-side change — seul un côté a changé par rapport à la base
    if (oursMatchesBase && !theirsMatchesBase) {
      return {
        type: "one_side_change",
        confidence: "certain",
        explanation:
          "Seule la branche entrante (theirs) a modifié ce bloc. Résolution : accepter theirs.",
      };
    }

    if (!oursMatchesBase && theirsMatchesBase) {
      return {
        type: "one_side_change",
        confidence: "certain",
        explanation:
          "Seule la branche courante (ours) a modifié ce bloc. Résolution : accepter ours.",
      };
    }

    // 4. Non-overlapping — les deux côtés ont changé mais à des endroits différents
    //    On tente un merge 3-way pour voir si les edits sont non-overlapping
    const merged = mergeNonOverlapping(baseLines, oursLines, theirsLines);
    if (merged !== null) {
      return {
        type: "non_overlapping",
        confidence: "high",
        explanation:
          "Les deux branches ont modifié des zones différentes du même bloc. Fusion automatique possible.",
      };
    }
  }

  // 5. Whitespace-only — différences de whitespace uniquement
  const oursNormalized = oursLines.map((l) => l.trim()).join("\n");
  const theirsNormalized = theirsLines.map((l) => l.trim()).join("\n");

  if (oursNormalized === theirsNormalized) {
    return {
      type: "whitespace_only",
      confidence: "high",
      explanation:
        "Les deux branches contiennent le même code avec des différences de whitespace uniquement.",
    };
  }

  // 5. Fallback — conflit complexe
  return {
    type: "complex",
    confidence: "low",
    explanation:
      "Conflit complexe nécessitant une résolution manuelle. Les deux branches ont modifié ce bloc différemment.",
  };
}

/**
 * Convertit un conflit brut en ConflictHunk typé.
 */
export function toConflictHunk(conflict: RawConflict): ConflictHunk {
  const { type, confidence, explanation } = classifyConflict(conflict);

  return {
    baseLines: conflict.baseLines,
    oursLines: conflict.oursLines,
    theirsLines: conflict.theirsLines,
    startLine: conflict.startLine,
    type,
    confidence,
    explanation,
  };
}
