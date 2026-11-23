# Stacked Branches (v3.14.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitWand knows which branch a branch is stacked on, notices when the parent moves (moment 1) or is merged, squash included (moment 2), previews the conflicts, and restacks the whole stack above in one click. After moment 2 it retargets the child's GitHub PR, then offers to push the moved layers and to delete the merged local branch.

**Architecture:** A new Rust module `src-tauri/src/stack/` holds plain functions over a repo path: metadata in local git config, detection, plan, run and finalize. It only runs git. Thin Tauri commands live in `commands/stack.rs`, plus two GitHub commands in `gh.rs`. Forge signals reach detection as *hints* passed in by the frontend, so detection stays pure git and gets parity coverage. In the frontend, `useStacks.ts` (a module-level store built by `createStacks(deps)`) orchestrates refresh, the bridge from GitHub, the restack flow and the post-success offers. The preview and the apply reuse `useMergePreview` / `MergePreviewPanel` / `useApplyFromPreview` (v3.11). A halted restack is handed to the existing `RebaseProgressBanner`.

**Tech Stack:** Rust (Tauri 2 commands, git CLI through `git_cmd()`), Vue 3 `<script setup>`, TypeScript, Vitest, the Node dev-server mirror (`dev-server.mjs` + a new `dev-stack-service.mjs`) and the parity harness (`tests/parity/`).

**Spec:** docs/superpowers/specs/2026-11-23-stacked-branches-design.md

## Global Constraints

- git arguments go in arrays (`.args([...])` / `.arg()`, `spawnSync(GIT, [...])`) and are never interpolated into a shell string (AGENTS.md § Security).
- Any branch name or ref from the frontend that starts with `-` is refused before git runs. Error text: `invalid branch name: <name>` (refs: `invalid ref: <ref>`).
- Every new `#[tauri::command]` ships in the same task with its typed wrapper (`backend.ts`, or `backend-pr.ts` for `gh_*`), its `commandRegistry.ts` entry and its `dev-server.mjs` route. Deterministic commands also get parity coverage (`tests/parity/` + the `command_parity` dispatch in `lib.rs:324`).
- Never call `invoke()` from a component or composable. Invoke with a string literal.
- Every user-visible string gets a key in all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) under `apps/desktop/src/locales/`, synced with the `i18n-sync` skill.
- Tests run on real temp git repos (Rust: `crate::worktree::test_support::TempRepo`; parity: `tests/parity/fixtures.mjs`). The git layer is never mocked. Composable tests inject fakes for the IPC deps, the same way `useWorktreeMergeBack.test.ts` does.
- Before every Rust commit: `cargo fmt`, and `cargo clippy --all-targets -- -D warnings` must pass (CI runs `cargo fmt --check` and clippy `-D warnings`).
- New components use Composition API `<script setup>`. Business logic lives in composables, and components only render and forward intents.
- Panels and dialogs mounted behind a `v-if` are lazy-loaded with `defineAsyncComponent`.
- A new settings field goes into both `useSettings.ts` (`AppSettings`) and `SettingsPanel.vue` (`Settings`) in the same commit.
- Never edit a version field (`package.json`, `Cargo.toml`, `tauri.conf.json`). Versions change only through `./scripts/bump-version.sh` at release time.
- No new polling. Refresh is driven by existing events only (Decision D14).
- Every command a frontend wrapper calls has a dev-server route, so `pnpm dev:web` tests what ships.

## Review Focus

The five failure modes most likely to hit a user that no task's happy-path tests would otherwise exercise, most likely first:

