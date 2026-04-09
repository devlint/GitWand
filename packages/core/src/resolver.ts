/**
 * GitWand Conflict Resolver
 *
 * Moteur de résolution automatique des conflits.
 * Applique les stratégies de résolution pour chaque type de conflit.
 *
 * Phase 7.1 : chaque HunkResolution inclut une resolutionReason et la trace
 *             de classification de son hunk.
 * Phase 7.2 : le MergeResult inclut un ValidationResult — détection de
 *             marqueurs résiduels et erreurs de syntaxe JSON.
 */

import type {
  ConflictHunk,
  Confidence,
  GitWandOptions,
  HunkResolution,
  MergeResult,
  MergeStats,
  ConflictType,
  ValidationResult,
} from "./types.js";
import { parseConflictMarkers, toConflictHunk } from "./parser.js";
import { mergeNonOverlapping } from "./diff.js";

/** Options par défaut */
const DEFAULT_OPTIONS: Required<GitWandOptions> = {
  resolveWhitespace: true,
  resolveNonOverlapping: true,
  minConfidence: "high",
  verbose: false,
  explainOnly: false,
};

// ─── Generated File Detection ────────────────────────────

/** Patterns de fichiers auto-générés qui ne doivent pas être mergés ligne par ligne */
const GENERATED_FILE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /package-lock\.json$/i, label: "npm lockfile" },
  { pattern: /yarn\.lock$/i, label: "yarn lockfile" },
  { pattern: /pnpm-lock\.yaml$/i, label: "pnpm lockfile" },
  { pattern: /composer\.lock$/i, label: "composer lockfile" },
  { pattern: /Gemfile\.lock$/i, label: "bundler lockfile" },
  { pattern: /Cargo\.lock$/i, label: "cargo lockfile" },
  { pattern: /\.min\.(js|css)$/i, label: "fichier minifié" },
  { pattern: /\bdist\//, label: "fichier build dist/" },
  { pattern: /\bbuild\/manifest\.json$/i, label: "manifest de build" },
  { pattern: /\.bundle\.(js|css)$/i, label: "bundle" },
  { pattern: /mix-manifest\.json$/i, label: "Laravel Mix manifest" },
];

function isGeneratedFile(filePath: string): { generated: boolean; label: string } {
  for (const { pattern, label } of GENERATED_FILE_PATTERNS) {
    if (pattern.test(filePath)) {
      return { generated: true, label };
    }
  }
  return { generated: false, label: "" };
}

/** Ordre de confiance pour comparaison */
const CONFIDENCE_ORDER: Record<Confidence, number> = {
  certain: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// ─── Phase 7.2 — Validation post-merge ───────────────────

/** Patterns de marqueurs de conflit résiduels */
const RESIDUAL_MARKER_PATTERNS = [
  /^<{7}\s/,  // <<<<<<< ours
  /^>{7}\s/,  // >>>>>>> theirs
  /^\|{7}\s/, // ||||||| base
  /^={7}$/,   // =======
];

/**
 * Valide le contenu fusionné pour détecter les problèmes résiduels.
 *
 * Vérifie :
 * 1. Marqueurs de conflit résiduels (indique une résolution incomplète)
 * 2. Erreurs de syntaxe JSON pour les fichiers .json
 *
 * @param content - Contenu fusionné à valider
 * @param filePath - Chemin du fichier (pour détecter le type)
 */
function validateMergedContent(content: string, filePath: string): ValidationResult {
  // 1. Détection de marqueurs résiduels
  const lines = content.split("\n");
  const residualMarkerLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RESIDUAL_MARKER_PATTERNS.some((p) => p.test(line))) {
      residualMarkerLines.push(i + 1); // 1-indexed
    }
  }

  const hasResidualMarkers = residualMarkerLines.length > 0;

  // 2. Validation syntaxique JSON
  let syntaxError: string | null = null;
  if (/\.json(c)?$/i.test(filePath)) {
    try {
      JSON.parse(content);
    } catch (err) {
      syntaxError = err instanceof Error ? err.message : String(err);
    }
  }

  const isValid = !hasResidualMarkers && syntaxError === null;

  return { hasResidualMarkers, residualMarkerLines, syntaxError, isValid };
}

/** Validation vide (pour les cas où le contenu n'est pas encore fusionné) */
const EMPTY_VALIDATION: ValidationResult = {
  hasResidualMarkers: false,
  residualMarkerLines: [],
  syntaxError: null,
  isValid: true,
};

// ─── Resolution engine ────────────────────────────────────

