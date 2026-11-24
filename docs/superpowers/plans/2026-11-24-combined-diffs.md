# Combined Diffs (v3.15.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select N (possibly non-contiguous) commits and review one net diff with per-line commit attribution, falling back to a per-commit view for files that cannot be combined without an unselected commit.

**Architecture:** A Rust command `git_combined_diff` replays the selected commits in topological order onto the parent of the oldest with `git merge-tree --write-tree` over synthetic commits (no worktree/index/ref writes), returns the net diff, the per-step `-U0` diffs and the fallback files. The dev-server mirrors it (parity-tested). Attribution is computed in pure TypeScript from the step diffs. UI: multi-select in `CommitGraph`, a lazy `CombinedDiffView` replacing the graph full-screen, attribution rendered by `CommitDiffViewer` through new optional props, file-history entry point, AI summary.

**Tech Stack:** Rust (Tauri 2), Vue 3 `<script setup>`, TypeScript, Vitest, Node dev-server (`dev-server.mjs`), parity harness (`apps/desktop/tests/parity/`).

**Spec:** `docs/superpowers/specs/2026-11-24-combined-diffs-design.md` — read it first; every task implicitly includes it.

All paths below are relative to `apps/desktop/` unless they start with `docs/`, `ROADMAP.md` or `CHANGELOG.md`.

## Global Constraints

- git floor **2.38**; error copy exactly `Combined diffs need git 2.38 or later (found X.Y).` (X.Y = detected version, or `unknown`).
- Selection: **2 ≤ N ≤ 50** after dedup; errors `Select at least 2 commits.` / `Select at most 50 commits.`
- Hash input must match `^[0-9a-fA-F]{7,64}$`, else `Invalid commit hash: <h>`; resolved with `rev-parse --verify --end-of-options <h>^{commit}`; unknown → `Unknown commit: <h>`.
- Never touch worktree, index, HEAD or refs. Only unreachable objects may be written.
- Every git call: argument arrays (AGENTS.md), `--no-color --no-ext-diff` on diff-producing commands, and `-c diff.noprefix=false -c diff.mnemonicPrefix=false -c core.quotePath=false` so user config cannot change the output the parsers expect.
- Synthetic commits: `git -c commit.gpgSign=false commit-tree …` with env `GIT_AUTHOR_NAME=GitWand GIT_AUTHOR_EMAIL=combined-diff@gitwand.local GIT_AUTHOR_DATE=2000-01-01T00:00:00Z` and the same three `GIT_COMMITTER_*`.
- Empty tree OID is **never hard-coded** (sha256 repos): `git hash-object -t tree -w --stdin` with empty stdin.
- Diffs are parsed only with `parse_multi_file_diff` (Rust) / the `/api/git-show` section splitter + `devParseDiffHunks` (dev-server).
- Main bundle budget 980 KB (`perf/bundle-check.mjs`); new UI only in async chunks; budget may be raised by ≤ 8 KB with a measured-size comment if strings/wiring alone exceed it (spec §4).
- Every user-visible string in `src/locales/{en,fr,es,pt-BR,zh-CN}.ts` under a new top-level `combined` namespace (use the `i18n-sync` skill).
- New Vue code: `<script setup>`, logic in composables.
- `cargo fmt` before every Rust commit.

## Review Focus

1. **User git config that reshapes diff output** (`diff.noprefix`, `diff.external`, `color.ui=always`, `commit.gpgSign=true`) — combined diff must equal the clean-config result and never prompt/sign. Test in Task 2.
2. **sha256 repositories and root commits** — selecting the root commit of a sha256 repo works (empty tree computed, not hard-coded). Test in Task 2.
3. **Stale selection** — commits that disappeared after a rebase/refresh give `Unknown commit: <h>` rendered inline, not a crash or empty view. Tests in Task 1 (Rust) and Task 7 (view error state).
4. **Paths with spaces and non-ASCII** — combined output matches `git_show` for the same file. Test in Task 2.
5. **Binary files and pure renames in the selection** — rendered like in the single-commit view (no hunks, no attribution, no crash). Tests in Task 2 (Rust) and Task 4 (attribution ignores hunkless files).