1. **A non-stack branch inside the rebased range** (an AI-task branch, a `backup/…` branch pointing at a commit of `step-2`). `--update-refs` silently moves it too, which breaks the anti-goal "rewrites a branch the user did not see".
2. **A layer that is *being rebased* (not just checked out) in another worktree, or a pending record seen from another worktree.** `git worktree list --porcelain` shows such a worktree as `detached`. A naive check therefore lets `--update-refs` skip the layer, or clears a pending record whose rebase is still running.
3. **Branch names with dots, slashes or capitals** (`release/1.2`, `Feat/Step.2`). `git config --get-regexp` lowercases the variable name but keeps the subsection, and the name itself contains dots. Splitting the key on the wrong dot loses the stack.
4. **A parent with no commits of its own yet** (`step-1` just created at `main`'s tip). The git fallback can mistake it for "merged", and a restack then silently unstacks `step-2`.
5. **Local trunk behind `origin/<trunk>` after a squash, with a failed fetch.** A stale `origin/main` lacks the squash commit, so the moment-2 restack "succeeds" without step 1's work.

Pinning tests:
- (1) Task 4, `plan_lists_a_non_stack_branch_inside_the_range` + `plan_refuses_when_a_non_stack_branch_in_range_is_checked_out_elsewhere`.
- (2) Task 2, `holders_report_a_branch_being_rebased_in_a_linked_worktree`; Task 5, `status_waits_while_top_is_rebasing_in_another_worktree`.
- (3) Task 1, `read_all_round_trips_dotted_slashed_and_capitalised_names`.
- (4) Task 3, `a_parent_without_commits_of_its_own_is_not_merged`.
- (5) Task 11, `moment_two_is_refused_when_the_fetch_fails`; Task 5, `moment_two_lands_the_squash_while_local_main_stays_behind`.

---

## Decisions (spec §6 and gaps the code revealed)

- **D1 — Sibling commands, not extensions** (§6). `git_rebase_onto` and `preview_rebase` keep their v3.11 contract and their parity tests untouched. New commands: `git_restack`, `preview_restack`, `stack_status`, `stack_set_parent`, `stack_unset`, `stack_restack_plan`, `git_push_branch`, `gh_branch_pr`, `gh_pr_set_base`. The replay core of `preview_rebase` (`read.rs:1971`) is extracted into `replay_preview()` and shared, so both previews stay byte-identical by construction.
- **D2 — git < 2.38: refuse, do not loop** (§4, §6). `stack_restack_plan` returns refusal `git_too_old`, which names the version found. Detection, badges and the banner keep working, and the banner's Preview button shows the refusal. Why: a bottom-up `--onto` loop that halts on layer 1 of 3 needs a multi-step resumable state machine. The single pending record (§5.4) cannot express that, and a half-finished loop is exactly the anti-goal "leaves one layer behind while reporting success". git 2.38 shipped in October 2022.
- **D3 — Config key `gitwandStackBase`, not `gitwandBase`.** The spec's name is already taken (see "Spec vs code" C1). The metadata keys are `branch.<b>.gitwandParent`, `branch.<b>.gitwandStackBase` and `branch.<top>.gitwandRestack`.
- **D4 — Pending record format.** `branch.<top>.gitwandRestack = "<moment> <onto-sha> <old-base-sha> <bottom> <new-parent|-> <original-branch>"`. `<moment>` is `parent_moved` or `parent_merged`. Branch names cannot contain spaces, so splitting on whitespace is exact. A record that fails to parse is cleared on the next refresh.
- **D5 — One finalization path.** `git_restack` never finalizes, even on a clean run. It writes the record, runs the rebase and returns `{ conflict }`. All finalization happens in `stack_status` (metadata, clearing the record, switching back to the original branch), whether the rebase ended at once, through the apply loop or through the banner. This is what makes a halted restack "end exactly like an uninterrupted one" (§5.4).
- **D6 — Forge signals are hints.** The frontend looks up merged PRs (`gh_branch_pr(cwd, parent, "merged")`, GitHub only, cached 60 s per repo+parent, failures ignored) and passes `MergedParentHint[]` to `stack_status` / `stack_restack_plan` / `git_restack`. Rust detection never touches the network.
- **D7 — The git "merged" fallback is two signals** (§5.3). (a) *cherry*: `git cherry <remote-trunk> <base>` prints at least one line and every line starts with `-`. (b) *merge commit*: `<base>` is an ancestor of `<remote-trunk>`, and the oldest merge on `git rev-list --merges --ancestry-path --reverse <base>..<remote-trunk>` has a first parent that does **not** contain `<base>`. `git cherry` alone prints nothing for a merge commit (C4), and (b) without the first-parent test misreads an empty parent as merged (Review Focus 4). A fast-forward merge of the parent is not detected; Unstack remains the way out.
- **D8 — Moment 2 below a non-trunk grandparent.** When the merged parent `P` is itself stacked on `P'` ≠ trunk, onto = local `P'`. As in moment 1, `P'` must not be behind its upstream (refusal `parent_behind`). When `P'` is the trunk, onto = `refs/remotes/origin/<trunk>`, as the spec says.
- **D9 — Trunk.** `resolve_default_branch_strict(cwd, configured)` is a new function. It runs steps 1–3 of `resolve_default_branch` (`git/cmd.rs:540`): the Settings default branch, `origin/HEAD`, `main`/`master`/`origin/main`/`origin/master`, with any `origin/` prefix stripped. It does **not** fall back to the current branch: a stacked branch must never be taken for the trunk. With no trunk, the report has `trunk: null` and no layer is classified. The remote trunk is `refs/remotes/origin/<trunk>` when it exists.
- **D10 — Pushing a layer that is not checked out.** `gitPush` only pushes `HEAD` (C2), so a new command `git_push_branch(cwd, branch, lease_sha)` runs `git push --force-with-lease=refs/heads/<remote-branch>:<sha> <remote> refs/heads/<branch>:refs/heads/<remote-branch>`, reusing `force_with_lease_arg` (`ops.rs:428`) and `repo_lock::push`. The leases are the `remote_sha` values of the plan, read **before** the restack. They are kept in memory. If the app restarted mid-restack, the finalized restack offers no push and says why (`stacks.push.noLeases`).
- **D11 — Retarget transport.** `gh_pr_set_base(cwd, number, base)` PATCHes `{"base": base}` through the REST path when a token is set (`rest_pr_set_base`). Otherwise it uses the existing `gh api PATCH repos/<nwo>/pulls/<n> -f base=<base>` fallback, the same one `gh_pr_edit_inner` uses (`gh.rs:856`), instead of `gh pr edit --base` (C6). The `gh api` path keeps the fork-parent repo resolution `gh_base_nwo` already does (#298). The child's open PR is found with `gh_branch_pr(cwd, child, "open")`.
- **D12 — UI placement** (§6). Badges and bridge chips go in the RepoSidebar dashboard branch list (`RepoSidebar.vue:1887`) and in the header BranchSelector's local list (`BranchSelector.vue:805`, which already shows `#PR`). The context-menu items are added to RepoSidebar's branch menu (`RepoSidebar.vue:1956`). The banner (`StackBanner.vue`) sits right above `.commit-panel` (`RepoSidebar.vue:1545`). `RestackDialog.vue` is mounted lazily in `App.vue`, and `StackOnDialog.vue` lazily in RepoSidebar. The "non-GitHub empty state" note goes in `StackOnDialog` (the only place shown before any detection), because the Stacks tab is deferred.
- **D13 — Bridge dismissals** are persisted in `AppSettings.stackBridgeDismissals: Record<string, string[]>` (keyed by `normaliseCwd(cwd)`), the same pattern as `branchUpdatePromptSkips` (`useSettings.ts:310`). Both interfaces are updated, with no Settings UI.
- **D14 — Refresh triggers.** The existing watcher `["head","refs"]` events (`App.vue:4443`), a change of the PR list (`prPanel.prs`), repo open (`repoFolderPath`), the operation state going from a rebase to `clean`, which covers the watcher being disabled, and after GitWand's own stack actions. `useStacks.refresh` coalesces calls (one in flight, one queued).
- **D15 — Dirty** means tracked changes: `git status --porcelain --untracked-files=no` is non-empty. That is git rebase's own rule (C5).
- **D16 — Detached HEAD** is refused (`detached`), because there is no branch to return to.
- **D17 — A fifth state, `base_lost`.** The parent tip is not an ancestor of the layer, and `gitwandStackBase` is missing or not an ancestor either, for example after the user rebased the layer elsewhere by hand. The spec's "otherwise up to date" would report a lie. No restack is offered. The banner says "Stack it again" (which resets the base to the merge-base) or Unstack. **Open decision for the checkpoint.**
- **D18 — Fetch** runs through the existing `gitFetch` before the plan. When it fails, moment 2 is refused (`fetch_failed`, Review Focus 5) and moment 1 proceeds with a warning, since it only needs local refs.
- **D19 — Retarget is automatic** after a moment-2 finalization on GitHub, before the push offer, as §5.4 says ("Retarget the child's open GitHub PR"). It is a forge edit, not a push.
- **D20 — The moment-2 old tip must exist locally.** `gitwandStackBase`, or failing that the hint's `head_ref_oid`, is checked with `git cat-file -e <sha>^{commit}`. When neither exists, the refusal is `no_old_base`.
- **D21 — Moving refs** = every local branch whose tip is in `rev-list <upstream>..<top>` (top included), stack layer or not, which is what `--update-refs` moves. The worktree refusal covers all of them (Review Focus 1).

## Spec vs code (contradictions found)

- **C1** — `branch.<b>.gitwandBase` is already written by the v3.13 worktree service (`worktree/create.rs:238`, `worktree/restore.rs:118`, `commands/scratch.rs:135` "the commit a task's branch was created from") and read by `worktree/guard.rs:117-130` (`legacy_owned`). Reusing it would make any worktree holding a stacked branch look GitWand-owned to the removal service. It would also make self-healing overwrite a task's recorded base. Hence D3.
- **C2** — §5.4 says `gitPush(…, force, lease)` "already supports" pushing each moved layer. It pushes the current branch only (`ops.rs:451`, `git push [--force-with-lease=…]`, no refspec). Hence D10.
- **C3** — §5.1 says the trunk is "the one GitWand already resolves for PR creation". PR creation uses a frontend heuristic (`PrCreateView.vue:152`, first of main/master/develop/dev). The backend resolver `resolve_default_branch` falls back to the *current branch*, which would make the stacked branch the trunk. Hence D9.
- **C4** — §5.3 says the `git cherry` fallback "catches merge commits". It prints nothing for a merge-commit merge (verified on git 2.54). Hence D7(b).
- **C5** — §4 says "refuse when the tree is dirty, exactly like the existing rebase entry points do". No existing entry point refuses explicitly: `git_rebase_onto` (`ops.rs:1048`) relies on git's own refusal, and `useApplyFromPreview` only checks the operation state. Hence D15.
- **C6** — `gh pr edit --base` is not how GitWand edits PRs on the `gh` transport. It uses `gh api PATCH` (`gh.rs:856`). Hence D11.
- **C7** — The sidebar branch list (`RepoSidebar.vue:930`, `pinnedBranches`) shows only the current branch and pinned branches (or the top 4 by activity), so a non-pinned stacked branch is not there. The badges are therefore also added to the header BranchSelector's full local list (D12).
- **C8** — ROADMAP v3.14 asks for a `Channel`-streamed "cascading restack" progress. With `--update-refs` the restack is one `git rebase`, so there is nothing to stream. The ROADMAP update in Task 14 drops that line.

---

## File Structure

**Rust (`apps/desktop/src-tauri/src/`)**
- `stack/mod.rs` (create): module doc, shared types (`Moment`, `LayerState`, `MergeSignal`, `StackMeta`, `PendingRestack`, `MergedParentHint`, `LayerStatus`, `FinalizedRestack`, `StackReport`, `MovingRef`, `RestackRefusal`, `RestackPlan`, `PreviewedRestack`, `RestackRun`).
- `stack/meta.rs` (create): metadata in local git config: read all, declare (with linear/cycle/trunk refusals), unstack, set base, and write, parse or clear the pending record.
- `stack/guard.rs` (create): git version parsing and branch holders (checked out or being rebased, per worktree).
- `stack/detect.rs` (create): trunk/remote trunk, layer classification, propagation, self-healing, pending-record outcome. Entry point `status()`.
- `stack/restack.rs` (create): `plan()`, `run()`, `finalize()`.
- `commands/stack.rs` (create): Tauri commands `stack_status`, `stack_set_parent`, `stack_unset`, `stack_restack_plan`, `git_restack`.
- `commands/mod.rs` (modify): `pub(crate) mod stack;`.
- `lib.rs` (modify): `pub(crate) mod stack;` next to `pub(crate) mod worktree;` (line 6), the `generate_handler!` entries (around lines 840/874/924), and `command_parity` arms (line 324).
- `git/cmd.rs` (modify): `resolve_default_branch_strict()`, with `resolve_default_branch()` delegating to it (line 540).
- `commands/ops.rs` (modify): `git_push_branch` command; `list_worktrees` (line 2756) made `pub(crate)`.
- `commands/read.rs` (modify): `replay_preview()` extracted from `preview_rebase` (line 1971); new `preview_restack` command.
- `commands/gh.rs` (modify): `gh_branch_pr`, `gh_pr_set_base` (+ `_inner` fns and the gh-JSON parser).
- `commands/github_api.rs` (modify): `rest_branch_pr`, `rest_pr_set_base`, `branch_pr_from_rest_json`.
- `types.rs` (modify): `BranchPr`.

**Dev server and parity (`apps/desktop/`)**
- `dev-stack-service.mjs` (create): Node mirror of `stack/` (same rules, same error strings).
- `dev-server.mjs` (modify): routes `/api/stack-status`, `/api/stack-set-parent`, `/api/stack-unset`, `/api/stack-restack-plan`, `/api/git-restack`, `/api/preview-restack` (via the extracted `devReplayPreview`), `/api/git-push-branch`, `/api/gh-branch-pr`, `/api/gh-pr-set-base`.
- `tests/parity/fixtures.mjs` (modify): `fixtureStack(kind)`.
- `tests/parity/stack.test.mjs` (create): parity for status, set-parent refusals, plan, preview, restack.

**Frontend (`apps/desktop/src/`)**
- `utils/backend.ts` (modify): stack types and wrappers, `previewRestack`, `gitRestack`, `gitPushBranch`.
- `utils/backend-pr.ts` (modify): `BranchPr`, `ghBranchPr`, `ghPrSetBase`.
- `utils/commandRegistry.ts` (modify): 9 entries.
- `composables/useMergePreview.ts` (modify): `computeRestackPreview()`.
- `composables/useApplyFromPreview.ts` (modify): `ApplyOptions.runRebase`.
- `composables/useSettings.ts`, `components/SettingsPanel.vue` (modify): `stackBridgeDismissals`.
- `composables/useStacks.ts` (create): store, detection orchestration, bridge, restack flow, post-success offers, host registration.
- `components/MergePreviewPanel.vue` (modify): `movingRefs` prop rendered above the files.
- `components/StackBadge.vue` (create): `↳ parent`, state, Restack button, bridge chip (presentational).
- `components/StackOnDialog.vue` (create): pick a parent.
- `components/StackBanner.vue` (create): banner above the commit area, plus the post-success offers.
- `components/RestackDialog.vue` (create): fetch → plan → preview → apply phases.
- `components/RepoSidebar.vue`, `components/header/BranchSelector.vue`, `App.vue` (modify): wiring.
- `locales/{en,fr,es,pt-BR,zh-CN}.ts` (modify): `stacks.*` keys.
- Tests: `composables/__tests__/useStacks.test.ts` (create), `composables/__tests__/useApplyFromPreview.test.ts` (modify), `composables/__tests__/useMergePreview-restack.test.ts` (create).

**Docs**
- `CHANGELOG.md` (`[Unreleased]`), `ROADMAP.md` (v3.14 scope + new v3.18.0 section).

---

## Shared Rust types (Task 1 creates them; every later task uses these exact names)

```rust
// stack/mod.rs — all Serialize; snake_case on the wire (MergeBackCheck precedent).
#[serde(rename_all = "snake_case")] pub enum Moment { ParentMoved, ParentMerged }           // Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug
#[serde(rename_all = "snake_case")] pub enum LayerState { UpToDate, OutOfDate, ParentMerged, ParentMissing, BaseLost }
#[serde(rename_all = "snake_case")] pub enum MergeSignal { Forge, Cherry, MergeCommit }
pub struct StackMeta { pub branch: String, pub parent: String, pub base: Option<String>, pub pending: Option<PendingRestack> }
pub struct PendingRestack { pub moment: Moment, pub onto: String, pub old_base: String, pub bottom: String, pub new_parent: Option<String>, pub original: String }
#[derive(Deserialize)] pub struct MergedParentHint { pub branch: String, pub number: i64, pub head_ref_oid: Option<String> }
pub struct LayerStatus { pub branch: String, pub parent: String, pub base: Option<String>, pub parent_tip: Option<String>,
    pub state: LayerState, pub inherited: bool, pub actionable: bool, pub merge_signal: Option<MergeSignal>,
    pub merged_pr: Option<i64>, pub parent_behind_upstream: u32, pub top: String }
pub struct FinalizedRestack { pub moment: Moment, pub bottom: String, pub merged_parent: Option<String>, pub new_parent: Option<String>,
    pub moved: Vec<String>, pub switched_back_to: Option<String>, pub switch_error: Option<String> }
pub struct StackReport { pub trunk: Option<String>, pub remote_trunk: Option<String>, pub layers: Vec<LayerStatus>,
    pub rebase_in_progress: bool, pub finalized: Option<FinalizedRestack>, pub git_supports_restack: bool }
pub struct MovingRef { pub branch: String, pub in_stack: bool, pub upstream: Option<String>, pub remote_sha: Option<String> }
pub struct RestackRefusal { pub code: String, pub message: String, pub branch: Option<String>, pub path: Option<String> }
pub struct RestackPlan { pub moment: Moment, pub bottom: String, pub parent: String, pub onto_ref: String, pub onto_sha: String,
    pub upstream_sha: String, pub top: String, pub top_sha: String, pub moving: Vec<MovingRef>,
    pub new_parent: Option<String>, pub refusal: Option<RestackRefusal> }
#[derive(Deserialize)] pub struct PreviewedRestack { pub onto_sha: String, pub upstream_sha: String, pub top_sha: String, pub moving: Vec<String> }
pub struct RestackRun { pub conflict: bool }
```

Refusal codes (exact strings, in check order): `rebase_in_progress`, `up_to_date`, `git_too_old`, `detached`, `dirty`, `occupied`, `parent_behind`, `no_remote_trunk`, `no_old_base`. The frontend adds `fetch_failed` and `stale_preview` (the latter mapped from the `git_restack` error that starts with `stale preview:`).

Nested struct fields stay snake_case over IPC (Tauri renames only top-level argument names). TS therefore sends `{ onto_sha, … }` inside `previewed` and `{ branch, number, head_ref_oid }` inside `mergedParents`.

---

## Task 1 — Rust: stack metadata in git config, trunk resolution

**Files:**
- Create: `apps/desktop/src-tauri/src/stack/mod.rs`, `apps/desktop/src-tauri/src/stack/meta.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (line 6: `pub(crate) mod stack;`), `apps/desktop/src-tauri/src/git/cmd.rs` (line 540)
- Test: `#[cfg(test)] mod tests` in `stack/meta.rs`, using `crate::worktree::test_support::{TempRepo, git_at}`; `git/cmd.rs` existing `resolve_default_branch` tests.

**Interfaces:**
- Consumes: `crate::git::git_cmd()`, `TempRepo::{new, commit, git, add_bare_origin}`.
- Produces:
  - `pub(crate) fn resolve_default_branch_strict(cwd: &str, configured: Option<&str>) -> Option<String>` (git/cmd.rs). `resolve_default_branch` becomes `strict(...).unwrap_or_else(current-branch fallback)`.
  - `pub(crate) fn validate_branch_name(name: &str) -> Result<(), String>`. Refuses empty or a leading `-` with `invalid branch name: <name>`; otherwise `git check-ref-format --branch <name>` must succeed.
  - `pub(crate) fn read_all(repo: &Path) -> Result<BTreeMap<String, StackMeta>, String>`. Reads `git config --local --get-regexp ^branch\..*\.gitwand(parent|stackbase|restack)$`, splitting each key as `branch.` + `<name>` + `.` + `<var>` on the **last** dot, and each line on the first space.
  - `pub(crate) fn set_parent(repo: &Path, trunk: Option<&str>, layer: &str, parent: &str) -> Result<StackMeta, String>`. Writes `gitwandParent` and `gitwandStackBase = merge-base(layer, parent)`.
  - `pub(crate) fn unset(repo: &Path, layer: &str) -> Result<(), String>`. Runs `git config --unset` on the three keys, treating exit 5 (not set) as success.
  - `pub(crate) fn set_base(repo: &Path, layer: &str, sha: &str) -> Result<(), String>`
  - `pub(crate) fn set_pending(repo: &Path, top: &str, p: &PendingRestack) -> Result<(), String>`, `pub(crate) fn clear_pending(repo: &Path, top: &str) -> Result<(), String>`
  - `impl PendingRestack { pub fn to_config(&self) -> String; pub fn parse(s: &str) -> Option<Self> }` (format D4).
  - `pub(crate) fn trunk(repo: &Path, configured: Option<&str>) -> Option<String>`, which is `resolve_default_branch_strict` with `origin/` stripped.

Error strings (exact; the Node mirror reproduces them):
`Unknown local branch: <b>` · `A branch cannot be stacked on itself.` · `<b> is the trunk and cannot be stacked.` · `<b> is the trunk: stacking on it is not a stack. Use Unstack instead.` · `<parent> already has a stacked branch (<child>). Stacks are linear for now: stack on <child> instead.` · `Stacking <layer> on <parent> would create a cycle.`

- [ ] **Step 1: Write failing tests** (`stack/meta.rs`):

```rust
#[test] fn set_parent_records_parent_and_merge_base() {
    let r = TempRepo::new(); r.git(&["checkout","-q","-b","step-1"]); let s1 = r.commit("a.txt","1\n","s1");
    r.git(&["checkout","-q","-b","step-2"]); r.commit("b.txt","2\n","s2");
    let m = set_parent(&r.path, Some("main"), "step-2", "step-1").unwrap();
    assert_eq!(m.parent, "step-1"); assert_eq!(m.base.as_deref(), Some(s1.as_str()));
    assert_eq!(r.git(&["config","--get","branch.step-2.gitwandStackBase"]), s1);
    // never writes the worktree service's key (D3): `git config --get` exits 1
    assert!(!crate::git::git_cmd().args(["config","--get","branch.step-2.gitwandBase"]).current_dir(&r.path)
        .status().unwrap().success());
}
#[test] fn a_second_child_on_the_same_parent_is_refused() { /* step-2 and step-3 both on step-1 */
    assert_eq!(set_parent(&r.path, Some("main"), "step-3", "step-1").unwrap_err(),
      "step-1 already has a stacked branch (step-2). Stacks are linear for now: stack on step-2 instead."); }
#[test] fn re_declaring_the_same_child_is_allowed() { /* set_parent(step-2, step-1) twice → Ok */ }
#[test] fn cycles_self_and_trunk_are_refused() {
    // A on B, then B on A:
    assert_eq!(set_parent(p, Some("main"), "B", "A").unwrap_err(), "Stacking B on A would create a cycle.");
    assert_eq!(set_parent(p, Some("main"), "A", "A").unwrap_err(), "A branch cannot be stacked on itself.");
    assert_eq!(set_parent(p, Some("main"), "A", "main").unwrap_err(), "main is the trunk: stacking on it is not a stack. Use Unstack instead.");
    assert_eq!(set_parent(p, Some("main"), "main", "A").unwrap_err(), "main is the trunk and cannot be stacked.");
    assert_eq!(set_parent(p, Some("main"), "-x", "A").unwrap_err(), "invalid branch name: -x");
    assert_eq!(set_parent(p, Some("main"), "A", "nope").unwrap_err(), "Unknown local branch: nope");
}
#[test] fn read_all_round_trips_dotted_slashed_and_capitalised_names() {
    // branches "release/1.2" and "Feat/Step.2"; Feat/Step.2 on release/1.2
    let all = read_all(&r.path).unwrap();
    assert_eq!(all["Feat/Step.2"].parent, "release/1.2");
}
#[test] fn pending_record_round_trips_and_rejects_garbage() {
    let p = PendingRestack { moment: Moment::ParentMerged, onto: "a".repeat(40), old_base: "b".repeat(40),
        bottom: "step-2".into(), new_parent: None, original: "step-1".into() };
    assert_eq!(p.to_config(), format!("parent_merged {} {} step-2 - step-1", "a".repeat(40), "b".repeat(40)));
    assert_eq!(PendingRestack::parse(&p.to_config()), Some(p));
    assert_eq!(PendingRestack::parse("parent_moved abc"), None);
}
#[test] fn unset_removes_only_stack_keys() { /* branch.step-2.remote stays, three gitwand keys gone; unset twice is Ok */ }
#[test] fn trunk_never_falls_back_to_the_current_branch() {
    // repo whose only branch is "trunk-less" feature → trunk() == None, resolve_default_branch still returns it
}
```

- [ ] **Step 2: Run** `cd apps/desktop/src-tauri && cargo test stack::meta`. Expected: FAIL (module `stack` not found).
- [ ] **Step 3: Implement** the signatures above in `stack/mod.rs` (types) and `stack/meta.rs`, and `resolve_default_branch_strict` in `git/cmd.rs`. Linear check: the parent already has a child when some other `StackMeta` names it as parent. Cycle check: walk `parent` links from `parent` and refuse when `layer` is reached (stop at 64 hops).
- [ ] **Step 4: Run** `cargo test stack::meta && cargo test resolve_default_branch`. Expected: PASS. Then `cargo fmt && cargo clippy --all-targets -- -D warnings`.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src/stack apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/git/cmd.rs && git commit -m "feat(stack): stack metadata in local git config"`

---

## Task 2 — Rust: git version and branch holders

**Files:**
- Create: `apps/desktop/src-tauri/src/stack/guard.rs`
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs:2756` (`fn list_worktrees` → `pub(crate) fn list_worktrees`), `stack/mod.rs` (`pub(crate) mod guard;`)
- Test: `stack/guard.rs` tests.

**Interfaces:**
- Consumes: `commands::ops::list_worktrees(cwd) -> Result<Vec<WorktreeEntry>, String>`.
- Produces:
  - `pub(crate) fn parse_git_version(s: &str) -> Option<(u32, u32)>`
  - `pub(crate) fn git_version() -> Option<(u32, u32)>` (runs `git --version` through `git_cmd()`)
  - `pub(crate) fn supports_update_refs(v: Option<(u32, u32)>) -> bool` (`>= (2, 38)`; `None` → false)
  - `pub(crate) struct Holder { pub branch: String, pub worktree: PathBuf, pub rebasing: bool, pub current: bool }`
  - `pub(crate) fn branch_holders(repo: &Path) -> Result<Vec<Holder>, String>`. For each worktree: (a) the porcelain `branch` line → `rebasing: false`; (b) its git dir (`git -C <wt> rev-parse --absolute-git-dir`) holding `rebase-merge/head-name` or `rebase-apply/head-name` → `rebasing: true`, branch = head-name without `refs/heads/`. `current` = the worktree's canonical path equals `repo`'s `rev-parse --show-toplevel`.

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn parses_git_version_strings() {
    assert_eq!(parse_git_version("git version 2.39.3 (Apple Git-146)"), Some((2, 39)));
    assert_eq!(parse_git_version("git version 2.45.1.windows.1"), Some((2, 45)));
    assert_eq!(parse_git_version("garbage"), None);
    assert!(!supports_update_refs(Some((2, 37)))); assert!(supports_update_refs(Some((2, 38))));
}
#[test] fn holders_report_a_branch_checked_out_in_a_linked_worktree() {
    // step-2 checked out in <sandbox>/wt via `git worktree add`
    let h = branch_holders(&r.path).unwrap();
    let x = h.iter().find(|h| h.branch == "step-2").unwrap();
    assert!(!x.current && !x.rebasing); assert!(x.worktree.ends_with("wt"));
    assert!(h.iter().any(|h| h.branch == "main" && h.current));
}
#[test] fn holders_report_a_branch_being_rebased_in_a_linked_worktree() {
    // in wt: `git rebase main` on step-2 with a conflicting commit → halted; porcelain shows detached
    let x = branch_holders(&r.path).unwrap().into_iter().find(|h| h.branch == "step-2").unwrap();
    assert!(x.rebasing && !x.current);
}
```

- [ ] **Step 2: Run** `cargo test stack::guard`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `cargo test stack::guard && cargo test commands::ops` (`list_worktrees` callers unchanged). Expected: PASS. `cargo fmt`, clippy.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src/stack apps/desktop/src-tauri/src/commands/ops.rs && git commit -m "feat(stack): git version and per-worktree branch holders"`

