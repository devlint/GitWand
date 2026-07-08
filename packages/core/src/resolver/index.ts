/**
 * GitWand Conflict Resolver — orchestration.
 *
 * Moteur de résolution automatique des conflits. Pour chaque hunk :
 * 1. applique la pénalité « zone chaude » (v1.4) si nécessaire,
 * 2. reclassifie les hunks complex en `generated_file` si le chemin matche,
 * 3. tente un résolveur format-aware (JSON/MD/YAML/Vue/CSS/imports…),
 * 4. à défaut, applique la politique de merge et le seuil de confiance,
 * 5. invoque le moteur textuel (`assembleResolution`),
 * 6. valide le contenu fusionné en sortie (marqueurs résiduels, JSON).
 *
 * Issu du split P1.1 de `resolver.ts`. Le fichier `packages/core/src/resolver.ts`
 * reste en place comme shim de re-export pour les consommateurs qui importent
 * `resolve` depuis `../resolver.js`.
 */

import type {
  ConflictHunk,
  ConflictType,
  ExternalValidationResult,
  GitWandOptions,
  HunkResolution,
  MergeResult,
  MergeStats,
  ValidationResult,
} from "../types.js";
import {
  tryStructuralMergeResolve,
  wrapStructuralResult,
  isStructuralLanguage,
  type StructuralLoaderOptions,
} from "../structural/index.js";
import { parseConflictMarkers, toConflictHunk } from "../parser.js";

import { EMPTY_VALIDATION, validateMergedContent } from "./validation.js";
import { checkParseTreeValid, applyPostMergeRiskPenalty } from "./validate-parse-tree.js";
import { runStrictValidation } from "./validate-strict.js";
import { isGeneratedFile, reclassifyIfGenerated } from "./generated-detection.js";
import {
  CONFIDENCE_ORDER,
  DEFAULT_OPTIONS,
  applyFileFrequencyPenalty,
  computeEffectiveMinConfidence,
  computeEffectivePolicy,
} from "./policy.js";
import { dispatchFormatAware } from "./format-dispatch.js";
import { assembleResolution } from "./assemble.js";
import { setLlmFallbackEnabled } from "../patterns/llm-proposed.js";
import { setRefMergeEnabled } from "../patterns/refactoring-aware-merge.js";
import { runLlmFallbackPhase } from "./llm-pipeline.js";