---

### Task 1: Rust — types, input validation, version guard, ordering

**Files:**
- Create: `src-tauri/src/combined/mod.rs`, `src-tauri/src/combined/order.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod combined;`), `src-tauri/src/types.rs` (new types)
- Test: unit tests in `src-tauri/src/combined/order.rs` (`#[cfg(test)]`, real temp repos)

**Interfaces:**
- Produces (types.rs, `#[derive(Serialize, Debug, Clone, PartialEq)]`, `#[serde(rename_all = "camelCase")]`):
  - `CombinedCommit { hash: String, short_hash: String, subject: String, author: String, date: String }` (`date` = `%aI`)
  - `CombinedFallbackCommitDiff { hash: String, diff: GitDiff }`
  - `CombinedFallbackFile { path: String, per_commit: Vec<CombinedFallbackCommitDiff>, blockers: Vec<String> }`
  - `CombinedDiff { base: Option<String>, commits: Vec<CombinedCommit>, diffs: Vec<GitDiff>, steps: Vec<Vec<GitDiff>>, fallback: Vec<CombinedFallbackFile> }`
- Produces (`combined/mod.rs`): `pub(crate) fn supports_combined_diff(v: Option<(u32, u32)>) -> bool` (≥ 2.38, `None` → false); `pub(crate) fn validate_hashes(hashes: &[String]) -> Result<Vec<String>, String>` (regex, dedup preserving first occurrence, bounds); reuses `crate::stack::guard::{git_version, parse_git_version}`.
- Produces (`combined/order.rs`): `pub(crate) fn resolve_and_order(cwd: &str, hashes: &[String]) -> Result<Vec<CombinedCommit>, String>` — full hashes in topological order (ancestors first).

- [ ] **Step 1: Write failing tests** — `validate_rejects_option_like_input` (`"--output=x"` → `Invalid commit hash: --output=x`), `validate_dedups_and_bounds` (`[a,a]` → `Select at least 2 commits.`, 51 distinct → `Select at most 50 commits.`), `version_floor` (`(2,37)` false, `(2,38)` true, `None` false), `order_is_topological_not_click_order` (linear A→B→C, input `[C,A]` → `[A,C]`), `order_across_branches` (base→X on branch1, base→Y on branch2 with Y committed earlier than X, plus X2 child of X: input `[X2,Y,X]` → Y,X,X2 or X,Y,X2 with X before X2 — assert ancestry only), `unknown_commit_errors` (valid-looking hash not in repo → `Unknown commit: <h>`).
- [ ] **Step 2: Run** `cd src-tauri && cargo test combined::` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Ordering algorithm (decided; tests do not pin it): resolve each hash with `rev-parse --verify --end-of-options <h>^{commit}`; then peel: `git merge-base --independent <remaining…>` returns the commits not reachable from any other remaining one (the "tips"); remove them, prepend them to the result sorted by committer date ascending (`git log --no-walk=unsorted --format=%H%x00%ct%x00%h%x00%s%x00%an%x00%aI <tips…>`), repeat until empty. ≤ 50 iterations, no full-history walk.
- [ ] **Step 4: Run** `cargo test combined::` — Expected: PASS.
- [ ] **Step 5: Commit** — `cargo fmt`, then `git commit -m "feat(combined): input validation, version guard and topological ordering"`.

### Task 2: Rust — replay engine, fallback, blockers, `git_combined_diff` command

