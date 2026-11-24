# Combined Diffs (v3.15.0) — design

**Date:** 2026-11-24
**Roadmap:** `ROADMAP.md` § v3.15.0 — Combined Diffs (multi-commit, non-contiguous).

Decisions the user made are stated plainly. Everything marked **(spec call)** is mine: the user delegated every decision on this PR ("je te laisse prendre les décisions qui servent la PR et qui sont vérifiées, plus sûres et pertinentes").

---

## 1. Intent

Review scattered work as one change. A feature often lands as several commits that are not adjacent: a fix three commits later, a follow-up after an unrelated merge. Today GitWand compares exactly two points (`git_show` for one commit, `getGitFileDiff(from, to)`, `folderDiff(refA, refB)`), so reviewing "these 3 commits together" means reading three diffs and merging them in your head.

Success: select N commits in the Git Tree (or N versions in a file's history), get **one** diff showing what those commits do together — and still be able to tell, line by line, which commit wrote what.

## 2. Goals, non-goals, anti-goals

**Goals**
- Multi-select commits in the Git Tree (`⌘`/`Ctrl`-click, `⇧`-click), with a selection chip that opens the combined diff.
- A `git_combined_diff` Tauri command that computes the **net effect of only the selected commits** (user decision: option 2, "net with per-file fallback").
- When the selected commits cannot be combined on a file without an unselected commit in between, that file falls back to a per-commit view, flagged, naming the unselected commit(s) responsible.
- Per-line commit attribution in the gutter (colored marker per commit), per-hunk badges summarizing the commits in the hunk, click → jump to that commit **(spec call: per line, the user had been offered per hunk vs per line; per line keeps "who wrote this" which is the point of attribution)**.
- Entry points: Git Tree selection chip, Git Tree context menu, file history (multi-select versions → combined diff restricted to that file).
- Optional AI summary "what these N commits do together", through `useAIProvider`.

**Non-goals**
- **PR review entry point (subset of a PR's commits) — deferred to a follow-up (spec call).** Recon: there is no PR commit list in the UI (`PullRequestDetail` has only `headSha`), and PR commits are not guaranteed local (fetched only on checkout via `pull/N/head:pr-N`). Doing it right needs a commit list per forge plus a fetch that writes refs — its own PR. Added to `ROADMAP.md` as a v3.15 follow-up.
- No action on the combined diff (no squash/apply/revert of the combination). Read-only review.
- No CLI/MCP exposure.
- No support for git < 2.38 (see §4) — same floor as the v3.14 restack, so Apple's bundled git (2.39) works.

**Anti-goals**
- Never show a "net" diff that is wrong. If git cannot replay a commit cleanly on a file, that file is not shown as net — no hand-rolled patch merging, no guessing.
- Never touch the working tree, the index, HEAD or refs. The computation only writes unreachable objects (as `git merge-tree --write-tree` already does), collected by `git gc`.
- Never block the UI on large selections: bounded selection size, computation off the main thread (async command).

## 3. Approaches considered

What "combine" means when commits are non-contiguous and touch the same lines (e.g. A: `x=1→x=2`, B unselected: `x=2→x=3`, C: `x=3→x=4` — C's patch does not apply on A alone):

1. **Juxtaposed** — per file, each commit's hunks in order with a badge. Always defined, trivial attribution, but a line can appear twice and it does not read as one change.
2. **Net with per-file fallback** — replay the selected commits in order onto the parent of the oldest, in memory, with `git merge-tree`; diff base → result. Files where a replay step conflicts fall back to (1), flagged. **Chosen by the user.** The roadmap's "conflict-free since same-history" is false for non-contiguous commits; the fallback is the honest answer.
3. **Full range with greyed unselected commits** — `first^..last`. Simple, but it is no longer "these commits".

Verified on git 2.54 (toy repo): replaying C onto A with `--merge-base=C^` conflicts on the A/B/C example; replaying an independent commit onto the accumulated result succeeds.

## 4. Constraints

- AGENTS.md: git args as arrays, never interpolated; diffs parsed with the shared parsers (`parse_diff_hunks` / `parse_multi_file_diff` in Rust, `classifyHunkLine` & co in TS); new Tauri command wrapped in `backend.ts`, registered in `commandRegistry.ts`, mirrored in `dev-server.mjs`, covered by a parity test; i18n in 5 locales; `<script setup>`; logic in composables.
- **Bundle budget:** main bundle is at ~976/980 KB. All new UI lives in lazy chunks (`CommitGraph`, `CommitDiffViewer`, `FileHistoryViewer` are already async; the new `CombinedDiffView` must be async too). App.vue changes stay minimal.
- **git ≥ 2.38** (`git merge-tree --write-tree`) **(spec call)**. `--merge-base` (2.40) is *not* used: Apple's bundled git is 2.39 and GitWand runs the `git` on PATH. Instead each replay step builds synthetic commits whose only merge base is exactly `tree(Ci^)` (§5.2) — verified on git 2.54 to produce the same tree as `--merge-base`, deterministically. Below 2.38 the command returns a clear error ("Combined diffs need git 2.38 or later (found X.Y)") using `stack/guard.rs::git_version` / `parse_git_version`.
- **Bundle budget (spec call):** strings are kept terse; the `en` locale is eager in main, so measure after the build. If main exceeds 980 KB only because of this feature's wiring and English strings, raise the budget in `perf/bundle-check.mjs` by the measured amount (cap +8 KB), with a comment stating the measured size and why — the precedent of 960 → 980. Anything heavier must move to a lazy chunk instead.

## 5. Design

### 5.1 Selection rules

- 2 ≤ N ≤ 50 commits **(spec call: 50 bounds the per-step git spawns; the error names the limit)**.
- WIP and stash rows cannot be multi-selected **(spec call: a stash is a merge of index/worktree commits, its "patch" is not meaningful in a replay)**.
- **Order of replay: topological (ancestors first), whatever the click order.** Builder picks the mechanism; it must be correct when commits are on different branches and must not walk the whole history on a 40k-commit repo (e.g. `git rev-list --topo-order --reverse <sel…> --not <parents of sel…>` filtered to the selection, or pairwise `merge-base --is-ancestor` for small N with committer-date tie-break). Tested.
- **Base** = first parent of the first commit in replay order; empty tree if it is a root commit.
- **Merge commits** are replayed against their first parent (what `git_show` already shows: `-m --first-parent`).

### 5.2 `git_combined_diff` command (Rust)

`git_combined_diff(cwd: String, hashes: Vec<String>, paths: Option<Vec<String>>) -> CombinedDiff`

Input validation: every hash must match `^[0-9a-fA-F]{7,64}$` (rejects options/rev expressions), duplicates removed, 2..=50 after dedup; resolved to full hashes with `git rev-parse --verify <h>^{commit}`. `paths` are passed after `--` with `GIT_LITERAL_PATHSPECS=1`. `cwd` handled exactly like `git_show`.

Algorithm (all through `Command::new(git).args([...])`):
1. Order the commits (§5.1), compute base.
2. `accTree` = tree of the base (the empty tree, written with `git mktree` on empty stdin, for a root base). For each commit `Ci`, with `parentTree` = tree of `Ci^` (empty tree for a root commit):
   - Fast path: if `accTree == parentTree` (contiguous replay), the result tree is `tree(Ci)` — no merge.
   - Otherwise build three synthetic commits with `git -c commit.gpgSign=false commit-tree`: `P` = commit of `parentTree` (no parent), `B1` = commit of `accTree` with parent `P`, `B2` = commit of `tree(Ci)` with parent `P`; then `git merge-tree --write-tree --name-only -z <B1> <B2>` (merge base is `P` by construction — no `--merge-base`, works on 2.38). Synthetic commits use a fixed author/committer env (`GIT_AUTHOR_NAME=GitWand`, fixed emails and `…_DATE`) so they never depend on user config, never sign, run no hooks, and are deterministic. Exit 0 → clean; exit 1 → conflicted (tree OID still written); other exit → error.
   - Record the step diff `accTree → resultTree` with `git diff-tree -r -p -M -U0 --no-color --no-ext-diff` (respecting `paths`), parsed with `parse_multi_file_diff`.
   - **On a conflicted step, the fallback set grows by the union of** (a) the conflicted paths `merge-tree` lists, (b) every path (old and new) in this step's diff, (c) every path (old and new) `Ci` itself touches (`git diff-tree -r --name-only -M Ci^ Ci`). Reason: `--name-only` misses paths a conflict moves — verified with a file/directory conflict where `f` becomes `f~<oid>` and `f` is not listed. The union is conservative: a file wrongly sent to fallback is shown commit by commit (still correct); a file wrongly kept as net would be a wrong diff (anti-goal).
   - Only the (a) paths are **conflicted** (`conflicted: true`); (b)/(c) paths are **companions** (`conflicted: false`, `blockers: []`). For each conflicted path added at step i, **blockers** = `git rev-list Ci^ --not <base> <C1 … C(i-1)> -- <path>` (omit `<base>` when it is the empty tree), capped at 5 — no `rev-list` for companions. A conflicted path with empty blockers → the conflict is between selected commits themselves (different branches); the banner says so instead of naming a blocker. A companion is never described as a conflict.
   - **On a clean merged step (not the fast path)**, every path of this step's diff and of `Ci`'s own diff goes through `git check-attr --stdin -z merge` (paths NUL-terminated on stdin, so a large step never hits the argv limit): a path whose `merge` attribute is neither `unspecified` nor `set` (`union`, `binary`, `-merge`, a custom `merge.<name>.driver`) joins the fallback as a companion. Reason: such a driver can make `merge-tree` succeed with content that is not the net effect (`union` keeps both sides' lines; an "ours" driver drops `Ci`'s change, so the path is absent from the step diff and only `Ci`'s own diff names it). Attributes are read as git reads them for the repository (worktree `.gitattributes`, `$GIT_DIR/info/attributes`); `merge-tree` also gets `-c merge.default=text` so unspecified paths always use the built-in text merge.
   - **After every step, clean or conflicted**, the fallback set is closed under renames: any rename pair (old → new) in this step's diff, or in `Ci`'s own diff (the side `merge-tree` followed), with one path in the fallback set brings the other path in (it inherits that path's `conflicted` flag and blockers; a conflicted side upgrades a companion partner), repeated until nothing changes. Reason: a later clean step can rename a fallback path and carry its conflict markers to a new path — verified on git 2.54 (A adds `p`, B unselected and C edit the same line, D renames `p→p2`; select A, C, D: step D exits 0 and `p2` would show up as a new file full of markers).
   - `merge-tree` runs with `-c merge.renames=true -c merge.directoryRenames=conflict -c merge.renameLimit=7000 -c merge.renormalize=false`, and every diff with `-c diff.renameLimit=7000`, so the user's merge config cannot change the result (e.g. `merge.directoryRenames=true` would move a file added in a renamed directory to a path no selected commit wrote).
   - `accTree` = `resultTree` and the loop continues. Conflict markers left in fallback paths are harmless only because of the rename closure above: every path that can hold them is in the fallback set and filtered out.
3. `combined` = `git diff-tree -r -p -M --no-color --no-ext-diff <base tree> <final tree>` (respecting `paths`), parsed with `parse_multi_file_diff`. Any entry whose `path` or `oldPath` is in the fallback set is dropped **and both its paths join the fallback set** (a rename pairing must not leak half a conflict into the net view).
4. For each fallback path touched by at least one selected commit: its per-commit diffs (`git show -m --first-parent --format= <Ci> -- <path>` for each selected commit that touches it, parsed the same way). Fallback paths no selected commit touches (conflict artefacts like `f~<oid>`) are dropped from the output.
5. Step diffs are also filtered to drop fallback files (their lines are attributed by the per-commit view), and every step entry of a file whose net entry or any step entry is truncated (> 5 MB, `truncatedFromBytes`): no partial attribution.
6. **Total payload budget (16 MB of hunk line content over `diffs`, `steps` and the fallback's `perCommit`)** — the per-file 5 MB cap does not bound `steps` × N. Over budget: (a) drop the step entries of whole files (names linked by renames), largest first, ties by smallest name — those files lose their markers, never get wrong ones; (b) if still over, make the largest net / per-commit entries header-only with `truncatedFromBytes`, largest first. `truncated: true` on the result when either happened; the view shows a one-line note. Same constant and order in `dev-server.mjs` (parity-tested through the test-only `GITWAND_COMBINED_BUDGET_BYTES`, read by the parity probe and the dev server, never by the shipped app).

Return type (serde camelCase, mirrored in `backend.ts`):

```ts
interface CombinedDiff {
  base: string | null;            // full hash, null = empty tree
  commits: CombinedCommit[];       // replay order
  diffs: GitDiff[];                // net diff, fallback files removed
  steps: GitDiff[][];              // steps[i] = -U0 diff of commit i's replay, fallback files removed
  fallback: CombinedFallbackFile[];
  truncated: boolean;              // the 16 MB payload budget cut something (step 6)
}
interface CombinedCommit { hash: string; shortHash: string; subject: string; author: string; date: string }
interface CombinedFallbackFile {
  path: string;
  conflicted: boolean;                              // merge-tree reported it (or its rename partner); false = conservative companion
  perCommit: { hash: string; diff: GitDiff }[];   // replay order
  blockers: string[];                               // full hashes, ≤ 5; only for conflicted files; conflicted + empty = conflict between selected commits
}
```

Rust unit tests on real temp repos (no mocks): contiguous, non-contiguous clean, overlap → fallback with blocker, root commit, merge commit, `paths` filter, rename across steps, binary file, invalid hash / option-looking input rejected, N bounds, git version guard (parse only).

### 5.3 Dev-server & parity

- `/api/git-combined-diff` in `dev-server.mjs` (POST or GET with JSON-encoded `hashes`; follow the existing convention for array args), same algorithm with `gitSpawn`, diffs parsed via `loadDevCore()` / `devParseDiffHunks` like `/api/git-show`.
- `commandRegistry.ts`: `git_combined_diff: { route: "/api/git-combined-diff" }`.
- Parity: `git_combined_diff_parity` wrapper in `lib.rs`, `parity_probe.rs` arm, `tests/parity/git-combined-diff.test.mjs` covering contiguous, non-contiguous clean and fallback.

### 5.4 Attribution (TypeScript, pure)

Computed in the frontend from `steps`, so both backends share one implementation: `apps/desktop/src/utils/combinedAttribution.ts`, unit-tested.

- For each file, keep a sparse model of the current lines: each line is `{ base: k }` (line k of the base) or `{ commit: i }`. Untouched spans map to themselves, so a list of inserted/removed segments plus a running offset is enough — the file's line count is never needed.
- Apply step i's hunks (new-side positions, `-U0`): deleted lines are removed (if they were `{base:k}`, record `deletedBy[k] = i`); added lines are inserted as `{commit:i}`. Renames move the array to the new path.
- Result per file of the net diff: `RIGHT:<newLine>` → commit index for `+` lines (from the array), `LEFT:<oldLine>` → commit index for `-` lines (from `deletedBy`). Line keys follow the `LEFT:<old>` / `RIGHT:<new>` convention of `lineKeyFor` in `DiffViewer.vue:155` (private today): extract it to a shared `utils/diffLineKey.ts` and use it from both. A line without attribution (diff alignment differs between steps and net) gets no marker — never a wrong one.
- Per hunk: the ordered set of commit indexes present on its lines.
- Fallback files: every line of `perCommit[j]` is attributed to that commit.

### 5.5 UI

**Git Tree (`CommitGraph.vue`, async chunk)**
- Plain click: single selection (unchanged). `⌘`-click (macOS) / `Ctrl`-click (others): toggle the row in a multi-selection (the currently selected commit becomes the first member). `⇧`-click: select the visible rows between the anchor and the clicked row (respecting active filters/search), skipping WIP/stash rows. `Esc`: clear.
- Selected rows keep `cg-row--selected` styling; the focused one stays distinct.
- **Selection chip** pinned at the bottom of the graph when ≥ 2 are selected: "3 commits selected · Combined diff · ✕". Over 50: chip shows the limit and the action is disabled.
- **Context menu**: on a row that belongs to a multi-selection, "Combined diff of N commits" at the top. On a single row: no change.
- Selection state lives in a small composable (`useCommitSelection`) in the graph's chunk, not in App.vue.

**Graph view behaviour (spec call, from the current layout: a commit click fills the right-rail file list; `CommitDiffViewer` replaces the graph full-screen only once a file is clicked)**
- `⌘`/`⇧`-clicks do **not** emit `select-commit`: no `git_show` reload, the right rail keeps showing the anchor (last plain-clicked) commit.
- Opening a combined diff (chip, context menu, `Enter` with ≥ 2 selected) shows `CombinedDiffView` **full-screen in place of the graph**, the same way `CommitDiffViewer` does today. It carries its own file list (no `RepoSidebar` change). Closing it (button or `Esc`) returns to the graph with the multi-selection **kept**; a second `Esc` clears it. Opening is explicit — ⌘-clicks alone don't recompute (avoids a recompute per click).

**Combined view (`CombinedDiffView.vue`, new, async)**
- Header: one colored chip per commit (short hash + subject, color from a fixed palette indexed by replay order), click → select that single commit (leaves combined mode). File/line counts. Close button.
- Fallback banner when `fallback.length > 0`: "N files could not be combined without abc1234 (and …) — shown commit by commit." Each fallback file is rendered as one section per commit, labelled with the commit chip.
- Body: `CommitDiffViewer` with new optional props for line attribution (marker in the gutter: inline mode → a thin colored bar next to the line numbers; side-by-side → the existing empty `cdv-sbs-gutter` column) and hunk badges (commit chips in the hunk header, click → jump to commit). Without these props `CommitDiffViewer` renders exactly as today.
- AI summary button when `useAIProvider().isAvailable`: "Summarize these N commits". Reuses `buildSummaryPrompt` from `usePrSummary.ts` (commit subjects + `path (+a/−d)` per file — no hunk text sent, same privacy as the PR summary) through a small adapter: `buildSummaryPrompt` counts lines from `SummaryFileEntry.raw`, while the combined diff is parsed `GitDiff[]`, so either pass counts or factor the counting out. System prompt variant for "N commits taken together". Result shown in the header, not persisted. Errors shown inline.
- Errors (git < 2.40, too many commits, invalid input) rendered inline in the view.

**File history (`FileHistoryViewer.vue`, log tab)**
- `⌘`/`Ctrl`/`⇧`-click on log entries builds a multi-selection; a "Combined diff (N)" button appears.
- Opens the combined diff with `paths` = every path the file had across the selected entries (renames): the panel closes and the app switches to the Git Tree view with `CombinedDiffView` open full-screen, its header showing a "limited to <path>" chip **(spec call: one mount point for the combined view; `FileHistoryViewer` never shows a commit diff today — clicking a log entry already navigates away)**. The existing compare tab (pair from/to) is unchanged.

**i18n**: every new string in `en`, `fr`, `es`, `pt-BR`, `zh-CN`.

### 5.6 Roadmap & docs

- `ROADMAP.md` v3.15.0: note the PR-review entry point as a follow-up (reason above); correct "conflict-free since same-history" to the net-with-fallback behaviour. Moving the section to Shipped happens at tag time, not in this PR.
- `CHANGELOG.md` `[Unreleased]`: Added entry.

## 6. Left to the builder

- Exact topo-ordering mechanism (§5.1) and exact `merge-tree` flags/output parsing, verified against git docs and a test on the installed git.
- Whether `steps` use `-M` rename detection identical to the net diff (they must agree for attribution through renames; test it).
- Component split inside `CombinedDiffView` and the exact prop names added to `CommitDiffViewer`.
- Exact App.vue wiring for the full-screen mount (graph view only), keeping App.vue changes minimal.
- Palette for commit colors (must pass contrast in light and dark themes; reuse existing lane colors if suitable).
