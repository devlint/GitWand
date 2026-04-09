/**
 * @gitwand/core
 *
 * Git's magic wand — automatic conflict resolution engine.
 *
 * @example
 * ```ts
 * import { resolve } from "@gitwand/core";
 *
 * const result = resolve(conflictedFileContent, "src/app.ts");
 *
 * console.log(`${result.stats.autoResolved}/${result.stats.totalConflicts} conflits résolus`);
 *
 * if (result.mergedContent) {
 *   // Tous les conflits ont été résolus !
 *   fs.writeFileSync("src/app.ts", result.mergedContent);
 * }
 * ```
 */

export { resolve } from "./resolver.js";
export { parseConflictMarkers, classifyConflict } from "./parser.js";
export { mergeNonOverlapping, computeDiff, lcs } from "./diff.js";

// Phase 7.3 — Résolveurs spécialisés par format
export { tryResolveJsonConflict, stripJsoncComments } from "./resolvers/json.js";

// Phase 7.4 — Politiques de merge et configuration par projet
export {
  matchGlob,
  effectivePolicyForFile,
  policyToConfig,
  parseGitwandrc,
  DEFAULT_POLICY,
} from "./config.js";
export { tryResolveMarkdownConflict, parseSections, extractFrontmatter } from "./resolvers/markdown.js";
export { tryFormatAwareResolve, isJsonFile, isMarkdownFile } from "./resolvers/dispatcher.js";

export type {
  MergeInput,
  MergeResult,
  MergeStats,
  ConflictHunk,
  ConflictType,
  Confidence,
  // Phase 7.3b — Score de confiance composite
  ConfidenceScore,
  HunkResolution,
  GitWandOptions,
  // Phase 7.1
  DecisionTrace,
  TraceStep,
  // Phase 7.2
  ValidationResult,
} from "./types.js";

export type { JsonMergeResult } from "./resolvers/json.js";
export type { MarkdownMergeResult, MarkdownSection } from "./resolvers/markdown.js";
export type { FormatResolveResult } from "./resolvers/dispatcher.js";
export type { MergePolicy, PolicyConfig, GitWandrcConfig } from "./config.js";