---

## Task 3 — Rust: detection, propagation, self-healing

**Files:**
- Create: `apps/desktop/src-tauri/src/stack/detect.rs`
- Test: `stack/detect.rs` tests.

**Interfaces:**
- Consumes: Task 1 (`read_all`, `trunk`, `set_base`), Task 2 (`branch_holders`, `git_version`, `supports_update_refs`).
- Produces:
  - `pub(crate) fn status(repo: &Path, configured_trunk: Option<&str>, hints: &[MergedParentHint]) -> Result<StackReport, String>`. Task 5 adds the pending-record step.
  - `pub(crate) fn merged_signal(repo: &Path, remote_trunk: &str, base: &str) -> Option<MergeSignal>` (D7; returns `Cherry` or `MergeCommit`)
  - `pub(crate) fn chains(all: &BTreeMap<String, StackMeta>) -> Vec<Vec<String>>`: bottom→top lists. A bottom is a layer whose parent is not itself a layer.
  - `pub(crate) fn behind_upstream(repo: &Path, branch: &str) -> u32` (`rev-list --count <b>..<b>@{upstream}`, 0 without an upstream)

Classification per layer `L` with parent `P`, in this order (spec §5.3, plus D7/D17):
1. A hint for `P` → `ParentMerged`, `merge_signal: Forge`, `merged_pr: Some(number)`.
2. A remote trunk exists, and `merged_signal(repo, remote_trunk, base-or-P-tip)` is `Some` → `ParentMerged`.
3. `P` missing locally → `ParentMissing`.
4. `P` tip is an ancestor of `L` → `UpToDate`. Self-heal: when the base differs from `P`'s tip and `rebase_in_progress` is false, `set_base(L, P tip)`.
5. The base exists and is an ancestor of `L` → `OutOfDate`.
6. Otherwise → `BaseLost`.

Propagation: walking each chain bottom→top, every layer above one in state `OutOfDate`/`ParentMerged` (own or inherited) gets `inherited: true`. `actionable` is true for the lowest `OutOfDate`/`ParentMerged` layer of each chain, and only when `rebase_in_progress` is false. `rebase_in_progress` = some holder has `rebasing` on a branch that is a layer. When it is true there are no writes. `top` = the last branch of the layer's chain. `parent_behind_upstream = behind_upstream(P)` for `OutOfDate`. `git_supports_restack = supports_update_refs(git_version())`. No trunk → `layers: []`.

- [ ] **Step 1: Write failing tests** (one fixture helper `stack3(&TempRepo)` builds main ← step-1 ← step-2 ← step-3, each with one commit, declared via `set_parent`):

```rust
#[test] fn up_to_date_stack_reports_no_action() { let s = status(&r.path, Some("main"), &[]).unwrap();
    assert!(s.layers.iter().all(|l| l.state == LayerState::UpToDate && !l.actionable)); }
#[test] fn parent_moved_marks_lowest_layer_actionable_and_inherits_above() {
    // commit on step-1 after declaring
    let l = |b| s.layers.iter().find(|l| l.branch == b).unwrap();
    assert_eq!(l("step-2").state, LayerState::OutOfDate); assert!(l("step-2").actionable);
    assert!(l("step-3").inherited && !l("step-3").actionable); assert_eq!(l("step-3").top, "step-3"); }
#[test] fn single_commit_squash_is_detected_by_cherry() {
    // origin bare; on main: merge --squash step-1 (one commit), push origin main, reset --hard HEAD~1
    assert_eq!(l("step-2").state, LayerState::ParentMerged); assert_eq!(l("step-2").merge_signal, Some(MergeSignal::Cherry)); }
#[test] fn merge_commit_merge_is_detected() { /* main: merge --no-ff step-1, push → MergeSignal::MergeCommit */ }
#[test] fn multi_commit_squash_needs_the_forge_hint() {
    // step-1 with two commits, squash-merged on origin/main
    assert_eq!(status(p, Some("main"), &[]).unwrap() /*step-2*/.state, LayerState::UpToDate);
    let h = [MergedParentHint { branch: "step-1".into(), number: 812, head_ref_oid: None }];
    let l2 = /* status(p, Some("main"), &h) step-2 */; assert_eq!(l2.state, LayerState::ParentMerged);
    assert_eq!(l2.merged_pr, Some(812)); assert_eq!(l2.merge_signal, Some(MergeSignal::Forge)); }
#[test] fn a_parent_without_commits_of_its_own_is_not_merged() {
    // step-1 created at main's tip with no commit, pushed main to origin; step-2 (1 commit) on step-1
    assert_eq!(l("step-2").state, LayerState::UpToDate); }
#[test] fn renamed_or_deleted_parent_reports_parent_missing() { /* git branch -m step-1 step-one → step-2 ParentMissing */ }
#[test] fn self_heal_moves_base_to_parent_tip_after_a_manual_rebase() {
    // commit on step-1, then `git rebase step-1` on step-2 by hand
    assert_eq!(r.git(&["config","--get","branch.step-2.gitwandStackBase"]), r.git(&["rev-parse","step-1"])); }
#[test] fn base_lost_when_neither_parent_tip_nor_base_is_an_ancestor() { /* rebase step-2 onto main by hand → BaseLost, not actionable */ }
#[test] fn no_writes_and_no_action_while_a_layer_is_rebasing() {
    // step-2 halted mid-rebase in a linked worktree; step-1 moved
    assert!(s.rebase_in_progress); assert!(s.layers.iter().all(|l| !l.actionable)); /* base unchanged */ }
#[test] fn parent_behind_its_upstream_is_reported() { /* origin/step-1 one commit ahead → parent_behind_upstream == 1 */ }
```