/**
 * Résout automatiquement un hunk de conflit.
 *
 * @param hunk - Le hunk à résoudre
 * @param filePath - Chemin du fichier (pour le dispatch format-aware et la politique)
 * @param options - Options de configuration (complètes, déjà fusionnées avec les défauts)
 * @returns Les lignes résolues + la raison, ou `null` + raison de refus
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

  // Phase 7.3 — Dispatch format-aware (bypasse le seuil de confiance textuel
  // car les résolveurs spécialisés font une validation sémantique).
  const dispatch = dispatchFormatAware(hunk, filePath, options);
  if (dispatch.status === "resolved") {
    return { lines: dispatch.lines, reason: dispatch.reason };
  }
  if (dispatch.status === "rejected-policy") {
    return { lines: null, reason: dispatch.reason };
  }
  // dispatch.status === "not-applicable" → on continue vers le moteur textuel.
  // `dispatch.note` porte la raison d'échec du résolveur spécialisé (pour
  // annotation du refus final si le seuil de confiance bloque aussi).

  // Phase 7.4 — Politique de merge effective pour ce fichier
  const { policy: effectivePolicy, cfg: policyCfg } = computeEffectivePolicy(filePath, options);
  const effectiveMinConfidence = computeEffectiveMinConfidence(policyCfg, options);

  // Vérifier le niveau de confiance minimum
  if (CONFIDENCE_ORDER[hunk.confidence.label] < CONFIDENCE_ORDER[effectiveMinConfidence]) {
    return {
      lines: null,
      reason: `Confiance ${hunk.confidence.label} (score: ${hunk.confidence.score}) insuffisante (minimum requis : ${effectiveMinConfidence}, politique : ${effectivePolicy}).${dispatch.note ? ` [${dispatch.note}]` : ""}`,
    };
  }

  return assembleResolution(hunk, options, effectivePolicy, policyCfg);
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

  // v2.6 — RefMerge opt-in : activer le pattern avant classification, désactiver après
  const refEnabled = !!(options.refactoringAware?.enabled);
  if (refEnabled) {
    setRefMergeEnabled(true, options.refactoringAware?.maxRefactoringsPerSide ?? 10);
  }

  const { segments } = parseConflictMarkers(conflictedContent);

  const hunks: ConflictHunk[] = [];
  const resolutions: HunkResolution[] = [];
  const outputLines: string[] = [];
  let allResolved = true;

  // Détecter si le fichier est auto-généré (built-ins + user patterns P2.4)
  const genInfo = isGeneratedFile(filePath, options.generatedFiles);

  // v1.4 — fileFrequency : compteur de hunks "complex" déjà vus dans ce fichier.
  // Appliqué comme pénalité sur la dimension fileFrequency du score de confiance.
  let priorComplexHunks = 0;

  for (const segment of segments) {
    if (segment.type === "text") {
      outputLines.push(...segment.lines);
      continue;
    }

    let hunk = toConflictHunk(segment.conflict);

    // v1.4 — Appliquer la pénalité fileFrequency si des hunks complexes ont déjà été vus
    hunk = applyFileFrequencyPenalty(hunk, priorComplexHunks);

    // Si fichier auto-généré et hunk classifié "complex", reclassifier en "generated_file"
    hunk = reclassifyIfGenerated(hunk, genInfo);

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

  // v2.6 — Désactiver le flag RefMerge après traitement
  if (refEnabled) setRefMergeEnabled(false);

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

/**
 * Async variant of `resolve()` — attempts structural (AST-based) merge for
 * TypeScript/TSX files before falling back to the standard hunk-by-hunk engine.
 * Additionally runs parse-tree validation (v2.4) and optionally strict validation
 * (tsc/eslint) when `validationLevel: "strict"` is configured.
 *
 * Structural merge requires `web-tree-sitter` as an **optional** peer dependency.
 * If it is not installed, `resolveAsync()` behaves identically to `resolve()` with
 * the addition of the parse-tree validation pass.
 *
 * ### v2.4 — Parse-tree validation & retraction
 *
 * After hunk-based resolution produces a `mergedContent`, `resolveAsync()` re-parses
 * it with tree-sitter. If the tree contains ERROR nodes (indicating the merged code is
 * syntactically broken), every auto-resolved hunk is **retracted**:
 *
 * - `resolution.autoResolved` → `false`
 * - `resolution.resolvedLines` → `null`
 * - `hunk.confidence.dimensions.postMergeRisk` → `100`
 * - `validation.parseTreeValid` → `false`
 * - `mergedContent` → `null` (conflicts restored as markers)
 *
 * This eliminates the class of false-positives where the resolver auto-merged code
 * that compiles/runs fine locally but is syntactically invalid (e.g. from two hunks
 * interacting unexpectedly).
 *
 * @param conflictedContent - File content with Git conflict markers
 * @param filePath          - File path (format detection + grammar selection)
 * @param userOptions       - GitWand options (same as `resolve()`)
 * @param structuralOpts    - Optional tree-sitter loader overrides
 */
