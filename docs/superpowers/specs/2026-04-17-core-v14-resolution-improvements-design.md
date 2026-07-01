# GitWand Core v1.4 — Resolution Engine Improvements

**Date:** 2026-04-17  
**Scope:** `packages/core`  
**Status:** Approved for implementation

---

## Summary

This document specifies improvements to GitWand's conflict resolution engine for v1.4. The work covers four axes:

1. **Pattern registry refactor** — convert the monolithic classifier into a pluggable registry
2. **Two new conflict patterns** — `reorder_only` and `insertion_at_boundary`
3. **Three new format-aware resolvers** — `Cargo.toml/Lock`, `.env`, `Dockerfile`
4. **Confidence scoring enhancements** — two new dimensions + zdiff3 support

**Constraints:** zero external dependencies (all parsing hand-rolled), no LLM integration in core, fully backward-compatible public API.

---

## 1. Architecture — Pattern Registry

### Motivation

`parser.ts` is currently 802 lines with a single monolithic `classifyConflict()` function containing 8 sequential if-else branches. Adding `reorder_only` and `insertion_at_boundary` inline would push it past 1000 lines, make individual pattern testing harder, and create friction for every future pattern addition.

### Design

Introduce a `PatternPlugin` interface and migrate each pattern to its own file under `src/patterns/`. The classifier becomes a thin loop over a sorted registry.

```typescript
// src/types/pattern.ts
interface PatternPlugin {
  type: ConflictType
  priority: number           // lower = tested first
  requires: 'diff3' | 'diff2' | 'both'
  detect(h: ClassifyInput): boolean
  confidence(h: ClassifyInput): ConfidenceScore
  resolve(h: ClassifyInput, policy: PolicyConfig): string[] | null
}
```

```typescript
// src/classifier.ts  (replaces classifyConflict() in parser.ts)
const PATTERNS: PatternPlugin[] = [
  same_change,          // priority 10
  delete_no_change,     // priority 20
  one_side_change,      // priority 30
  non_overlapping,      // priority 40
  whitespace_only,      // priority 50
  reorder_only,         // priority 55  ← new
  insertion_at_boundary,// priority 57  ← new
  value_only_change,    // priority 60
  generated_file,       // priority 70
  complex,              // priority 999 (fallback, detect always true)
]

export function classifyConflict(hunk: RawConflict): ClassifyResult {
  const hasBase = hunk.baseLines !== null
  const eligible = PATTERNS
    .filter(p => p.requires === 'both'
      || (p.requires === 'diff3' && hasBase)
      || (p.requires === 'diff2' && !hasBase))
    .sort((a, b) => a.priority - b.priority)

  for (const pattern of eligible) {
    if (pattern.detect(hunk)) {
      return {
        type: pattern.type,
        confidence: pattern.confidence(hunk),
        trace: buildTrace(hunk, eligible, pattern),
      }
    }
  }
  // unreachable — complex always matches
}
```

### New file structure

```
packages/core/src/
├── types.ts                    ← add PatternPlugin interface
├── resolver.ts                 ← unchanged (orchestrator)
├── classifier.ts               ← new: replaces classifyConflict() in parser.ts
├── parser.ts                   ← keeps parseConflictMarkers(), removes classifier
├── diff.ts                     ← unchanged
├── config.ts                   ← unchanged
├── patterns/
│   ├── same-change.ts          ← extracted from parser.ts
│   ├── delete-no-change.ts
│   ├── one-side-change.ts
│   ├── non-overlapping.ts
│   ├── whitespace-only.ts
│   ├── reorder-only.ts         ← new
│   ├── insertion-at-boundary.ts← new
│   ├── value-only-change.ts
│   ├── generated-file.ts
│   └── complex.ts
└── resolvers/
    ├── dispatcher.ts           ← add cargo/dotenv/dockerfile dispatch
    ├── cargo.ts                ← new
    ├── dotenv.ts               ← new
    ├── dockerfile.ts           ← new
    └── (existing resolvers unchanged)
```

### Migration contract

- All existing exports from `parser.ts` remain available (re-exported) — no breaking change
- `classifyConflict()` signature unchanged
- Existing tests pass without modification
- Each pattern file exports a single `PatternPlugin` object as default

---

## 2. New Conflict Patterns

### 2.1 `reorder_only`

**Priority:** 55 (after `whitespace_only`, before `value_only_change`)  
**Requires:** `both` (diff2 and diff3)

**Description:** Both branches contain exactly the same set of lines but in a different order. Most common with auto-sorted imports, alphabetically-reordered config keys, or manually reorganized export lists.

**Detection algorithm:**

