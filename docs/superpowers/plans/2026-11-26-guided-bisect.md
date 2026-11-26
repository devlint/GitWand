# Guided Bisect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a bisect in progress, start one from the Git Tree, answer Good / Bad / Skip from a banner until the first bad commit is named and opened, and end any bisect.

**Architecture:** `git_repo_state` reports `bisect`; a new Rust module `commands/bisect.rs` reads (`git_bisect_status`) and drives (`git_bisect_start` / `_mark` / `_reset`) it with git's machine outputs only; a lazy `BisectBanner.vue` replaces the operation banner for that state; two Git Tree context-menu entries start it through a confirmation.

**Tech Stack:** Rust (Tauri 2 commands, git CLI via `git_cmd()`), Vue 3 `<script setup>`, Vitest, dev-server.mjs for `pnpm dev:web`.

**Spec:** `docs/superpowers/specs/2026-11-26-guided-bisect-design.md`

All paths below are relative to `apps/desktop/` unless they start with `docs/`, `CHANGELOG.md` or `ROADMAP.md`.

## Global Constraints

- Never parse git's human (translated) messages to decide anything: refs under `refs/bisect/`, `BISECT_*` files, `rev-list --bisect-vars`, exit codes.
- Every git call through `git_cmd()` with discrete args, no shell; start/mark/reset under `repo_lock::write(&cwd)`, status under `repo_lock::read(&cwd)`.
- Every new Tauri command: registered in `src-tauri/src/lib.rs`, a dev-server route with the same git calls and refusals, an entry in `src/utils/commandRegistry.ts`.
- UI strings in `src/locales/{en,fr,es,pt-BR,zh-CN}.ts` (skill `i18n-sync`).
- `BisectBanner.vue` is loaded with `defineAsyncComponent`.
- Tests run real git on temporary repos (AGENTS.md); component tests may mock `../utils/backend`.
- Not in scope: `bisect run`, custom-term UI, several goods at start, CLI/MCP, guards on other actions during a bisect.
- `cargo fmt` before every Rust commit; clippy `-D warnings` clean.

## Review Focus

1. A bisect started in a terminal with custom terms (`git bisect start --term-new=broken --term-old=fixed`): the banner still shows, counts read the terms from `BISECT_TERMS`, and Good/Bad map to those terms. → Task 2 test `status_reads_custom_terms`, mark test `mark_good_uses_old_term`.
2. `git bisect start` with no good/bad yet: status has no `remaining`, the banner says to mark a bad and a good commit, and Good/Bad still work. → Task 2 `status_before_both_ends_has_no_estimate`; Task 5 banner test `asks for both ends`.
3. Every remaining commit skipped: candidates list, not a single culprit. → Task 2 `status_lists_candidates_when_only_skips_remain`.
4. End bisect after the start branch was deleted: the error is returned and `BISECT_LOG` is still there. → Task 2 `reset_fails_and_keeps_bisect_when_start_branch_is_gone`.
5. A repo opened as a linked worktree (git dir is per worktree): `git_repo_state` sees that worktree's bisect, and not the main checkout's. → Task 1 `repo_state_sees_bisect_in_linked_worktree_only`.

---

### Task 1: `git_repo_state` reports a bisect; watcher classifies bisect files

**Files:**
- Modify: `src-tauri/src/commands/read.rs` (`git_repo_state`, after the existing rebase/merge/cherry-pick/revert checks, before the `"clean"` return)
- Modify: `src-tauri/src/commands/watcher.rs` (`classify_path`, the `mergeState` arm)
- Test: same files' test modules

**Interfaces:**
- Produces: `RepoOperationState { state: "bisect", has_conflict: false, operation_head: Some(<HEAD full hash>), target_branch: None, step: 0, total: 0 }` when `<git dir>/BISECT_LOG` exists and no other operation is in progress.

- [ ] **Step 1: Failing tests**
  - read.rs `repo_state_reports_bisect`: repo with 3 commits; `git bisect start`; assert `state == "bisect"`, `operation_head == HEAD`; `git bisect reset`; assert `"clean"`.
  - read.rs `repo_state_prefers_merge_over_bisect`: bisect started, then `MERGE_HEAD` written (or a conflicting merge) → `state == "merge"`.
  - read.rs `repo_state_sees_bisect_in_linked_worktree_only`: `git worktree add ../wt`, `git bisect start` in `wt`; `git_repo_state(wt) == "bisect"`, `git_repo_state(main) == "clean"`.
  - watcher.rs: `classify_path(".git/BISECT_LOG") == Some("mergeState")`, same for `BISECT_START`, `BISECT_EXPECTED_REV`, `BISECT_ANCESTORS_OK`, `BISECT_NAMES`, `BISECT_TERMS`, `BISECT_RUN`.