**Files:**
- Create: `src-tauri/src/combined/replay.rs`, `src-tauri/src/commands/combined.rs`
- Modify: `src-tauri/src/commands/read.rs` (make `parse_multi_file_diff` `pub(crate)`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (register `commands::combined::git_combined_diff` in `invoke_handler`; add `pub fn git_combined_diff_parity(cwd: String, hashes: Vec<String>, paths: Option<Vec<String>>) -> Result<types::CombinedDiff, String>` in the "Parity probe re-exports" block, next to `git_show_parity`)
- Test: `#[cfg(test)]` in `src-tauri/src/combined/replay.rs`

**Interfaces:**
- Consumes: Task 1 (`validate_hashes`, `resolve_and_order`, `supports_combined_diff`, types).
- Produces: `#[tauri::command] pub(crate) async fn git_combined_diff(cwd: String, hashes: Vec<String>, paths: Option<Vec<String>>) -> Result<CombinedDiff, String>` (takes `repo_lock::read(&cwd)` like `git_show`); internally `pub(crate) fn combined_diff(cwd: &str, hashes: &[String], paths: Option<&[String]>) -> Result<CombinedDiff, String>`.

- [ ] **Step 1: Write failing tests** (real temp repos; helper builds commits from `(path, content)` lists):
  - `contiguous_equals_range_diff` — A,B consecutive: `diffs` equal `parse_multi_file_diff(git diff-tree -r -p -M A^ B)`; `fallback` empty; `steps.len() == 2`.
  - `non_contiguous_clean` — A edits `f`, B (unselected) edits `g`, C edits `f` elsewhere: `diffs` contain `f` with both edits and **no** `g`.
  - `overlap_falls_back_with_blocker` — spec example (A `x=1→2`, B `2→3`, C `3→4` + adds line `e`; select A,C): `f` absent from `diffs`, `fallback[0].path == "f"`, `per_commit` hashes `[A,C]`, `blockers == [B]`.
  - `conflict_between_selected_on_two_branches_has_no_blocker` — two branches edit the same line, select both tips: fallback with `blockers` empty.
  - `file_directory_conflict_never_leaks` — A modifies `f`; B (unselected) replaces `f` with dir `f/x`; C edits `f/x`; select A,C: no entry in `diffs` has path or oldPath `f`, `f/x` or starting with `f~`; `fallback` paths ⊆ {`f`, `f/x`} and each has ≥ 1 `per_commit`.
  - `root_commit_sha256` — `git init --object-format=sha256`, select root + a later commit: `base == None`, diff shows the files as added.
  - `merge_commit_uses_first_parent` — selecting a merge commit yields the same file set as `git_show` of it.
  - `paths_filter` — `Some(["f"])` restricts `diffs`, `steps` and `fallback` to `f`.
  - `rename_across_steps` — A renames `a.txt→b.txt`, C (non-contiguous) edits `b.txt`: one `diffs` entry `b.txt` with `status == "renamed"`, `oldPath == "a.txt"`.
  - `binary_file` — selection touching a binary file: entry present, no hunks, no error.
  - `hostile_config` — repo config `diff.noprefix=true`, `color.ui=always`, `diff.external=false`, `commit.gpgSign=true`, `gpg.program=false`: result identical to the same repo without that config.
  - `space_and_unicode_paths` — `dir with space/é.txt`: entry path equals what `git_show` returns for the same commit.
  - `large_file_is_truncated` — a selection producing a > 5 MB file diff returns that entry with `truncated_from_bytes` set and no hunks, like `git_diff` (P2.4 IPC rule: reuse `git_diff`'s 5 MB threshold constant/helper rather than a new one); `steps` entries for that file are dropped (no attribution).
  - `never_moves_refs_or_index` — record `HEAD`, `git status --porcelain`, `git for-each-ref` before/after: identical.
- [ ] **Step 2: Run** `cargo test combined::replay` — Expected: FAIL.
- [ ] **Step 3: Implement** per spec §5.2 (fast path, synthetic `P`/`B1`/`B2`, `merge-tree --write-tree --name-only -z`, exit 0/1/other, step diff `diff-tree -r -p -M -U0`, conservative fallback union, blockers `rev-list --max-count=5 Ci^ --not <base> <C1…Ci-1> -- <path>` skipped for root `Ci`, net diff filter that moves both paths of a touched rename pair into fallback, fallback artefacts without any selected-commit diff dropped). `paths` → appended after `--` with env `GIT_LITERAL_PATHSPECS=1`. Version check first: `!supports_combined_diff(git_version())` → spec error.
- [ ] **Step 4: Run** `cargo test combined::` and `cargo clippy --all-targets -- -D warnings` — Expected: PASS, no warnings.
- [ ] **Step 5: Commit** — `cargo fmt`, `git commit -m "feat(combined): git_combined_diff replay engine with per-file fallback"`.

### Task 3: Dev-server route, `backend.ts` wrapper, command registry, parity

**Files:**
- Modify: `dev-server.mjs` (route `POST /api/git-combined-diff`, JSON body `{cwd, hashes, paths?}`, read with the existing `readBody`), `src/utils/backend.ts`, `src/utils/commandRegistry.ts` (`git_combined_diff: { route: "/api/git-combined-diff" }`), `src-tauri/examples/parity_probe.rs` (arm `"git-combined-diff"`)
- Create: `tests/parity/git-combined-diff.test.mjs`
- Test: also `src/utils/__tests__/backend-combined.test.ts` (mapper only)

**Interfaces:**
- Consumes: Task 2 command and JSON shape.
- Produces (`backend.ts`): TS interfaces `CombinedCommit`, `CombinedFallbackFile` (`perCommit: { hash: string; diff: GitDiff }[]`), `CombinedDiff` exactly as spec §5.2; `export async function getCombinedDiff(cwd: string, hashes: string[], paths?: string[]): Promise<CombinedDiff>`. Extract the snake→camel `GitDiff` mapper currently inline in `getGitShow` into `function mapRawGitDiff(raw): GitDiff` and use it in both (no behaviour change for `getGitShow`).

- [ ] **Step 1: Write failing parity test** — three scenarios from Task 2 (`contiguous_equals_range_diff`, `non_contiguous_clean`, `overlap_falls_back_with_blocker`) built with `mkTempRepo`/`commitFile` from `fixtures.mjs`, each `assertParity(dev, { command: "git-combined-diff", args: {cwd, hashes}, httpPath: "/api/git-combined-diff", method: "POST", body: {cwd, hashes} })` (extend `assertParity` for POST if it only does GET; keep the GET path unchanged). Plus `backend-combined.test.ts`: `mapRawGitDiff` maps `old_start`→`oldStart`, `old_line_no`→`oldLineNo`, keeps `status`/`oldPath`.
- [ ] **Step 2: Run** `cargo build --example parity-probe && pnpm test:parity -- git-combined-diff` — Expected: FAIL (no arm/route).
- [ ] **Step 3: Implement** the route as a line-for-line mirror of Task 2's algorithm using `gitSpawn` (stdin needed for `hash-object --stdin`: add a small `gitSpawnInput(args, cwd, input)` next to `gitSpawn`), sections parsed exactly like `/api/git-show`. Same error strings as Rust, HTTP 400 for validation errors, 500 otherwise, `{ error }` body. The `backend.ts` dev branch throws `new Error(body.error)` so the view can show it.
- [ ] **Step 4: Run** `pnpm test:parity -- git-combined-diff`, `pnpm vitest run src/utils` (includes `commandRegistry.test.ts`) — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): dev-server route, backend wrapper and parity coverage"`.

### Task 4: Attribution (pure TS) and shared line keys

**Files:**
- Create: `src/utils/diffLineKey.ts`, `src/utils/combinedAttribution.ts`, `src/utils/__tests__/combinedAttribution.test.ts`
- Modify: `src/components/DiffViewer.vue` (import `lineKeyFor` from `diffLineKey.ts` instead of the private copy at :155; no behaviour change)

**Interfaces:**
- Consumes: `CombinedDiff`, `GitDiff`, `DiffLine` from `backend.ts`.
- Produces:
  - `diffLineKey.ts`: `export function lineKeyFor(line: DiffLine): string | null` (`LEFT:<oldLineNo>` for `delete`, `RIGHT:<newLineNo>` otherwise; `null` when the number is missing).
  - `combinedAttribution.ts`:
    ```ts
    export interface FileAttribution {
      lineCommit: Map<string, number>;   // lineKey → commit index (replay order)
      hunkCommits: number[][];           // per hunk: sorted unique commit indexes
      sectionCommit?: number;            // set on fallback sections: the whole section is this commit
    }
    export interface CombinedEntry { diff: GitDiff; attribution: FileAttribution; fallback?: { blockers: string[] } }
    export function buildCombinedEntries(c: CombinedDiff): CombinedEntry[]
    ```
    Order: net `diffs` first (their order), then for each fallback file its `perCommit` sections in replay order.

- [ ] **Step 1: Write failing tests** (hand-built `CombinedDiff` fixtures, no backend):
  - `attributes_added_lines_to_their_commit` — two steps adding lines in different places: each `RIGHT:n` maps to the right index.
  - `later_step_shifts_earlier_lines` — step 0 adds at line 10, step 1 inserts 3 lines at line 2: step-0 line is `RIGHT:13` → 0.
  - `deleted_base_line_attributed_to_deleter` — step 1 deletes base line 5: `LEFT:5` → 1.
  - `line_added_then_removed_has_no_marker` — step 0 adds, step 1 deletes it: net diff has no such line, no stray keys.
  - `rename_moves_the_model` — step 0 renames `a→b` (status `renamed`, `oldPath`), step 1 edits `b`: attributions on `b` correct.
  - `added_file_starts_empty` — status `added` resets model (no base lines).
  - `hunk_commits_are_union` — a net hunk containing lines of steps 0 and 2 → `[0, 2]`.
  - `unaligned_line_gets_no_marker` — net `+` line whose position holds a base origin → absent from `lineCommit` (never a wrong index).
  - `fallback_sections_are_whole_commit` — every line of `perCommit[j]` → index of `perCommit[j].hash` in `commits`; `sectionCommit` set.
  - `hunkless_file_is_ignored` — binary entry (no hunks): empty maps, no throw.
- [ ] **Step 2: Run** `pnpm vitest run src/utils/__tests__/combinedAttribution.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Algorithm (decided): per path, a segment list `Seg = {kind:"base", start:number, len:number} | {kind:"commit", idx:number, len:number}` ending with an implicit `{base, start:k, len:∞}` (none for a file whose step status is `added`). For each step i, for each file diff, apply its hunks **from the last hunk to the first** in old coordinates: remove `oldCount` lines at old index (`oldStart-1`, or `oldStart` when `oldCount == 0`), recording `deletedBy[baseLine] = i` for removed base lines, then insert `newCount` lines `{commit:i}` there. Rename: move the model (and `deletedBy`) from `oldPath` to `path` before applying. Final: for each net `+` line, look up origin at `newLineNo-1`; `commit` → set `RIGHT:n`; for each `-` line, `deletedBy[oldLineNo]` → set `LEFT:n`.
- [ ] **Step 4: Run** the test file and `pnpm vitest run src/components` (DiffViewer unchanged) — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): per-line attribution from replay steps"`.

### Task 5: `CommitDiffViewer` attribution rendering

**Files:**
- Modify: `src/components/CommitDiffViewer.vue`
- Create: `src/utils/commitColors.ts`
- Test: `src/components/__tests__/CommitDiffViewer.attribution.test.ts`

**Interfaces:**
- Consumes: `FileAttribution` (Task 4), `lineKeyFor` (Task 4).
- Produces:
  - `commitColors.ts`: `export function commitColor(idx: number): string` — returns `var(--combined-c<idx % 8>)`; the 8 CSS variables defined once in `CommitDiffViewer.vue`'s style for light and dark (contrast ≥ 3:1 against the diff background in both themes — reuse lane colors if they pass).
  - New optional props on `CommitDiffViewer`: `attribution?: FileAttribution[]` (aligned with `diffs`), `attributionCommits?: { hash: string; shortHash: string; subject: string }[]`, `fileNotes?: (string | null)[]`. New emit `jump-to-commit: [hash: string]`.

- [ ] **Step 1: Write failing tests** (mount with `@vue/test-utils`, two diffs): without the new props the rendered HTML equals the current snapshot (no regression); with them, an attributed `+` line has an element `.cdv-attr-marker` whose style uses `var(--combined-c1)` and `title` containing the commit's short hash + subject; each hunk header shows one `.cdv-attr-chip` per index of `hunkCommits`; clicking a chip emits `jump-to-commit` with the full hash; a `sectionCommit` file header shows that commit's chip; `fileNotes[i]` renders as a banner under file i's header; side-by-side mode puts the marker in `td.cdv-sbs-gutter`.
- [ ] **Step 2: Run** the test — Expected: FAIL.
- [ ] **Step 3: Implement.** Inline mode: a 3px-wide marker cell before `td.cdv-line-marker`, only rendered when `attribution` is set (column count unchanged otherwise). Chips are `<button>`s (keyboard reachable, `aria-label` from i18n `combined.jumpToCommit` with `{hash}`).
- [ ] **Step 4: Run** test + `pnpm vitest run src/components` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): attribution markers and hunk chips in CommitDiffViewer"`.

