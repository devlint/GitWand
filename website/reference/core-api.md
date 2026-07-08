# Core API

The `@gitwand/core` package exposes the conflict resolution engine as a programmatic API.

## Installation

```bash
npm install @gitwand/core
```

## Main Function

### `resolve(input, options?)`

Resolves merge conflicts in a file.

```typescript
import { resolve } from '@gitwand/core'

const result = resolve({
  base: baseContent,
  ours: oursContent,
  theirs: theirsContent,
  filePath: 'src/config.ts',
})
```

**Parameters:**

```typescript
interface MergeInput {
  base: string      // Common ancestor content
  ours: string      // Current branch content
  theirs: string    // Incoming branch content
  filePath: string  // File path (used for format detection and reporting)
}

interface GitWandOptions {
  resolveWhitespace?: boolean       // Resolve whitespace-only conflicts (default: true)
  resolveNonOverlapping?: boolean   // Resolve non-overlapping changes (default: true)
  minConfidence?: Confidence        // Minimum confidence for auto-resolution (default: "high")
  verbose?: boolean                 // Enable verbose output (default: false)
  explainOnly?: boolean             // Classify without resolving (default: false)
  policy?: MergePolicy              // Merge policy override
  patternOverrides?: Record<string, MergePolicy>  // Per-glob policy overrides
}
```

**Returns:** `MergeResult`

```typescript
interface MergeResult {
  filePath: string
  mergedContent: string | null   // null if nothing could be resolved
  hunks: ConflictHunk[]
  resolutions: HunkResolution[]
  stats: MergeStats
  validation: ValidationResult
}

interface MergeStats {
  totalConflicts: number
  autoResolved: number
  remaining: number
  byType: Record<ConflictType, number>
}
```

### `resolveAsync(content, filePath, options?, structuralOpts?)`

Async variant of `resolve`. Adds tree-sitter structural merge for supported languages, parse-tree validation, and the opt-in LLM fallback phase. Use this when `llmFallback` or structural merge is enabled.

### `summarizeTiers(byType)` *(v3.4)*

Derives the **recoverable-before-model** funnel from `MergeStats.byType` — a pure, TS-side helper (not part of `MergeStats` itself, which is a serialized contract).

```typescript
import { summarizeTiers } from '@gitwand/core'

const tiers = summarizeTiers(result.stats.byType)
// {
//   byTier: { trivial, advancedDeterministic, model, unresolved },
//   residual,              // advancedDeterministic + model + unresolved
//   aiReachable,           // model + unresolved
//   recoverableBeforeModel // advancedDeterministic / residual, 0 when residual is 0
// }
```

Consumed by the CLI resolve summary, the desktop MergeEditor, and the MCP `tierSummary` field.

## Parser Utilities

### `parseConflictMarkers(content)`

Extracts conflict blocks from a file's content.

```typescript
import { parseConflictMarkers } from '@gitwand/core'

const hunks = parseConflictMarkers(fileContent)
// Returns: ConflictHunk[]
```

### `classifyConflict(hunk)`

Classifies a conflict hunk into one of the conflict types (12 patterns in the registry, plus `generated_file`).

```typescript
import { classifyConflict } from '@gitwand/core'

const classification = classifyConflict(hunk)
// Returns: { type: ConflictType, confidence: ConfidenceScore, trace: DecisionTrace }
```

## Diff Utilities

### `computeDiff(a, b)`

Computes a line-level diff between two strings.

### `lcs(a, b)`

Computes the Longest Common Subsequence between two arrays.

### `mergeNonOverlapping(base, ours, theirs)`

Merges non-overlapping changes from both sides using LCS.

## Format-Aware Resolvers

Each resolver handles a specific file format. They are called automatically by `resolve()` based on the file extension, but can also be used directly.

### JSON / JSONC

```typescript
import { tryResolveJsonConflict, stripJsoncComments } from '@gitwand/core'
```

- `tryResolveJsonConflict(base, ours, theirs)` — Recursive key-by-key merging
- `stripJsoncComments(content)` — Remove JSONC comments for parsing

### Markdown

```typescript
import { tryResolveMarkdownConflict, parseSections, extractFrontmatter } from '@gitwand/core'
```

- `tryResolveMarkdownConflict(base, ours, theirs)` — Section-aware merging
- `parseSections(content)` — Split Markdown into heading-delimited sections
- `extractFrontmatter(content)` — Extract YAML frontmatter

### YAML

```typescript
import { tryResolveYamlConflict } from '@gitwand/core'
```

### TypeScript/JavaScript Imports

```typescript
import { tryResolveImportConflict, isImportBlock } from '@gitwand/core'
```

- `tryResolveImportConflict(base, ours, theirs)` — Import deduplication
- `isImportBlock(lines)` — Detect whether lines are import statements

### Vue SFC

```typescript
import { tryResolveVueConflict, parseSfcBlocks } from '@gitwand/core'
```

- `tryResolveVueConflict(base, ours, theirs)` — Per-block resolution
- `parseSfcBlocks(content)` — Parse `<template>`, `<script>`, `<style>` blocks

### CSS

```typescript
import { tryResolveCssConflict, parseCssRules } from '@gitwand/core'
```

### Lockfiles

```typescript
import {
  tryResolveLockfileNpmConflict,
  tryResolveYarnLockConflict,
  tryResolvePnpmLockConflict,
} from '@gitwand/core'
```

## File Type Detection

```typescript
import {
  isJsonFile, isMarkdownFile, isYamlFile,
  isJsFile, isVueFile, isCssFile,
  isNpmLockfile, isYarnLockfile, isPnpmLockfile, isLockfile,
  tryFormatAwareResolve,
} from '@gitwand/core'
```

- `tryFormatAwareResolve(filePath, base, ours, theirs)` — Tries the appropriate format-aware resolver based on file extension, falling back to `null` if no specialized resolver matches.

## Configuration Utilities

```typescript
import {
  parseGitwandrc,
  effectivePolicyForFile,
  policyToConfig,
  matchGlob,
  DEFAULT_POLICY,
} from '@gitwand/core'
```

- `parseGitwandrc(content)` — Parse a `.gitwandrc` JSON file
- `effectivePolicyForFile(config, filePath)` — Get the effective policy for a file path (considering pattern overrides)
- `policyToConfig(policy)` — Convert a `MergePolicy` name to its `PolicyConfig` object
- `matchGlob(pattern, filePath)` — Match a file path against a glob pattern
- `DEFAULT_POLICY` — `"prefer-theirs"`

## Types

The commonly used types are exported from the package (this list is not exhaustive — see [`packages/core/src/index.ts`](https://github.com/devlint/GitWand/blob/main/packages/core/src/index.ts) for the full surface, including the resolver-, diff- and format-profile result types):

```typescript
import type {
  MergeInput,
  MergeResult,
  MergeStats,
  ConflictHunk,
  HunkResolution,
  ConflictType,
  Confidence,
  ConfidenceScore,
  DecisionTrace,
  TraceStep,
  ValidationResult,
  ExternalValidationResult,
  GitWandOptions,
  MergePolicy,
  PolicyConfig,
  GitWandrcConfig,
  // LLM fallback (v2.5)
  LlmEndpoint,
  LlmFallbackConfig,
  LlmTrace,
  // Refactoring-aware merge (v2.6)
  RefactoringKind,
  Refactoring,
  // Token-level merge (v3.4)
  TokenMergeTrace,
  TokenMergeLineDetail,
  // Recoverable-before-model tier metric (v3.4)
  ResolutionTier,
  TierSummary,
} from '@gitwand/core'
```
