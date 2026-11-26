# Guided bisect — design

2026-11-26 · roadmap item "Guided bisect" (Later, from the 2026-10-08 Gitoryx scan) · first version without `bisect run`

## Intent

Find the commit that introduced a bug without leaving GitWand: pick a known-good and a known-bad commit in the Git Tree, then answer Good / Bad / Skip on each commit git checks out, with the remaining steps shown, until GitWand names the first bad commit and opens it. A competitor (Gitoryx) ships it; GitWand today does not even show that a bisect is running.

## Current state

- A bisect in progress is detected in one place only: `useAutoFastForward.ts` runs `git bisect log` to block auto fast-forward. `git_repo_state` (read.rs) does not report it, so the operation banner, the status and the Git Tree know nothing (follow-up noted after #265).
- `ops.rs` refuses `abort` for `bisect` (`operation_action_args("bisect", "abort")` is an error): GitWand cannot end a bisect started in a terminal.
- The watcher (watcher.rs `classify_path`) maps `MERGE_HEAD`, `REBASE_HEAD`… to `mergeState`; the bisect files (`BISECT_LOG`, `BISECT_START`, `BISECT_EXPECTED_REV`…) are not classified.
- The Git Tree already shows `refs/bisect/*` in decorations (`%D`), and has a multi-commit selection (`useCommitSelection`, v3.15 combined diffs).
- The main bundle is at its 992 KB budget.

## Goals

1. A bisect in progress, started in GitWand or in a terminal, is visible: a banner with the commit under test, its subject, the good/bad/skipped counts and an estimate of the remaining steps.
2. Start a bisect from the Git Tree:
   - two commits selected → context menu "Bisect between these commits": the older is good, the newer is bad (by ancestry; if neither is an ancestor of the other, refuse with an explanation);
   - one commit → context menu "Bisect from here (this commit is good)": bad = HEAD; refused when the commit is HEAD or not an ancestor of HEAD.
   A confirmation names both commits and the branch the bisect will return to.
3. Good / Bad / Skip on the commit under test, from the banner. After each answer the banner, the Git Tree and the status refresh.
4. When git has narrowed it down, the banner names the first bad commit (or, when skips leave several candidates, lists them) with "Open commit" (selects it in the Git Tree and opens its diff) and "End bisect".
5. "End bisect" (`git bisect reset`) returns to the branch or commit the bisect started from, for any bisect, including one started in a terminal.

## Non-goals (v1)

- `git bisect run` with a user command (next version: it runs a user command at every step, with the stop/timeout/trust questions of worktree `setup`).
- Custom terms (`--term-old/--term-new`), `bisect replay`, exporting the log, several good commits picked at start (git accepts them; the UI offers one, a terminal bisect with several is still shown correctly).
- CLI / MCP tools.

- New guards on other actions during a bisect (user's decision, 2026-11-26): GitWand blocks nothing during any operation today and git decides; a branch switch, pull or commit during a bisect is allowed as git allows it. The banner stays as long as the bisect exists, with End bisect to return to the start branch.

## Anti-goals

- Losing uncommitted work, or checking out over it.
- Leaving the user on a detached HEAD with no visible way back.
- Reading git's human messages (translated by `LANG`) to decide anything.

## Constraints

- Every git call through the existing runners, under `repo_lock` (write for start/mark/reset), no shell.
- Each new Tauri command gets a dev-server route and a `commandRegistry.ts` entry (`commandRegistry.test.ts`).
- UI strings in the 5 locales.
- The banner is a lazy chunk; the budget is raised by what the wrappers and strings measure, noted in the CHANGELOG as previous raises were.
- Tests run real git on temporary repos (AGENTS.md: never a mocked git layer).

## Approaches considered

- **A. Banner driven by repo state (chosen).** `git_repo_state` reports `bisect`; a `BisectBanner` (lazy) sits where `RebaseProgressBanner` does, fed by a `git_bisect_status` read. Fits how every other in-progress operation is shown, and shows terminal-started bisects for free.
- **B. A dedicated bisect panel/view.** More room (candidate list, log), but a second place to look, and a terminal-started bisect would still need the banner. Overkill for three buttons and a counter.
- **C. Reuse `RebaseProgressBanner` with bisect buttons.** Less code, but its Continue/Skip/Abort model and conflict handling do not fit (Good/Bad/Skip, no conflicts, a result state); it would grow conditionals everywhere.

`bisect run`: left out of v1 (user's choice, 2026-11-26).

## Design

### Backend (Rust, `commands/bisect.rs` or next to the ops commands)

- `git_repo_state`: when `BISECT_LOG` exists in the git dir (and no rebase/merge/cherry-pick/revert is in progress, which take precedence as they do today), return `state: "bisect"`, `operation_head` = HEAD commit, `step`/`total` 0. Audit every consumer of `repoOperationState` in App.vue and `useAutoFastForward` (the banner, the rebase auto-resolve loop, `pendingSplitAtHalt`, the 3 s operation poll, the restack refresh) and exclude `bisect` where they mean a rebase/merge-like operation:
  - **split prompt** (`pendingSplitAtHalt`): never for a bisect (decision: the tested commit is not halted, a split there makes no sense);
  - **3 s operation poll**: not for a bisect, which can stay open for hours; the banner refreshes from the watcher (`mergeState`, `head`, `refs`) and after each action (decision);
  - `RebaseProgressBanner` never shows for a bisect.
- `git_bisect_status(cwd) -> BisectStatus`:
  - `bad: Option<String>` (`refs/bisect/bad`), `good: Vec<String>` (`refs/bisect/good-*`), `skipped: Vec<String>` (`refs/bisect/skip-*`), `current: Option<String>` (HEAD), `start: Option<String>` (`BISECT_START`: the branch or commit `reset` returns to);
  - `remaining` and `steps`: from `git rev-list --bisect-vars <bad> --not <goods>` (`bisect_nr`, `bisect_steps`), machine output, no locale; absent until both a good and a bad exist;
  - `candidates`: when the range minus skipped commits is ≤ 1, or only skipped commits remain: the commits that can still be the first bad one (`rev-list <bad> --not <goods>` minus skips, plus `bad`); one candidate = the culprit.
- `git_bisect_start(cwd, bad, good)`: refuses when tracked files have changes (status porcelain, untracked ignored) with an explicit message ("commit or stash your changes first"), when a bisect or another operation is already in progress, and when `good` is not an ancestor of `bad`. Runs `git bisect start <bad> <good>` (`--` before nothing else: both are full hashes resolved by the frontend, validated as hex).
- `git_bisect_mark(cwd, verdict: "good" | "bad" | "skip")`: `git bisect <verdict>` on HEAD. Returns the new `BisectStatus`. A failed checkout (git refuses) surfaces git's stderr.
- Uncommitted changes during a bisect (decision): Good/Bad/Skip and End bisect do not refuse them. Git carries edits that do not conflict to the next commit (nothing is lost, as with a checkout) and refuses the checkout when they would be overwritten, which the banner shows as an error. The banner says so when tracked files are modified: "Your uncommitted changes will follow you to the next commit." Start still refuses them, so a bisect never begins on a dirty tree.
- `git_bisect_reset(cwd)`: `git bisect reset`. When the original branch no longer exists or cannot be checked out, surface the error and leave the bisect in place.
- `ops.rs`: `operation_action_args("bisect", "abort")` stays refused (reset is its own command, with its own wording).
- watcher.rs: classify `BISECT_LOG`, `BISECT_START`, `BISECT_EXPECTED_REV`, `BISECT_ANCESTORS_OK`, `BISECT_NAMES`, `BISECT_TERMS`, `BISECT_RUN` as `mergeState` (the kind that already refreshes repo state); `refs/bisect/*` already falls under `refs`.

### Frontend

- `backend.ts` wrappers: `gitBisectStatus`, `gitBisectStart`, `gitBisectMark`, `gitBisectReset`; `RepoOperationState["state"]` gains `"bisect"`.
- `BisectBanner.vue` (lazy, `defineAsyncComponent`), shown when `repoOperationState.state === "bisect"`, in the place of `RebaseProgressBanner` (which is not shown for bisect):

  ```
  ⑂ Bisecting · testing a1b2c3d "Fix parser edge case" · 37 commits left, about 5 steps · 2 good, 1 bad, 0 skipped
                                                   [ Good ] [ Bad ] [ Skip ]   End bisect
  ```
  Result state:
  ```
  ⑂ First bad commit: e4f5a6b "Refactor tokenizer" — Jane, 3 days ago     [ Open commit ]  [ End bisect ]
  ```
  Several candidates (skips): "The first bad commit is one of these 3:" with each short hash/subject as a link, plus End bisect.
  Buttons disabled while an action runs; errors shown inline in the banner.
- Git Tree context menu (`CommitGraph.vue`, `CommitLog.vue` where it has the same menu): the two start entries of goal 2, hidden while any operation is in progress. The confirmation is a small `BaseModal`: "Bisect between good a1b2c3d and bad f00ba12? Your working tree will move to the commits git picks; End bisect brings you back to main."
- "Open commit": selects the commit in the Git Tree (scrolling to it, loading pages if needed, as other jump-to-commit actions do) and opens its diff.
- After start/mark/reset: `refreshRepoState()`, forced log reload (refs/bisect moved), status reload.
- End bisect: no confirmation (nothing is lost; the marks are in the bisect log git keeps until reset — say so in the tooltip: "Ends the bisect and checks out main again").

### dev-server

Routes for the four commands with the same git calls and refusals; `git_repo_state`'s route reports `bisect` the same way.

## Left to the builder

- File layout on the Rust side, exact type names, the shape of `BisectStatus` fields beyond the ones above.
- Exact wording of strings (keep the tone of the existing banners), icons.
- How "Open commit" reuses the existing jump-to-commit path.
- Tests: Rust on real repos (status counts and candidates with skips, start refusals, mark, reset back to the start branch, terminal-started bisect seen by `git_repo_state`, watcher classification); vitest for the banner states and the menu entries' enabling; dev-server parity through the registry test.
