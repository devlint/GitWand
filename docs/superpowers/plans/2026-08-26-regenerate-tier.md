# Regenerate Tier for Generated Files (accuracy lot D, full) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For declared-generated files, stop declining and start producing the *right* answer: resolve the source-of-truth file (`package.json`, `composer.json`, `Cargo.toml`…), then re-run the ecosystem's generator in a sandbox and take its output as the resolution. Lockfiles are the single biggest class of conflicts the interim lot D declines today; regeneration is the only correct resolution for them — a textual merge of a lockfile is wrong ~100 % of the time, which is why the interim ships "decline and explain".

**Why this is its own plan (spec § D):** regeneration executes repository-triggered tooling. That makes it categorically different from every other engine feature: it needs explicit user consent, a sandbox, script suppression (an `npm install` runs lifecycle scripts from the repo — an attack vector on untrusted clones), a timeout, an offline fallback that declines rather than merges, and a failure path that hands the conflict back intact. None of this can be "on by default".

**Architecture — plan in core, execution at the edges:** core stays pure and Node-free. The engine never spawns a process; it emits a **regeneration plan** (a data object) when a generated file's source of truth is resolvable. Callers (CLI first, desktop later) own execution, exactly like `detectMergeContext` and the conventions runner.

```ts
/** accuracy lot D — one ecosystem the regenerate tier knows how to drive. */
export interface RegenEcosystem {
  id: "npm" | "pnpm" | "yarn-berry" | "composer" | "cargo";
  /** The generated file this entry owns (matches GENERATED_FILE_PATTERNS). */
  lockfile: RegExp;
  /** Files that must be conflict-free (or engine-resolved) before regeneration makes sense. */
  sourcesOfTruth: string[];
  /** Lockfile-only, script-suppressed command. Never a full install. */
  command: { bin: string; args: string[] };
  network: "required" | "offline-capable";
  defaultTimeoutMs: number;
}

/** What the engine emits instead of resolving; the caller decides whether to run it. */
export interface RegenerationPlan {
  file: string;
  ecosystem: RegenEcosystem["id"];
  /** Every source of truth and how it was settled (clean | engine-resolved(confidence) | conflicted). */
  sources: Array<{ path: string; state: "clean" | "resolved" | "conflicted"; confidence?: number }>;
  /** Plan is only runnable when no source is "conflicted". */
  runnable: boolean;
}
```

**v1 registry (deliberately small):** only ecosystems with a lockfile-only, script-suppressed mode:
`npm install --package-lock-only --ignore-scripts`, `pnpm install --lockfile-only --ignore-scripts`,
`yarn install --mode=update-lockfile` (berry only — classic yarn has no lockfile-only mode: excluded),
`composer update --lock --no-scripts --no-install`, `cargo generate-lockfile` (resolves, never builds).
`go.sum` (`go mod tidy` rewrites sources), `Gemfile.lock`, `poetry.lock` and snapshot regeneration (`jest -u` — runs arbitrary test code) are explicitly **out of scope for v1**; the registry is designed so adding one is one entry + one fixture.

**Consent & precedence:** regeneration never runs by itself. Explicit `.gitwandrc` `regenerate: true` or per-invocation `--regenerate` > conventions (`generatedFiles: "regenerate"` verdict makes the CLI *offer* it, still gated on the flag/config) > default off (interim decline message, now ending with "or re-run with --regenerate"). `resolveGeneratedFiles: true` (textual opt-in) and regeneration are mutually exclusive; the explicit textual opt-in wins and skips the plan.

**Execution sandbox (caller side):** run in a disposable `git worktree` populated from the in-progress merge index with the resolved sources written in — never in the user's working tree. Wall-clock timeout (default 120 s, configurable), stdout/stderr captured into the trace, `--ignore-scripts`-family flags are **non-negotiable registry constants** (not user-overridable). On any failure — non-zero exit, timeout, missing toolchain (`which` probe first), offline while `network: "required"` — the file comes back as the untouched conflict with the actionable interim reason plus the failure detail. Regeneration output only replaces the conflict if the generated file parses (reuse lot B validators where a format validator exists).