```typescript
function detect(h: ClassifyInput): boolean {
  const ours = h.oursLines.map(normalizeWhitespace).filter(l => l.length > 0)
  const theirs = h.theirsLines.map(normalizeWhitespace).filter(l => l.length > 0)
  if (ours.length !== theirs.length) return false
  return isMultisetEqual(ours, theirs)  // counts occurrences, handles duplicates
}

function isMultisetEqual(a: string[], b: string[]): boolean {
  const freq = new Map<string, number>()
  for (const l of a) freq.set(l, (freq.get(l) ?? 0) + 1)
  for (const l of b) {
    const n = freq.get(l)
    if (!n) return false
    n === 1 ? freq.delete(l) : freq.set(l, n - 1)
  }
  return freq.size === 0
}
```

**Resolution:** Accept `theirs` (most recent reordering intent). If base is available and base order matches theirs, accept ours instead (ours is the reorder, theirs is original).

**Confidence:**
- `typeClassification`: 92 (pure permutation is unambiguous)
- `dataRisk`: 5 (no data loss — same lines)
- `scopeImpact`: standard scale
- Penalty: −10 if duplicate lines detected (order is ambiguous)
- Booster: "Permutation pure — mêmes lignes, ordre différent"

**Edge cases:**
- Lines with only whitespace differences: normalize before comparison, but flag with `whitespace_only` booster
- Duplicate lines: penalty applied, confidence drops; still resolved (deterministic)
- Empty lines: stripped before comparison (consistent with existing `whitespace_only` normalization)

---

### 2.2 `insertion_at_boundary`

**Priority:** 57  
**Requires:** `both` (diff2 and diff3; confidence penalty applied without base)

**Description:** Both branches have only inserted lines relative to base — no deletions, no modifications. The insertions may be at different positions (top, bottom, or within the block). Common in dependency lists, route arrays, enum definitions, export lists.

Inspired by the ORT merge strategy (Git 2.34+) which introduced virtual merge base handling for add/add conflicts.

**Detection algorithm:**

```typescript
function detect(h: ClassifyInput): boolean {
  if (!h.baseLines) return detectWithoutBase(h)
  
  const oursRemovals = lcsRemovals(h.baseLines, h.oursLines)
  const theirsRemovals = lcsRemovals(h.baseLines, h.theirsLines)
  const oursAdded = lcsAdditions(h.baseLines, h.oursLines)
  const theirsAdded = lcsAdditions(h.baseLines, h.theirsLines)
  
  return oursRemovals.length === 0
    && theirsRemovals.length === 0
    && oursAdded.length > 0
    && theirsAdded.length > 0
    && !hasOverlap(oursAdded, theirsAdded)  // distinct insertions
}

// diff2 fallback: heuristic — if ours contains all theirs lines + extra,
// or vice versa, treat as boundary insertion with reduced confidence
function detectWithoutBase(h: ClassifyInput): boolean {
  const oursSet = new Set(h.oursLines.map(normalizeWhitespace))
  const theirsSet = new Set(h.theirsLines.map(normalizeWhitespace))
  const union = new Set([...oursSet, ...theirsSet])
  // Both sides are subsets of the union (neither deleted from the other)
  return [...oursSet].every(l => union.has(l))
    && [...theirsSet].every(l => union.has(l))
    && oursSet.size !== theirsSet.size  // they're not equal (same_change handles that)
}
```

**Resolution:**
- With base: `base lines` + `ours insertions` + `theirs insertions` (ours first by convention)
- Without base: `ours lines` + lines in `theirs` not in `ours` (union, ours order preserved)

**Confidence:**
- With base: `typeClassification` 90, `dataRisk` 8
- Without base: `typeClassification` 68, `dataRisk` 20
- Booster (diff3): "Insertions pures — base intacte des deux côtés"
- Penalty (diff2): "Sans base (diff2) — heuristique d'union"

**Relation to existing `non_overlapping`:** `non_overlapping` (priority 40) is tested before `insertion_at_boundary` (priority 57). For non-overlapping insertions the LCS 3-way merge succeeds and `non_overlapping` fires. `insertion_at_boundary` catches the cases where LCS fails because insertions land at the same positional boundary — the semantic analysis (pure-insertion check) still succeeds there and resolves via union. `non_overlapping` catches mixed add/modify cases that `insertion_at_boundary` intentionally excludes.

---

## 3. New Format-Aware Resolvers

All three resolvers follow the existing `FormatResolveResult` contract: return `{ lines }` on success or `null` to fall through to textual resolution.

### 3.1 `cargo.ts` — Cargo.toml and Cargo.lock

**Detection:** filename is exactly `Cargo.toml` or `Cargo.lock`

**Cargo.toml resolution:**