- [ ] **Step 2:** `cargo test --lib repo_state_ classify_path` → the new ones FAIL.
- [ ] **Step 3:** Implement: in `git_repo_state`, `git_dir.join("BISECT_LOG").exists()` → the struct above (HEAD via `git rev-parse HEAD`); in `classify_path`, add the seven names to the `mergeState` `matches!`.
- [ ] **Step 4:** Same command → PASS; `cargo fmt`; clippy clean.
- [ ] **Step 5:** Commit `feat(bisect): repo state reports a bisect in progress`.

### Task 2: `commands/bisect.rs` — status, start, mark, reset

**Files:**
- Create: `src-tauri/src/commands/bisect.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub(crate) mod bisect;`), `src-tauri/src/lib.rs` (register the four commands next to `git_repo_state`), `src-tauri/src/types.rs` (`BisectStatus`)
- Test: `bisect.rs` `#[cfg(test)] mod tests` (TempRepo helper as in read.rs)

**Interfaces:**
- Produces (Rust, `#[serde(rename_all = "camelCase")]`):
  ```rust
  pub struct BisectStatus {
      pub current: Option<String>,      // HEAD full hash
      pub start: Option<String>,        // BISECT_START contents (branch name or hash)
      pub bad: Option<String>,          // refs/bisect/<bad term>
      pub good: Vec<String>,            // refs/bisect/<good term>-*
      pub skipped: Vec<String>,         // refs/bisect/skip-*
      pub remaining: Option<u32>,       // bisect_nr, None until bad and ≥1 good
      pub steps: Option<u32>,           // bisect_steps
      pub candidates: Vec<String>,      // non-empty once git has narrowed it down; len 1 = culprit
      pub terms: (String, String),      // (bad term, good term), default ("bad", "good")
  }
  ```
  - `#[tauri::command] git_bisect_status(cwd: String) -> Result<BisectStatus, String>`
  - `git_bisect_start(cwd: String, bad: String, good: String) -> Result<BisectStatus, String>`
  - `git_bisect_mark(cwd: String, verdict: String) -> Result<BisectStatus, String>` — verdict `"good" | "bad" | "skip"`
  - `git_bisect_reset(cwd: String) -> Result<(), String>`

- [ ] **Step 1: Failing tests** (linear repo `c1..c8` unless noted)
  - `status_counts_and_estimate`: `bisect start c8 c1` → `bad == c8`, `good == [c1]`, `remaining == Some(n)` and `steps == Some(k)` equal to `git rev-list --bisect-vars c8 --not c1`'s `bisect_nr`/`bisect_steps`, `candidates` empty, `current == HEAD`, `start == Some("main")`.
  - `status_before_both_ends_has_no_estimate`: `git bisect start` only → `remaining == None`, `bad == None`, `good` empty.
  - `mark_until_culprit`: bug introduced at `c5`; loop: `mark(if HEAD reaches c5 {"bad"} else {"good"})` until `candidates.len() == 1`; assert `candidates == [c5]`.
  - `status_lists_candidates_when_only_skips_remain`: `bisect start c4 c1`; skip until git stops; `candidates` contains `c2`, `c3`, `c4` (every non-good commit left), len > 1.
  - `status_reads_custom_terms`: `git bisect start --term-new=broken --term-old=fixed c8 c1` → `terms == ("broken","fixed")`, `bad == c8`, `good == [c1]`.
  - `mark_good_uses_old_term`: same start; `mark("good")` runs `git bisect fixed` (assert `refs/bisect/fixed-<HEAD>` exists).
  - `start_refuses_tracked_changes`: modify a tracked file → `Err` containing `"uncommitted"`; untracked file alone → Ok.
  - `start_refuses_when_good_is_not_ancestor`: branch `side` off `c2` with its own commit; `start(bad=c8, good=side_tip)` → `Err`, no `BISECT_LOG`.
  - `start_refuses_during_another_operation`: a bisect already started → `Err`.
  - `start_rejects_non_hex`: `good = "--foo"` → `Err`, git never run (no `BISECT_LOG`).
  - `mark_rejects_unknown_verdict`: `"maybe"` → `Err`.
  - `reset_returns_to_start_branch`: after a few marks, `reset` → HEAD on `main`, no `BISECT_LOG`.
  - `reset_fails_and_keeps_bisect_when_start_branch_is_gone`: start from a branch `tmp` (checked out first), detach via the bisect, delete `tmp` with `update-ref -d` → `reset` returns `Err`, `BISECT_LOG` still exists.