**Measurement (its own harness — the gate cannot use merge-tree):** `merge-tree --write-tree` replays never touch a working tree, so the existing benchmark cannot score this lot. New `scripts/replay-regenerate.mjs`: full (non-bare) clones, for each historical corpus merge whose conflicts include a v1-registry lockfile, check out the merge state, run the plan, byte/structurally compare against the committed lockfile. Bounded (≤ 20 merges per ecosystem), network required → runs manually/in the container, **not** in the CI gate; results and method documented in `benchmark/README.md` alongside the agreement metric. The CI gate (lot G) keeps guarding the text engine, unchanged.

**Spec:** [`docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md`](../specs/2026-08-26-conflict-engine-accuracy.md) § D. Assumes lots 1/C/E/F-core (`feat/conflict-engine-accuracy`).

## Global Constraints

- pnpm only; no shell interpolation in git/tool commands (`.args([...])`); `safe_repo_path()` for any Rust FS access.
- Core emits plans, never executes. Every executed regeneration is traced: command, duration, exit code, and provenance in the resolution reason (`regenerated via pnpm install --lockfile-only (4.2 s)`).
- Script suppression flags are registry constants; a registry entry without them must not compile past review.
- Hermetic git env in every test that spawns git (see merge-context-detect.test.ts) **and** explicit `{ timeout: 30_000 }` on every integration `it()` (macOS XProtect).
- New user-visible strings in all 5 locales. `Required<GitWandOptions>` keeps compiling.
- Offline is a first-class path, not an error: decline with the interim message, never a partial lockfile.

## Tasks

### 1 — Core: registry + plan emission
- [ ] `packages/core/src/regenerate/registry.ts` — `RegenEcosystem`, the 5 v1 entries, `findEcosystem(path)`.
- [ ] `packages/core/src/regenerate/plan.ts` — pure `buildRegenerationPlan(file, hunks, options)`: locate sources of truth in the same conflict set, mark each clean/resolved/conflicted, set `runnable`.
- [ ] Resolver integration: when the generated gate declines AND an ecosystem matches, attach the plan to the declined resolution (`resolution.regenerationPlan?`); reason text gains the "--regenerate" hint. Mutual exclusion with `resolveGeneratedFiles: true`.
- [ ] Unit tests: plan runnable only when sources settle, conflicted source → runnable:false with the source named, non-registry generated file (`.min.js`) → no plan, textual opt-in wins.

### 2 — CLI: the executor
- [ ] `packages/cli/src/regenerate-runner.ts` — toolchain probe, disposable worktree from the merge index + resolved sources, spawn with timeout, capture, validate output, clean up the worktree in `finally`.
- [ ] `gitwand resolve --regenerate` (+ `.gitwandrc` `regenerate: true`): execute runnable plans after the engine pass; per-file verbose line (ecosystem, command, duration, outcome). Failure → untouched conflict + detailed reason.
- [ ] Tests on fabricated temp repos (one per ecosystem where the toolchain exists on the runner; `describe.skipIf` per missing binary): success path, timeout path, missing-toolchain path, output-fails-validation path, worktree always cleaned.

### 3 — Conventions & context interplay
- [ ] `generatedFiles` convention verdict "regenerate" → CLI prints the offer when declining without the flag; verdict "merge" → conventions already flip the textual path, plan suppressed. Precedence test: `.gitwandrc` beats both.
- [ ] MCP: expose `regenerate` as a tool option on the 3 resolve() sites (duplicate the small helper — mcp must not depend on cli).
- [ ] Reference docs: `website/reference/config.md` § Generated Files gains the regenerate tier (consent model, sandbox, what runs, what never runs).

### 4 — Measurement harness + gate
- [ ] `scripts/replay-regenerate.mjs` per the design above; run in the container against corpus v2 repos with lockfile conflicts (laravel/composer, prettier/npm…).
- [ ] **GATE:** ship the desktop surface and any default-on behaviour ONLY if measured agreement on regenerated lockfiles is materially better than decline (target: ≥ 80 % structural match on runnable plans). Below target → keep CLI opt-in only, document findings, stop here.
- [ ] `benchmark/README.md`: method, results table, why this metric lives outside the CI gate.

### 5 — Desktop surface — gated on task 4
- [ ] Consent dialog (what command, what it touches, network), per-repo remembered choice; progress + trace in the resolution panel; Tauri command with `safe_repo_path()`. Own plan if the gate passes — not started before.
