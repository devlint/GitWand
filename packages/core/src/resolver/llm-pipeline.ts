/**
 * v2.5 — LLM fallback pipeline (phase 5 de resolveAsync).
 *
 * Après la résolution hunk-par-hunk et la validation parse-tree, cette phase
 * tente de résoudre les hunks `complex` restants via le fallback LLM.
 *
 * ## Intégration dans resolveAsync
 *
 * La fonction `runLlmFallbackPhase` est appelée par `resolveAsync()` uniquement si :
 * - `options.llmFallback.enabled === true`
 * - `options.llmFallback.endpoint` est injecté
 * - Il reste des hunks `complex` non résolus dans `result.resolutions`
 *
 * ## Reconstruction du mergedContent
 *
 * Les `HunkResolution` sont mises à jour en place. Le `mergedContent` est
 * reconstruit à partir des segments parsés de `conflictedContent` en appliquant
 * les nouvelles résolutions.
 */

import type {
  ConflictHunk,
  GitWandOptions,
  HunkResolution,
  LlmFallbackConfig,
  MergeResult,
  MergeStats,
} from "../types.js";
import type { StructuralLoaderOptions } from "../structural/index.js";
import { parseConflictMarkers } from "../parser.js";
import { tryLlmFallbackResolve } from "../resolvers/llm-fallback.js";
import { checkParseTreeValid, applyPostMergeRiskPenalty } from "./validate-parse-tree.js";
import { validateMergedContent } from "./validation.js";

// ─── Helpers ──────────────────────────────────────────────

/**
 * Extrait les lignes de contexte autour d'un hunk dans le contenu original.
 * Utilisé pour construire le prompt LLM.
 *
 * @param conflictedContent - Contenu original avec marqueurs de conflit
 * @param hunk              - Hunk de conflit
 * @param contextLines      - Nombre de lignes de contexte de chaque côté
 */
function extractHunkContext(
  conflictedContent: string,
  hunk: ConflictHunk,
  contextLines: number,
): string {
  const allLines = conflictedContent.split("\n");
  const startIdx = Math.max(0, hunk.startLine - 1 - contextLines);
  const endIdx = Math.min(allLines.length, hunk.startLine + contextLines);
  return allLines.slice(startIdx, endIdx).join("\n");
}

/**
 * Reconstruit le `mergedContent` à partir du contenu original et des résolutions.
 * Remplace chaque hunk par ses lignes résolues, ou restore les marqueurs de conflit.
 *
 * Retourne :
 * - La string fusionnée si toutes les résolutions sont résolues (`allResolved = true`)
 * - `null` si des conflits subsistent
 */
function reconstructMergedContent(
  conflictedContent: string,
  resolutions: HunkResolution[],
): { content: string; allResolved: boolean } {
  const { segments } = parseConflictMarkers(conflictedContent);
  const outputLines: string[] = [];
  let hunkIndex = 0;
  let allResolved = true;

  for (const segment of segments) {
    if (segment.type === "text") {
      outputLines.push(...segment.lines);
      continue;
    }

    const resolution = resolutions[hunkIndex++];
    if (resolution?.autoResolved && resolution.resolvedLines !== null) {
      outputLines.push(...resolution.resolvedLines);
    } else {
      // Restore conflict markers
      const h = resolution?.hunk;
      if (h) {
        outputLines.push(`<<<<<<< ours`);
        outputLines.push(...h.oursLines);
        if (h.baseLines.length > 0) {
          outputLines.push(`||||||| base`);
          outputLines.push(...h.baseLines);
        }
        outputLines.push(`=======`);
        outputLines.push(...h.theirsLines);
        outputLines.push(`>>>>>>> theirs`);
      }
      allResolved = false;
    }
  }

  return { content: outputLines.join("\n"), allResolved };
}

/**
 * Applique le fallback LLM sur les hunks `complex` non résolus.
 *
 * Retourne le `MergeResult` mis à jour avec :
 * - Les `HunkResolution` patchées (llm_proposed ou toujours complex)
 * - La `DecisionTrace` enrichie avec `llmTrace` pour chaque résolution LLM
 * - Le `mergedContent` reconstruit
 * - Les stats mises à jour
 * - La validation post-merge re-exécutée si toutes les résolutions passent
 */
