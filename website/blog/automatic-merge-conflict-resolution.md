---
title: "How I built automatic merge conflict resolution: pattern classification and composite confidence scoring"
description: "Pattern-based engine that auto-resolves trivial Git merge conflicts using classification, composite confidence scoring, and format-aware resolvers."
date: 2026-04-20
---

# How I built automatic merge conflict resolution: pattern classification and composite confidence scoring

Every Git client I've ever used treats merge conflicts the same way: show the markers, let the human figure it out. Even for the obvious ones — a lockfile where both branches bumped a version number, a config file where only one side changed a value, two branches that independently made the exact same edit. The tool knows it's a conflict. It just doesn't try to resolve it.

PhpStorm has a "magic wand" button that resolves trivial conflicts automatically. It's one of those features that, once you've used it, makes every other editor feel like it's missing a limb. I wanted that everywhere — not just in PhpStorm, not just with a specific language server. So I built the engine myself, as a standalone TypeScript library at the core of GitWand.

This article is about how that engine works: how conflicts are parsed, how each hunk gets classified, how confidence is scored across multiple dimensions, and how format-aware resolvers handle JSON and Markdown differently from plain text.

---

## What a merge conflict actually is

Before building a resolver, it helps to understand exactly what Git produces when it can't merge automatically.

When you run `git merge` and it hits a conflict, it writes conflict markers directly into the file:

```
<<<<<<< HEAD
const timeout = 5000;
||||||| base
const timeout = 3000;
=======
const timeout = 10000;
const retries = 3;
>>>>>>> feature/retry-logic
```

The `<<<<<<< HEAD` section is **ours** — the current branch. The `>>>>>>> feature/retry-logic` section is **theirs** — the incoming branch. The `||||||| base` section in the middle only appears when you use `git merge --diff3` (or `git config merge.conflictstyle diff3`), and it shows the **common ancestor** — what the code looked like before either branch touched it.

That third section, the base, is the key to almost everything. With ours and theirs alone (diff2), you can detect that two things conflict but you can't tell *who changed what relative to the starting point*. With the base (diff3), a whole class of conflicts becomes trivially resolvable:

- If ours matches the base but theirs doesn't → only one side changed → take theirs
- If theirs matches the base but ours doesn't → only one side changed → take ours
- If both changed, but to the same value → both sides agreed → take either

This is the foundation of the classifier.

---

## The pattern registry

The engine is built around a **pattern registry** — an ordered list of `PatternPlugin` objects, each responsible for detecting and resolving one class of conflict. Here's the interface:

```typescript
export interface PatternPlugin {
  type: ConflictType;
  priority: number;
  requires: "diff3" | "diff2" | "both";
  detect(h: ClassifyInput): boolean;
  confidence(h: ClassifyInput): ConfidenceScore;
  explanation(h: ClassifyInput): string;
  passReason(h: ClassifyInput): string;
  failReason(h: ClassifyInput): string;
}
```

The `requires` field is how the engine handles the diff2 vs diff3 distinction. If a pattern requires `"diff3"`, it's skipped entirely when the base isn't available. The `priority` determines evaluation order — lower numbers are tried first. The `complex` fallback always sits at priority 999 and always returns true, so something always matches.

The registry:

```typescript
const PATTERNS: PatternPlugin[] = [
  sameChange,            // priority 10  — both sides made the same edit
  deleteNoChange,        // priority 20  — one side deleted, the other didn't touch it
  oneSideChange,         // priority 30  — only one branch changed this block
  nonOverlapping,        // priority 40  — additions at different positions
  whitespaceOnly,        // priority 50  — same logic, different indentation
  reorderOnly,           // priority 55  — same lines, different order
  insertionAtBoundary,   // priority 57  — pure insertions on both sides, base intact
  valueOnlyChange,       // priority 60  — same structure, volatile values differ
  complex,               // priority 999 — overlapping edits, never auto-resolved
];
```

The `classifyConflict` function filters the registry by `requires`, sorts by priority, and returns the first pattern whose `detect()` returns true:

```typescript
export function classifyConflict(hunk: ClassifyInput): ClassifyResult {
  const hasBase = hunk.baseLines.length > 0;

  const eligible = PATTERNS
    .filter((p) =>
      p.requires === "both" ||
      (p.requires === "diff3" && hasBase) ||
      (p.requires === "diff2" && !hasBase),
    )
    .sort((a, b) => a.priority - b.priority);

  for (const pattern of eligible) {
    if (pattern.detect(hunk)) {
      const trace = buildTrace(hunk, eligible, allSorted, pattern);
      return {
        type: pattern.type,
        confidence: pattern.confidence(hunk),
        explanation: pattern.explanation(hunk),
        trace,
      };
    }
  }
}
```

