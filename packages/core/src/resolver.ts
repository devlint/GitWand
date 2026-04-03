/**
 * GitWand Conflict Resolver
 *
 * Moteur de résolution automatique des conflits.
 * Applique les stratégies de résolution pour chaque type de conflit.
 */

import type {
  ConflictHunk,
  Confidence,
  GitWandOptions,
  HunkResolution,
  MergeResult,
  MergeStats,
  ConflictType,
} from "./types.js";
import { parseConflictMarkers, toConflictHunk } from "./parser.js";
import { mergeNonOverlapping } from "./diff.js";

/** Options par défaut */
const DEFAULT_OPTIONS: Required<GitWandOptions> = {
  resolveWhitespace: true,
  resolveNonOverlapping: true,
  minConfidence: "high",
  verbose: false,
};

/** Ordre de confiance pour comparaison */
const CONFIDENCE_ORDER: Record<Confidence, number> = {
  certain: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Résout automatiquement un hunk de conflit.
 *
 * @returns Les lignes résolues, ou null si le conflit ne peut pas être résolu automatiquement
 */
function resolveHunk(
  hunk: ConflictHunk,
  options: Required<GitWandOptions>,
): string[] | null {
  // Vérifier le niveau de confiance minimum
  if (CONFIDENCE_ORDER[hunk.confidence] < CONFIDENCE_ORDER[options.minConfidence]) {
    return null;
  }

  switch (hunk.type) {
    case "same_change":
      // Les deux côtés ont le même contenu, on prend l'un des deux
      return [...hunk.oursLines];

    case "one_side_change": {
      // Identifier quel côté a changé
      const baseText = hunk.baseLines.join("\n");
      const oursText = hunk.oursLines.join("\n");

      if (oursText === baseText) {
        // Ours n'a pas changé → prendre theirs
        return [...hunk.theirsLines];
      } else {
        // Theirs n'a pas changé → prendre ours
        return [...hunk.oursLines];
      }
    }

    case "delete_no_change":
      // Un côté supprime, l'autre n'a pas touché → accepter la suppression
      return [];

    case "whitespace_only":
      if (!options.resolveWhitespace) return null;
      // Préférer la version "ours" pour le whitespace
      return [...hunk.oursLines];

    case "non_overlapping": {
      if (!options.resolveNonOverlapping) return null;
      // Fusionner les changements non-overlapping via le diff 3-way
      const merged = mergeNonOverlapping(
        hunk.baseLines,
        hunk.oursLines,
        hunk.theirsLines,
      );
      return merged;
    }

    case "complex":
      // Pas de résolution automatique
      return null;

    default:
      return null;
  }
}

/**
 * Analyse et résout automatiquement les conflits d'un fichier.
 *
 * @param conflictedContent - Le contenu du fichier avec marqueurs de conflit Git
 * @param filePath - Le chemin du fichier (pour le reporting)
 * @param userOptions - Options de configuration
 * @returns Le résultat de la résolution
 */
export function resolve(
  conflictedContent: string,
  filePath: string,
  userOptions: GitWandOptions = {},
): MergeResult {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };

  const { segments } = parseConflictMarkers(conflictedContent);

  const hunks: ConflictHunk[] = [];
  const resolutions: HunkResolution[] = [];
  const outputLines: string[] = [];
  let allResolved = true;

  for (const segment of segments) {
    if (segment.type === "text") {
      outputLines.push(...segment.lines);
    } else {
      const hunk = toConflictHunk(segment.conflict);
      hunks.push(hunk);

      const resolvedLines = resolveHunk(hunk, options);
      const autoResolved = resolvedLines !== null;

      resolutions.push({ hunk, resolvedLines, autoResolved });

      if (autoResolved) {
        outputLines.push(...resolvedLines);
        if (options.verbose) {
          console.log(
            `  [GitWand] Auto-resolved (${hunk.type}): L${hunk.startLine} — ${hunk.explanation}`,
          );
        }
      } else {
        // Remettre les marqueurs de conflit pour les conflits non résolus
        outputLines.push(`<<<<<<< ours`);
        outputLines.push(...hunk.oursLines);
        if (hunk.baseLines.length > 0) {
          outputLines.push(`||||||| base`);
          outputLines.push(...hunk.baseLines);
        }
        outputLines.push(`=======`);
        outputLines.push(...hunk.theirsLines);
        outputLines.push(`>>>>>>> theirs`);
        allResolved = false;
      }
    }
  }

  // Calculer les stats
  const byType = {} as Record<ConflictType, number>;
  for (const hunk of hunks) {
    byType[hunk.type] = (byType[hunk.type] || 0) + 1;
  }

  const autoResolvedCount = resolutions.filter((r) => r.autoResolved).length;

  const stats: MergeStats = {
    totalConflicts: hunks.length,
    autoResolved: autoResolvedCount,
    remaining: hunks.length - autoResolvedCount,
    byType,
  };

  return {
    filePath,
    mergedContent: allResolved ? outputLines.join("\n") : null,
    hunks,
    resolutions,
    stats,
  };
}