- [ ] **Step 2:** `cargo test --lib bisect::` → FAIL (module missing).
- [ ] **Step 3:** Implement.
  - Terms: `BISECT_TERMS` (two lines: bad term, good term) if present, else `("bad","good")`.
  - Refs: one `git for-each-ref --format=%(refname) %(objectname) refs/bisect/`; classify by `refs/bisect/<bad>`, `<good>-`, `skip-`.
  - Estimate: when `bad` and ≥1 good: `git rev-list --bisect-vars <bad> --not <goods…>` and parse `bisect_nr=`/`bisect_steps=` lines.
  - Candidates: `git rev-list <bad> --not <goods…>` → set S; remaining-after-skips R = S minus skipped. If `R == {bad}` → `[bad]` (culprit). Else if every member of S except `bad` is skipped, or `bisect_nr == 0` with skips → `S` ordered as rev-list prints it. Else empty.
  - Start: validate both args `^[0-9a-f]{7,64}$`; refuse when `BISECT_LOG` exists or `git_repo_state` would be non-clean; refuse on `git status --porcelain --untracked-files=no` non-empty ("Commit or stash your uncommitted changes before starting a bisect."); `git merge-base --is-ancestor <good> <bad>` must exit 0 ("The good commit must be an ancestor of the bad one."); then `git bisect start <bad> <good>`; on failure return stderr.
  - Mark: map verdict to the term (`skip` stays `skip`), `git bisect <term>`; failure → stderr.
  - Reset: `git bisect reset`; failure → stderr.
- [ ] **Step 4:** `cargo test --lib bisect::` → PASS; fmt; clippy.
- [ ] **Step 5:** Commit `feat(bisect): status, start, mark and reset commands`.

### Task 3: Frontend wrappers, dev-server routes, registry

**Files:**
- Modify: `src/utils/backend.ts` (wrappers next to `gitRepoState`; `RepoOperationState["state"]` union gains `"bisect"`; `BisectStatus` interface mirroring Task 2 with `terms: [string, string]`)
- Modify: `dev-server.mjs` (routes; `/api/git-repo-state` reports bisect the Task 1 way)
- Modify: `src/utils/commandRegistry.ts`
- Test: `src/__tests__/bisect.devserver.test.ts` (start the dev server the way `worktreeService.devserver.test.ts` does)

**Interfaces:**
- Produces:
  - `gitBisectStatus(cwd: string): Promise<BisectStatus>` → `git_bisect_status` / `GET /api/git-bisect-status?cwd=`
  - `gitBisectStart(cwd: string, bad: string, good: string): Promise<BisectStatus>` → `POST /api/git-bisect-start` `{cwd,bad,good}`
  - `gitBisectMark(cwd: string, verdict: "good" | "bad" | "skip"): Promise<BisectStatus>` → `POST /api/git-bisect-mark`
  - `gitBisectReset(cwd: string): Promise<void>` → `POST /api/git-bisect-reset`
  - Errors: wrappers throw `Error(message)` with the backend's message (as other wrappers do).

- [ ] **Step 1: Failing test** `bisect.devserver.test.ts`: real repo `c1..c8`, bug at `c5`; through the wrappers in dev mode: `gitRepoState` → `"clean"`; `gitBisectStart(c8,c1)` → `remaining > 0`; mark until `candidates.length === 1` → `[c5]`; `gitRepoState` → `"bisect"`; `gitBisectStart` again rejects; a dirty tracked file makes a fresh start reject with "uncommitted"; `gitBisectReset` → `"clean"`, HEAD on `main`.
- [ ] **Step 2:** `npx vitest run src/__tests__/bisect.devserver.test.ts src/utils/__tests__/commandRegistry.test.ts` → FAIL.
- [ ] **Step 3:** Implement wrappers, routes (same refusals, messages and candidate rule as Task 2), registry entries.
- [ ] **Step 4:** Same command → PASS; `npx vue-tsc --noEmit` exit 0.
- [ ] **Step 5:** Commit `feat(bisect): IPC wrappers and dev-server routes`.

