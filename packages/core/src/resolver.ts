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
 * Phase 7.3 : dispatch automatique vers les résolveurs spécialisés par format
 *             (JSON/JSONC, Markdown) avant le moteur textuel.
 */

import type {
  ConflictHunk,
  Confidence,
  ConfidenceScore,
  GitWandOptions,
  HunkResolution,
  MergeResult,
  MergeStats,
  ConflictType,
  ValidationResult,
} from "./types.js";
import { parseConflictMarkers, toConflictHunk } from "./parser.js";
import { mergeNonOverlapping } from "./diff.js";
import { tryFormatAwareResolve } from "./resolvers/dispatcher.js";
import {
  effectivePolicyForFile,
  policyToConfig,
  DEFAULT_POLICY,
  type MergePolicy,
} from "./config.js";

/** Options par défaut */
const DEFAULT_OPTIONS: Required<GitWandOptions> = {
  resolveWhitespace: true,
  resolveNonOverlapping: true,
  minConfidence: "high",
  verbose: false,
  explainOnly: false,
  policy: DEFAULT_POLICY,
  patternOverrides: {},
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

// ─── Smart generated file comparison ─────────────────────

/**
 * Supprime les valeurs volatiles (hashes, timestamps, resolved URLs, integrity)
 * d'un bloc de lignes pour permettre une comparaison structurelle.
 * Utilisé pour détecter les conflits cosmétiques dans les fichiers générés.
 */
function stripVolatileValues(lines: string[]): string {
  return lines
    .map((line) =>
      line
        // SHA/integrity hashes
        .replace(/sha[0-9]+-[A-Za-z0-9+/=]+/g, "<hash>")
        // npm resolved URLs with version+hash
        .replace(/"resolved":\s*"[^"]+"/g, '"resolved": "<url>"')
        // integrity fields
        .replace(/"integrity":\s*"[^"]+"/g, '"integrity": "<hash>"')
        // Generic hex hashes (7+ chars)
        .replace(/\b[a-f0-9]{7,64}\b/g, "<hex>")
        // ISO timestamps
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
        // Semver with build metadata
        .replace(/\d+\.\d+\.\d+[-+][A-Za-z0-9.]+/g, "<ver>")
    )
    .join("\n");
}

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
 * @param hunk - Le hunk à résoudre
 * @param filePath - Chemin du fichier (pour le dispatch format-aware)
 * @param options - Options de configuration
 * @returns Les lignes résolues + la raison, ou null + raison de refus
 */
function resolveHunk(
  hunk: ConflictHunk,
  filePath: string,
  options: Required<GitWandOptions>,
): { lines: string[] | null; reason: string } {
  // explainOnly : ne pas appliquer de résolution, juste tracer
  if (options.explainOnly) {
    return {
      lines: null,
      reason: `Mode explain-only : résolution non appliquée (type: ${hunk.type}, confiance: ${hunk.confidence.label} [score: ${hunk.confidence.score}]).`,
    };
  }

  // Phase 7.3 — Dispatch format-aware
  // Tenter le résolveur spécialisé avant le moteur textuel.
  // Les résolveurs JSON/YAML/Markdown/Vue/CSS effectuent une validation sémantique,
  // ce qui justifie de bypasser le filtre de confiance textuel.
  //
  // Exception : le résolveur `imports` est sémantiquement équivalent à `non_overlapping`
  // (combinaison d'ajouts indépendants) — il doit respecter la politique `allowNonOverlapping`.
  const formatResult = tryFormatAwareResolve(hunk, filePath);
  if (formatResult.resolverUsed !== "none") {
    if (formatResult.lines !== null) {
      // Gate politique pour le résolveur d'imports (≈ non_overlapping)
      if (formatResult.resolverUsed === "imports") {
        // Vérifier l'option globale resolveNonOverlapping
        if (!options.resolveNonOverlapping) {
          return {
            lines: null,
            reason: "Résolution d'imports (non-overlapping) désactivée par options (resolveNonOverlapping: false).",
          };
        }
        const _effectivePolicy: MergePolicy = effectivePolicyForFile(
          filePath,
          options.policy,
          options.patternOverrides,
        );
        const _policyCfg = policyToConfig(_effectivePolicy);
        if (!_policyCfg.allowNonOverlapping) {
          return {
            lines: null,
            reason: `Résolution d'imports (non-overlapping) désactivée par la politique "${_effectivePolicy}".`,
          };
        }
      }
      return { lines: formatResult.lines, reason: formatResult.reason };
    }
    // Le résolveur spécialisé a échoué → noter et continuer vers le moteur textuel
  }

  // Phase 7.4 — Politique de merge effective pour ce fichier
  const effectivePolicy: MergePolicy = effectivePolicyForFile(
    filePath,
    options.policy,
    options.patternOverrides,
  );
  const policyCfg = policyToConfig(effectivePolicy);

  // Le seuil de confiance effectif est le min entre l'option globale et celui de la politique
  // (on prend le plus permissif : la politique peut abaisser le seuil, et une option explicite
  // peut aussi l'abaisser en dessous du défaut de la politique)
  const effectiveMinConfidence =
    CONFIDENCE_ORDER[policyCfg.minConfidence] < CONFIDENCE_ORDER[options.minConfidence]
      ? policyCfg.minConfidence
      : options.minConfidence;

  // Vérifier le niveau de confiance minimum
  if (CONFIDENCE_ORDER[hunk.confidence.label] < CONFIDENCE_ORDER[effectiveMinConfidence]) {
    return {
      lines: null,
      reason: `Confiance ${hunk.confidence.label} (score: ${hunk.confidence.score}) insuffisante (minimum requis : ${effectiveMinConfidence}, politique : ${effectivePolicy}).${formatResult.resolverUsed !== "none" ? ` [${formatResult.reason}]` : ""}`,
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
        // Trouver les lignes ajoutées par chaque côté via inclusion dans l'ensemble de base
        const baseSet = new Set(hunk.baseLines);
        const oursInsertions = hunk.oursLines.filter((l) => !baseSet.has(l));
        const theirsInsertions = hunk.theirsLines.filter((l) => !baseSet.has(l));
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

    case "whitespace_only":
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

  // v1.4 — fileFrequency : compteur de hunks "complex" déjà vus dans ce fichier.
  // Appliqué comme pénalité sur la dimension fileFrequency du score de confiance.
  let priorComplexHunks = 0;

  for (const segment of segments) {
    if (segment.type === "text") {
      outputLines.push(...segment.lines);
    } else {
      let hunk = toConflictHunk(segment.conflict);

      // v1.4 — Appliquer la pénalité fileFrequency si des hunks complexes ont déjà été vus
      if (priorComplexHunks > 0 && hunk.type !== "complex") {
        const ff = Math.min(100, priorComplexHunks * 20);
        const d  = hunk.confidence.dimensions;
        const raw =
          d.typeClassification
          - d.dataRisk        * 0.40
          - d.scopeImpact     * 0.15
          - ff                * 0.10
          + (d.baseAvailability ?? 0) * 0.05;
        const newScore = Math.round(Math.max(0, Math.min(100, raw)));
        const newLabel = newScore >= 92 ? "certain" as const
                       : newScore >= 68 ? "high"    as const
                       : newScore >= 44 ? "medium"  as const
                       : "low"    as const;
        hunk = {
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

      // Si fichier auto-généré et hunk classifié "complex", reclassifier en "generated_file"
      if (genInfo.generated && hunk.type === "complex") {
        const generatedScore: ConfidenceScore = {
          score: 72,
          label: "high",
          dimensions: { typeClassification: 90, dataRisk: 30, scopeImpact: 15, fileFrequency: 0, baseAvailability: 0 },
          boosters: [`Chemin correspond au pattern de fichier auto-généré : ${genInfo.label}`],
          penalties: ["Le contenu sera régénéré — theirs est supposé plus récent"],
        };
        hunk = {
          ...hunk,
          type: "generated_file",
          confidence: generatedScore,
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

      const { lines: resolvedLines, reason: resolutionReason } = resolveHunk(hunk, filePath, options);
      const autoResolved = resolvedLines !== null;

      // v1.4 — Incrémenter le compteur de hunks complexes non résolus pour fileFrequency
      if (!autoResolved && hunk.type === "complex") {
        priorComplexHunks++;
      }

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
