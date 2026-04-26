# @gitwand/core

[![npm](https://img.shields.io/npm/v/@gitwand/core?color=22c55e)](https://www.npmjs.com/package/@gitwand/core)
[![License](https://img.shields.io/badge/license-MIT-8B5CF6)](../../LICENSE)

**The conflict resolution engine that powers [GitWand](https://github.com/devlint/GitWand).**

This package is primarily a build-time dependency of [`@gitwand/cli`](https://www.npmjs.com/package/@gitwand/cli) and [`@gitwand/mcp`](https://www.npmjs.com/package/@gitwand/mcp). Most users should install one of those instead.

> ⚠️ **Pre-1.0 stability note.** `@gitwand/core` exposes a deliberately small API (`resolve`, `MergeResult`, a handful of types) but is not yet under a formal semver stability commitment. Breaking changes may land in minor versions until the API is declared stable in a future release. If you depend on it directly, pin an exact version.

## Use as a library

```ts
import { resolve } from "@gitwand/core";

const content = readFileSync("src/app.ts", "utf-8");
const result = resolve(content, "src/app.ts");

console.log(`${result.stats.autoResolved}/${result.stats.totalConflicts} resolved`);

if (result.mergedContent) {
  writeFileSync("src/app.ts", result.mergedContent);
}
```

### With options

```ts
const result = resolve(content, "package-lock.json", {
  policy: "prefer-merge",
  minConfidence: "medium",
  patternOverrides: { "*.lock": "prefer-theirs" },
  explainOnly: true,  // don't produce a merged output, just analyze
});
```

## What it does

Parses a file with Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and produces a structured merge result: per-hunk classification, composite confidence score, decision trace, and — when possible — a clean merged content string.

Pattern detection is priority-ordered: `same_change`, `one_side_change`, `delete_no_change`, `non_overlapping`, `whitespace_only`, `reorder_only`, `insertion_at_boundary`, `value_only_change`, `generated_file`, and `complex` (never auto-resolved).

Format-aware resolvers layer on top: JSON / JSONC, Markdown (ATX-heading-aware), YAML, Vue SFC, CSS, and common lockfiles.

See the [main README](https://github.com/devlint/GitWand#conflict-resolution-engine) for the full pattern list, confidence scoring details, and `.gitwandrc` configuration.

## Diff backend (v2.1+)

Since `2.1.0`, the underlying diff algorithm is **Histogram diff** (rare-anchor splitting with JGit-style forward/backward extension). Histogram produces more stable alignments on real source code than the previous LCS-only backend, which lifts auto-resolution rates on `non_overlapping` and `insertion_at_boundary` patterns.

The public signatures are unchanged — `lcs(a, b)`, `computeDiff(base, branch)`, and `mergeNonOverlapping(base, ours, theirs)` keep their contracts. The switch is opaque to consumers.

To roll back to the legacy LCS DP / Hirschberg backend (e.g. for reproducibility, debugging a tie-break difference, or perf comparison on a specific input):

```bash
GITWAND_DIFF=lcs node ./your-script.mjs
```

The flag is read at call time, so you can also set it inside a Node process. On runtimes where `process.env` is undefined (pure browser), the default Histogram path is always used.

Two new primitives ship alongside:

```ts
import { histogramDiff, detectBlockMove } from "@gitwand/core";

// Direct Histogram call — same return shape as lcs().
const pairs = histogramDiff(linesA, linesB);

// Detect blocks moved between ours and theirs but absent (or at a
// different position) in base. Used downstream by the refactor-aware
// merge work scheduled for v2.6.
const moves = detectBlockMove(base, ours, theirs);
```

## Links

- 📖 [Documentation](https://github.com/devlint/GitWand#conflict-resolution-engine)
- 🐛 [Issue tracker](https://github.com/devlint/GitWand/issues)
- 📜 [License — MIT](../../LICENSE)
