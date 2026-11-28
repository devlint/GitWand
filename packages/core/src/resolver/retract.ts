/**
 * #301 — Retractions of automatic resolutions. Every retraction (a format
 * invariant, an invalid parse tree, after the LLM fallback too) goes through
 * here, so a retracted hunk never names a format resolver it was not, in
 * the end, resolved by.
 */
import type { ConflictHunk, HunkResolution } from "../types.js";
import type { ExplanationKey } from "../explanation-keys.js";
import { applyPostMergeRiskPenalty } from "./validate-parse-tree.js";
import complexPattern from "../patterns/complex.js";

/**
 * accuracy lot 1 — Les résolutions automatiques d'un fichier dont le contenu
 * fusionné viole un invariant de format sont rétractées. #301 — un hunk
 * rétracté ne nomme plus de résolveur de format : ce n'est pas lui qui l'a résolu.
 */
export function retractForInvariant(
  hunks: ConflictHunk[],
  resolutions: HunkResolution[],
  why: string,
): { hunks: ConflictHunk[]; resolutions: HunkResolution[] } {
  const retracted = new Set(resolutions.flatMap((r, i) => (r.autoResolved ? [i] : [])));
  const out = forgetRetractedFormatResolvers(hunks, resolutions, (i) => retracted.has(i));
  return {
    hunks: out.hunks,
    resolutions: out.resolutions.map((r, i) =>
      retracted.has(i)
        ? {
            ...r,
            autoResolved: false,
            resolvedLines: null,
            resolutionReason: `Retracted: the merged content violates a format invariant. ${why}`,
          }
        : r,
    ),
  };
}

/**
 * #301 — Every retraction (format invariant, parse tree) goes through here:
 * a retracted hunk names no format resolver, in `hunks` and in `resolutions`.
 */
export function forgetRetractedFormatResolvers(
  hunks: ConflictHunk[],
  resolutions: HunkResolution[],
  isRetracted: (index: number) => boolean,
): { hunks: ConflictHunk[]; resolutions: HunkResolution[] } {
  return {
    hunks: hunks.map((h, i) => (isRetracted(i) ? withoutFormatResolver(h) : h)),
    resolutions: resolutions.map((r, i) => (isRetracted(i) ? { ...r, hunk: withoutFormatResolver(r.hunk) } : r)),
  };
}

/**
 * Explanations that say a mechanism resolved the hunk. Only these are
 * withdrawn: a pattern's explanation ("Resolution: take theirs.") describes
 * the resolution it proposes, which a retracted or held-back hunk still
 * offers as a proposal (the merge editor shows it), so it stays true.
 */
const CLAIMS_A_RESOLUTION = new Set<ExplanationKey>([
  "formatSemantic",
  "llmProposed",
  "structuralMerge",
  // "Resolved through the RefMerge pipeline".
  "refactoringRenames",
  "refactoringMoves",
  "refactoringBoth",
  "refactoringDetected",
  "refactoringFallback",
]);

/**
 * #301 — A hunk whose format-aware resolution was not applied names no
 * resolver. Nor does its explanation: one that says the hunk was resolved by
 * a format resolver, a structural merge, RefMerge or the LLM goes back to the
 * genuine-conflict one, in both forms (`explanation`, `explanationRef`).
 */
export function withoutFormatResolver(hunk: ConflictHunk): ConflictHunk {
  const { formatResolver: _unused, ...rest } = hunk;
  const key = rest.explanationRef?.key;
  if (key === undefined || !CLAIMS_A_RESOLUTION.has(key)) return rest;
  const input = { ...rest, endLine: rest.startLine };
  // The type stays (a held-back format_semantic hunk is still classified and
  // traced as one: min-confidence-score's contract); only the claim goes.
  return { ...rest, explanation: complexPattern.explanation(input), explanationRef: complexPattern.explanationRef?.(input) };
}

/**
 * Parse-tree invalide → rétraction de toutes les résolutions automatiques
 * (avec la pénalité de risque post-merge), sans résolveur de format nommé.
 */
export function retractForParseTree(
  hunks: ConflictHunk[],
  resolutions: HunkResolution[],
): { hunks: ConflictHunk[]; resolutions: HunkResolution[] } {
  const penalized = resolutions.map((r) => (r.autoResolved ? applyPostMergeRiskPenalty(r) : r));
  return forgetRetractedFormatResolvers(hunks, penalized, (i) => resolutions[i].autoResolved);
}
