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

export type {
  MergeInput,
  MergeResult,
  MergeStats,
  ConflictHunk,
  ConflictType,
  Confidence,
  HunkResolution,
  GitWandOptions,
} from "./types.js";
