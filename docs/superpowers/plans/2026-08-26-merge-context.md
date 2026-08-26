# Merge Context (accuracy lot C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine the one input it has never had — *what merge is this?* — so the patterns that currently guess can decide. Measured on the benchmark corpus (`benchmark/`), the largest remaining source of disagreement with what teams actually ship is `value_only_change` picking "the newer semver" on back-merges where the only correct answer is *the target branch's value* (laravel: ~112 wrong resolutions from this single rule; `'13.x-dev'` does not even parse as semver). Nothing in `resolve(content, filePath, options)` knows which branch is being merged into which.

**Architecture:** A new optional `mergeContext` on `GitWandOptions`, plain data, fully serialisable:

```ts
/** v3.10 — What operation produced these conflict markers. */
export interface MergeContext {
  /** The git operation in progress. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert";
  /**
   * Which side of the markers is the branch being merged INTO.
   * In git's own marker convention this is "ours" for merge, rebase
   * (ours = the branch rebased onto) AND cherry-pick — but callers state it
   * explicitly so the engine never re-derives the famous rebase inversion.
   */
  targetSide: "ours" | "theirs";
  /** Ref names, for traces and explanations only — never parsed for decisions. */
  oursRef?: string;
  theirsRef?: string;
}
```

Detection lives with the callers, not the core: the CLI and MCP read `.git` state (`MERGE_HEAD`, `rebase-merge/`/`rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) via a shared helper; the desktop already knows its own operation state and passes it directly. The core stays a pure function — context in, decision out, context echoed in the trace.

**Behavioural rules (the whole point):**

1. `value_only_change` on a **version-like scalar** (semver-ish, or same key as a known version field):
   - context present → resolve to the **target side**, trace says why ("back-merge: the target branch's version survives").
   - context absent → **propose, never auto-apply** (like `token_level_merge`). The current "pick the newer semver" heuristic measured 27–47 % agreement; a coin-flip has no business auto-applying. Non-version scalars (hashes, timestamps) keep today's behaviour.
2. Changelog-shaped markdown (same detector as the invariant check): context present → the target side's section *structure* wins; incoming release sections are surfaced as a proposal, not silently unioned. Context absent → unchanged (lot-1 invariants already retract the bad unions).
3. The trace records the context on every hunk it influenced (`trace.steps` entry + `explanation`), so the desktop can show "resolved because this is a back-merge into 13.x".

**Tech Stack:** TypeScript (`@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`), Vue 3 composables, Node `dev-server.mjs` parity if any new Tauri command is needed (expected: none — the desktop's existing state knows the operation), Vitest + corpus fixtures, `benchmark/` for the before/after.

**Spec:** [`docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md`](../specs/2026-08-26-conflict-engine-accuracy.md) § C. Lot 1 (A/B/D-interim) landed in `3c2a4b4` — this plan assumes it.

## Global Constraints

- Package manager is **pnpm only**. Never edit version files by hand — `./scripts/bump-version.sh X.Y.Z`.
- `mergeContext` is **optional everywhere**; every existing call site keeps compiling and behaving identically except rule 1's context-absent demotion, which is deliberate and test-pinned.
- No shell string interpolation in git commands — `.args([...])` with discrete values; any new FS access through `safe_repo_path()` if Rust ends up involved.
- Every user-visible string (desktop trace display) in all 5 locales: `en`, `fr`, `es`, `pt-BR`, `zh-CN`.
- Tests use real temporary git repos (`TempRepo`, `fixtures.mjs`) — do not mock the git layer.
- The golden-funnel snapshot WILL change (value_only demotion). Regenerate it in its own commit with the numbers in the message, never silently.

## Tasks

### 1 — Core: the type and the plumbing
- [ ] `types.ts`: add `MergeContext`, add `mergeContext?: MergeContext` to `GitWandOptions`; `DEFAULT_OPTIONS.mergeContext: undefined` (typed `MergeContext | undefined`; keep `Required<GitWandOptions>` compiling).
- [ ] Thread `options.mergeContext` into `resolveHunk` / `assembleResolution` (already receive full options — verify, no signature change expected).
- [ ] Unit: `resolve()` with and without context returns identical results on a corpus fixture that context should NOT influence.

### 2 — Core: version-aware `value_only_change`
- [ ] In `patterns/value-only-change.ts` (or `assemble.ts` case): add `isVersionLikeScalar()` — semver-ish values, or the changed token sits in a `version`-named key (`"version":`, `const VERSION`, `version =`). Deliberately conservative; when unsure, it is not version-like.
- [ ] Context present + version-like → resolve to `targetSide`, confidence `high`, trace step naming the operation and refs.
- [ ] Context absent + version-like → `lines: null`, reason explaining both candidate values and how to enable the deterministic path (run from a repo where GitWand can see the operation, or pass `mergeContext`).
- [ ] Unit tests: the laravel `Application.php` shape (back-merge, target wins), the rebase inversion (targetSide "ours" while user perceives it as theirs), absent-context demotion, non-version scalar untouched.

### 3 — Detection helper (callers' side)
- [ ] `packages/cli/src/git.ts`: `detectMergeContext(cwd): MergeContext | null` from `.git` state files + `git rev-parse --abbrev-ref HEAD` / `MERGE_HEAD` for the ref names. Cover worktrees (`.git` as file).
- [ ] Unit tests with `TempRepo`: mid-merge, mid-rebase, mid-cherry-pick, clean repo → null.
- [ ] CLI `resolve` / `preview`: call it, pass it, print one line in verbose mode ("context: merging feature/x into main").
- [ ] MCP `gitwand_resolve_conflicts` (+ preview tool): same detection from the tool's cwd; echo the detected context in the tool result so agents can reason about it.

### 4 — Desktop
- [ ] `useGitWand.ts`: build `mergeContext` from the state the app already tracks (merge in progress / rebase in progress / cherry-pick — the same signals the conflict banner uses) and merge it into `resolveOptions`.
- [ ] Trace display: show the context line in the hunk explanation panel; 5-locale strings.
- [ ] Verify the dev-server parity suite still passes; add a parity fixture only if a new backend read is actually needed.

### 5 — Measure, then decide what ships
- [ ] `scripts/replay-conflicts.mjs`: pass `mergeContext: { operation: "merge", targetSide: "ours" }` — in a replayed merge commit, the first parent IS the target branch, so the benchmark exercises the real rule.
- [ ] Re-run `benchmark/run.mjs`; expected: laravel agreement jumps (the ~112 Application.php cases flip), corpus agreement moves accordingly. Record `results/v<next>.json` and update the tables in `benchmark/README.md`.
- [ ] If agreement does NOT improve on at least two repos, stop and re-open the spec before wiring the desktop — the rule, not the plumbing, would be wrong.

### 6 — Close
- [ ] Corpus fixtures: add 2 context-dependent fixtures (back-merge version, rebase inversion) to `src/__tests__/corpus.ts`.
- [ ] Golden funnel: regenerate, numbers in the commit message.
- [ ] `website/reference/config.md` + `guide/conflict-resolution.md`: document `mergeContext` (auto-detected; API consumers can pass it explicitly).
- [ ] CHANGELOG entry; `./scripts/bump-version.sh` per release train.
