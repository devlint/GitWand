# Conflict Resolution Engine

GitWand's core engine classifies merge conflicts into 8 patterns, scores each with a composite confidence metric, and auto-resolves the ones it's confident about — leaving the complex ones for human judgment.

## Pipeline

```
Conflicted text → parseConflictMarkers → classifyConflict → resolveHunk → MergeResult
```

1. **Parse** — Extract conflict markers from the file, producing `ConflictHunk` objects with `base`, `ours`, and `theirs` lines
2. **Classify** — Determine the conflict type by evaluating each pattern in order
3. **Score** — Compute a composite confidence score for the classification
4. **Resolve** — Apply the appropriate resolution strategy (or mark as manual)
5. **Validate** — Check the merged output for residual markers and syntax errors

## The 8 Conflict Types

### `same_change`

Both sides made identical changes from the base. Resolution: use either side (they're the same).

### `one_side_change`

Only one side modified the base; the other kept it unchanged. Resolution: take the modified side.

### `delete_no_change`

One side deleted the block while the other left it unchanged. Resolution: accept the deletion.

### `non_overlapping`

Both sides made changes, but at different locations within the block. Resolution: merge both changes using LCS (Longest Common Subsequence).

### `whitespace_only`

The only differences are whitespace (indentation, trailing spaces, line endings). Resolution: prefer ours (preserve local formatting).

### `value_only_change`

Same structure, but volatile values differ — hashes, version numbers, timestamps, integrity fields. Common in lockfiles and build outputs. Resolution: prefer theirs (incoming values are newer).

### `generated_file`

The file is auto-generated (lockfiles, minified bundles, build manifests). Detected by filename patterns. Resolution: prefer theirs (the file will be regenerated).

**Detected patterns:** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `composer.lock`, `Gemfile.lock`, `Cargo.lock`, `.min.js`, `.min.css`, `dist/`, `build/manifest.json`, `.bundle.js`, `.bundle.css`

### `complex`

A real conflict that requires human judgment. GitWand does **not** auto-resolve these.

## Composite Confidence Scoring

Each classification produces a score from 0 to 100 across three dimensions:

| Dimension | Range | Meaning |
|-----------|-------|---------|
| `typeClassification` | 0–100 | How certain is the conflict type detection |
| `dataRisk` | 0–100 | Risk of data loss (0 = safe, 100 = high risk) |
| `scopeImpact` | 0–100 | Impact of the change size (0 = small, 100 = large) |

**Formula:**

```
score = typeClassification − dataRisk × 0.4 − scopeImpact × 0.15
```

**Score-to-label mapping:**

| Score | Label |
|-------|-------|
| ≥ 92 | `certain` |
| ≥ 68 | `high` |
| ≥ 44 | `medium` |
| < 44 | `low` |

The score also includes `boosters` (factors that increased confidence) and `penalties` (cautionary factors) for transparency.

## Decision Traces

Every classification produces a `DecisionTrace` showing which patterns were evaluated, which passed, and why the final type was selected. This is useful for debugging unexpected classifications.

```typescript
interface DecisionTrace {
  steps: Array<{
    type: ConflictType
    passed: boolean
    reason: string
  }>
  selected: ConflictType
  summary: string
  hasBase: boolean
}
```

Use `explainOnly: true` in the options to get traces without writing any files.

## Resolution Policies

The default resolution strategy can be overridden per-project with a [`.gitwandrc` configuration file](/reference/config).

**Default behavior by type:**

| Type | Resolution | Rationale |
|------|-----------|-----------|
| `same_change` | Either side | Identical changes |
| `one_side_change` | Modified side | Preserve the change |
| `delete_no_change` | Accept deletion | Intentional removal |
| `non_overlapping` | LCS merge | Both changes coexist |
| `whitespace_only` | Ours | Preserve local formatting |
| `value_only_change` | Theirs | Incoming values are newer |
| `generated_file` | Theirs | Will be regenerated |
| `complex` | No auto-resolution | Too risky |

## Format-Aware Resolvers

Beyond the generic text-based resolution, GitWand includes specialized resolvers for structured file formats:

- **JSON / JSONC** — Recursive key-by-key merging, preserving structure
- **Markdown** — Section-aware merging with frontmatter extraction
- **YAML** — Structure-aware merging
- **TypeScript/JavaScript imports** — Import statement deduplication
- **Vue SFC** — Per-block (`<template>`, `<script>`, `<style>`) resolution
- **CSS** — Rule-level merging
- **Lockfiles** — Specialized handlers for npm, Yarn, and pnpm lockfiles

Format detection is automatic based on file extension. Format-aware resolvers are tried first; if they can't handle the conflict, the generic resolver takes over.

## Post-Merge Validation

After resolution, GitWand validates the output:

- **Residual markers** — Checks that no `<<<<<<<`, `=======`, or `>>>>>>>` markers remain
- **Syntax errors** — For structured formats (JSON, YAML), validates the output parses correctly

```typescript
interface ValidationResult {
  hasResidualMarkers: boolean
  residualMarkerLines: number[]
  syntaxError: string | null
  isValid: boolean
}
```