- [ ] **Step 2: Run** `cargo test stack::detect`. Expected: FAIL.
- [ ] **Step 3: Implement** `status`, `merged_signal`, `chains` and `behind_upstream` as specified. `merged_signal` (a): `git cherry <remote_trunk> <base>` → `Some(Cherry)` iff there is at least one line and every line starts with `-`. (b): `merge-base --is-ancestor <base> <remote_trunk>`, then the first sha of `rev-list --merges --ancestry-path --reverse <base>..<remote_trunk>`, and `Some(MergeCommit)` iff `merge-base --is-ancestor <base> <that>^1` fails.
- [ ] **Step 4: Run** `cargo test stack::detect`. Expected: PASS. `cargo fmt`, clippy.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src/stack && git commit -m "feat(stack): detect parent moved / parent merged, self-heal the base"`

---

## Task 4 — Rust: restack plan and restack preview

**Files:**
- Create: `apps/desktop/src-tauri/src/stack/restack.rs` (`plan` only in this task)
- Modify: `apps/desktop/src-tauri/src/commands/read.rs` (extract `replay_preview` from `preview_rebase`, line 1971; add `preview_restack`)
- Test: `stack/restack.rs` tests; `read.rs` tests module.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `pub(crate) fn plan(repo: &Path, configured_trunk: Option<&str>, layer: &str, hints: &[MergedParentHint], git_version: Option<(u32, u32)>) -> Result<RestackPlan, String>`. Errors only for unknown branches; every refusable condition goes in `refusal`, in the order of the refusal-code list. `occupied` sets `branch` + `path` and applies to any `MovingRef` held by a non-current worktree, checked out or rebasing. Moment 1: `onto_ref = parent`, `upstream = base`. Moment 2: D8/D20 (`onto_ref` = `origin/<trunk>` or `P'`, `new_parent` = `None` for trunk).
  - `pub(crate) fn moving_refs(repo: &Path, upstream: &str, top: &str, stack: &[String]) -> Result<Vec<MovingRef>, String>` (D21; `upstream` = `<b>@{upstream}` short name; `remote_sha` = its sha)
  - `pub(crate) fn replay_preview(git: &str, cwd: &str, onto_sha: &str, upstream_sha: &str, tip_sha: &str) -> Result<Vec<FileMergePreview>, String>` (read.rs: the per-commit replay + dedupe + sort currently inside `preview_rebase`, with the range `upstream..tip`)
  - `#[tauri::command] pub(crate) async fn preview_restack(cwd: String, onto: String, upstream: String, branch: String) -> Result<Vec<FileMergePreview>, String>`. Refs starting with `-` → `invalid ref: <r>`. Unknown refs → the existing `Unknown or invalid ref: <r>` from `rev_parse_verify`.
  - `preview_rebase` keeps its signature and calls `replay_preview(git, cwd, onto_sha, merge_base, head_sha)`.

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn plan_moment_one_rebases_from_base_onto_parent() {
    // stack3, commit on step-1
    let p = plan(&r.path, Some("main"), "step-2", &[], Some((2, 54))).unwrap();
    assert_eq!(p.moment, Moment::ParentMoved); assert_eq!(p.onto_ref, "step-1");
    assert_eq!(p.onto_sha, r.git(&["rev-parse","step-1"])); assert_eq!(p.upstream_sha, old_step1_tip);
    assert_eq!(p.top, "step-3"); assert_eq!(names(&p.moving), ["step-2","step-3"]); assert!(p.refusal.is_none()); }
#[test] fn plan_moment_two_targets_origin_trunk_with_new_parent_none() {
    // squash on origin/main, local main behind
    assert_eq!(p.onto_ref, "origin/main"); assert_eq!(p.onto_sha, r.git(&["rev-parse","origin/main"]));
    assert_eq!(p.upstream_sha, step2_base); assert_eq!(p.new_parent, None); }
#[test] fn plan_moment_two_under_a_stacked_grandparent_targets_it() { /* step-2 merged into step-1 via hint → onto_ref "step-1", new_parent Some("step-1") */ }
#[test] fn plan_without_base_uses_head_ref_oid_else_refuses() {
    // unset gitwandStackBase on step-2
    let h = [MergedParentHint { branch: "step-1".into(), number: 812, head_ref_oid: Some(old_tip.clone()) }];
    assert_eq!(plan(p, Some("main"), "step-2", &h, V).unwrap().upstream_sha, old_tip);
    let h2 = [MergedParentHint { branch: "step-1".into(), number: 812, head_ref_oid: None }];
    assert_eq!(code(plan(p, Some("main"), "step-2", &h2, V)), "no_old_base");
    let h3 = [MergedParentHint { head_ref_oid: Some("f".repeat(40)), ..h2[0].clone() }];
    assert_eq!(code(plan(p, Some("main"), "step-2", &h3, V)), "no_old_base"); }
#[test] fn plan_refuses_a_layer_checked_out_in_another_worktree() {
    let rf = plan(...).unwrap().refusal.unwrap(); assert_eq!(rf.code, "occupied");
    assert_eq!(rf.branch.as_deref(), Some("step-3")); assert!(rf.path.unwrap().ends_with("wt")); }
#[test] fn plan_allows_a_layer_checked_out_in_the_current_worktree() { /* step-2 checked out in r.path → refusal None */ }
#[test] fn plan_lists_a_non_stack_branch_inside_the_range() {
    // `git branch backup step-2` → moving contains {branch:"backup", in_stack:false}
}
#[test] fn plan_refuses_when_a_non_stack_branch_in_range_is_checked_out_elsewhere() { /* backup in a worktree → occupied, branch "backup" */ }
#[test] fn plan_refuses_dirty_detached_old_git_and_parent_behind() {
    // tracked edit → "dirty" (untracked file alone → no refusal); `checkout --detach` → "detached";
    // Some((2,37)) → "git_too_old" with message containing "2.37"; origin/step-1 ahead → "parent_behind"
}
#[test] fn plan_moment_two_without_origin_refuses_no_remote_trunk() { /* forge hint, no origin remote */ }
#[test] fn plan_records_remote_sha_of_each_upstream() { /* step-2 pushed with -u → moving[step-2].remote_sha == origin/step-2 sha; step-3 None */ }
// read.rs
#[test] fn preview_restack_replays_only_the_layers_commits() {
    // multi-commit squash fixture where step-1's commits conflict with themselves if replayed:
    // preview_restack(onto=origin/main, upstream=old step-1 tip, branch=step-3) has no file from step-1 and no conflicts
}
#[test] fn preview_rebase_output_is_unchanged_by_the_extraction() { /* fixture from existing test → identical Vec */ }
```

- [ ] **Step 2: Run** `cargo test stack::restack commands::read`. Expected: FAIL.
- [ ] **Step 3: Implement** `plan`, `moving_refs`, `replay_preview` and `preview_restack`. The `git_too_old` message: `Restacking needs git 2.38 or later (found <maj>.<min>).`
- [ ] **Step 4: Run** `cargo test stack:: commands::read`. Expected: PASS. `cargo fmt`, clippy.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src/stack apps/desktop/src-tauri/src/commands/read.rs && git commit -m "feat(stack): restack plan and restack preview"`

---

## Task 5 — Rust: run, pending record, finalize

**Files:**
- Modify: `apps/desktop/src-tauri/src/stack/restack.rs` (`run`, `finalize`), `stack/detect.rs` (the pending step in `status`)
- Test: `stack/restack.rs` tests (end-to-end on real repos).

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `pub(crate) fn run(repo: &Path, configured_trunk: Option<&str>, layer: &str, hints: &[MergedParentHint], previewed: &PreviewedRestack, git_version: Option<(u32, u32)>) -> Result<RestackRun, String>`. Re-plans. An existing refusal → `Err(refusal.message)`. Any mismatch of `onto_sha`/`upstream_sha`/`top_sha`/moving names → `Err("stale preview: the stack changed since the preview. Preview again.")`. Records `original` from `git symbolic-ref --short -q HEAD`. Calls `set_pending`. Runs `git rebase --update-refs --onto <onto_sha> <upstream_sha> <top>` with `GIT_EDITOR=true`, `EDITOR=true`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `LANGUAGE=` (same env as `git_rebase_onto`, `ops.rs:1066`). Success → `{conflict:false}` and the record **stays** (D5). Conflict (`CONFLICT`/`could not apply` in stdout or stderr) → `{conflict:true}`. Other failure → clear the record unless a rebase is now in progress, then `Err("git rebase failed: …")`.
  - `pub(crate) fn finalize(repo: &Path, top: &str, p: &PendingRestack) -> Result<FinalizedRestack, String>`. Moment 1: `bottom.base = tip(bottom.parent)`. Moment 2: `merged_parent = Some(old bottom.parent)`, and `bottom.parent = new_parent` or, when `None`, `unset(bottom)`. Then every layer above `bottom` in its chain gets `base = tip(parent)`. Then `clear_pending(top)`. Finally, when `repo`'s current branch is `top`, `original != top` and `original` exists, run `git switch <original>`; a failure fills `switch_error`.
  - In `status`, before classification, for each `StackMeta` with `pending`: if a holder is `rebasing` `top` → `rebase_in_progress = true` (wait). Else if `merge-base --is-ancestor <onto> <top>` → `report.finalized = Some(finalize(..))`. Else → `clear_pending` (abort).

- [ ] **Step 1: Write failing tests:**

```rust
fn restack(r: &TempRepo, layer: &str, h: &[MergedParentHint]) -> RestackRun {
    let p = plan(&r.path, Some("main"), layer, h, V).unwrap();
    run(&r.path, Some("main"), layer, h, &previewed(&p), V).unwrap()
}
#[test] fn moment_one_three_layers_end_to_end() {
    // stack3 on branch step-1, commit on step-1
    assert!(!restack(&r, "step-2", &[]).conflict);
    let s = status(&r.path, Some("main"), &[]).unwrap(); let f = s.finalized.unwrap();
    assert_eq!(f.moved, ["step-2","step-3"]); assert_eq!(f.switched_back_to.as_deref(), Some("step-1"));
    assert!(is_ancestor(&r, "step-1", "step-2") && is_ancestor(&r, "step-2", "step-3"));
    assert_eq!(cfg(&r, "branch.step-2.gitwandStackBase"), r.git(&["rev-parse","step-1"]));
    assert_eq!(cfg(&r, "branch.step-3.gitwandStackBase"), r.git(&["rev-parse","step-2"]));
    assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none());
    assert_eq!(r.git(&["branch","--show-current"]), "step-1");
    assert!(s.layers.iter().all(|l| l.state == LayerState::UpToDate)); }
#[test] fn moment_two_lands_the_squash_while_local_main_stays_behind() {
    // step-1 two commits, squash on origin/main, local main reset behind; hint with number 812
    let main_before = r.git(&["rev-parse","main"]);
    assert!(!restack(&r, "step-2", &h).conflict);          // no phantom conflicts
    let f = status(&r.path, Some("main"), &h).unwrap().finalized.unwrap();
    assert_eq!(f.merged_parent.as_deref(), Some("step-1")); assert_eq!(f.new_parent, None);
    assert_eq!(r.git(&["rev-parse","main"]), main_before);       // local main untouched
    assert!(is_ancestor(&r, "origin/main", "step-2"));
    assert_eq!(r.git(&["rev-list","--count","origin/main..step-2"]), "1"); // only step-2's own commit
    assert!(cfg_opt(&r, "branch.step-2.gitwandParent").is_none());   // now an ordinary branch
    assert_eq!(cfg(&r, "branch.step-3.gitwandParent"), "step-2"); }
#[test] fn conflict_halt_then_continue_finalizes_moment_one() {
    // step-1 and step-2 edit the same line; restack → conflict; status while halted → no finalized, rebase_in_progress
    // resolve, `git add`, GIT_EDITOR=true git rebase --continue → status().finalized is Some, switched back
}
#[test] fn conflict_halt_then_continue_finalizes_moment_two() { /* same, moment 2 → step-2 parent unset after continue */ }
#[test] fn abort_clears_the_record_and_changes_nothing() {
    // conflict, then `git rebase --abort`; snapshot refs + config before
    let s = status(&r.path, Some("main"), &[]).unwrap(); assert!(s.finalized.is_none());
    assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_none()); /* refs and stack keys == before */ }
#[test] fn status_waits_while_top_is_rebasing_in_another_worktree() {
    // record on step-3; step-3 halted mid-rebase in linked worktree wt; status from r.path
    assert!(s.rebase_in_progress && s.finalized.is_none()); assert!(cfg_opt(&r, "branch.step-3.gitwandRestack").is_some()); }
#[test] fn stale_preview_is_refused() { /* plan, then commit on step-3, run with old previewed → Err starts_with("stale preview:") */ }
#[test] fn run_refuses_a_dirty_tree() { /* tracked edit → Err(message of "dirty") and no record written */ }
#[test] fn malformed_record_is_cleared() { /* config gitwandRestack "garbage" → status clears it */ }
```