/**
 * Résout automatiquement un hunk de conflit.
 *
 * @returns Les lignes résolues + la raison, ou null + raison de refus
 */
function resolveHunk(
  hunk: ConflictHunk,
  options: Required<GitWandOptions>,
): { lines: string[] | null; reason: string } {
  // explainOnly : ne pas appliquer de résolution, juste tracer
  if (options.explainOnly) {
    return {
      lines: null,
      reason: `Mode explain-only : résolution non appliquée (type: ${hunk.type}, confiance: ${hunk.confidence}).`,
    };
  }

  // Vérifier le niveau de confiance minimum
  if (CONFIDENCE_ORDER[hunk.confidence] < CONFIDENCE_ORDER[options.minConfidence]) {
    return {
      lines: null,
      reason: `Confiance ${hunk.confidence} insuffisante (minimum requis : ${options.minConfidence}).`,
    };
  }

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

    case "whitespace_only":
      if (!options.resolveWhitespace) {
        return {
          lines: null,
          reason: "Résolution whitespace désactivée par options (resolveWhitespace: false).",
        };
      }
      return {
        lines: [...hunk.oursLines],
        reason: "Seul le whitespace diffère. Résolution : préférer ours.",
      };

    case "non_overlapping": {
      if (!options.resolveNonOverlapping) {
        return {
          lines: null,
          reason: "Résolution non-overlapping désactivée par options (resolveNonOverlapping: false).",
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

    case "value_only_change":
      return {
        lines: [...hunk.theirsLines],
        reason: "Même structure, valeur(s) volatile(s) différente(s). Résolution : accepter theirs (plus récent).",
      };

    case "generated_file":
      return {
        lines: [...hunk.theirsLines],
        reason: "Fichier auto-généré — le fichier sera régénéré après merge. Résolution : accepter theirs.",
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

/**
 * Analyse et résout automatiquement les conflits d'un fichier.
 *
 * @param conflictedContent - Le contenu du fichier avec marqueurs de conflit Git
 * @param filePath - Le chemin du fichier (pour le reporting)
 * @param userOptions - Options de configuration
 * @returns Le résultat de la résolution avec traces et validation
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

  // Détecter si le fichier est auto-généré
  const genInfo = isGeneratedFile(filePath);

  for (const segment of segments) {
    if (segment.type === "text") {
      outputLines.push(...segment.lines);
    } else {
      let hunk = toConflictHunk(segment.conflict);

      // Si fichier auto-généré et hunk classifié "complex", reclassifier en "generated_file"
      if (genInfo.generated && hunk.type === "complex") {
        hunk = {
          ...hunk,
          type: "generated_file",
          confidence: "medium",
          explanation: `Fichier auto-généré (${genInfo.label}). Ce fichier sera régénéré après le merge. Résolution proposée : accepter theirs et relancer le build.`,
          // Update the trace to reflect the reclassification
          trace: {
            ...hunk.trace,
            selected: "generated_file",
            summary: `Fichier auto-généré (${genInfo.label}) — reclassifié depuis complex.`,
            steps: [
              ...hunk.trace.steps.slice(0, -1), // remove the "complex passed: true" step
              {
                type: "complex" as ConflictType,
                passed: false,
                reason: `Reclassifié : fichier auto-généré (${genInfo.label}) détecté par son chemin.`,
              },
              {
                type: "generated_file" as ConflictType,
                passed: true,
                reason: `Chemin correspond au pattern de fichier auto-généré : ${genInfo.label}.`,
              },
            ],
          },
        };
      }

      hunks.push(hunk);

      const { lines: resolvedLines, reason: resolutionReason } = resolveHunk(hunk, options);
      const autoResolved = resolvedLines !== null;

      resolutions.push({ hunk, resolvedLines, autoResolved, resolutionReason });

      if (autoResolved) {
        outputLines.push(...resolvedLines);
        if (options.verbose) {
          console.log(
            `  [GitWand] Auto-resolved (${hunk.type}): L${hunk.startLine} — ${hunk.explanation}`,
          );
          console.log(`    Trace: ${hunk.trace.summary}`);
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

  const mergedContent = allResolved ? outputLines.join("\n") : null;

  // Phase 7.2 — Validation post-merge
  const validation: ValidationResult = mergedContent !== null
    ? validateMergedContent(mergedContent, filePath)
    : EMPTY_VALIDATION;

  return {
    filePath,
    mergedContent,
    hunks,
    resolutions,
    stats,
    validation,
  };
}
