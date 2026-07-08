# Conflict Resolution Engine

GitWand's core engine classifies each merge-conflict hunk against a prioritised pattern registry, scores each with a composite confidence metric, and auto-resolves the ones it's confident about — leaving the complex ones for human judgment. Eight deterministic patterns auto-apply; the rest either propose a merge you confirm, are opt-in, or hand the hunk back with its trace.

## Pipeline

```
Conflicted text → parseConflictMarkers → classifyConflict → resolveHunk → MergeResult
```

1. **Parse** — Extract conflict markers from the file, producing `ConflictHunk` objects with `base`, `ours`, and `theirs` lines
2. **Recover base if needed** *(v3.4)* — When git wrote the conflict in its default style (no `|||||||` base section), the diff3 base is reconstructed from the git index so the base-dependent patterns below can still fire. Without this, roughly half the patterns were inert on default-configured repos. Skipped when the working tree was hand-edited outside the markers, to avoid clobbering manual work.
3. **Classify** — Evaluate patterns in the **pattern registry** in priority order; each pattern declares whether it requires `diff3` (base available), `diff2`, or works on `both`
4. **Score** — Compute a composite confidence score for the classification
5. **Resolve** — Apply the appropriate resolution strategy (or mark as manual)
6. **Validate** — Check the merged output for residual markers and syntax errors

## Pattern Registry (v1.4)

In v1.4, the classifier was rewritten around a prioritised pattern registry. Each pattern implements a common interface:

```typescript
interface ConflictPattern {
  type: ConflictType
  priority: number                          // smaller = evaluated first
  requires: 'diff3' | 'diff2' | 'both'      // base availability required
  detect(h: ClassifyInput): boolean
  confidence(h: ClassifyInput): ConfidenceScore
  explanation(h: ClassifyInput): string
  passReason(h: ClassifyInput): string
  failReason(h: ClassifyInput): string
}
```

Patterns are evaluated in priority order until one matches. The full evaluation trace (passed/failed + reason for each step) lives in the `DecisionTrace` and is available via the `--verbose` CLI flag or the `gitwand_explain_hunk` MCP tool.

## The Conflict Types

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

### `reorder_only` *(v1.4)*

Both sides contain the same lines as the base, but in a different order — a pure permutation with no content changes. Common with import sorters, alphabetised keys, or table-of-contents updates. Resolution: take either side (content is identical).

### `insertion_at_boundary` *(v1.4)*

Both sides only insert new lines around an intact base — no modifications to existing content. Resolution: concatenate both insertions, preserving the original base lines between them.

### `value_only_change`

Same structure, but volatile values differ — hashes, version numbers, timestamps, integrity fields. Common in lockfiles and build outputs. When both sides changed the value and the tokens are comparable (semver or ISO timestamps), GitWand keeps the higher semver / later timestamp deterministically; otherwise it falls back to the merge policy. *(v3.4: extended to work with a base, and quote-aware so multi-word quoted values like `'2026-07-06 11:42:00'` aren't split on inner whitespace.)*

### `token_level_merge` *(v3.4)*

Both sides changed the same line but touched **disjoint tokens** of it — e.g. two branches editing different utility classes on one HTML/JSX tag, or different attributes of the same element. GitWand decomposes the line token by token and computes the merge. **Never auto-applied**, regardless of confidence: it surfaces the proposed result in a panel you confirm explicitly, applied through the same path as a manual edit.

### `refactoring_aware_merge` *(opt-in)*

A rename or method move detected on one or both sides and replayed across the conflict (invert → merge → replay). Off by default; enable via `refactoringAware`. Forced on automatically whenever the LLM fallback is enabled, so a deterministically recoverable rename never reaches the model.

### `llm_proposed` *(opt-in)*

When enabled, a hunk no deterministic pattern could resolve is sent to the configured LLM endpoint; the proposal is validated post-merge (parse-tree, optionally tsc/eslint) before it can be accepted. Strictly opt-in, always audited.

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
| `reorder_only` | Either side | Same content, different order |
| `insertion_at_boundary` | Merge both | Independent additions around intact base |
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