export async function resolveAsync(
  conflictedContent: string,
  filePath: string,
  userOptions: GitWandOptions = {},
  structuralOpts: StructuralLoaderOptions = {},
): Promise<MergeResult> {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };

  // ─── 1. Tentative de merge structurel (v2.3) ──────────────────────────────
  if (isStructuralLanguage(filePath)) {
    try {
      const merged = await tryStructuralMergeResolve(
        conflictedContent,
        filePath,
        structuralOpts,
      );
      if (merged !== null) {
        const result = wrapStructuralResult(conflictedContent, merged, filePath);
        // Validation parse-tree sur le résultat structurel (devrait toujours passer,
        // mais on vérifie quand même par cohérence).
        const parseTreeValid = await checkParseTreeValid(result.mergedContent ?? "", filePath, structuralOpts);
        return {
          ...result,
          validation: { ...result.validation, parseTreeValid, externalValidation: null },
        };
      }
    } catch {
      // Structural merge failed unexpectedly — fall through to hunk-based resolver
    }
  }

  // ─── 2. Résolution hunk-par-hunk (synchrone) ─────────────────────────────
  //   Si le LLM fallback est activé, on positionne le flag avant la classification
  //   pour que `llmProposed.detect()` retourne true sur les hunks complex.
  //   Le flag est réinitialisé immédiatement après `resolve()` — il ne doit pas
  //   persister entre appels (module-level state, potentiellement partagé).
  const llmEnabled = !!(options.llmFallback?.enabled && options.llmFallback?.endpoint);
  // Coupling fix (v2.7) — the LLM path must only be reachable for hunks no
  // enabled deterministic pattern can resolve. Force refactoringAware on
  // whenever llmFallback is on, so a rename-on-both-sides hunk never skips
  // the deterministic recoverer just because the user only opted into the LLM.
  const effectiveOptions = llmEnabled
    ? { ...userOptions, refactoringAware: { ...options.refactoringAware, enabled: true } }
    : userOptions;
  if (llmEnabled) setLlmFallbackEnabled(true);
  const result = resolve(conflictedContent, filePath, effectiveOptions);
  if (llmEnabled) setLlmFallbackEnabled(false);

  if (options.verbose && llmEnabled && result.resolutions.some((r) => !r.autoResolved && r.hunk.type === "llm_proposed")) {
    console.error("[GitWand] LLM fallback activé — phase 5 en attente des hunks llm_proposed non résolus.");
  }

  // Rien à valider si la résolution n'est pas complète et pas de LLM fallback
  if (result.mergedContent === null) {
    if (!llmEnabled) return result;
    // Phase 5 — LLM fallback pour les hunks llm_proposed non résolus
    return runLlmFallbackPhase(conflictedContent, result, filePath, options, structuralOpts);
  }

  // ─── 3. v2.4 — Validation parse-tree ─────────────────────────────────────
  //   Skipped when validationLevel === "off" (performance mode).
  if (options.validationLevel === "off") {
    return { ...result, validation: { ...result.validation, parseTreeValid: null, externalValidation: null } };
  }

  const parseTreeValid = await checkParseTreeValid(result.mergedContent, filePath, structuralOpts);

  if (parseTreeValid === false) {
    // Parse-tree invalide → rétraction de toutes les résolutions automatiques.
    // On ne peut pas savoir quel hunk a cassé la syntaxe sans une analyse fine,
    // donc on est conservatif : tout remettre en conflits manuels.
    const retractedResolutions = result.resolutions.map((r) =>
      r.autoResolved ? applyPostMergeRiskPenalty(r) : r,
    );

    return {
      ...result,
      // mergedContent = null indique aux consommateurs que des conflits subsistent.
      // Le contenu original (avec marqueurs) est conservé dans conflictedContent
      // par l'appelant — ici on expose uniquement la MergeResult enrichie.
      mergedContent: null,
      resolutions: retractedResolutions,
      stats: {
        ...result.stats,
        autoResolved: 0,
        remaining: result.stats.totalConflicts,
      },
      validation: {
        ...result.validation,
        isValid: false,
        parseTreeValid: false,
      },
    };
  }

  // ─── 4. v2.4 — Validation stricte opt-in (tsc / eslint) ─────────────────
  let externalValidation: ExternalValidationResult | null = null;
  if (options.validationLevel === "strict") {
    const tools: Array<"tsc" | "eslint"> = options.validationTools ?? ["tsc"];
    const strictResult = await runStrictValidation(result.mergedContent, filePath, tools);
    const failedTool = (strictResult.toolsFailed[0] ?? strictResult.toolsRun[0] ?? "tsc") as "tsc" | "eslint";
    externalValidation = {
      tool: failedTool,
      errors: strictResult.errors,
      passed: strictResult.errors.length === 0,
    };
  }

  return {
    ...result,
    validation: {
      ...result.validation,
      parseTreeValid,
      externalValidation,
      ...(externalValidation && !externalValidation.passed ? { isValid: false } : {}),
    },
  };
}
