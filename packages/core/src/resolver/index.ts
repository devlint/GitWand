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
  ConfidenceScore,
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
/**
 * accuracy lot 1 — Types de hunk qu'un pattern textuel peut résoudre sans risque même
 * dans un fichier généré : ils ne fabriquent aucun contenu (ils prennent un
 * côté existant ou constatent l'identité des deux).
 */
const SAFE_TEXTUAL_ON_GENERATED: ReadonlySet<ConflictType> = new Set([
  "same_change",
  "one_side_change",
  "delete_no_change",
  "whitespace_only",
]);

/**
 * accuracy lot 1 — Contrat du classifieur : un hunk `complex` résolu par un résolveur
 * format-aware est reclassifié `format_semantic`, avec une confiance et une
 * trace — plus jamais un hunk affiché « complex » mais appliqué en douce.
 */
function reclassifyFormatSemantic(hunk: ConflictHunk, resolverUsed: string): ConflictHunk {
  // On ne remplace pas le score du classifieur, on l'augmente : les dimensions
  // (baseAvailability, dataRisk…) et les boosters existants (zdiff3…) restent —
  // la reclassification ajoute l'information « fusion sémantique validée »,
  // elle n'efface pas ce que la classification savait déjà.
  const confidence: ConfidenceScore = {
    score: Math.max(hunk.confidence.score, 78),
    label: "high",
    dimensions: { ...hunk.confidence.dimensions, typeClassification: 85 },
    boosters: [
      ...hunk.confidence.boosters,
      `Résolveur format-aware « ${resolverUsed} » : fusion sémantique validée pour ce format`,
    ],
    penalties: hunk.confidence.penalties,
  };
  return {
    ...hunk,
    type: "format_semantic",
    confidence,
    explanation: `Hunk résolu sémantiquement par le résolveur « ${resolverUsed} » (fusion par structure du format, pas par lignes).`,
    trace: {
      ...hunk.trace,
      selected: "format_semantic",
      summary: `Résolveur format-aware « ${resolverUsed} » — reclassifié depuis complex.`,
      steps: [
        ...hunk.trace.steps,
        {
          type: "format_semantic" as ConflictType,
          passed: true,
          reason: `Le résolveur « ${resolverUsed} » a produit une fusion sémantique ; le hunk n'est plus « complex ».`,
        },
      ],
    },
  };
}

/**
 * accuracy lot 1 — Un hunk non-complex résolu par un résolveur format-aware garde son
 * type (la classification textuelle reste vraie) mais sa confiance intègre la
 * validation sémantique du résolveur : c'est elle qui justifie l'application,
 * et elle doit être visible dans la trace au lieu d'un bypass silencieux.
 */
function boostFormatValidated(hunk: ConflictHunk, resolverUsed: string): ConflictHunk {
  if (CONFIDENCE_ORDER[hunk.confidence.label] >= CONFIDENCE_ORDER.high) return hunk;
  const confidence: ConfidenceScore = {
    score: Math.max(hunk.confidence.score, 75),
    label: "high",
    dimensions: hunk.confidence.dimensions,
    boosters: [
      ...hunk.confidence.boosters,
      `Résolveur format-aware « ${resolverUsed} » : fusion validée sémantiquement pour ce format`,
    ],
    penalties: hunk.confidence.penalties,
  };
  return { ...hunk, confidence };
}