- [ ] **Step 2: Run** `cargo test stack::restack`. Expected: FAIL.
- [ ] **Step 3: Implement** `run`, `finalize` and the pending step in `status`.
- [ ] **Step 4: Run** `cargo test stack::`. Expected: PASS. `cargo fmt`, clippy.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src/stack && git commit -m "feat(stack): restack with --update-refs, pending record finalized on refresh"`

---

## Task 6 — Rust: Tauri commands (stack + push one branch)

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/stack.rs`
- Modify: `commands/mod.rs`, `commands/ops.rs` (`git_push_branch` after `git_push`, line 451), `lib.rs` (`generate_handler!`; `command_parity` arms `stack_status`, `stack_set_parent`, `stack_unset`, `stack_restack_plan`, `git_restack`, `preview_restack`)
- Test: `commands/ops.rs` test module (push); `lib.rs` `command_parity_tests` (line 1653).

**Interfaces:**
- Consumes: `stack::{detect::status, meta::{set_parent, unset, trunk}, restack::{plan, run}, guard::git_version}`, `repo_lock::{write, read, push}`, `force_with_lease_arg`.
- Produces (each body is: lock, call into `stack::`, map the result):

```rust
#[tauri::command] pub(crate) async fn stack_status(cwd: String, configured_trunk: Option<String>, merged_parents: Vec<MergedParentHint>) -> Result<StackReport, String>      // repo_lock::write (self-heal, finalize)
#[tauri::command] pub(crate) async fn stack_set_parent(cwd: String, branch: String, parent: String, configured_trunk: Option<String>) -> Result<StackMeta, String> // write
#[tauri::command] pub(crate) async fn stack_unset(cwd: String, branch: String) -> Result<(), String>                                                              // write
#[tauri::command] pub(crate) async fn stack_restack_plan(cwd: String, branch: String, configured_trunk: Option<String>, merged_parents: Vec<MergedParentHint>) -> Result<RestackPlan, String> // read
#[tauri::command] pub(crate) async fn git_restack(cwd: String, branch: String, configured_trunk: Option<String>, merged_parents: Vec<MergedParentHint>, previewed: PreviewedRestack) -> Result<RestackRun, String> // write
#[tauri::command] pub(crate) async fn git_push_branch(cwd: String, branch: String, lease_sha: String) -> Result<GitPushPullResult, String> // repo_lock::push
```

`StackMeta` gains `Serialize`. `git_push_branch`: `validate_branch_name(branch)`. Read `branch.<b>.remote` and `branch.<b>.merge`; when either is missing → `Err("<b> has no upstream")`. Args: `["push", &force_with_lease_arg(remote_branch, &lease_sha)?, &remote, &format!("refs/heads/{b}:refs/heads/{remote_branch}")]`. The refspec is a single argv element, so this is not shell interpolation.

- [ ] **Step 1: Write failing tests:**

```rust
// ops.rs
#[test] fn push_branch_force_pushes_a_non_checked_out_branch_with_its_lease() {
    // bare origin; step-2 pushed -u; amend step-2 while on main; lease = old origin/step-2 sha
    let r = block_on(git_push_branch(cwd, "step-2".into(), old)).unwrap(); assert!(r.success);
    assert_eq!(git_at(&bare, &["rev-parse","step-2"]), local_step2); }
#[test] fn push_branch_refuses_a_stale_lease() { /* lease = "0"*40 → success == false, remote unchanged */ }
#[test] fn push_branch_without_upstream_errors() { assert_eq!(err, "step-3 has no upstream"); }
#[test] fn push_branch_refuses_a_dash_name() { assert_eq!(err, "invalid branch name: -f"); }
// lib.rs command_parity_tests
#[test] fn command_parity_knows_the_stack_commands() { for c in ["stack_status","stack_set_parent","stack_unset","stack_restack_plan","git_restack","preview_restack"] {
    assert!(!command_parity(c.into(), json!({})).unwrap_err().contains("does not know")); } }
```

- [ ] **Step 2: Run** `cargo test push_branch command_parity`. Expected: FAIL.
- [ ] **Step 3: Implement** the commands, register all six plus `preview_restack` in `generate_handler!`, and add the `command_parity` arms. Args for those arms: `cwd`, `branch`, `parent`, `trunk` (optional), `mergedParents` (array), `previewed` (object), `onto`, `upstream`.
- [ ] **Step 4: Run** `cargo test && cargo build --example parity-probe`. Expected: PASS. `cargo fmt`, clippy.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src && git commit -m "feat(stack): Tauri commands for stacks, restack and single-branch push"`

---

## Task 7 — Rust: GitHub branch-PR lookup and base retarget

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs` (`BranchPr`), `commands/gh.rs`, `commands/github_api.rs`, `lib.rs` (`generate_handler!`)
- Test: unit tests in `gh.rs` / `github_api.rs` (parsers and payload; no network).

**Interfaces:**
- Consumes: `github_api::with_rest`, `owner_repo` (`github_api.rs:285`), `base_owner_repo` (`:1715`), `api_json` (`:427`), `gh_base_cmd` (`gh.rs:1798`), `gh_base_nwo` (`:1871`), `gh_api_write` (`:2247`), `output_with_timeout`.
- Produces:
  - `pub struct BranchPr { pub number: i64, pub base: String, pub head_ref_oid: String, pub merged_at: Option<String>, pub url: String }` (Serialize, snake_case)
  - `#[tauri::command] pub(crate) async fn gh_branch_pr(cwd: String, branch: String, state: String) -> Result<Option<BranchPr>, String>`. `state` ∈ {`open`,`merged`}, anything else → `Err("invalid PR state: <s>")`. A `-` branch → `invalid branch name: <b>`. REST: `GET /repos/<base>/pulls?state=<open|closed>&head=<origin-owner>:<branch>&per_page=10`, keeping (for `merged`) entries with a non-null `merged_at` and taking the newest `merged_at`. gh: `gh pr list --state <state> --head <branch> --json number,baseRefName,headRefOid,mergedAt,url --limit 10`, then the newest.
  - `#[tauri::command] pub(crate) async fn gh_pr_set_base(cwd: String, number: i64, base: String) -> Result<(), String>`. `rest_pr_set_base` PATCHes `{"base": base}`. The fallback is `gh_api_write(&cwd, "PATCH", "repos/<nwo>/pulls/<n>", &[("base", base)])`.
  - `pub(crate) fn parse_gh_branch_pr_json(stdout: &str) -> Result<Option<BranchPr>, String>`, `pub(crate) fn branch_pr_from_rest_json(v: &serde_json::Value) -> Option<BranchPr>`, `pub(crate) fn newest_merged(prs: Vec<BranchPr>) -> Option<BranchPr>`.

- [ ] **Step 1: Write failing tests:**

```rust
#[test] fn parses_gh_branch_pr_json_and_keeps_the_newest_merge() {
    let s = r#"[{"number":800,"baseRefName":"main","headRefOid":"aaa","mergedAt":"2026-11-01T00:00:00Z","url":"u1"},
               {"number":812,"baseRefName":"main","headRefOid":"bbb","mergedAt":"2026-11-20T00:00:00Z","url":"u2"}]"#;
    let pr = newest_merged(parse_all(s)).unwrap(); assert_eq!((pr.number, pr.head_ref_oid.as_str()), (812, "bbb")); }
#[test] fn empty_gh_list_is_none() { assert_eq!(parse_gh_branch_pr_json("[]").unwrap(), None); }
#[test] fn rest_json_maps_head_sha_and_base_ref() {
    let v = json!({"number":812,"base":{"ref":"step-1"},"head":{"sha":"bbb","ref":"step-2"},"merged_at":null,"html_url":"u"});
    let pr = branch_pr_from_rest_json(&v).unwrap(); assert_eq!((pr.base.as_str(), pr.merged_at), ("step-1", None)); }
#[test] fn set_base_rejects_dash_and_empty() { /* inner fn: "" → "base must not be empty", "-x" → "invalid branch name: -x" */ }
#[test] fn branch_pr_rejects_unknown_state() { assert_eq!(err, "invalid PR state: closed"); }
```

- [ ] **Step 2: Run** `cargo test branch_pr set_base`. Expected: FAIL.
- [ ] **Step 3: Implement** and register both commands.
- [ ] **Step 4: Run** `cargo test`. Expected: PASS. `cargo fmt`, clippy.
- [ ] **Step 5: Commit** `git add apps/desktop/src-tauri/src && git commit -m "feat(gh): find a branch's PR and retarget a PR's base"`

---

## Task 8 — Dev-server mirror, routes, parity

**Files:**
- Create: `apps/desktop/dev-stack-service.mjs`, `apps/desktop/tests/parity/stack.test.mjs`
- Modify: `apps/desktop/dev-server.mjs` (import; extract `devReplayPreview(cwd, ontoSha, upstreamSha, tipSha)` from the `/api/preview-rebase` route at line 2654 and call it there; new routes next to `/api/git-rebase-onto` line 4307 and the gh routes near `/api/gh-dismiss-review` line 7343), `apps/desktop/tests/parity/fixtures.mjs`
- Test: `tests/parity/stack.test.mjs`, plus the existing `tests/parity/preview-rebase.test.mjs` unchanged and still green.