### Task 6: Git Tree multi-selection

**Files:**
- Create: `src/composables/useCommitSelection.ts`, `src/composables/__tests__/useCommitSelection.test.ts`
- Modify: `src/components/CommitGraph.vue` (row click handlers at :1670, :1742, :1852; context menu template ~:1953 and `CommitEvent` union :66 / `defineEmits` :92; key handling), locales.

**Interfaces:**
- Produces (`useCommitSelection.ts`, module-scoped state keyed by repo path so it survives `CommitGraph` unmounting while the combined view is open):
  ```ts
  export function useCommitSelection(repoPath: Ref<string>): {
    selected: ComputedRef<string[]>;            // in graph row order
    anchor: ComputedRef<string | null>;
    toggle(hash: string, current: string | null): void;  // first toggle seeds with `current`
    range(hash: string, visibleOrder: string[]): void;   // anchor..hash inclusive, in visibleOrder
    clear(): void;
    canCombine: ComputedRef<boolean>;           // 2..50
  }
  export const COMBINE_MAX = 50;
  ```
- Produces (`CommitGraph`): emit `open-combined: [hashes: string[]]`. WIP and stash rows are never added (they keep their current click behaviour).

- [ ] **Step 1: Write failing tests** — composable: `toggle` seeds with current and toggles off; `range` respects `visibleOrder` and skips hashes not in it; `clear`; `canCombine` false at 1 and 51; state kept across two `useCommitSelection` calls for the same path and isolated between paths. Component (`CommitGraph` mount with a 5-row log fixture): `⌘`-click (metaKey on mac UA, ctrlKey otherwise) does **not** emit `select-commit`; chip appears at 2 with text from `combined.chip` and its button emits `open-combined` with row-ordered hashes; `Esc` clears; context menu on a multi-selected row shows `combined.ctxOpen` first; plain click resets to single and emits `select-commit` as before.
- [ ] **Step 2: Run** `pnpm vitest run src/composables/__tests__/useCommitSelection.test.ts src/components/__tests__/CommitGraph*` — Expected: FAIL.
- [ ] **Step 3: Implement.** Platform modifier: `navigator.userAgent` mac test like `backend.ts:4709`, extracted to a tiny exported helper if one does not exist. Chip pinned bottom of the graph; disabled with `combined.tooMany` (`{max}`) above 50. `Enter` with `canCombine` → `open-combined`. Multi-selected rows get `cg-row--multi` (distinct from `cg-row--selected`). Strings: `combined.chip` ("{n} commits selected"), `combined.open` ("Combined diff"), `combined.ctxOpen` ("Combined diff of {n} commits"), `combined.clear`, `combined.tooMany` — in all 5 locales.
- [ ] **Step 4: Run** tests — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): multi-select commits in the Git Tree"`.

