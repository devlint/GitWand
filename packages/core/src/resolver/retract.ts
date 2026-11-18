/**
 * #301 — Retractions of automatic resolutions. Every retraction (a format
 * invariant, an invalid parse tree, after the LLM fallback too) goes through
 * here, so a retracted hunk never names a format resolver it was not, in
 * the end, resolved by.
 */
import type { ConflictHunk, HunkResolution } from "../types.js";
import { applyPostMergeRiskPenalty } from "./validate-parse-tree.js";

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

/** #301 — A hunk whose format-aware resolution was not applied names no resolver. */
export function withoutFormatResolver(hunk: ConflictHunk): ConflictHunk {
  const { formatResolver: _unused, ...rest } = hunk;
  return rest;
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