**Interfaces:**
- Consumes: the Rust behaviour and error strings of Tasks 1–7.
- Produces (Node, same semantics and strings as Rust):
  - `export function devStackStatus(cwd, configuredTrunk, mergedParents)`
  - `export function devStackSetParent(cwd, branch, parent, configuredTrunk)`
  - `export function devStackUnset(cwd, branch)`
  - `export function devStackRestackPlan(cwd, branch, configuredTrunk, mergedParents)`
  - `export function devGitRestack(cwd, branch, configuredTrunk, mergedParents, previewed)`
  - Routes (POST JSON bodies with the wrappers' camelCase argument names; errors → `{ error }` with status 400): `/api/stack-status`, `/api/stack-set-parent`, `/api/stack-unset`, `/api/stack-restack-plan`, `/api/git-restack`, `/api/preview-restack` `{cwd, onto, upstream, branch}`, `/api/git-push-branch` `{cwd, branch, leaseSha}`, `/api/gh-branch-pr` `{cwd, branch, state}` (gh CLI), `/api/gh-pr-set-base` `{cwd, number, base}` (`gh api -X PATCH … -f base=…`).
  - `export function fixtureStack(kind)` with `kind` ∈ `"moved" | "squashed" | "merge-commit" | "conflict" | "occupied"`. Each call returns a fresh repo (with a bare origin for `squashed`/`merge-commit`). Commit dates are fixed with the existing `commitFile` index, so shas match across the two backends.

- [ ] **Step 1: Write failing parity tests** (`stack.test.mjs`, same structure as `git-rebase-onto.test.mjs`):

```js
it("stack-status is identical for every fixture state", async () => {
  for (const kind of ["moved", "squashed", "merge-commit", "occupied"]) {
    const cwd = fixtureStack(kind);   // status may self-heal → each side on its own fresh fixture
    const cwd2 = fixtureStack(kind);
    const rust = runProbe("command-parity", { command: "stack_status", args: { cwd, trunk: "main", mergedParents: [] } });
    const node = await post(dev, "/api/stack-status", { cwd: cwd2, configuredTrunk: "main", mergedParents: [] });
    expect(normalizeShas(node.value)).toEqual(normalizeShas(rust.value));   // shas → index of first appearance
  }
});
it("set-parent refusals have the same wording", async () => {
  // second child, cycle, self, trunk, "-x" → rust.error === node.error, e.g.
  expect(rust.error).toBe("step-1 already has a stacked branch (step-2). Stacks are linear for now: stack on step-2 instead.");
});
it("restack plans are identical, refusals included", async () => { /* moved, squashed (+hint), occupied → code "occupied" */ });
it("preview-restack is byte-identical", async () => { /* onto=origin/main upstream=<base> branch=step-3 */ });
it("a clean restack leaves the same state, finalized by the next status", async () => {
  // stateOf = { logs per branch (subjects), stack config keys, current branch, rebasing }
});
it("a conflicting restack halts identically", async () => { /* conflict:true, rebasing:true on both */ });
```

- [ ] **Step 2: Run** `cd apps/desktop/src-tauri && cargo build --example parity-probe && cd .. && pnpm test:parity -- stack`. Expected: FAIL (routes 404).
- [ ] **Step 3: Implement** `dev-stack-service.mjs` and the routes, and refactor `/api/preview-rebase` to use `devReplayPreview`.
- [ ] **Step 4: Run** `pnpm test:parity`. Expected: PASS for the whole parity suite, including `preview-rebase.test.mjs`.
- [ ] **Step 5: Commit** `git add apps/desktop/dev-stack-service.mjs apps/desktop/dev-server.mjs apps/desktop/tests/parity && git commit -m "feat(stack): dev-server mirror and parity coverage"`

---

## Task 9 — TS wrappers and command registry

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts` (next to `gitRebaseOnto`, line 1212, and `previewRebase`, line 2842), `apps/desktop/src/utils/backend-pr.ts` (next to `ghPrEdit`, line 563), `apps/desktop/src/utils/commandRegistry.ts`
- Test: `apps/desktop/src/utils/__tests__/commandRegistry.test.ts` (existing guard).

**Interfaces:**
- Produces (TS mirrors of the Rust types, snake_case fields):

```ts
export type StackMoment = "parent_moved" | "parent_merged";
export type StackLayerState = "up_to_date" | "out_of_date" | "parent_merged" | "parent_missing" | "base_lost";
export interface MergedParentHint { branch: string; number: number; head_ref_oid: string | null }
export interface StackLayerStatus { branch: string; parent: string; base: string | null; parent_tip: string | null; state: StackLayerState;
  inherited: boolean; actionable: boolean; merge_signal: "forge" | "cherry" | "merge_commit" | null; merged_pr: number | null;
  parent_behind_upstream: number; top: string }
export interface FinalizedRestack { moment: StackMoment; bottom: string; merged_parent: string | null; new_parent: string | null;
  moved: string[]; switched_back_to: string | null; switch_error: string | null }
export interface StackReport { trunk: string | null; remote_trunk: string | null; layers: StackLayerStatus[];
  rebase_in_progress: boolean; finalized: FinalizedRestack | null; git_supports_restack: boolean }
export interface StackMeta { branch: string; parent: string; base: string | null }
export type RestackRefusalCode = "rebase_in_progress" | "up_to_date" | "git_too_old" | "detached" | "dirty" | "occupied"
  | "parent_behind" | "no_remote_trunk" | "no_old_base" | "fetch_failed" | "stale_preview";
export interface RestackRefusal { code: RestackRefusalCode; message: string; branch: string | null; path: string | null }
export interface RestackMovingRef { branch: string; in_stack: boolean; upstream: string | null; remote_sha: string | null }
export interface RestackPlan { moment: StackMoment; bottom: string; parent: string; onto_ref: string; onto_sha: string; upstream_sha: string;
  top: string; top_sha: string; moving: RestackMovingRef[]; new_parent: string | null; refusal: RestackRefusal | null }
export interface PreviewedRestack { onto_sha: string; upstream_sha: string; top_sha: string; moving: string[] }

export function stackStatus(cwd: string, trunk: string | null, mergedParents: MergedParentHint[]): Promise<StackReport>;
export function stackSetParent(cwd: string, branch: string, parent: string, trunk: string | null): Promise<StackMeta>;
export function stackUnset(cwd: string, branch: string): Promise<void>;
export function stackRestackPlan(cwd: string, branch: string, trunk: string | null, mergedParents: MergedParentHint[]): Promise<RestackPlan>;
export function previewRestack(cwd: string, onto: string, upstream: string, branch: string): Promise<FileMergePreview[]>;
export function gitRestack(cwd: string, branch: string, trunk: string | null, mergedParents: MergedParentHint[], previewed: PreviewedRestack): Promise<{ conflict: boolean }>;
export function gitPushBranch(cwd: string, branch: string, leaseSha: string): Promise<GitPushPullResult>;   // IPC_TIMEOUT.NETWORK
// backend-pr.ts
export interface BranchPr { number: number; base: string; head_ref_oid: string; merged_at: string | null; url: string }
export function ghBranchPr(cwd: string, branch: string, state: "open" | "merged"): Promise<BranchPr | null>;  // IPC_TIMEOUT.NETWORK
export function ghPrSetBase(cwd: string, number: number, base: string): Promise<void>;                        // IPC_TIMEOUT.NETWORK
```

Each wrapper follows `gitRebaseOnto`'s shape: `tauriInvoke("<literal>", { cwd, …, configuredTrunk: trunk })`, otherwise `devFetch` to the Task 8 route, where a non-ok response throws `new Error(err.error)`.

Registry entries: `stack_status: { route: "/api/stack-status" }`, `stack_set_parent`, `stack_unset`, `stack_restack_plan`, `git_restack`, `preview_restack`, `git_push_branch` (routes as in Task 8), `gh_branch_pr: { route: "/api/gh-branch-pr", cliPathOnly: "…the Rust command uses the REST API whenever a token is configured…" }`, and `gh_pr_set_base` (same `cliPathOnly` text as `gh_disable_auto_merge`).

- [ ] **Step 1: Write the failing check.** Add the wrappers without the registry entries and run `cd apps/desktop && pnpm vitest run src/utils/__tests__/commandRegistry.test.ts`. Expected: FAIL, listing the 9 commands as invoked but absent from `commandRegistry.ts`.
- [ ] **Step 2: Implement** the registry entries.
- [ ] **Step 3: Run** the same test. Expected: PASS. Then `pnpm --filter @gitwand/core build && pnpm --filter @gitwand/desktop exec vue-tsc --noEmit -p tsconfig.json`. Expected: no errors.
- [ ] **Step 4: Commit** `git add apps/desktop/src/utils && git commit -m "feat(stack): typed IPC wrappers and command registry entries"`

---

## Task 10 — Preview and apply plumbing

**Files:**
- Modify: `apps/desktop/src/composables/useMergePreview.ts` (`computePreview` at line 168), `apps/desktop/src/composables/useApplyFromPreview.ts` (`ApplyOptions` at line 136, the rebase call at line 256), `apps/desktop/src/components/MergePreviewPanel.vue` (props at line 265)
- Test: `composables/__tests__/useApplyFromPreview.test.ts` (add), `composables/__tests__/useMergePreview-restack.test.ts` (create; mocks `../../utils/backend` `previewRestack` and `readGitwandrc` the way `useMergePreview-confidence.test.ts` mocks the engine).

**Interfaces:**
- Produces:
  - `computeRestackPreview(spec: { onto: string; upstream: string; branch: string; label: string }): Promise<void>` returned by `useMergePreview`. It calls `previewRestack(cwd(), spec.onto, spec.upstream, spec.branch)`, summarizes with operation `"rebase"`, and sets `summary.sourceBranch = spec.label`. The summarizing body of `computePreview` moves into a private `summarize(rawFiles, operation, label)` used by both.
  - `ApplyOptions.runRebase?: (ref: string) => Promise<{ conflict: boolean }>`, used as `await (opts.runRebase ?? deps.runRebaseOnto)(ref_)`.
  - `MergePreviewPanel` prop `movingRefs?: { branch: string; inStack: boolean }[]`. When non-empty, it renders above the file list a block titled `t('stacks.preview.moving')`: one `mono` line per branch, with `t('stacks.preview.notInStack')` appended for `inStack === false`.

- [ ] **Step 1: Write failing tests:**

```ts
it("a rebase with opts.runRebase never calls deps.runRebaseOnto", async () => {
  const runRebase = vi.fn(async () => ({ conflict: false }));
  await apply("rebase", "step-1", 0, { runRebase });
  expect(runRebase).toHaveBeenCalledWith("step-1"); expect(deps.runRebaseOnto).not.toHaveBeenCalled();
});
it("computeRestackPreview passes onto/upstream/branch and labels the summary", async () => {
  await p.computeRestackPreview({ onto: "o", upstream: "u", branch: "step-3", label: "step-2…step-3 → step-1" });
  expect(previewRestack).toHaveBeenCalledWith("/repo", "o", "u", "step-3");
  expect(p.summary.value?.sourceBranch).toBe("step-2…step-3 → step-1");
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/composables/__tests__/useApplyFromPreview.test.ts src/composables/__tests__/useMergePreview-restack.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests plus `useMergePreview-confidence.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add apps/desktop/src/composables apps/desktop/src/components/MergePreviewPanel.vue && git commit -m "feat(stack): restack preview and a custom rebase runner for apply-from-preview"`

---

## Task 11 — `useStacks` composable and the bridge-dismissal setting

**Files:**
- Create: `apps/desktop/src/composables/useStacks.ts`, `apps/desktop/src/composables/__tests__/useStacks.test.ts`
- Modify: `apps/desktop/src/composables/useSettings.ts` (`AppSettings` next to `branchUpdatePromptSkips` line 310, default line 561), `apps/desktop/src/components/SettingsPanel.vue` (`Settings` line 234, default line 353)

**Interfaces:**
- Consumes: Task 9 wrappers, `gitFetch`, `gitDeleteBranch(cwd, name, true)`, `loadSettings`/`saveSettings`/`normaliseCwd`, `ApplyOutcome`.
- Produces:

```ts
export interface StacksDeps {
  status: typeof stackStatus; setParent: typeof stackSetParent; unset: typeof stackUnset; plan: typeof stackRestackPlan;
  fetch: (cwd: string) => Promise<{ success: boolean; message: string }>;
  branchPr: typeof ghBranchPr; setPrBase: typeof ghPrSetBase; pushBranch: typeof gitPushBranch;
  deleteBranch: (cwd: string, name: string) => Promise<void>;
  forge: () => string | null;            // ForgeName of the active repo, "github" enables hints/retarget
  trunkSetting: () => string | null;     // settings.defaultBranch
  dismissed: (cwd: string) => string[]; dismiss: (cwd: string, branch: string) => void;
  now: () => number;
}
export type RestackPhase = "idle" | "fetching" | "planning" | "refused" | "preview" | "applying" | "residual" | "done" | "error";
export interface RestackFlow { phase: RestackPhase; cwd: string | null; plan: RestackPlan | null; refusal: RestackRefusal | null;
  fetchWarning: string | null; outcome: ApplyOutcome | null; error: string | null }
export interface StackBannerModel { layer: StackLayerStatus; kind: "parent_moved" | "parent_merged" | "parent_behind" | "parent_missing" | "base_lost" }
export interface AfterRestack { finalized: FinalizedRestack;
  retarget: { state: "none" | "done" | "failed" | "manual"; number: number | null; base: string | null; error: string | null };
  deleteOffer: string | null; push: { pushable: { branch: string; lease: string }[]; skipped: string[]; noLeases: boolean } }
export interface BridgeOffer { branch: string; parent: string; pr: number }
export interface RestackHost { apply(cwd: string, plan: RestackPlan, previewed: PreviewedRestack, hints: MergedParentHint[], estimated: number): Promise<ApplyOutcome>;
  offerPush(after: AfterRestack, run: () => Promise<void>): void; notify(message: string): void }
export interface Stacks {
  report: Ref<StackReport | null>; flow: Ref<RestackFlow>; after: Ref<AfterRestack | null>;
  banner: ComputedRef<StackBannerModel | null>; offers: ComputedRef<Map<string, BridgeOffer>>;
  setContext(ctx: { cwd: string | null; currentBranch: string | null; localBranches: string[]; prs: { branch: string; base: string; number: number; state: string }[] }): void;
  refresh(cwd: string): Promise<void>;
  layerOf(branch: string): StackLayerStatus | null; actionableFor(branch: string): StackLayerStatus | null;
  stackOnCandidates(branch: string): string[];
  stackOn(cwd: string, branch: string, parent: string): Promise<void>; unstack(cwd: string, branch: string): Promise<void>;
  acceptBridge(cwd: string, offer: BridgeOffer): Promise<void>; dismissBridge(cwd: string, branch: string): void;
  startRestack(cwd: string, branch: string): Promise<void>; applyRestack(estimated: number): Promise<void>; closeRestack(): void;
  later(): void; retryRetarget(): Promise<void>; deleteMergedParent(): Promise<void>; pushMoved(): Promise<{ branch: string; ok: boolean; message: string }[]>;
}
export function createStacks(deps: StacksDeps): Stacks;
export function useStacks(): Stacks;                 // module-level singleton bound to the real backend
export function registerRestackHost(h: RestackHost): void;
```

Behaviour the tests pin:
- `refresh` coalesces (one in flight plus one queued). Hints: only when `forge() === "github"`, one `branchPr(cwd, parent, "merged")` per distinct parent, cached 60 000 ms per `cwd|parent` (`now()`), with errors swallowed. It then calls `status(cwd, trunkSetting(), hints)`. A non-null `report.finalized` → `onFinalized`.
- `onFinalized`: `push` comes from the in-memory plan of the last restack whose `top` contains the moved layers. `pushable` = moved stack layers with a `remote_sha`; `skipped` = moved ones without. No plan in memory → `noLeases: true`. For moment `parent_merged`, on GitHub: `branchPr(cwd, bottom, "open")`, then `setPrBase(number, new_parent ?? trunk)` → `done`, an error → `failed` (with the message), no open PR → `none`. Off GitHub: `manual`. `deleteOffer = merged_parent`. Then `host.offerPush(after, pushMoved)` when `pushable.length > 0 || noLeases`.
- `startRestack`: `flow.phase` goes `fetching` → `fetch(cwd)`. On failure, a layer in state `parent_merged` → `refused` with `{code:"fetch_failed"}`, and `plan` is never called. On failure in moment 1 → `fetchWarning = message` and continue. Then `planning` → `plan(...)`. A refusal → `refused`, otherwise `preview`.
- `applyRestack` → `applying` → `host.apply(...)`. Outcome `stoppedReason === "clean"` → `done` then `refresh(cwd)`. `residual`/`loop-bound`/`resolve-failed` → `residual` (the banner takes over). `op-failed` → `error`, except when the message starts with `stale preview:` → `refused` `{code:"stale_preview"}`.
- `banner`: among the current branch's chain, from the current branch downwards, the lowest layer with own state ≠ `up_to_date`. Its kind is that state, except `out_of_date` with `parent_behind_upstream > 0` → `parent_behind`. `later()` hides it until that layer's `state` or `parent_tip` changes (in memory).
- `offers`: open PRs whose `branch` and `base` are local, `base !== report.trunk`, `branch` not already a layer, `base` with no stacked child, no cycle, and `branch` not in `dismissed(cwd)`.
- `stackOnCandidates(b)`: local branches minus `b`, the trunk, branches that already have a stacked child other than `b`, and branches whose parent chain contains `b`.

- [ ] **Step 1: Write failing tests** (fake deps; `createStacks(fakes)`):

```ts
it("asks GitHub for merged parents once per minute, never on other forges", …)   // two refreshes within 60 s → branchPr called once; forge "gitlab" → never
it("finalized moment two retargets the child PR to the trunk on GitHub", …)      // branchPr(open) → {number: 813}; setPrBase("/r", 813, "main"); after.retarget.state "done"
it("a failed retarget keeps the restack and can be retried", …)                  // setPrBase rejects once → "failed" with message; retryRetarget → "done"
it("off GitHub the retarget is left to the user", …)                             // forge "gitlab" → state "manual", setPrBase not called
it("push offer leases the remote shas read before the restack", …)               // plan.moving step-2 remote_sha "aaa", step-3 null → pushable [{step-2,"aaa"}], skipped ["step-3"]; pushMoved → pushBranch("/r","step-2","aaa")
it("a restack finalized without a plan in memory offers no push", …)            // after.push.noLeases === true, pushable []
it("moment_two_is_refused_when_the_fetch_fails", …)                             // fetch {success:false} + layer parent_merged → flow.refusal.code "fetch_failed", plan not called
it("moment one continues after a failed fetch with a warning", …)                // fetchWarning set, plan called
it("a stale preview error becomes a refusal", …)                                 // host.apply → op-failed "stale preview: …" → refusal.code "stale_preview"
it("bridge offers skip trunk bases, existing layers, taken parents and dismissed branches", …)
it("dismissing a bridge offer is remembered for that branch", …)                 // dismiss called with ("/r","step-2"); offers no longer has step-2
it("the banner shows the lowest problem at or below the current branch and Later hides it until it changes", …)
it("deleting the merged parent force-deletes it and clears the offer", …)        // deleteBranch("/r","step-1"); after.deleteOffer null
```

- [ ] **Step 2: Run** `pnpm vitest run src/composables/__tests__/useStacks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `useStacks.ts`, and add `stackBridgeDismissals: Record<string, string[]>` (default `{}`) to both `AppSettings` and `SettingsPanel`'s `Settings`. `useStacks()` binds `dismissed`/`dismiss` to `loadSettings().stackBridgeDismissals[normaliseCwd(cwd)]`.
- [ ] **Step 4: Run** the test, then `vue-tsc` as in Task 9. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `git add apps/desktop/src/composables apps/desktop/src/components/SettingsPanel.vue && git commit -m "feat(stack): useStacks orchestration, bridge from GitHub, post-restack offers"`

---

## Task 12 — Badges, bridge chips, context menu, Stack on…, locales

**Files:**
- Create: `apps/desktop/src/components/StackBadge.vue`, `apps/desktop/src/components/StackOnDialog.vue`
- Modify: `apps/desktop/src/components/RepoSidebar.vue` (pinned rows at line 1887, archived rows at 1931, context menu at 1956), `apps/desktop/src/components/header/BranchSelector.vue` (local rows at line 805, pinned rows near line 773), `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`
- Test: `apps/desktop/src/components/__tests__/StackBadge.test.ts` (create, `// @vitest-environment jsdom`), plus the locale key-parity check through the `i18n-sync` skill (audit mode).

**Interfaces:**
- `StackBadge.vue` props `{ layer: StackLayerStatus | null; offer: BridgeOffer | null }`, emits `restack: []`, `acceptOffer: []`, `dismissOffer: []`. It renders `↳ {parent}`, a state label for any state ≠ `up_to_date` (or when `inherited`, with `out_of_date` text), a `Restack` button when `layer.actionable`, and the chip `stacks.bridge.prompt` with Stack/Dismiss buttons when `offer` is set. Buttons use `--radius-sm` (never pill).
- `StackOnDialog.vue` (BaseModal) props `{ cwd: string; branch: string; candidates: string[]; forge: string | null }`, emits `close`. It calls `useStacks().stackOn(...)` itself and shows the Rust error inline. It shows `stacks.stackOn.forgeHint` when `forge !== "github"`.
- RepoSidebar menu: `Stack on…` for a local non-trunk branch (opens `StackOnDialog`, lazy), `Unstack` when `layerOf(b)`, `Restack…` when `actionableFor(b)` → `startRestack(cwd, actionableFor(b).branch)`.

en strings (fr in parentheses; es / pt-BR / zh-CN via `i18n-sync`):
```
stacks.state.out_of_date "out of date" ("pas à jour") · .parent_merged "parent merged" ("parent fusionnée") · .parent_missing "parent missing" ("parent introuvable") · .base_lost "base unknown" ("base inconnue")
stacks.badge.parent "↳ {0}" · stacks.restack "Restack" ("Restacker")
stacks.menu.stackOn "Stack on…" ("Empiler sur…") · .unstack "Unstack" ("Désempiler") · .restack "Restack…" ("Restacker…")
stacks.bridge.prompt "Stack {0} on {1}?" ("Empiler {0} sur {1} ?") · .accept "Stack" ("Empiler") · .dismiss "Dismiss" ("Ignorer")
stacks.stackOn.title "Stack {0} on…" ("Empiler {0} sur…") · .parent "Parent branch" ("Branche parente") · .confirm "Stack" ("Empiler")
stacks.stackOn.hint "GitWand will offer to restack {0} when its parent changes or is merged." ("GitWand proposera de restacker {0} quand sa parente change ou est fusionnée.")
stacks.stackOn.forgeHint "Squash merges of more than one commit are detected on GitHub only. On {0}, use Unstack once the parent is merged." ("Les squash merges de plusieurs commits ne sont détectés que sur GitHub. Sur {0}, utilisez Désempiler une fois la parente fusionnée.")
stacks.preview.moving "Branches that will move" ("Branches qui vont bouger") · .notInStack "(not in the stack)" ("(hors de la pile)")
```

- [ ] **Step 1: Write the failing test** (`StackBadge.test.ts`): actionable `out_of_date` renders `↳ step-1`, the text `out of date` and a Restack button that emits `restack`; `up_to_date` renders no state and no button; an `offer` renders `Stack step-2 on step-1?` and emits `acceptOffer`/`dismissOffer`.
- [ ] **Step 2: Run** `pnpm vitest run src/components/__tests__/StackBadge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both components and the RepoSidebar/BranchSelector wiring (components read `useStacks()` directly, like `TrackedIgnoredNotice` reads `useTrackedIgnored`). Add the keys to `en.ts` and `fr.ts`, then run `i18n-sync` mode 3 for `es`, `pt-BR`, `zh-CN`.
- [ ] **Step 4: Run** the test and `i18n-sync` mode 1 (audit). Expected: PASS, and 0 missing / 0 orphan keys in all 5 locales.
- [ ] **Step 5: Commit** `git add apps/desktop/src/components apps/desktop/src/locales && git commit -m "feat(stack): branch badges, bridge prompt, Stack on…/Unstack/Restack… menu"`

---

## Task 13 — Banner, restack dialog, App wiring, push toast

**Files:**
- Create: `apps/desktop/src/components/StackBanner.vue`, `apps/desktop/src/components/RestackDialog.vue`
- Modify: `apps/desktop/src/components/RepoSidebar.vue` (`<StackBanner>` right before `.commit-panel`, line 1545), `apps/desktop/src/App.vue` (watcher hook next to line 4443; `registerRestackHost` next to `registerMergeBackHost` line 2970; lazy `RestackDialog`; `setContext` watch; operation-state watch), locales ×5
- Test: `apps/desktop/src/components/__tests__/StackBanner.test.ts` (jsdom), plus manual QA in `pnpm dev:web` (Task 15).

**Interfaces:**
- `StackBanner.vue` (no props; reads `useStacks()`). Restack mode: the `banner` model's text (`stacks.banner.<kind>`, plus `stacks.banner.oldCommits` for `parent_merged`), and buttons `Preview restack` → `startRestack(cwd, layer.branch)` and `Later` → `later()`. `parent_behind`, `parent_missing` and `base_lost` show their text, with Unstack for `parent_missing`/`base_lost`. After mode (`after` set): the retarget line (`done`/`failed` + `Retry retarget`/`manual`), `Delete local {0}` when `deleteOffer`, `switch_error` text, and a dismiss ✕ that clears `after`.
- `RestackDialog.vue` (BaseModal, lazy in App, `v-if="stacks.flow.value.phase !== 'idle'"`): `fetching`/`planning` text, `refused` → `t('stacks.refusal.' + code, branch ?? '', path ?? '')`, `preview` → intro + `fetchWarning` + embedded `MergePreviewPanel` fed by its own `useMergePreview` instance through `computeRestackPreview({ onto: plan.onto_sha, upstream: plan.upstream_sha, branch: plan.top, label })` with `:moving-refs` = `plan.moving` mapped to `{branch, inStack}`; `@apply` → `applyRestack(preview.estimatedAutoResolutions.value)`. `residual` → `stacks.dialog.residual` and Close. `done` → `stacks.dialog.done`.
- App host: `apply` = `runApplyFromPreview("rebase", plan.onto_ref, estimated, { runRebase: () => gitRestack(cwd, plan.bottom, settings.value.defaultBranch || null, hints, previewed) })`. `offerPush` = `showDetailToast(t("stacks.push.offer", n), skipped.length ? t("stacks.push.skipped", skipped.join(", ")) : null, 10000, { action: { label: t("stacks.push.action"), run }, key: "stack-push" })`, or the `noLeases` text with no action. `pushMoved`'s results → `showDetailToast(t("stacks.push.done", ok, total), failures.join("\n") || null)`.
- Refresh hooks (D14): `repoWatcher.on(["head","refs"], () => watcherRefreshQueue.schedule("stacks", () => stacks.refresh(cwd)))`; `watch(repoFolderPath)` → refresh; `watch(() => prPanel.prs.value)` → `setContext` + refresh; `watch(() => repoOperationState.value?.state)`: from `rebase`/`rebase_interactive` to `clean` → refresh; `watch([repoFolderPath, currentBranch, branches])` → `setContext`.

en strings (fr in parentheses):
```
stacks.banner.parent_moved "{0} has new commits that {1} is not on yet." ("{0} a de nouveaux commits que {1} n'a pas encore.")
stacks.banner.parent_merged "{0} was merged into {1}." ("{0} a été fusionnée dans {1}.") · .parentMergedPr "{0} was merged into {1} (PR #{2})." ("{0} a été fusionnée dans {1} (PR #{2}).")
stacks.banner.oldCommits "{0} still contains its old commits." ("{0} contient encore ses anciens commits.")
stacks.banner.parent_behind "{0} is behind its remote. Pull {0} first, then restack." ("{0} est en retard sur son remote. Mettez {0} à jour, puis restackez.")
stacks.banner.parent_missing "{0} no longer exists locally." ("{0} n'existe plus en local.")
stacks.banner.base_lost "GitWand no longer knows where {0} sits on {1}. Stack it again to reset its base." ("GitWand ne sait plus où {0} se trouve sur {1}. Empilez-la de nouveau pour réinitialiser sa base.")
stacks.banner.preview "Preview restack" ("Prévisualiser le restack") · .later "Later" ("Plus tard")
stacks.after.retargeted "PR #{0} now targets {1}." ("La PR #{0} cible maintenant {1}.") · .retargetFailed "Could not retarget PR #{0} to {1}: {2}" ("Impossible de recibler la PR #{0} vers {1} : {2}")
stacks.after.retry "Retry retarget" ("Réessayer") · .retargetManual "Retarget the pull request of {0} to {1} on {2}." ("Reciblez la pull request de {0} vers {1} sur {2}.")
stacks.after.deleteParent "Delete local {0}" ("Supprimer {0} en local") · .switchFailed "Restacked, but could not switch back to {0}: {1}" ("Restack fait, mais impossible de revenir sur {0} : {1}")
stacks.push.offer "{0} restacked branches can be pushed." ("{0} branches restackées peuvent être poussées.") · .action "Push" ("Pousser")
stacks.push.skipped "Not pushed (no upstream): {0}" ("Non poussées (pas d'upstream) : {0}") · .done "Pushed {0} of {1}." ("{0} sur {1} poussées.")
stacks.push.noLeases "Restacked. Push the moved branches yourself: the remote positions read before the restack are no longer known." ("Restack fait. Poussez vous-même les branches déplacées : les positions distantes lues avant le restack ne sont plus connues.")
stacks.dialog.title "Restack {0}" ("Restacker {0}") · .fetching "Fetching…" ("Récupération…") · .planning "Preparing the restack…" ("Préparation du restack…")
stacks.dialog.intro.parent_moved "Moves {0} onto the new tip of {1}." ("Déplace {0} sur la nouvelle pointe de {1}.")
stacks.dialog.intro.parent_merged "Moves {0} onto {1}, without the commits of {2}." ("Déplace {0} sur {1}, sans les commits de {2}.")
stacks.dialog.fetchFailed "Fetch failed ({0}). Restacking onto the local {1}." ("Échec du fetch ({0}). Restack sur {1} en local.")
stacks.dialog.residual "The restack stopped on conflicts. Resolve them, then continue the rebase from the banner." ("Le restack s'est arrêté sur des conflits. Résolvez-les, puis poursuivez le rebase depuis le bandeau.")
stacks.dialog.done "Restacked." ("Restack terminé.")
stacks.refusal.rebase_in_progress "A rebase is already in progress." ("Un rebase est déjà en cours.") · .up_to_date "Nothing to restack." ("Rien à restacker.")
stacks.refusal.git_too_old "Restacking needs git 2.38 or later." ("Le restack nécessite git 2.38 ou plus récent.") · .detached "Check out a branch first." ("Placez-vous d'abord sur une branche.")
stacks.refusal.dirty "Commit or stash your changes first." ("Commitez ou remisez d'abord vos modifications.")
stacks.refusal.occupied "{0} is checked out in another worktree ({1}). Restacking would leave it behind." ("{0} est extraite dans un autre worktree ({1}). Le restack la laisserait en arrière.")
stacks.refusal.parent_behind "The parent is behind its remote. Pull it first." ("La parente est en retard sur son remote. Mettez-la d'abord à jour.")
stacks.refusal.no_remote_trunk "No origin branch for the trunk: fetch from origin first." ("Pas de branche origin pour le tronc : faites d'abord un fetch d'origin.")
stacks.refusal.no_old_base "GitWand cannot tell which commits belonged to the parent. Restack this branch by hand." ("GitWand ne peut pas savoir quels commits appartenaient à la parente. Restackez cette branche à la main.")
stacks.refusal.fetch_failed "Could not fetch: the merged commit may be missing locally. Try again when online." ("Fetch impossible : le commit fusionné peut manquer en local. Réessayez une fois en ligne.")
stacks.refusal.stale_preview "The stack changed since the preview. Preview again." ("La pile a changé depuis l'aperçu. Relancez l'aperçu.")
```

- [ ] **Step 1: Write the failing test** (`StackBanner.test.ts`, the store seeded through `createStacks` fakes, exported for tests as `__setStacksForTest`): an `out_of_date` model shows `step-1 has new commits that step-2 is not on yet.` and Preview calls `startRestack`; Later hides it; `after.retarget.state === "failed"` shows the retry button, which calls `retryRetarget`; `deleteOffer` shows `Delete local step-1`.
- [ ] **Step 2: Run** `pnpm vitest run src/components/__tests__/StackBanner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both components, the App wiring and the locale keys (en + fr by hand, the other three through `i18n-sync`).
- [ ] **Step 4: Run** `pnpm test` (whole desktop suite), `i18n-sync` audit and `vue-tsc`. Expected: all green, 0 missing keys. Then run `pnpm bundle-check`: the new components are lazy, so the main bundle must stay within budget.
- [ ] **Step 5: Commit** `git add apps/desktop/src && git commit -m "feat(stack): restack banner, preview dialog and push offer"`

---

## Task 14 — CHANGELOG and ROADMAP

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`), `ROADMAP.md` (table line 13, section `### v3.14.0` line 23; new `### v3.18.0 — Stacked Branches II` after `### v3.17.0`)

- [ ] **Step 1:** Add under `[Unreleased]` → `### Added` one entry: "**Stacked branches.** *Stack on…* records which branch a branch sits on (local git config). GitWand notices when the parent gets new commits or is merged (on GitHub, squash merges included; elsewhere, merge commits, rebase merges and single-commit squashes) and offers a one-click restack of the whole stack, conflict preview first. After a merge the child's GitHub PR is retargeted, then GitWand offers to push the moved branches (with a lease) and to delete the merged local branch. A layer checked out in another worktree, a dirty tree or git older than 2.38 are refused with the reason. An open PR based on another local branch suggests *Stack on…*." This text must match the shipped behaviour; adjust it if a decision changed during review.
- [ ] **Step 2:** In ROADMAP §v3.14.0, keep Restack, merged-PR detection and the GitHub retarget. Replace "Metadata in `.gitwand-workspace.json`" with "Metadata in local git config (`branch.<b>.gitwandParent` / `gitwandStackBase`)" and drop the Channel-progress clause (C8). Move to a new `### v3.18.0 — Stacked Branches II` section, and to the summary table, the deferred items: the Stacks tab in Today, the sidebar stack banner and `⌘⇧S`; Submit stack; the stale-head `sha` guard on every in-app PR merge; the Archived Branches "merged" hint; retargeting on GitLab / Azure DevOps; tree-shaped stacks; and the bottom-up restack for git < 2.38 if users ask. Point the v3.16.0 cleanup line (ROADMAP line 98) at `gh_branch_pr` as its merged-PR signal.
- [ ] **Step 3: Commit** `git add CHANGELOG.md ROADMAP.md && git commit -m "docs: stacked branches in Unreleased, defer stack UI extras to v3.18.0"`

---

## Task 15 — Full verification

- [ ] `cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test`
- [ ] `cargo build --example parity-probe && cd .. && pnpm test:parity`
- [ ] `pnpm --filter @gitwand/core build && pnpm -r run test && pnpm --filter @gitwand/desktop exec vue-tsc --noEmit -p tsconfig.json`
- [ ] Manual QA in `pnpm dev:web` on a scratch clone, with the repo injected through localStorage. Moment 1 on a 3-layer stack. Moment 2 after a real squash merge on a test GitHub repo: retarget, push toast, delete offer. A layer opened in a worktree from the worktree manager → refusal names it. Conflict → banner Continue → switched back and the badges clear. Abort → nothing changed.
- [ ] Fresh review of the whole diff (code-reviewer), fix every finding, and re-review until clean (max 10 passes).

---

## Self-review

**Spec coverage**
- §1–2 goals: detection (T3), restack (T4–T5), retarget (T7, T11), delete offer (T11, T13), push offer (T6, T11, T13).
- §2 non-goals deferred: T14.
- Anti-goals: "one layer left behind" is covered by T2 holders + T4 `occupied`; "phantom conflicts after a squash" by T4 `preview_restack_replays_only_the_layers_commits` + T5 moment-2 tests; "branch not in preview" by D21 + T4 + T10 `movingRefs` + the T5 stale-preview guard; "no push without asking" by T11 (a toast action only).
- §3: git config (T1), with the key renamed per D3. Bridge from GitHub: T11/T12. `headRefOid` fallback: T4/T7.
- §4: git version (D2, T2/T4); worktrees (T2/T4); clean tree (T4/T5); rebase plumbing (D1, T4); AGENTS.md (T6/T8/T9, locales T12/T13).
- §5.1: data model, linear-only and self-healing in T1/T3; rename/delete in T3 `renamed_or_deleted_parent…`.
- §5.2: Stack on… and Unstack (T1, T12); bridge with remembered dismissal (T11 D13); cycles (T1).
- §5.3: precedence, cherry fallback and propagation (T3, D7); refresh triggers (T13, D14).
- §5.4: fetch and remote trunk (T4, T11, D18); pending record (T1, T5, D4/D5); branch afterwards (T5 finalize); moment 1 and moment 2 commands (T5); retarget with retry (T11/T13); delete offer (T11/T13); preview listing layers (T10/T13); push with lease, skips listed (T6/T11/T13, D10); abort (T5).
- §5.5: UI in T12/T13 (D12).
- §6 test matrix:
  - moment 1: T5
  - multi-commit squash: T3/T5
  - 3 layers: T5
  - worktree refusal: T4
  - dirty: T4/T5
  - halt then continue, both moments: T5
  - local trunk behind: T5
  - second child refused: T1
  - abort: T5
  - missing base with and without `headRefOid`: T4

  Dev-server and parity: T8. CHANGELOG and ROADMAP: T14.

**Type consistency.** The Rust names (`StackReport`, `LayerStatus`, `RestackPlan`, `PreviewedRestack`, `MergedParentHint`, `FinalizedRestack`, `RestackRun`, `BranchPr`) are defined once (Shared Rust types, T7 for `BranchPr`) and mirrored field-for-field in T9's TS types (snake_case). Command argument names: Rust `configured_trunk` and `merged_parents` arrive from TS as `configuredTrunk` and `mergedParents` (Tauri converts top-level args). The nested `previewed` / hint objects stay snake_case. Refusal codes are listed once and reused by T4 (Rust), T9 (`RestackRefusalCode`) and T13 (`stacks.refusal.*` keys). `ApplyOptions.runRebase` (T10) is consumed by the T13 host. `useStacks` signatures (T11) are what T12/T13 components call.