export async function runLlmFallbackPhase(
  conflictedContent: string,
  result: MergeResult,
  filePath: string,
  options: Required<GitWandOptions>,
  structuralOpts: StructuralLoaderOptions = {},
): Promise<MergeResult> {
  const llmConfig: LlmFallbackConfig = options.llmFallback ?? { enabled: false };

  if (!llmConfig.enabled || !llmConfig.endpoint) {
    return result;
  }

  const contextLines = llmConfig.contextLines ?? 50;

  // Identifier les hunks llm_proposed non résolus.
  // Quand setLlmFallbackEnabled(true) était actif pendant resolve(), les hunks
  // qui auraient été "complex" ont été classifiés "llm_proposed". Leur score
  // (dataRisk: 60) étant trop bas pour une auto-résolution, ils restent non résolus.
  const complexUnresolved = result.resolutions
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => !r.autoResolved && r.hunk.type === "llm_proposed");

  if (complexUnresolved.length === 0) {
    return result;
  }

  // Cloner les résolutions pour mutation
  const updatedResolutions: HunkResolution[] = result.resolutions.map((r) => ({ ...r }));
  const updatedHunks: ConflictHunk[] = result.hunks.map((h) => ({
    ...h,
    trace: { ...h.trace, steps: [...h.trace.steps] },
    confidence: {
      ...h.confidence,
      dimensions: { ...h.confidence.dimensions },
    },
  }));

  // Traiter chaque hunk complex en séquence
  // (séquentiel pour respecter l'ordre et éviter les race conditions d'endpoint)
  for (const { r, idx } of complexUnresolved) {
    const hunk = r.hunk;
    const fileContext = extractHunkContext(conflictedContent, hunk, contextLines);

    const llmResult = await tryLlmFallbackResolve(hunk, filePath, fileContext, llmConfig);

    if (llmResult.lines !== null) {
      // Résolution acceptée — mettre à jour le hunk et la résolution
      const updatedHunk: ConflictHunk = {
        ...updatedHunks[idx],
        type: "llm_proposed",
        trace: {
          ...updatedHunks[idx].trace,
          selected: "llm_proposed",
          summary: `LLM fallback (${llmConfig.model ?? "claude-sonnet-4-6"}) — ${llmResult.reason}`,
          llmTrace: llmResult.llmTrace,
        },
      };
      updatedHunks[idx] = updatedHunk;
      updatedResolutions[idx] = {
        hunk: updatedHunk,
        resolvedLines: llmResult.lines,
        autoResolved: true,
        resolutionReason: llmResult.reason,
      };
    } else {
      // Résolution refusée — enrichir la trace avec llmTrace pour l'audit
      const updatedHunk: ConflictHunk = {
        ...updatedHunks[idx],
        trace: {
          ...updatedHunks[idx].trace,
          summary: `${updatedHunks[idx].trace.summary} | LLM rejected: ${llmResult.reason}`,
          llmTrace: llmResult.llmTrace,
        },
      };
      updatedHunks[idx] = updatedHunk;
      updatedResolutions[idx] = {
        ...updatedResolutions[idx],
        hunk: updatedHunk,
        resolutionReason: `${updatedResolutions[idx].resolutionReason} | LLM rejected: ${llmResult.reason}`,
      };
    }
  }

  // Reconstruire le mergedContent depuis les résolutions mises à jour
  const { content: newMergedContent, allResolved } = reconstructMergedContent(
    conflictedContent,
    updatedResolutions,
  );

  // Calculer les nouvelles stats
  const autoResolvedCount = updatedResolutions.filter((r) => r.autoResolved).length;
  const updatedStats: MergeStats = {
    ...result.stats,
    autoResolved: autoResolvedCount,
    remaining: updatedResolutions.length - autoResolvedCount,
    byType: {} as MergeStats["byType"],
  };
  for (const hunk of updatedHunks) {
    updatedStats.byType[hunk.type] = (updatedStats.byType[hunk.type] || 0) + 1;
  }

  if (!allResolved) {
    // Des conflits subsistent — pas de mergedContent
    return {
      ...result,
      hunks: updatedHunks,
      resolutions: updatedResolutions,
      stats: updatedStats,
      mergedContent: null,
    };
  }

  // Tout est résolu — re-valider le mergedContent complet
  const validation = validateMergedContent(newMergedContent, filePath);

  // Re-vérification parse-tree sur le contenu post-LLM
  if (options.validationLevel !== "off") {
    const parseTreeValid = await checkParseTreeValid(newMergedContent, filePath, structuralOpts);

    if (parseTreeValid === false) {
      // Parse-tree invalide après fallback LLM → rétraction de tout
      const retractedResolutions = updatedResolutions.map((r) =>
        r.autoResolved ? applyPostMergeRiskPenalty(r) : r,
      );
      return {
        ...result,
        hunks: updatedHunks,
        resolutions: retractedResolutions,
        stats: { ...updatedStats, autoResolved: 0, remaining: updatedStats.totalConflicts },
        mergedContent: null,
        validation: { ...validation, isValid: false, parseTreeValid: false, externalValidation: null },
      };
    }

    return {
      ...result,
      hunks: updatedHunks,
      resolutions: updatedResolutions,
      stats: updatedStats,
      mergedContent: newMergedContent,
      validation: { ...validation, parseTreeValid, externalValidation: null },
    };
  }

  return {
    ...result,
    hunks: updatedHunks,
    resolutions: updatedResolutions,
    stats: updatedStats,
    mergedContent: newMergedContent,
    validation: { ...validation, parseTreeValid: null, externalValidation: null },
  };
}