### Task 7: `CombinedDiffView` and App wiring

**Files:**
- Create: `src/composables/useCombinedDiff.ts`, `src/components/CombinedDiffView.vue`, tests `src/composables/__tests__/useCombinedDiff.test.ts`, `src/components/__tests__/CombinedDiffView.test.ts`
- Modify: `src/App.vue` (async import next to `CommitDiffViewer` at :34; a `combinedRequest` ref; a `v-else-if` branch before the `graph-diff-full` one at ~:5159; listener `@open-combined` on `CommitGraph`), locales.

**Interfaces:**
- Consumes: `getCombinedDiff` (Task 3), `buildCombinedEntries` (Task 4), `CommitDiffViewer` props (Task 5), `open-combined` (Task 6).
- Produces:
  - `export interface CombinedRequest { hashes: string[]; paths?: string[] }`
  - `useCombinedDiff(cwd: Ref<string>, request: Ref<CombinedRequest | null>, fetcher: typeof getCombinedDiff = getCombinedDiff)` (the fetcher parameter lets tests inject a fake instead of mocking `backend.ts` — `apps/desktop/CLAUDE.md`: do not mock Tauri commands) → `{ data: Ref<CombinedDiff | null>; entries: ComputedRef<CombinedEntry[]>; loading: Ref<boolean>; error: Ref<string | null>; reload(): void }` — ignores stale responses (request changed while loading).
  - `CombinedDiffView` props `{ cwd: string; request: CombinedRequest; diffMode }`; emits `close`, `select-commit: [hash]`, `update:diffMode`.