function resolveHunk(
  hunk: ConflictHunk,
  filePath: string,
  options: Required<GitWandOptions>,
  genInfo: { generated: boolean; label: string },
): { hunk: ConflictHunk; lines: string[] | null; reason: string } {
  // explainOnly : ne pas appliquer de résolution, juste tracer
  if (options.explainOnly) {
    return {
      hunk,
      lines: null,
      reason: `Mode explain-only : résolution non appliquée (type: ${hunk.type}, confiance: ${hunk.confidence.label} [score: ${hunk.confidence.score}]).`,
    };
  }

  // accuracy lot 1 — Fichier généré : par défaut on ne fusionne pas, on régénère.
  // Les résolveurs format-aware (lockfiles compris) ne sont même pas tentés ;
  // seuls les patterns textuels qui ne fabriquent rien restent autorisés.
  const generatedGate = genInfo.generated && !options.resolveGeneratedFiles;
  if (generatedGate && hunk.type !== "generated_file" && !SAFE_TEXTUAL_ON_GENERATED.has(hunk.type)) {
    return {
      hunk,
      lines: null,
      reason: `Fichier auto-généré (${genInfo.label}) — ne se fusionne pas, se régénère. Résous le fichier source puis relance l'outil qui produit celui-ci (install/build). Auto-résolution disponible via resolveGeneratedFiles: true.`,
    };
  }

  // Phase 7.3 — Dispatch format-aware. accuracy lot 1 : plus de bypass silencieux —
  // un hunk complex résolu ici est reclassifié `format_semantic` (confiance +
  // trace) puis soumis au même seuil de confiance que les patterns.
  let dispatchNote = "";
  if (!generatedGate) {
    const dispatch = dispatchFormatAware(hunk, filePath, options);
    if (dispatch.status === "resolved") {
      const effective = hunk.type === "complex"
        ? reclassifyFormatSemantic(hunk, dispatch.resolverUsed)
        : boostFormatValidated(hunk, dispatch.resolverUsed);
      const { policy: fmtPolicy, cfg: fmtCfg } = computeEffectivePolicy(filePath, options);
      const fmtMinConfidence = computeEffectiveMinConfidence(fmtCfg, options);
      // Une fusion sémantique combine du contenu des deux côtés — même famille
      // de risque que non_overlapping. Les politiques qui l'excluent (strict,
      // prefer-safety) l'excluent donc aussi, comme pour le résolveur imports.
      if (effective.type === "format_semantic" && !fmtCfg.allowNonOverlapping) {
        return {
          hunk: effective,
          lines: null,
          reason: `Fusion sémantique (${dispatch.resolverUsed}) désactivée par la politique "${fmtPolicy}" — elle combine du contenu des deux côtés.`,
        };
      }
      if (CONFIDENCE_ORDER[effective.confidence.label] < CONFIDENCE_ORDER[fmtMinConfidence]) {
        return {
          hunk: effective,
          lines: null,
          reason: `Confiance ${effective.confidence.label} (score: ${effective.confidence.score}) insuffisante pour appliquer la résolution format-aware (minimum requis : ${fmtMinConfidence}, politique : ${fmtPolicy}).`,
        };
      }
      return { hunk: effective, lines: dispatch.lines, reason: dispatch.reason };
    }
    if (dispatch.status === "rejected-policy") {
      return { hunk, lines: null, reason: dispatch.reason };
    }
    // dispatch.status === "not-applicable" → on continue vers le moteur textuel.
    // `dispatch.note` porte la raison d'échec du résolveur spécialisé (pour
    // annotation du refus final si le seuil de confiance bloque aussi).
    dispatchNote = dispatch.note;
  }

  // Phase 7.4 — Politique de merge effective pour ce fichier
  const { policy: effectivePolicy, cfg: policyCfg } = computeEffectivePolicy(filePath, options);
  const effectiveMinConfidence = computeEffectiveMinConfidence(policyCfg, options);

  // Vérifier le niveau de confiance minimum
  if (CONFIDENCE_ORDER[hunk.confidence.label] < CONFIDENCE_ORDER[effectiveMinConfidence]) {
    return {
      hunk,
      lines: null,
      reason: `Confiance ${hunk.confidence.label} (score: ${hunk.confidence.score}) insuffisante (minimum requis : ${effectiveMinConfidence}, politique : ${effectivePolicy}).${dispatchNote ? ` [${dispatchNote}]` : ""}`,
    };
  }

  const assembled = assembleResolution(hunk, options, effectivePolicy, policyCfg);
  return { hunk, ...assembled };
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

    const { hunk: effectiveHunk, lines: resolvedLines, reason: resolutionReason } = resolveHunk(hunk, filePath, options, genInfo);
    hunk = effectiveHunk;
    hunks.push(hunk);

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

  // accuracy lot 1 — Une violation d'invariant de format (deux « Unreleased » dans un
  // changelog, clé JSON dupliquée…) rétracte les résolutions automatiques du
  // fichier, comme la validation parse-tree le fait déjà pour la syntaxe.
  // Une résolution qui casse un invariant n'est pas appliquée, quel que soit
  // le pattern qui l'a produite.
  if (mergedContent !== null && validation.invariantErrors && validation.invariantErrors.length > 0) {
    const why = validation.invariantErrors.join(" ");
    const retractedResolutions = resolutions.map((r) =>
      r.autoResolved
        ? {
            ...r,
            autoResolved: false,
            resolvedLines: null,
            resolutionReason: `Rétracté : le contenu fusionné viole un invariant du format. ${why}`,
          }
        : r,
    );
    return {
      filePath,
      mergedContent: null,
      hunks,
      resolutions: retractedResolutions,
      stats: { ...stats, autoResolved: 0, remaining: stats.totalConflicts },
      validation: { ...validation, isValid: false },
    };
  }

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
    console.error("[GitWand] LLM fallback triggered — phase 5 waiting for unresolved llm_proposed hunks.");
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