Hand-rolled TOML section parser. Only handles the subset relevant to conflict resolution:
- Section headers: `[section]`, `[section.subsection]`, `[[array]]`
- Key-value pairs: `key = "value"`, `key = { ... }`, multiline arrays `key = [\n  ...\n]`

Strategy per section:
- `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`: merge by crate name (union of keys; if same key with different version → `value_only_change` delegate)
- `[package]`: key-by-key merge; `version` field delegates to `value_only_change` detection
- `[features]`: merge feature lists as sets (union)
- `[workspace.members]` / `[workspace.dependencies]`: same as dependencies
- Any other section: conservative — fall through to textual if both modified

**Cargo.lock resolution:**

Parses `[[package]]` array entries. Each entry has `name`, `version`, `source`, `checksum`, `dependencies`.
- Key: `name@version`
- Merge: union by key; on key conflict prefer theirs (newer lock state)
- Confidence booster: "Cargo.lock — merge par crate name+version"
- Post-merge note added to booster: "Running `cargo update` recommended to verify integrity"

---

### 3.2 `dotenv.ts` — .env files

**Detection:** filename matches `.env`, `.env.*`, `*.env` (e.g. `.env.local`, `.env.production`)

**Parser:**
```
LINE = COMMENT | BLANK | EXPORT? KEY '=' VALUE
COMMENT = '#' ...
EXPORT = 'export '
KEY = [A-Z_][A-Z0-9_]*
VALUE = QUOTED_VALUE | UNQUOTED_VALUE
QUOTED_VALUE = '"' ... '"' | "'" ... "'"
UNQUOTED_VALUE = (everything until newline or '#')
```

Multiline values (backslash continuation or `"...\n..."`) are not supported — fall through to textual.

**Resolution strategy:**
- Parse all three versions (base, ours, theirs) into ordered `Map<string, Entry>`
- Merge as key-value union (same algorithm as JSON resolver):
  - Key in ours only → include ours
  - Key in theirs only → include theirs
  - Key in both, same value → include once
  - Key in both, different value → delegate to `value_only_change`; if not volatile → unresolvable
- Preserve comment lines immediately preceding a key (move with the key)
- Preserve blank-line grouping from theirs

---

### 3.3 `dockerfile.ts` — Dockerfile

**Detection:** filename is `Dockerfile`, `Dockerfile.*`, `*.dockerfile`

**Instruction model:**

```typescript
type Instruction =
  | { kind: 'FROM'; image: string; alias?: string }
  | { kind: 'ENV' | 'ARG'; entries: Map<string, string> }
  | { kind: 'COPY' | 'ADD'; src: string[]; dest: string }
  | { kind: 'RUN' | 'CMD' | 'ENTRYPOINT'; raw: string }
  | { kind: 'WORKDIR' | 'EXPOSE' | 'USER' | 'LABEL'; raw: string }
  | { kind: 'COMMENT'; text: string }
  | { kind: 'BLANK' }
```

**Multi-stage support:** Split on `FROM … AS <stage>` boundaries. Merge stage-by-stage. If stage added by one branch only → include it.

**Per-instruction merge strategy:**
- `FROM`: prefer theirs (base image update is the more recent intent)
- `ENV` / `ARG`: merge by key (same as .env resolver)
- `COPY` / `ADD`: merge if destinations are distinct; conflict if same dest
- `RUN`: conservative — if both branches modify the same `RUN` instruction, fall through to textual
- `WORKDIR`, `EXPOSE`, `USER`: prefer theirs; flag as manual if both modified differently
- `COMMENT`, `BLANK`: preserve from theirs

**Limitation:** `RUN` with `\` line continuations parsed as a single logical instruction; multi-line RUN conflicts always fall through.

---

### 3.4 Improvements to Existing Resolvers

**YAML — list merge:**  
Currently sequences (`- item`) fall through. New behavior: if all items are scalar (string/number/bool, no nesting), merge as set union (sorted). Anchors/aliases still cause fallthrough.

**Markdown — intra-section list merge:**  
Currently intra-section conflicts fall through entirely. New behavior: if the conflicting region is a bullet list (`-` or `*` at consistent indent), merge as item union.

**CSS — one-level SCSS nesting:**  
Detect `selector { nested-selector { ... } }` patterns (one level only). Merge nested selectors as additional keys within the parent. Two-level or deeper nesting falls through.

---

## 4. Confidence Scoring Enhancements

### 4.1 New dimensions

**`fileFrequency` (penalty, weight 0.10):**  
A penalty applied when the same file path has previously generated `complex` unresolved conflicts in the current `resolve()` call (multiple hunks in the same file). This signals a "hot" conflict zone.

```
fileFrequency = min(100, priorComplexHunksInFile × 20)
```

Reduces overconfidence when applying whitespace/value-only resolutions to a file that's already shown ambiguity.

**`baseAvailability` (bonus, weight 0.05):**  
Formalizes the existing diff2/diff3 distinction as an explicit dimension. diff3 (base known) = 100, diff2 (no base) = 0. Currently captured only in per-pattern penalties; making it a dimension makes it visible in the `ConfidenceScore` output.

**Updated formula:**
```
score = typeClassification
      − (dataRisk        × 0.40)
      − (scopeImpact     × 0.15)
      − (fileFrequency   × 0.10)
      + (baseAvailability × 0.05)