- App: `combinedRequest: Ref<CombinedRequest | null>`; `@open-combined="h => combinedRequest = { hashes: h }"`; view `@close` → `null`; `@select-commit` → `combinedRequest = null; onGraphSelectCommit(hash)`. Opening also sets `graphFileIdx = null`.

- [ ] **Step 1: Write failing tests** — composable with an injected fake `fetcher` (no `vi.mock` of `backend.ts`; the git layer itself is covered by Tasks 2–3): loading → data; error string surfaced verbatim (`Unknown commit: abc1234`); stale response discarded. View: header renders one chip per commit (short hash + subject) in replay order, clicking emits `select-commit`; fallback banner text from `combined.fallbackBlocked` (`{files}`, `{commits}`) when blockers exist, `combined.fallbackBetween` when blockers are empty; `paths` → `combined.limitedTo` chip; error state renders the message and a retry; empty-diff state `combined.empty`; `Esc` emits `close`; it contains its own file list (click scrolls `CommitDiffViewer` via `scroll-to-file-idx`).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `fileNotes` for the first section of each fallback file = the banner text for that file. App.vue: keep the diff to the import, one ref, one template branch, one listener (bundle).
- [ ] **Step 4: Run** tests, then `pnpm --filter @gitwand/core build && pnpm vue-tsc --noEmit -p tsconfig.json` — Expected: PASS, 0 type errors.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): combined diff view in the Git Tree"`.

