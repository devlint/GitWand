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
export { tryResolveMarkdownConflict, parseSections, extractFrontmatter } from "./resolvers/markdown.js";

// Phase 7.3b — Résolveurs supplémentaires (YAML, imports TS/JS, Vue SFC, CSS)
export { tryResolveYamlConflict } from "./resolvers/yaml.js";
export { tryResolveImportConflict, isImportBlock } from "./resolvers/imports.js";
export { tryResolveVueConflict, parseSfcBlocks } from "./resolvers/vue.js";
export { tryResolveCssConflict, parseCssRules } from "./resolvers/css.js";

// Phase 8.1 — Résolveurs lockfile sémantiques (auto-resolve étendu)
export { tryResolveLockfileNpmConflict } from "./resolvers/lockfile-npm.js";
export { tryResolveYarnLockConflict } from "./resolvers/lockfile-yarn.js";
export { tryResolvePnpmLockConflict } from "./resolvers/lockfile-pnpm.js";

// Phase 7.4 — Politiques de merge et configuration par projet
export {
  matchGlob,
  effectivePolicyForFile,
  policyToConfig,
  parseGitwandrc,
  DEFAULT_POLICY,
} from "./config.js";
export {
  tryFormatAwareResolve,
  isJsonFile,
  isMarkdownFile,
  isYamlFile,
  isJsFile,
  isVueFile,
  isCssFile,
  isNpmLockfile,
  isYarnLockfile,
  isPnpmLockfile,
  isLockfile,
} from "./resolvers/dispatcher.js";

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
export type { YamlMergeResult, YamlEntry } from "./resolvers/yaml.js";
export type { ImportMergeResult, ImportStatement } from "./resolvers/imports.js";
export type { VueMergeResult, SfcBlock } from "./resolvers/vue.js";
export type { CssMergeResult, CssRule } from "./resolvers/css.js";
export type { FormatResolveResult } from "./resolvers/dispatcher.js";
export type { LockfileMergeResult } from "./resolvers/lockfile-npm.js";
export type { YarnLockMergeResult } from "./resolvers/lockfile-yarn.js";
export type { PnpmLockMergeResult } from "./resolvers/lockfile-pnpm.js";
export type { ImportSortStrategy } from "./resolvers/imports.js";
export type { MergePolicy, PolicyConfig, GitWandrcConfig } from "./config.js";