```

### 4.2 zdiff3 detection

Git 2.35+ introduced `zdiff3` conflict style. Unlike `diff3`, the base section only shows lines that differ from both ours and theirs, making markers shorter and easier to parse semantically.

GitWand already detects the `|||||||` marker for diff3. zdiff3 produces the same markers but with a trimmed base region. Detection: when base lines are a strict subset of either ours or theirs → flag as `zdiff3: true` in `ConflictHunk`.

Effect: `baseAvailability` dimension set to 100 (same as diff3); add booster "zdiff3 — base tronquée aux sections divergentes".

### 4.3 New boosters and penalties

| Pattern | Booster | Penalty |
|---------|---------|---------|
| `reorder_only` | "Permutation pure — mêmes lignes, ordre différent" | "Lignes dupliquées — ordre ambigu (−10)" |
| `insertion_at_boundary` (diff3) | "Insertions pures — base intacte des deux côtés" | — |
| `insertion_at_boundary` (diff2) | — | "Sans base (diff2) — heuristique d'union (−22)" |
| `cargo` resolver | "Cargo.toml — merge par nom de crate" | — |
| `.env` resolver | "Format key=value — merge par clé" | — |
| `dockerfile` FROM | "Dockerfile FROM — prefer-theirs (image plus récente)" | — |
| zdiff3 | "zdiff3 — base tronquée aux sections divergentes" | — |

---

## 5. Test Corpus

### Expansion: 20 → 32 fixtures

| Range | Category | New fixtures |
|-------|----------|--------------|
| F01–F20 | Existing (unchanged) | — |
| F21–F22 | `reorder_only` | F21: imports triés alphabétiquement; F22: clés de config réorganisées |
| F23–F24 | `insertion_at_boundary` | F23: liste de dépendances npm; F24: tableau de routes |
| F25–F27 | Cargo | F25: `[dependencies]` conflict; F26: version bump; F27: `Cargo.lock` package merge |
| F28–F29 | `.env` | F28: clés ajoutées des deux côtés; F29: même clé, valeur différente |
| F30 | Dockerfile | F30: ENV + FROM conflict, multi-stage |
| F31 | zdiff3 | F31: zdiff3 format detection + correct base extraction |
| F32 | Edge case | F32: `reorder_only` avec lignes dupliquées |

### New test files

- `src/__tests__/patterns/reorder-only.test.ts`
- `src/__tests__/patterns/insertion-at-boundary.test.ts`
- `src/__tests__/resolvers/cargo.test.ts`
- `src/__tests__/resolvers/dotenv.test.ts`
- `src/__tests__/resolvers/dockerfile.test.ts`
- `src/__tests__/confidence-v14.test.ts` (new dimensions + zdiff3)

Estimated test count: 332 → ~430 tests.

### Benchmark baseline maintained

The existing `pnpm test:bench` benchmarks must not regress. Pattern registry lookup adds one extra sort per `classifyConflict()` call — acceptable since PATTERNS has ≤ 11 entries.

---

## 6. Non-goals

- No LLM integration in core (handled by desktop app and MCP server)
- No external parsing dependencies (`@iarna/toml`, `dotenv` package, etc.)
- No support for `go.mod`, Protobuf, SQL migrations, or HCL in this version
- No changes to the public `resolve()` API signature
- No changes to the CLI or MCP packages (they consume the core as-is)
- No recursive SCSS nesting beyond one level

---

## 7. Implementation order

1. Pattern registry migration (pure refactor, no behavior change, all existing tests pass)
2. `reorder_only` pattern + F21–F22 + tests
3. `insertion_at_boundary` pattern + F23–F24 + tests
4. `cargo.ts` resolver + F25–F27 + tests
5. `dotenv.ts` resolver + F28–F29 + tests
6. `dockerfile.ts` resolver + F30 + tests
7. Confidence scoring v1.4 + zdiff3 + F31–F32 + tests
8. YAML/Markdown/CSS improvements (bonus — if scope allows)