### Task 8: AI summary

**Files:**
- Modify: `src/composables/usePrSummary.ts` (factor counting: `export function buildSummaryPromptFromCounts(files: { path: string; added: number; deleted: number }[], commitTitles: string[]): string`; `buildSummaryPrompt` delegates to it — existing tests unchanged)
- Create: `src/composables/useCombinedSummary.ts`, `src/composables/__tests__/useCombinedSummary.test.ts`
- Modify: `src/components/CombinedDiffView.vue`, locales.

**Interfaces:**
- Produces: `useCombinedSummary(rawPrompt = useAIProvider().rawPrompt)` (injectable for tests) → `{ available: ComputedRef<boolean>; summary: Ref<string | null>; loading: Ref<boolean>; error: Ref<string | null>; generate(c: CombinedDiff, locale: string): Promise<void> }`, using `useAIProvider().rawPrompt(system, user)`; system prompt = "N commits taken together" variant (same structure and language handling as `buildSystemPrompt` in `usePrSummary.ts`, defined in `useCombinedSummary.ts`); user prompt = `buildSummaryPromptFromCounts(counts from c.diffs + fallback per-commit diffs, c.commits.map(c => c.subject))`.

- [ ] **Step 1: Write failing tests** — `buildSummaryPromptFromCounts` output equals `buildSummaryPrompt` for equivalent raw input (regression); user prompt contains every commit subject and `path (+a/-d)`, and **no hunk content** (assert a distinctive added line's text is absent); `generate` sets `error` on provider failure; `available` mirrors `isAvailable`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; view: button `combined.summarize` (`{n}`) shown only when `available`, result block under the header, `combined.summaryError` on failure.
- [ ] **Step 4: Run** `pnpm vitest run src/composables` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): AI summary of the combined commits"`.

