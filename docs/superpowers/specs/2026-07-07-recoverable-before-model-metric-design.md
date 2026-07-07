# Design — "Recoverable-before-model" metric + deterministic-before-LLM coupling

Status: **Draft / for spec** · Target: **PR #117** (`feat/merge-conflicts-token-level-v2.7`) · Owner: Laurent · Date: 2026-07-07

## 1. Origin & motivation

A technical exchange on the Show HN thread surfaced two linked issues in the resolution pipeline:

1. **Coupling bug** — `refactoringAware` and `llmFallback` are *independent* opt-ins. A user can enable the LLM path without the deterministic rename recoverer, so the model gets invoked on conflicts that were deterministically recoverable.
2. **Missing metric** — the engine reports `~95% auto-resolved` as a flat number. What's actually decision-useful is: *of the residual left after the cheap deterministic passes, how much is still recoverable deterministically before the model is ever invoked.*

The insight that ties them: once (1) is fixed so the LLM only ever sees the true residual, the metric in (2) stops being a vanity number and becomes a **regression guard** — every new deterministic pattern must measurably shrink the AI-reachable bucket, or it's redundant or shadowed by a higher-priority recoverer.

This work rides on PR #117 because that branch already adds `token_level_merge` (a new advanced-deterministic pattern) and the `ResolutionPreviewPanel` (a natural place to surface the metric).

## 2. Current state (verified against `origin/main`)

- **Pattern priorities** (`packages/core/src/classifier.ts`, sorted ascending = evaluated first):
  `same_change 10 · delete_no_change 20 · one_side_change 30 · non_overlapping 40 · whitespace_only 50 · reorder_only 55 · insertion_at_boundary 57 · value_only_change 60 · refactoring_aware 970 · llm_proposed 998 · complex 999`.
