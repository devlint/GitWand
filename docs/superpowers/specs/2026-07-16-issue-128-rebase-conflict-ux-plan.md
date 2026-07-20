# Plan — Fix issue #128: clunky conflict-resolution UX & non-interactive rebase modal

**Issue:** devlint/GitWand #128 — "Bug: Clunky conflict resolution UX and non-interactive rebase modal"
**Date:** 2026-07-16
**Branch:** `fix/128-rebase-conflict-ux` (off `main`, one PR for this issue)
**Author of plan:** gitwand-planner (implementation to be done by executor)

---

## Problem summary (three complaints)

- **A. Blocking rebase-conflict modal.** When an interactive rebase pauses on a merge conflict, `RebaseEditor.vue` stays open inside `BaseModal` (fixed overlay, `z-index: 100`). In the paused-on-conflict state the modal only renders a status badge + Continue/Skip/Abort — **no per-hunk resolution UI**. The real resolution surface (`MergeEditor.vue`) lives in `App.vue`'s `changes` view and is blocked by the overlay, so the user must close/abort the modal to reach it.
- **B. Clunky resolution UI.** `MergeEditor.vue` layers many resolution mechanisms. Fuzzy "polish" complaint — **scoped out** of this fix (see §Scope decisions).
- **C. Freeze on resolution.** `apps/desktop/src/utils/diffHighlight.ts` `lcsTokens` is an unguarded O(m·n) word-level LCS with a boxed 2D array. A conflicting line that tokenizes into thousands of "words" (minified bundle / long JSON / base64) blows the DP table into millions of cell writes on the main thread — re-run for every hunk on every resolution click via `MergeEditor.vue`'s `highlightedHunks` computed.

---

## Ground-truth findings (verified against current code, 2026-07-16)

### The non-blocking banner infrastructure already handles interactive rebase

`App.vue:1953` — `showRebaseBanner` already matches **both** rebase states:

```
repoOperationState.value.state === "rebase" || repoOperationState.value.state === "rebase_interactive"
```

and `refreshRepoState()` (`App.vue:1960-1974`) populates `repoOperationState` for both. The banner is rendered at the top of the changes view (`App.vue:3230-3233`), and `RebaseProgressBanner.vue` already exposes Continue/Skip/Abort **and** an "Auto-resolve" button for the whole rebase (`onRebaseBannerAutoResolve`, `App.vue:2008`).

**The only thing suppressing the banner during an interactive rebase is `!showRebase.value`** (`App.vue:1956`) — a deliberate guard so the banner doesn't overlap the open `RebaseEditor` modal. So the fix for **A** is: when the interactive rebase pauses on a *conflict*, close the modal (`showRebase = false`) and let the already-proven banner + changes view take over. No new banner component, no new i18n keys for the banner (the `rebase.banner*` keys already exist — `en.ts:574-579`).

### Conflict is a distinct, already-surfaced halt signal

`useInteractiveRebase.ts` — `startRebase`, `rebaseContinue`, `rebaseSkip` all return `{ success, conflict?, inProgress? }` and set `conflict: true, inProgress: true` on a conflict halt (`useInteractiveRebase.ts:262, 274, 310, 354`). `RebaseProgress.hasConflict` (`:56`) distinguishes a conflict stop from an `edit`/`split` stop. **Only conflict halts should close the modal** — `edit`/`split` halts must keep it open because `RebaseEditor` owns those affordances (the "Split this commit" button, `RebaseEditor.vue:446-469`).

### Latent finalize bug that would break the handoff

`advanceToNextConflictOrFinalize()` (`App.vue:648-658`) auto-finalizes after the last conflicted file is resolved by calling `doMergeContinue()` (a `git merge --continue`). It is guarded for cherry-pick (`isCherryPicking`) but **not for rebase**. During a rebase this fires `git merge --continue` → "no merge in progress" error. This already affects the plain-rebase banner flow and would break the interactive handoff. Must be made rebase-aware (§Step 3).

### Core has a guarded LCS, but its shape doesn't fit word-level highlighting

`packages/core/src/diff/lcs.ts` guards with `HIRSCHBERG_THRESHOLD = 4_000_000` cells (`:17`) and is exported as `lcsLegacy` from the package root (`packages/core/src/index.ts:38`). But it operates on **arrays of lines** and returns `Array<[number,number]>` pairs, whereas `diffHighlight.lcsTokens` operates on **word tokens within one line** and returns `{aIdx, bIdx}` sets. Above the threshold we *want to skip* word-level detail (fall back to whole-line highlight), not compute a Hirschberg LCS. Importing core buys nothing here and couples the desktop highlighter to the core engine. **Recommendation: replicate the threshold + fallback locally** (task-approved option). Keep the `packages/core` browser constraint irrelevant since we touch only `apps/desktop`.

