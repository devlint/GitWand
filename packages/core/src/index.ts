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

export { resolve, resolveAsync } from "./resolver/index.js";

// v2.3 — Merge structurel AST (tree-sitter) — TS/TSX/JS/JSX/Python/Go/Rust
export {
  tryStructuralMergeResolve,
  isTypeScriptFile,       // backward compat
  isStructuralLanguage,   // preferred
  wrapStructuralResult,
} from "./structural/index.js";
export type { StructuralLoaderOptions, SupportedLanguage } from "./structural/index.js";
export { parseConflictMarkers, classifyConflict } from "./parser.js";
export { mergeNonOverlapping, computeDiff, lcs } from "./diff.js";

// v2.1 — nouveaux backends diff exposés
export {
  histogramDiff,
  detectBlockMove,
  lcsLegacy,
  type HistogramOptions,
  type MovedBlock,
  type BlockMoveOptions,
} from "./diff/index.js";

// v2.2 — registre de profils de format + RFC 6902
export {
  profileForFile,
  registerFormatProfile,
  strategyForPath,
  type FormatProfile,
  type PathStrategy,
} from "./format-profiles/index.js";
export {
  diffJson,
  applyJsonPatch,
  mergeJsonPatches,
  parseJsonPointer,
  buildJsonPointer,
  jsonStructEqual,
} from "./format-profiles/json-patch.js";
export type { JsonPatchOp } from "./format-profiles/types.js";

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
  ExternalValidationResult,
  // v2.5 — LLM fallback
  LlmEndpoint,
  LlmFallbackConfig,
  LlmTrace,
  // v2.6 — Refactoring-aware merge
  RefactoringKind,
  Refactoring,
  // v2.7 — Token-level merge
  TokenMergeTrace,
  TokenMergeLineDetail,
} from "./types.js";

// v2.6 — Refactoring-aware merge pipeline
export {
  detectRefactorings,
  invertRefactorings,
  replayRefactorings,
  mergeRefactorings,
  tryRefMerge,
} from "./refactoring/index.js";
export type { RefMergeResult } from "./refactoring/index.js";

// v2.5 — LLM fallback resolver (consommateurs souhaitant invoquer directement)
export { tryLlmFallbackResolve } from "./resolvers/llm-fallback.js";
export type { LlmResolveResult } from "./resolvers/llm-fallback.js";

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

// v2.7 — "Recoverable-before-model" tier metric (derived, TS-only — see stats/tiers.ts)
export { summarizeTiers } from "./stats/tiers.js";
export type { ResolutionTier, TierSummary } from "./stats/tiers.js";

// v3.5.0 — Secrets scanner (pure, mirrored in Rust — see secrets/scanner.ts)
export { scanSecrets, shannonEntropy, redact, isIgnored, DEFAULT_IGNORE_GLOBS } from "./secrets/scanner.js";
export { BUILT_IN_PATTERNS } from "./secrets/patterns.js";
export type {
  SecretSeverity,
  SecretPattern,
  ScanFileInput,
  SecretsScanConfig,
  SecretFinding,
} from "./secrets/types.js";