- **Opt-ins** (`packages/core/src/resolver/policy.ts`, `DEFAULT_OPTIONS`): `llmFallback: { enabled: false }` and `refactoringAware: { enabled: false }` — two independent flags, both off by default.
- **`refactoring_aware`** already tokenizes and inverts renames on *both* sides (`oursRefs` + `theirsRefs`) off the diff3 base — it handles rename-on-both-sides. Requires the base (returns false when `baseLines.length === 0`).
- **`MergeStats`** (`packages/core/src/types.ts`) already carries `totalConflicts`, `autoResolved`, `remaining`, and **`byType: Record<ConflictType, number>`** — the per-type counts the metric derives from.
- **`token_level_merge`** (new in #117) never auto-applies today (produces a proposal trace); its priority is TBD — see §6.

## 3. Problems restated

- **P1 (correctness/config):** With `llmFallback` on and `refactoringAware` off, a rename-on-both-sides hunk skips priority 970 (disabled) and is resolved by `llm_proposed` (998) — an AI guess where a deterministic answer existed.
- **P2 (observability):** No way to see how much of the residual the deterministic layer covers vs. what genuinely reaches the model — so no way to justify "the AI only handles the truly ambiguous X%", and no guard against a new pattern being dead weight.

## 4. Proposed design

### 4.A — Deterministic-before-LLM invariant (fixes P1)

Guarantee: **the LLM path is only reachable for hunks no enabled deterministic pattern can resolve.** Two candidate implementations (decide in spec):

- **Option A1 (coupling):** when `llmFallback.enabled`, force the deterministic recoverers (`refactoringAware`, and any future advanced-deterministic pattern) on regardless of their individual flags.
- **Option A2 (gating, preferred):** make `llm_proposed.detect()` (priority 998) structurally the *last* thing before `complex` — i.e. it only fires once every deterministic pattern with a lower priority has passed. This is already true *by priority* when the patterns are enabled; the fix is to stop letting a disabled deterministic pattern hand its hunks to the model. Cleanest framing: "deterministic patterns are not individually disable-able below the LLM — the LLM is a floor, not a peer."

A2 is preferred because it encodes the invariant in the ordering contract rather than in flag-coupling logic that can drift. Exact mechanism TBD in spec (e.g. an `isDeterministic` marker on `PatternPlugin` + an assertion that no deterministic pattern sits above `llm_proposed` and none is silently skipped when the LLM is enabled).

### 4.B — Tier metric (fixes P2)

Add a **pure, derived** summary over `byType` — *not* a change to resolution logic.

Tier taxonomy:

| Tier | ConflictTypes |
|---|---|
| `trivial` | same_change, delete_no_change, one_side_change, non_overlapping, whitespace_only, reorder_only, insertion_at_boundary, value_only_change |
| `advancedDeterministic` | refactoring_aware, token_level_merge |
| `model` | llm_proposed |
| `unresolved` | complex |

Derived figure:

```
residual              = advancedDeterministic + model + unresolved   // everything past the cheap passes
recoverableBeforeModel = advancedDeterministic / residual            // 0 if residual == 0
aiReachable           = model + unresolved                           // the bucket a new pattern must shrink
```

### 4.C — Regression guard (turns 4.B into a test)

A conflict-corpus test asserting that enabling an advanced-deterministic pattern does **not increase** the AI-reachable bucket, and for a targeted corpus **decreases** it:

```
countReachingModel(corpus, { token_level_merge: on })  ≤  countReachingModel(corpus, { token_level_merge: off })
```

If a newly added pattern doesn't shrink the bucket on any corpus, it is **redundant** (another pattern already covered those hunks) or **shadowed** (a lower-priority-number recoverer fires first). Either way the guard flags it.

### 4.D — token_level_merge priority (P1-adjacent, #117-specific)

`token_level_merge` **must** sit at priority `< 998` or it silently loses to the model. It overlaps `refactoring_aware` (970) on renames, so its position *relative to 970* decides which catches a shared hunk (the shadowing case). Proposed: choose a value in ~960–975, decided consciously against 970, and covered by the §4.C guard.

## 5. API sketch

```ts
// packages/core/src/... (pure helper, TS-only — see §7 parity note)
export type ResolutionTier = "trivial" | "advancedDeterministic" | "model" | "unresolved";

export interface TierSummary {
  byTier: Record<ResolutionTier, number>;
  residual: number;              // advancedDeterministic + model + unresolved
  aiReachable: number;           // model + unresolved
  recoverableBeforeModel: number; // advancedDeterministic / residual, 0 when residual == 0
}

export function summarizeTiers(byType: Record<ConflictType, number>): TierSummary;
```

Single source of truth for the ConflictType→tier mapping lives beside this helper.

## 6. Surfacing

- **CLI** (`@gitwand/cli`): one summary line after `gitwand resolve`, e.g.
  `residual 18 → 11 deterministic · 7 to model · recoverable-before-model 61%`.
- **Desktop** (`ResolutionPreviewPanel`, already in #117): a compact tier bar / stat. Any user-facing string → 5 locales.
- **MCP** (`@gitwand/mcp`): include `tierSummary` in the `gitwand_status` / resolve output so agents can decide whether to invoke the model.

## 7. Constraints

- **Stable contract:** do **not** add these fields to `MergeStats` — it's a serialized public contract (CLI `--json` reports, MCP output); derived metrics stay derived. Keep `summarizeTiers` a TS-side helper consumed by CLI/desktop/MCP. *(Correction post-implémentation : la version initiale de cette contrainte invoquait le parity-probe Rust↔TS ; vérification faite, ce probe compare des commandes git Rust↔dev-server Node, pas les structs de résolution — il n'existe aucune implémentation Rust du moteur. La contrainte de contrat sérialisé reste valable, le motif parité était fantôme.)*
- **Browser-safe:** `packages/core` stays Node-free; the helper is pure (no fs/path).
- **No resolution-logic change from 4.B/4.C** — they read existing output. Only 4.A and 4.D touch behavior.

## 8. Test plan

- Unit: `summarizeTiers` — tier mapping, residual/ratio math, `residual == 0` edge case, unknown/zero types.
- Guard: corpus-based `countReachingModel(on) ≤ countReachingModel(off)` for `token_level_merge` (and a rename corpus where it must strictly decrease).
- Invariant (4.A): a rename-on-both-sides fixture with `llmFallback` on + `refactoringAware` off must NOT reach `llm_proposed`.
- Parity probe unchanged and green.

## 9. Open questions — resolved

1. **4.A: coupling (A1) vs. ordering-contract (A2)? → A1, shipped.** `resolveAsync()`
   now forces `refactoringAware.enabled: true` whenever `llmFallback` is on
   (`packages/core/src/resolver/index.ts`), rather than adding an
   `isDeterministic` marker to `PatternPlugin`. A2 would have touched every
   pattern's interface for a problem A1 solves in the call site alone.
   **Prerequisite found and fixed along the way:** `detectRefactorings()`
   tokenized identifiers with a regex that didn't respect string-literal
   boundaries, so any ordinary value-conflict (e.g. two config strings
   changing on both sides) false-positived as a "bijective rename" once
   `refactoringAware` was forced on — silently misresolving hunks that should
   have reached the LLM. Fixed in `packages/core/src/refactoring/detect.ts`
   (`maskStringLiterals()`) before shipping A1; regression test:
   `packages/core/src/__tests__/refactoring/refactoring-pipeline.test.ts`
   (F-R06b).
2. **`token_level_merge` priority vs. `refactoring_aware` (970) → 65 wins, by
   design.** Confirmed against `packages/core/CLAUDE.md` and `classifier.ts`:
   `token_level_merge` sits at priority 65 (before every opt-in deterministic
   pattern), which is documented as a deliberate deviation, not an oversight.
   Covered by
   `packages/core/src/__tests__/regression-guard-tiers.test.ts` ("token_level_merge
   (priority 65) gagne sur refactoring_aware_merge (priority 970) pour un hunk
   partagé").
3. **Residual denominator includes `complex` → yes, shipped as proposed.**
   `summarizeTiers()` (`packages/core/src/stats/tiers.ts`) computes
   `residual = advancedDeterministic + model + unresolved`.
4. **Telemetry aggregation → out of scope for this pass.** Only per-resolution
   surfacing shipped (CLI summary line, desktop `MergeEditor` header stat, MCP
   `tierSummary` field on `gitwand_status`/`gitwand_resolve_conflicts`). No
   cross-resolution aggregation/telemetry was added — still open if wanted later.

## 10. Non-goals

- No new resolution pattern beyond what #117 already ships.
- No change to the LLM prompt/endpoint.
- No Rust-side stats work.

## 11. Effort

~½ day for 4.B + 4.C + surfacing (data already exists in `byType`). 4.A (invariant) and 4.D (priority) are small but behavior-touching — spec the mechanism, add the fixtures, land inside #117 alongside `token_level_merge`.