### Task 4: Operation-state consumers know about bisect

**Files:**
- Create: `src/utils/operationKinds.ts`
- Modify: `src/App.vue` (`pendingSplitAtHalt` ~l.1253, the 3 s `_rebaseStateInterval` watch ~l.3352, `RebaseProgressBanner` `v-if` ~l.5094)
- Modify: `src/composables/useAutoFastForward.ts` only if it reads `operation.state` in a way that breaks on `"bisect"` (it must keep blocking: it already treats any operation as a block)
- Test: `src/utils/__tests__/operationKinds.test.ts`

**Interfaces:**
- Produces:
  - `isBisect(op: RepoOperationState | null): boolean`
  - `pollsRepoState(op: RepoOperationState | null): boolean` — true for any non-null op except bisect
  - `showsOperationBanner(op: RepoOperationState | null): boolean` — true for any non-null op except bisect

- [ ] **Step 1: Failing test**: each function on `null`, `rebase`, `rebase_interactive`, `merge`, `cherry_pick`, `revert`, `bisect` (expected: bisect → `isBisect` true, the two others false; other ops → false/true/true; null → false/false/false).
- [ ] **Step 2:** `npx vitest run src/utils/__tests__/operationKinds.test.ts` → FAIL.
- [ ] **Step 3:** Implement; in App.vue: `pendingSplitAtHalt` returns null when `isBisect(st)`; the interval watch uses `pollsRepoState(op)`; `RebaseProgressBanner`'s `v-if` adds `showsOperationBanner(repoOperationState)`.
- [ ] **Step 4:** test PASS; `npx vitest run src/composables/__tests__/useAutoFastForward.test.ts` PASS (its "bisect in progress -> blocked" case included); vue-tsc 0.
- [ ] **Step 5:** Commit `feat(bisect): operation consumers treat bisect apart`.

### Task 5: `BisectBanner.vue`, mounted in App, strings

**Files:**
- Create: `src/components/BisectBanner.vue`
- Modify: `src/App.vue` (lazy import next to `RebaseProgressBanner`; render `<BisectBanner v-if="isBisect(repoOperationState) && repoFolderPath" …>` in the same slot)
- Modify: `src/locales/*.ts` (`bisect.*` keys)
- Test: `src/components/__tests__/BisectBanner.test.ts` (`// @vitest-environment jsdom`, `vi.mock("../../utils/backend")`)

**Interfaces:**
- Consumes: Task 3 wrappers, Task 4 `isBisect`.
- Produces: props `{ cwd: string; refreshKey: unknown; hasTrackedChanges: boolean }`; emits `changed` (after start/mark/reset: parent runs `refreshRepoState()`, `repoRefresh(true)`), `open-commit` `(hash: string)` (parent: `selectCommit(hash); viewMode = 'history'`). The banner calls `gitBisectStatus(cwd)` on mount and whenever `refreshKey` changes (parent passes `repoOperationState` and the refs fingerprint/status object it already has).
- Keys (en, copy in the other four): `bisect.title` "Bisecting", `bisect.testing` "Testing {0}", `bisect.left` "{0} commits left, about {1} steps", `bisect.counts` "{0} good · {1} bad · {2} skipped", `bisect.needEnds` "Mark a bad and a good commit to start narrowing down", `bisect.good` "Good", `bisect.bad` "Bad", `bisect.skip` "Skip", `bisect.end` "End bisect", `bisect.endHint` "Ends the bisect and checks out {0} again", `bisect.culprit` "First bad commit: {0}", `bisect.candidates` "The first bad commit is one of these {0}:", `bisect.open` "Open commit", `bisect.dirty` "Your uncommitted changes will follow you to the next commit.".