### Two patterns in detail

**`same_change`** is the simplest case. It requires no base at all (`"both"`) because it doesn't need to reason about what changed — it only needs to know that ours and theirs ended up in the same place:

```typescript
const sameChange: PatternPlugin = {
  type: "same_change",
  priority: 10,
  requires: "both",

  detect(h: ClassifyInput): boolean {
    return h.oursLines.join("\n") === h.theirsLines.join("\n");
  },

  confidence(h: ClassifyInput): ConfidenceScore {
    return makeScore(100, 0, scopeImpact(h.oursLines.length), [
      "Both branches have exactly the same content",
    ], []);
  },
};
```

TypeClassification is 100 (string equality — no ambiguity), dataRisk is 0 (both sides agree on the output), and the only variable is `scopeImpact` from the block size.

**`one_side_change`** is the second most impactful pattern, but it requires diff3. Without the base, you can't tell which side changed:

```typescript
const oneSideChange: PatternPlugin = {
  type: "one_side_change",
  priority: 30,
  requires: "diff3",

  detect(h: ClassifyInput): boolean {
    const baseText   = h.baseLines.join("\n");
    const oursText   = h.oursLines.join("\n");
    const theirsText = h.theirsLines.join("\n");
    const oursMatchesBase   = oursText === baseText;
    const theirsMatchesBase = theirsText === baseText;
    return (oursMatchesBase && !theirsMatchesBase)
        || (!oursMatchesBase && theirsMatchesBase);
  },
};
```

If ours equals the base, theirs is the side that changed — accept theirs. If theirs equals the base, accept ours. No ambiguity, no risk of data loss.

---

## Composite confidence scoring

A simple "high / medium / low" label isn't sufficient for making reliable auto-resolution decisions. Two conflicts can both be classified as "high confidence" but have very different risk profiles. The engine uses a composite `ConfidenceScore` with five dimensions:

```typescript
export interface ConfidenceScore {
  score: number;     // 0–100 composite
  label: Confidence; // "certain" | "high" | "medium" | "low"
  dimensions: {
    typeClassification: number; // certainty of the detected pattern (0–100)
    dataRisk: number;           // risk of data loss if auto-resolved (0–100)
    scopeImpact: number;        // impact from block size (0–100)
    fileFrequency: number;      // penalty if file already has complex hunks
    baseAvailability: number;   // bonus if diff3 base is available
  };
  boosters: string[];
  penalties: string[];
}
```

The formula:

```
score = typeClassification
      − dataRisk        × 0.40
      − scopeImpact     × 0.15
      − fileFrequency   × 0.10
      + baseAvailability × 0.05
```

`scopeImpact` is a stepped function — a 2-line block and a 10-line block don't carry meaningfully different risk, but a 50-line block is a different story:

```typescript
export function scopeImpact(lines: number): number {
  if (lines <= 2)  return 0;
  if (lines <= 10) return 15;
  if (lines <= 30) return 35;
  return 55;
}
```

Label thresholds:

```typescript
export function labelFromScore(score: number): Confidence {
  if (score >= 92) return "certain";
  if (score >= 68) return "high";
  if (score >= 44) return "medium";
  return "low";
}
```

The `fileFrequency` dimension addresses a subtle failure mode: a file that already has several complex conflicts is likely to have more. Auto-resolving high-confidence hunks in a file riddled with complexity adds unnecessary risk. The penalty formula is `min(100, priorComplexHunksInFile × 20)`.

### A worked example

A `same_change` hunk on a 1-line block:
- typeClassification = 100, dataRisk = 0, scopeImpact = 0
- **score = 100 → label: `"certain"`**

A `value_only_change` hunk on a 3-line block without base:
- typeClassification = 88, dataRisk = 25, scopeImpact = 15
- **score = 88 − 25×0.4 − 15×0.15 ≈ 76 → label: `"high"`**

---

## The DecisionTrace

Every classification produces a `DecisionTrace` — a structured log of which patterns were evaluated, whether they passed, and why:

```typescript
export interface DecisionTrace {
  steps: TraceStep[];
  selected: ConflictType;
  summary: string;
  hasBase: boolean;
}
```

