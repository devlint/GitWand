# `@gitwand/core` — Changelog

All notable changes to this package will be documented in this file. Format inspired by [Keep a Changelog](https://keepachangelog.com/), with deltas grouped by minor version of the v2 sequence (see [`CORE-V2-ROADMAP.md`](../../CORE-V2-ROADMAP.md) for the full plan).

## [2.1.0] — 2026-04-27

### Diff backend — Histogram by default

The underlying LCS routine now uses **Histogram diff** (rare-anchor splitting with forward/backward extension, JGit-style), replacing the pure DP / Hirschberg backend that shipped through 2.0.x. The new alignment is more stable on real source code, which directly lifts the success rate of `non_overlapping` and `insertion_at_boundary` patterns — observed gains on the v2.1 corpus fixtures (F22, F23, F24) where conflicts that previously hit `complex` are now auto-resolved end-to-end.

The change is **opaque to consumers**: `lcs(a, b)`, `computeDiff(base, branch)` and `mergeNonOverlapping(base, ours, theirs)` keep their public signatures. Tie-breaks may differ from the legacy backend on the exact pair list, but length and validity contracts hold.

To roll back to the legacy backend (debug, reproducibility, perf comparison):

```bash
GITWAND_DIFF=lcs node ./script.mjs
```

The flag is read at call time. On runtimes without `process.env` (pure browser), Histogram is always used.

### New exports

- `histogramDiff(a, b, opts?)` — direct call to the new backend, same return shape as `lcs()`. Options: `maxDepth` (recursion guard), `smallInputThreshold` (200 by default — short-circuits to legacy DP on inputs smaller than this).
- `lcsLegacy(a, b)` — explicit handle on the legacy DP / Hirschberg backend, preserved for testing and side-by-side comparison.
- `detectBlockMove(base, ours, theirs, opts?)` — Rabin-Karp rolling-hash detector for blocks present in `ours` and `theirs` but absent (or at a different position) in `base`. Filters: 5-line minimum window, token diversity threshold, literal anti-collision check, adjacent-window compaction. Primitive only — no scoring impact in 2.1; consumed by the refactor-aware merge scheduled for v2.6.
- `MovedBlock`, `BlockMoveOptions`, `HistogramOptions` — new types.

### `ConfidenceScore`

A new optional dimension `algorithmStability` is part of the `ConfidenceScore.dimensions` shape. The score formula gains a `−algorithmStability × 0.10` term (default `0` → identical numeric output to v1.4 for all existing patterns). Consumers that don't set it see no behavioral change. The dimension is wired into the type system but not yet alimented — it'll be driven by `detectBlockMove` once the v2.6 refactoring-aware merge lands.

### Internals

- `src/diff.ts` split into `src/diff/{lcs,histogram,block-move,shared,index}.ts`. The flat `src/diff.ts` becomes a one-line shim that re-exports `./diff/index.js` so existing imports `from "../diff.js"` keep working with no churn. Slated for removal in v2.2.
- `src/patterns/insertion-at-boundary.ts` no longer maintains its own LCS DP — it delegates to the shared `lcs()` (which routes through Histogram by default). Dead-code elimination, identical behavior.
- New tests: `__tests__/diff/histogram.test.ts`, `__tests__/diff/parity.test.ts`, `__tests__/diff/block-move.test.ts`, `__tests__/patterns/make-score.test.ts` (≈ +30 tests). Corpus extended with fixtures F21–F25.
- New benches: `histogramDiff` vs `lcsLegacy` on 100×100 and 3000×3000 inputs in `bench.bench.ts`.

### Notes on parity

Histogram is a heuristic. On purely random inputs (small alphabet, dense repetition), it can return a shorter LCS than the optimal DP solution — the JGit algorithm is deliberately tuned for human-readable code, not worst-case optimality. On code-like inputs (mostly unique lines per file, edits applied to a shared base), parity with the legacy backend holds in our test suite. See the comments in `__tests__/diff/parity.test.ts` for the exact contract.

---

## Versions before 2.1.0

`@gitwand/core` evolved alongside the desktop / CLI / MCP packages and was tagged with the umbrella project version. See the top-level [`ROADMAP.md`](../../ROADMAP.md) "Shipped" section for the history through `2.0.0`. Future minor bumps of `@gitwand/core` (the v2.1 → v2.6 sequence) are documented here in their own sections.
