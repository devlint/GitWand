/**
 * @gitwand/core v2.3 — Structural (AST-based) merge dispatcher
 *
 * Provides `tryStructuralMergeResolve()`, an async entry point that:
 *
 * 1. Reconstructs the three file versions (base/ours/theirs) from the
 *    Git conflict markers in the conflicted content.
 * 2. Parses each version with tree-sitter (via `web-tree-sitter`, optional peer).
 * 3. Extracts top-level entities and matches them across the three versions.
 * 4. Merges entities individually — only auto-resolvable conflicts are handled.
 * 5. Reconstructs the merged file following theirs entity order.
 *
 * Returns `null` (never throws) when:
 * - `web-tree-sitter` is not installed (graceful degradation)
 * - The grammar WASM file is unavailable
 * - Any version has parse errors
 * - Any entity has a real (both-changed-diff) conflict
 *
 * In all these cases the caller falls back to the standard hunk-based resolver.
 */

import { parseConflictMarkers } from "../parser.js";
import { validateMergedContent } from "../resolver/validation.js";
import type { MergeResult, ValidationResult, ConflictHunk, HunkResolution, MergeStats } from "../types.js";
import { loadGrammarForFile } from "./parsers/grammars/ts.js";
import { createParser, type LoaderOptions } from "./parsers/loader.js";
import { extractEntities, hasParseErrors } from "./entities.js";
import { matchEntities } from "./matching.js";
import { mergeEntity, hasEntityConflict } from "./merge.js";
import { reconstructFile } from "./reconstruct.js";
import { isStructuralLanguage } from "./parsers/grammars/languages.js";

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { LoaderOptions as StructuralLoaderOptions };
export { isStructuralLanguage };
export type { SupportedLanguage } from "./parsers/grammars/languages.js";

// ─── Backward-compat alias ────────────────────────────────────────────────────

/**
 * Returns `true` for `.ts` and `.tsx` files.
 * @deprecated Use `isStructuralLanguage` — now covers JS/JSX/Python/Go/Rust too.
 */
export function isTypeScriptFile(filePath: string): boolean {
  return /\.(ts|tsx)$/i.test(filePath) && !/\.d\.ts$/i.test(filePath);
}

// ─── Version reconstruction ───────────────────────────────────────────────────

interface VersionTriple {
  base: string;
  ours: string;
  theirs: string;
}

/**
 * Reconstruct the three clean file versions from a conflicted file.
 *
 * - `ours`   = text segments + ours lines from each conflict hunk
 * - `theirs` = text segments + theirs lines from each conflict hunk
 * - `base`   = text segments + base lines (diff3) or ours lines (diff2 fallback)
 */
function reconstructVersions(conflictedContent: string): VersionTriple {
  const { segments } = parseConflictMarkers(conflictedContent);

  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  const baseLines: string[] = [];

  for (const seg of segments) {
    if (seg.type === "text") {
      oursLines.push(...seg.lines);
      theirsLines.push(...seg.lines);
      baseLines.push(...seg.lines);
    } else {
      const { conflict } = seg;
      oursLines.push(...conflict.oursLines);
      theirsLines.push(...conflict.theirsLines);
      // Use diff3 base if available; fall back to ours (conservative)
      baseLines.push(
        ...(conflict.baseLines.length > 0 ? conflict.baseLines : conflict.oursLines),
      );
    }
  }

  return {
    base: baseLines.join("\n"),
    ours: oursLines.join("\n"),
    theirs: theirsLines.join("\n"),
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Attempt structural (AST-based) merge resolution for a TypeScript/TSX file.
 *
 * @param conflictedContent - File content with Git conflict markers
 * @param filePath          - File path (grammar selection + type detection)
 * @param opts              - Optional loader overrides (WASM paths, custom loaders)
 * @returns Merged content string on success, `null` on any failure
 */
export async function tryStructuralMergeResolve(
  conflictedContent: string,
  filePath: string,
  opts: LoaderOptions = {},
): Promise<string | null> {
  // Only handle supported languages
  if (!isStructuralLanguage(filePath)) return null;

  // Load tree-sitter grammar (returns null if optional peer not installed)
  const language = await loadGrammarForFile(filePath, opts);
  if (!language) return null;

  // Create parser
  const parser = await createParser(language, opts);
  if (!parser) return null;

  // Reconstruct the three file versions
  const { base, ours, theirs } = reconstructVersions(conflictedContent);

  // Parse all three versions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = parser as any;
  const [baseTree, oursTree, theirsTree] = [base, ours, theirs].map((src) => p.parse(src));

  // Abort on parse errors in any version
  if (hasParseErrors(baseTree) || hasParseErrors(oursTree) || hasParseErrors(theirsTree)) {
    return null;
  }

  // Extract top-level entities
  const baseEntities = extractEntities(baseTree, base);
  const oursEntities = extractEntities(oursTree, ours);
  const theirsEntities = extractEntities(theirsTree, theirs);

  // 3-way entity matching
  const matches = matchEntities(baseEntities, oursEntities, theirsEntities);

  // Entity-level merge decisions
  const merges = matches.map(mergeEntity);

  // Abort if any entity has a real conflict
  if (hasEntityConflict(merges)) return null;

  // Reconstruct the merged file
  const mergedContent = reconstructFile(merges, theirsEntities, oursEntities, theirs);

  return mergedContent;
}

// ─── MergeResult wrapper ──────────────────────────────────────────────────────

/**
 * Wrap a structurally merged content string in a `MergeResult` object.
 *
 * All hunks are marked as auto-resolved via the "structural-merge" resolver.
 * This keeps the return type compatible with the synchronous `resolve()`.
 */
export function wrapStructuralResult(
  conflictedContent: string,
  mergedContent: string,
  filePath: string,
): MergeResult {
  const { segments } = parseConflictMarkers(conflictedContent);

  const hunks: ConflictHunk[] = segments
    .filter((s): s is Extract<typeof s, { type: "conflict" }> => s.type === "conflict")
    .map((s) => ({
      baseLines: s.conflict.baseLines,
      oursLines: s.conflict.oursLines,
      theirsLines: s.conflict.theirsLines,
      startLine: s.conflict.startLine,
      type: "complex" as const,
      confidence: {
        score: 100,
        label: "certain" as const,
        dimensions: {
          typeClassification: 100,
          dataRisk: 0,
          scopeImpact: 0,
          fileFrequency: 0,
          baseAvailability: s.conflict.baseLines.length > 0 ? 100 : 0,
        },
        boosters: ["structural-merge"],
        penalties: [],
      },
      explanation: "Resolved by a structural merge (tree-sitter AST)",
      trace: {
        steps: [],
        selected: "complex" as const,
        summary: "Resolved by structural AST analysis: merged per TypeScript entity",
        hasBase: s.conflict.baseLines.length > 0,
      },
    }));

  const resolutions: HunkResolution[] = hunks.map((hunk) => ({
    hunk,
    resolvedLines: null,
    autoResolved: true,
    resolutionReason: "structural-merge: resolved by tree-sitter AST analysis",
  }));

  const byType = hunks.length > 0 ? ({ complex: hunks.length } as MergeStats["byType"]) : ({} as MergeStats["byType"]);

  const validation: ValidationResult = validateMergedContent(mergedContent, filePath);

  return {
    filePath,
    mergedContent,
    hunks,
    resolutions,
    stats: {
      totalConflicts: hunks.length,
      autoResolved: hunks.length,
      remaining: 0,
      byType,
    },
    validation,
  };
}