---

## Scope decisions

- **In scope:** A (non-blocking handoff) + C (freeze guard) + the rebase-aware finalize sub-fix required to make A correct.
- **Out of scope — B (MergeEditor polish):** After reading `MergeEditor.vue`, there is no single, cheap, unambiguously-broken affordance to fix; the complaint is a diffuse "too many overlapping mechanisms" impression. A redesign is a separate chantier and must not be bundled into a bug-fix PR. Document this in the PR description; do **not** touch `MergeEditor.vue` except as required by Step 4 (the freeze guard is in `diffHighlight.ts`, not the component).
- **Known limitation (document, don't fix now):** after the modal closes on a conflict and the user later hits a subsequent `edit`/`split` halt *within the same rebase*, the RebaseEditor's split affordance won't reappear — only the banner's Continue/Skip/Abort. This is strictly better than the blocking-modal status quo and is a rare edge case. Note it in the PR body and add a roadmap follow-up (§Step 6).

---

## Implementation steps

### Step 1 — Emit a dedicated `conflict` signal from `RebaseEditor.vue` on a conflict halt

**File:** `apps/desktop/src/components/RebaseEditor.vue`

- Add `conflict: []` to the `defineEmits` block (`:55-62`).
- In each place that inspects a rebase result and currently keeps the modal open on a non-finished state — `startRebase` (`:275-290`), `doContinue` (`:292-297`), `doSkip` (`:304-309`), and the post-split continue in `handleSplitAtHead` (`:335-342`) — after the existing `if (result.success && !result.inProgress) emit('done')` check, add: **if `result.inProgress && result.conflict` → `emit('conflict')`.** Do **not** emit on `inProgress && !conflict` (edit/split halt) — the modal stays open with its existing affordances.
- Leave the in-modal `#toolbar` conflict badge and `rb-progress-actions` untouched; they are now only reachable for the brief moment before the parent tears the modal down, and remain a correct fallback if the parent ignores the event.

**Acceptance:** `RebaseEditor` emits `conflict` exactly once per conflict halt and never on an `edit`/`split` halt. Verified by unit test in Step 5.

### Step 2 — Handle the handoff in `App.vue`

**File:** `apps/desktop/src/App.vue`

- Add a handler `onRebaseConflict()` near the other rebase handlers (`onRebaseDone`, `App.vue:3081-3086`):
  1. `showRebase.value = false` (closes the modal → un-suppresses `showRebaseBanner`, `:1956`).
  2. `rebaseInitialBase.value = undefined`.
  3. `await refreshRepoState()` (populate `repoOperationState` so the banner renders — `:1960`).
  4. `await repoRefresh()` (refresh git status so conflicted files are known).
  5. `viewMode.value = "changes"` (mirror the existing conflict-surfacing pattern at `:2309` / `:2582`).
  6. If `repoStatus.value?.conflicted.length`, `await repoSelectFile(repoStatus.value.conflicted[0], false)` — this trips the `[isSelectedFileConflicted, repoSelectedFile]` watcher (`:631-642`) which opens `MergeEditor` for that file.
- Wire the event on the `RebaseEditor` element (`App.vue:3497-3499`): add `@conflict="onRebaseConflict"`.

**Acceptance:** Triggering a conflict during an interactive rebase closes the modal, shows `RebaseProgressBanner` at the top of the changes view, and opens `MergeEditor` on the first conflicted file — all interactive (no blocking overlay). Verified manually (Step 5 QA).

### Step 3 — Make `advanceToNextConflictOrFinalize` rebase-aware

**File:** `apps/desktop/src/App.vue` (`:648-658`)

- Before the `else` branch that calls `doMergeContinue()`, add a rebase guard: if a rebase is in progress (`repoOperationState.value?.state === "rebase" || repoOperationState.value?.state === "rebase_interactive"`), **do not** call `doMergeContinue()`. Instead leave finalization to the banner's Continue button (the banner is the rebase control surface). Optionally set `showMergeSuccess` is **not** appropriate here — skip it during rebase.
- Keep the existing merge and cherry-pick branches unchanged.

**Why:** `git merge --continue` during a rebase errors; the banner's `runAction('continue')` (`RebaseProgressBanner.vue:48-60` → `gitRebaseAction`) is the correct continue path. This also fixes the pre-existing plain-rebase auto-finalize bug.

**Acceptance:** Resolving the last conflicted file mid-rebase does **not** emit a `git merge --continue` error; the banner's Continue advances the rebase. Verified in the Step 5 real-repo test + manual QA.

### Step 4 — Guard the word-level LCS against pathological lines (the freeze)

**File:** `apps/desktop/src/utils/diffHighlight.ts`

- Add a module-level constant with a comment cross-referencing `packages/core/src/diff/lcs.ts`'s `HIRSCHBERG_THRESHOLD` rationale:
  ```ts
  // Word-level LCS is O(m·n). Above this token-product a single line is
  // pathological (minified bundle, long JSON/base64) and would freeze the
  // main thread — mirror packages/core/src/diff/lcs.ts's guard and fall back
  // to whole-line highlighting instead of computing per-token diffs.
  const WORD_DIFF_MAX_CELLS = 1_000_000;
  ```
- In `highlightLine` (`:69-108`), after tokenizing `srcTokens`/`refTokens` and **before** calling `lcsTokens` (`:82-84`): if `srcTokens.length * refTokens.length > WORD_DIFF_MAX_CELLS`, return the whole-line highlight — i.e. `` `<span class="${cssClass}">${esc(source)}</span>` `` (identical to the existing `reference === null` branch at `:75`). This keeps behavior correct (the line is still visibly marked as changed) at O(n) cost.
- Leave `lcsTokens` itself unchanged (it is only reached below the threshold now). Do **not** implement Hirschberg locally — excessive for this fix, per the issue direction.
- Do **not** touch any diff **line-classification** logic; this file does word highlighting only, so the `line.startsWith(' ')` gotcha does not apply here (no regression risk, but flagged for the reviewer).

**Acceptance:** `highlightLine` returns in O(tokens) for a pathological line; no DP table is allocated above the threshold. Verified by the Step 5 unit test.

> Note (scoped out): `MergeEditor.vue`'s `highlightedHunks` computed (`:567-573`) still recomputes all hunks on every resolution click. With the Step 4 guard each line is now cheap, so this is no longer a freeze source. Do not refactor the recompute in this PR.

### Step 5 — Tests

**5a. Unit test — freeze guard (no git repo needed).**
New file `apps/desktop/src/utils/__tests__/diffHighlight.test.ts` (jsdom, Vitest):
- **Correctness (below threshold):** a short line with one changed word wraps only the changed token in `<span class="diff-add">`; identical lines return escaped plain text; `esc` escapes `&`/`<`/`>`.
- **Regression / freeze guard:** build a line of ~5,000 space-separated distinct words on each side (so `m·n` ≫ `WORD_DIFF_MAX_CELLS`); assert `highlightConflict` returns the whole line wrapped in a single `diff-add` span (fallback path) and completes well under a time bound (e.g. assert the call returns; optionally wrap in a generous `performance.now()` assertion < 100 ms). This is the concrete regression test for issue #128 part C.

**5b. Real-git-repo test — interactive rebase conflict signal.**
There is currently **no** test for `useInteractiveRebase` (`src/composables/__tests__/` has none). Add `src/composables/__tests__/useInteractiveRebase.test.ts` that spins up a **real temporary git repo** (per AGENTS.md — no git-layer mocking), creates a divergent history that conflicts on rebase, runs `startRebase`, and asserts the returned result has `conflict === true, inProgress === true` and `progress.hasConflict === true`. This locks the signal that Step 1/2 depend on. Clean up the temp repo on teardown.
- If the desktop test environment cannot drive the Rust/dev-server git backend for this composable in `vitest run` (jsdom), fall back to asserting the result-shape contract with a real repo via the Node dev-server path used elsewhere; if neither is feasible, document that the handoff is covered by manual QA (5c) and keep 5b limited to what the harness supports. Do not mock git to force it green.

**5c. Manual QA (UI — must be run in the app, `cd apps/desktop && pnpm dev`).** State this explicitly in the PR since the handoff is UI-level:
1. Create a repo with a branch that conflicts when rebased onto another. Open the interactive RebaseEditor, start the rebase.
2. Confirm: the modal closes on the conflict, the `RebaseProgressBanner` appears at the top of the **changes** view, and `MergeEditor` opens on the first conflicted file — the resolution area is fully interactive (nothing blocked by an overlay).
3. Resolve all hunks; confirm no `git merge --continue` error appears (Step 3), then click the banner **Continue** and confirm the rebase advances/finishes.
4. Confirm an `edit`/`split` halt (no conflict) still keeps the RebaseEditor modal open with its Split affordance (no regression).
5. Freeze check: introduce a conflict on a file with a very long minified/one-line hunk; confirm resolution clicks stay responsive.

**Run:** `cd apps/desktop && pnpm test` (5a, 5b). Parity tests unaffected (no `#[tauri::command]` added) but run `pnpm test:parity` to confirm no regression.

### Step 6 — Changelog + roadmap

- **`CHANGELOG.md`** — add under the existing `## [Unreleased]` (`:8`) a `### Fixed` block:
  - Interactive rebase now hands a conflict off to the non-blocking rebase banner + inline conflict editor instead of trapping it behind a modal (#128).
  - Fixed a UI freeze when highlighting conflicts on very long / minified lines (word-level diff now guards against pathological line lengths) (#128).
  - (Version bump is **not** part of this PR — done at release time via `./scripts/bump-version.sh`.)
- **`website/changelog.md`** — per AGENTS.md the two changelogs stay in sync **at tag time**, not per-PR. Since this PR does not tag, leave `website/changelog.md` for the release step, or add a matching `[Unreleased]`-equivalent narrative note if the team convention is to touch it now. **Open decision for the human** (§below).
- **`roadmap.md`** — add a small planned follow-up bullet: "Interactive rebase: re-surface split/edit affordances after a mid-rebase conflict handoff" (the documented Step-0 limitation).

---

## Constraints checklist (must all hold)

- [ ] `packages/core` untouched → browser constraint N/A (all changes in `apps/desktop`).
- [ ] No manual version edits; no `package.json`/`Cargo.toml`/`tauri.conf.json` version changes.
- [ ] No new `#[tauri::command]` → no `backend.ts` wrapper / dev-server route needed. (Confirm none added.)
- [ ] Composition API only; new logic (`onRebaseConflict`) is thin orchestration in `App.vue` reusing existing composables. No business logic added to components.
- [ ] i18n: **no new user-visible strings** if the handoff reuses the existing `rebase.banner*` keys. If the executor adds any new string, it MUST land in all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) in the same commit.
- [ ] No settings field added → `useSettings.ts` / `SettingsPanel.vue` untouched.
- [ ] `BaseModal` `.bm-btn` specificity rule untouched.
- [ ] Diff line-classification `line.startsWith(' ')` gotcha not regressed (Step 4 touches word highlighting only).
- [ ] Real temp git repos in tests; no git-layer mocking.
- [ ] Regression test added for the fixed freeze bug (5a) in the same PR.

---

## Open decisions for the human checkpoint

1. **Handoff trigger placement.** Plan emits a `conflict` event from `RebaseEditor` and handles it in `App.vue` (Step 1+2). Alternative: `App.vue` watches `repoOperationState.hasConflict` while `showRebase` is true and closes the modal itself, keeping `RebaseEditor` unaware. The event approach is more explicit and localized; confirm preference.
2. **`website/changelog.md` timing.** Touch it now with a narrative note, or defer to release/tag per the "sync at tag time" reading of AGENTS.md? (Plan defers; flag if you want it now.)
3. **Test 5b feasibility.** Whether the desktop Vitest harness can exercise `useInteractiveRebase` against a real backend in `vitest run`. If not, the handoff falls to manual QA (5c) — accept, or invest in an integration harness?
4. **`WORD_DIFF_MAX_CELLS` value.** Proposed `1_000_000` (vs. core's 4M for line arrays — lower here because it is per-line word tokens on the main thread). Confirm or tune.

---

## Files this plan touches

- `apps/desktop/src/components/RebaseEditor.vue` — emit `conflict` (Step 1)
- `apps/desktop/src/App.vue` — `onRebaseConflict` handoff + wire event + rebase-aware finalize (Steps 2, 3)
- `apps/desktop/src/utils/diffHighlight.ts` — threshold guard (Step 4)
- `apps/desktop/src/utils/__tests__/diffHighlight.test.ts` — new unit test (Step 5a)
- `apps/desktop/src/composables/__tests__/useInteractiveRebase.test.ts` — new real-repo test (Step 5b)
- `CHANGELOG.md`, `roadmap.md`, (maybe `website/changelog.md`) — Step 6