For a `one_side_change` hunk, the trace looks like this in `--verbose` output:

```
[❌] same_change: Both branches have different content.
[✅] one_side_change: Theirs matches base — only ours changed.
```

Patterns skipped because of a `requires` mismatch are annotated with the reason they were skipped. This structure powers the `--verbose` CLI output, the explain-only mode in the desktop app, and the `pendingHunks` payload sent to LLMs.

---

## Format-aware resolvers

Plain-text LCS matching works for most source code. But some formats have enough structure that semantic merging is far more reliable. GitWand ships format-aware resolvers for JSON, JSONC, Markdown, YAML, CSS, Vue SFC, lockfiles (npm, pnpm, yarn), Cargo.toml, Dockerfile, and `.env`.

### JSON: recursive key-by-key merge

Consider this conflict in `package.json`:

```json
<<<<<<< HEAD
{
  "dependencies": {
    "react": "^18.0.0",
    "lodash": "^4.17.21"
  }
}
||||||| base
{
  "dependencies": {
    "react": "^18.0.0"
  }
}
=======
{
  "dependencies": {
    "react": "^18.0.0",
    "axios": "^1.6.0"
  }
}
>>>>>>> feature/http-client
```

Line-level LCS matching produces an overlapping-edit conflict because both sides touched `dependencies`. The JSON resolver parses all three versions and merges key by key:

- `dependencies.react`: unchanged on both sides → keep
- `dependencies.lodash`: added on ours only → accept
- `dependencies.axios`: added on theirs only → accept

Result: a clean merged `package.json` with both `lodash` and `axios`. No human required.

### Markdown: section-by-section merge

Markdown conflicts often happen when two people added content in different sections. The Markdown resolver parses the file by ATX headings (H1–H6) and merges section by section. If the same section was modified on both sides, it falls back to text matching for that section only. If they modified different sections, the merge succeeds automatically.

---

## The CI mode and LLM collaboration loop

The `--ci` flag returns structured JSON designed for machine consumption:

```json
{
  "summary": { "totalConflicts": 5, "autoResolved": 4, "remaining": 1 },
  "files": [{
    "path": "src/complex.ts",
    "pendingHunks": [{
      "line": 42,
      "type": "complex",
      "ours": "const timeout = 5000;",
      "theirs": "const timeout = 10000;\nconst retries = 3;",
      "base": "const timeout = 3000;",
      "trace": { "summary": "Both sides modified — manual resolution required." }
    }]
  }]
}
```

The `pendingHunks` array is what makes LLM integration tractable. Instead of asking an LLM to parse conflict-marker files, you hand it everything: ours/theirs/base already extracted, the classification trace, and the file path for context.

The MCP server (`@gitwand/mcp`) enables a four-step loop:

1. LLM calls `gitwand_preview_merge` → sees how many conflicts exist and how many GitWand can handle
2. LLM calls `gitwand_resolve_conflicts` → GitWand auto-resolves the trivial ones, returns `pendingHunks`
3. LLM reads `pendingHunks` and generates resolutions
4. LLM calls `gitwand_apply_resolution` for each hunk

GitWand handles the deterministic part. The LLM handles the semantic reasoning. Neither tries to do the other's job.

---

## Performance

Benchmarks on an Apple M-series chip:

| Fixture | Throughput |
|---------|-----------|
| 1 conflict / ~30 lines | ~249 000 ops/s |
| 5 conflicts / ~140 lines | ~40 000 ops/s |
| 50 conflicts / ~1 350 lines | ~4 500 ops/s |
| JSON/Markdown format-aware | ~137 000 ops/s |

The main optimization worth mentioning is the LCS implementation. The naive DP table is O(n·m) in both time and memory. The engine uses Hirschberg's divide-and-conquer algorithm for large inputs, reducing memory to O(min(n, m)) — roughly 35× lower on 3000×3000 line inputs.

---

## What's next

322 tests passing across the 9 pattern types. The roadmap for the next cycle includes folder diff, image diff, GitLab / Bitbucket integration, and MCP Registry submission.

The repo is at [github.com/devlint/GitWand](https://github.com/devlint/GitWand). The CLI is `npx @gitwand/cli resolve`. If you use diff3 conflict style (you should — `git config --global merge.conflictstyle diff3`), the engine will automatically use the base for more precise classification.

The source for each pattern is an isolated file in `packages/core/src/patterns/` — straightforward to read and extend.