### Task 9: File history entry point

**Files:**
- Modify: `src/components/FileHistoryViewer.vue` (log tab), `src/App.vue` (listener), locales
- Test: `src/components/__tests__/FileHistoryViewer.combined.test.ts`

**Interfaces:**
- Consumes: `useCommitSelection` (keyed by `repoPath + "::file:" + filePath`, so it does not mix with the graph selection), `CombinedRequest` (Task 7).
- Produces: emit `open-combined: [req: CombinedRequest]` with `paths` = unique paths of the selected log entries (each entry's path at that commit; renames included). App: close the panel, `onViewModeChange("graph")`, `combinedRequest = req`.

- [ ] **Step 1: Write failing tests** — `⌘`-click two log entries shows `combined.historyButton` (`{n}`); click emits `open-combined` with both hashes and the union of their paths (fixture with a rename); plain click keeps today's `select-commit` behaviour; compare tab unchanged.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(combined): combine versions from a file's history"`.

### Task 10: Docs, bundle, full verification

**Files:**
- Modify: `ROADMAP.md` (v3.15.0 section: replace "conflict-free since same-history" by the net-with-fallback behaviour; add "PR review entry point (subset of a PR's commits) — follow-up: needs a PR commit list per forge and a fetch of `pull/N/head`"), `CHANGELOG.md` (`[Unreleased]` → `### Added` entry), possibly `perf/bundle-check.mjs`.

- [ ] **Step 1:** `pnpm build` at repo root, then `node apps/desktop/perf/bundle-check.mjs` — Expected: PASS. If main > 980 KB only from this feature's strings/wiring, raise `main_max_kb` by the measured overshoot rounded up (≤ 8 KB) with a comment `// v3.15 combined diffs: main measured at N KB (en strings + wiring)`; otherwise move code to async chunks until it passes.
- [ ] **Step 2:** Full suites — `pnpm -r run test`, `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`, `cd apps/desktop && cargo build --manifest-path src-tauri/Cargo.toml --example parity-probe && pnpm test:parity`, `pnpm vue-tsc --noEmit -p tsconfig.json`. Expected: all green (note any parity test that needs the keychain approval, as in v3.14).
- [ ] **Step 3:** Edit ROADMAP/CHANGELOG as above; commit `docs: combined diffs in ROADMAP and CHANGELOG`.