- [ ] **Step 1: Failing tests** (status mocked):
  - `shows the commit under test, counts and estimate`: `remaining 37, steps 5`, 2 good, 1 bad → text contains "37 commits left, about 5 steps" and "2 good · 1 bad · 0 skipped".
  - `asks for both ends`: `remaining null` → `bisect.needEnds` text; Good/Bad enabled.
  - `marks and emits changed`: click Bad → `gitBisectMark(cwd, "bad")` called once, buttons disabled until it resolves, then `changed` emitted.
  - `shows a mark error inline`: `gitBisectMark` rejects "would be overwritten" → message rendered, buttons re-enabled.
  - `culprit state`: `candidates [h]` → `bisect.culprit`, Open commit emits `open-commit` with `h`, Good/Bad/Skip absent.
  - `candidates state`: 3 candidates → each listed, clicking one emits `open-commit`.
  - `end bisect`: click → `gitBisectReset` then `changed`; tooltip names `start`.
  - `dirty note`: `hasTrackedChanges: true` → `bisect.dirty` shown.
- [ ] **Step 2:** `npx vitest run src/components/__tests__/BisectBanner.test.ts` → FAIL.
- [ ] **Step 3:** Implement the component (layout per the spec sketch, styles from `RebaseProgressBanner`, buttons from global `.btn`), the App mount and the locale keys.
- [ ] **Step 4:** test PASS; vue-tsc 0.
- [ ] **Step 5:** Commit `feat(bisect): banner`.

### Task 6: Start from the Git Tree

**Files:**
- Create: `src/utils/bisectEndpoints.ts`
- Modify: `src/components/CommitGraph.vue` (two context-menu items after the cherry-pick ones; new `CommitEvent`s), `src/components/CommitLog.vue` if it renders the same commit menu, `src/App.vue` (handlers + a `BaseModal` confirmation), `src/locales/*.ts`
- Test: `src/utils/__tests__/bisectEndpoints.test.ts`, `src/components/__tests__/CommitGraph-bisect-menu.test.ts` (extend an existing CommitGraph menu test if one exists)

**Interfaces:**
- Produces:
  - `bisectEndpoints(selected: string[], logOrder: Map<string, number>): { good: string; bad: string } | null` — exactly two hashes present in `logOrder`: the higher row index (older) is `good`, the other `bad`; anything else → null.
  - CommitGraph emits `bisect-between: [good: string, bad: string]` and `bisect-from-here: [entry: GitLogEntry]`.
  - Menu items: "Bisect between these commits" shown when `bisectEndpoints(...)` is non-null; "Bisect from here (this commit is good)" shown for a single commit that is not HEAD; both hidden when the new prop `operationInProgress: boolean` is true.
  - App: confirmation `BaseModal` "Bisect between good {good} and bad {bad}? Your working tree will move to the commits git picks; End bisect brings you back to {branch}." (`bisect.confirmTitle`, `bisect.confirmBody`, `bisect.confirmStart`); on confirm `gitBisectStart(cwd, bad, good)` (bad = HEAD full hash for "from here"); on success `refreshRepoState()` + `repoRefresh(true)`; on error a toast with the message.
- [ ] **Step 1: Failing tests**: `bisectEndpoints` (two hashes in either selection order → older is good; one, three, or an unknown hash → null); menu test: two selected → "Bisect between" visible and emits `bisect-between(good,bad)`; HEAD entry → "from here" hidden; `operationInProgress` → both hidden.
- [ ] **Step 2:** run both test files → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; vue-tsc 0.
- [ ] **Step 5:** Commit `feat(bisect): start from the Git Tree`.

### Task 7: Docs, budget, full verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased → Added: guided bisect; Changed: budget raise with the measured size), `ROADMAP.md` (remove "Guided bisect" from Later; in the #265 follow-ups, drop "a bisect in progress is invisible to the status"; add a Later line for `bisect run` with the trust/stop/timeout questions), `perf/bundle-check.mjs` (main budget to the measured size rounded up to the next 4 KB, history comment)
- [ ] **Step 1:** `pnpm build && node perf/bundle-check.mjs` → note the main size; raise the budget only by that.
- [ ] **Step 2:** Full checks: `npx vue-tsc --noEmit` (exit 0), `npx vitest run` (all pass; re-run alone any known-flaky failure), `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`.
- [ ] **Step 3:** Manual dev:web pass on a throwaway repo: start from two selected commits, mark to the culprit, Open commit, End bisect; a terminal-started bisect shows the banner.
- [ ] **Step 4:** Commit `docs(bisect): changelog, roadmap, bundle budget`.
