# Repo Conventions (accuracy lot F) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop assuming a repository's merge conventions — **measure them**, from the repository's own history. `scripts/replay-conflicts.mjs` already replays a repo's merges through the engine and compares against what the team actually committed; pointed at the *user's* repo instead of a benchmark corpus, the same mechanism answers, with evidence: does this team regenerate or merge its lockfiles? who wins version-identity scalars here? does their changelog get unioned or rebuilt by tooling? Derived answers become per-repo engine defaults with a visible provenance ("measured on your last N merges"), replacing guesses. Nobody else in this market can do this, and every building block already exists.

**Why this is the moat:** the engine's rules were calibrated on a public corpus. Lot C's own history proves conventions differ per repo (laravel keeps the target's version identity; prettier takes the newer dep). A convention *measured on the user's repo* is the strongest possible form of the product's claim — not "we know what's trivial" but "we measured what your team does."

**Architecture:** one new pure module in core + one derivation runner + consumers.

```ts
/** accuracy lot F — a convention measured from the repo's own merge history. */
export interface RepoConventions {
  /** How many merges/files the derivation actually saw — consumers must gate on this. */
  evidence: { mergesReplayed: number; conflictedFiles: number; derivedAt: string; engineVersion: string };
  /** Per-question verdicts, each with its own sample size and agreement rate. */
  generatedFiles?: { verdict: "regenerate" | "merge"; samples: number; agreement: number };
  versionIdentity?: { verdict: "target-wins" | "newest-wins"; samples: number; agreement: number };
  changelog?: { verdict: "target-structure" | "union" | "tool-rebuilt"; samples: number; agreement: number };
  /** Per-path-glob overrides discovered (e.g. docs/** always theirs). Bounded, top-N only. */
  pathPolicies?: Array<{ glob: string; policy: "prefer-ours" | "prefer-theirs"; samples: number; agreement: number }>;
}
```

Derivation is a **replay**: for each historical merge with conflicts, re-run the engine under each candidate rule and score which candidate matches the committed result. A verdict is only emitted above a floor (`samples >= 5 && agreement >= 0.8`); below it, the field is absent and the engine keeps its measured public-corpus defaults. Everything is local — no network, no telemetry.

**Storage & precedence:** derived conventions are written to `.git/gitwand/conventions.json` (per-clone, never committed, invisible to the repo). Precedence: explicit `.gitwandrc` > derived conventions > engine defaults. `.gitwandrc` always wins — a team that states its policy is never overridden by inference, and the UI says which layer decided.

**Tech Stack:** TypeScript. Derivation logic in `@gitwand/core` (pure: takes replay observations, returns `RepoConventions`); the git-walking runner in a shared caller-side helper (like `detectMergeContext` — core stays Node-free); Tauri command + dev-server parity route for the desktop; Vitest with real temp repos; the pinned benchmark to prove the loop closes.

**Spec:** [`docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md`](../specs/2026-08-26-conflict-engine-accuracy.md) § F. Assumes lots 1/C/E (`feat/conflict-engine-accuracy`).

## Global Constraints

- pnpm only; `./scripts/bump-version.sh` for versions; no shell interpolation in git commands (`.args([...])`); `safe_repo_path()` for any Rust FS access.
- Derivation must be **bounded**: default cap 200 merges / 60s wall, resumable, and runs off the UI thread (worker or backend). A 100k-commit monorepo must not freeze the app.
- Conventions carry provenance everywhere they act: every resolution influenced by a derived convention says so in its trace (`convention: regenerate-lockfiles (measured on 41 merges, 97%)`).
- New user-visible strings in all 5 locales. Tests on real temp repos, **hermetic git env** (see merge-context-detect.test.ts — global config must never leak in).
- `Required<GitWandOptions>` keeps compiling: `conventions?: RepoConventions | null`, default `null`.

## Tasks

### 1 — Core: the observation → verdict engine
- [ ] `packages/core/src/conventions/types.ts` — `RepoConventions`, `ConventionObservation` (one replayed conflicted file: path, hunk classes, what each candidate rule would produce, what the humans committed).
- [ ] `packages/core/src/conventions/derive.ts` — pure `deriveConventions(observations: ConventionObservation[]): RepoConventions`, with the sample/agreement floors and per-question scoring. No git, no fs.
- [ ] Unit tests: floors respected (4 samples → no verdict), conflicting evidence → no verdict, agreement math, engineVersion stamped.

### 2 — Core: conventions as an input
- [ ] `GitWandOptions.conventions?: RepoConventions | null` (default null) + precedence: explicit `.gitwandrc` keys win over conventions, conventions win over defaults. Implement for the three questions that already have engine switches: `resolveGeneratedFiles` (generatedFiles verdict "merge" → behave as opt-in true), version-identity side (versionIdentity verdict feeds the lot-C rule when `mergeContext` is absent), changelog handling (verdict "tool-rebuilt" → decline changelog unions outright).
- [ ] Trace provenance: every influenced resolution's reason names the convention, its sample count and agreement.
- [ ] Unit tests per question + a precedence test (.gitwandrc beats conventions).

### 3 — The derivation runner (caller side)
- [ ] `packages/cli/src/conventions-runner.ts` — walk `rev-list --merges` (cap + `--since` window), re-create each conflict via `merge-tree --write-tree` (git ≥ 2.38 guard), build `ConventionObservation`s, call `deriveConventions`, write `.git/gitwand/conventions.json` atomically. Shares the merge-walk shape with `scripts/replay-conflicts.mjs` — extract the common walk into the runner and have the benchmark script consume it, so there is ONE replay implementation.
- [ ] `gitwand conventions` CLI command: derive (`--max-merges`, `--json`), show current verdicts with evidence, `--clear`. Verbose prints the per-question table.
- [ ] Tests: temp repo with a fabricated history (team regenerates lockfiles in 6 merges → verdict; 4 merges → no verdict), worktree case, cap respected.

### 4 — Desktop
- [ ] Tauri command `derive_conventions` (Rust spawns the same runner logic via the existing node sidecar? NO — implement the walk in Rust `git/conventions.rs` OR call the CLI runner as a subprocess; decide by effort at implementation time, parity route in `dev-server.mjs` either way) + typed wrapper in `utils/backend.ts` + `invoke_handler!` registration.
- [ ] `useGitWand.ts`: load `.git/gitwand/conventions.json` alongside `.gitwandrc` at repo open; merge into `resolveOptions` at the documented precedence.
- [ ] Settings > repo section: "Measure this repo's merge conventions" action with progress, results table (question / verdict / evidence), re-run and clear. 5 locales.
- [ ] The conflict UI shows convention provenance when a hunk was influenced (reuses the trace string from task 2).

### 5 — Prove the loop closes (gate)
- [ ] Benchmark: derive conventions on each corpus repo from its FIRST half of merges, then measure agreement on the SECOND half with conventions applied vs not. Ship the desktop surface only if agreement improves (or stays flat with better coverage) on at least two repos and regresses on none beyond noise.
- [ ] Record the split-half results in `benchmark/README.md`.

### 6 — Close
- [ ] `website/reference/config.md` + `/conflict-engine`: document the layer and its precedence; `llms.txt` line.
- [ ] CHANGELOG; corpus fixtures if any new decline/resolve behaviours emerged; golden funnel if the funnel moved.
- [ ] Note the v4.0 tie-in in ROADMAP: `useResolutionMemory` (manual-choice memory) and conventions (history-derived) should share the provenance display, and eventually one store.
