# Implementation Plan — v2.21.0 "Monorepo Scope"

> Status: approved · Branch: `feat/monorepo-scope`
> Design: [2026-06-17-monorepo-scope-design.md](./2026-06-17-monorepo-scope-design.md)

All decisions are locked per the design spec; this plan sequences and grounds them in verified code locations.

## Verified ground truth (real file:line)

- `detect_monorepo` — `apps/desktop/src-tauri/src/commands/ops.rs:2551` (today: pnpm + package.json `workspaces`). Returns `MonorepoInfo`.
- `MonorepoPackage` / `MonorepoInfo` — `apps/desktop/src-tauri/src/types.rs:279` / `:286` (serde field-name serialization, e.g. `is_monorepo`).
- Glob/enumeration helper `find_workspace_packages` — `apps/desktop/src-tauri/src/git/parse.rs:623` (only pnpm YAML + package.json `workspaces`; discovery hardcoded to `package.json`).
- `git_log` — `apps/desktop/src-tauri/src/commands/read.rs:611` (builds `args: Vec<String>`, returns `Vec<GitLogEntry>`, no pathspec).
- `git_status` — `read.rs:47`; `git_status_libgit2` `:75`; `git_status_cli` `:291`.
- `getGitLog` — `apps/desktop/src/utils/backend.ts:512` (6 params + dev-server fetch fallback `:548`).
- `detectMonorepo` wrapper + `MonorepoInfo` TS interface — `backend.ts:1836` / `:1845`.
- `WorkspaceConfig` — `backend.ts:2243` (`{ name, repos }`); `workspaceRead` `:2325`; `workspaceWrite` `:2335`.
- `useGitRepo.ts`: `repoStats` computed `:226`; `loadLog` `:451`; `loadMoreLog` `:482`; existing `watch(folderPath, …)` `:159`.
- `useCommitSearch.ts`: `filterCommitsLocal` `:48` (consumes a passed-in list — no change needed).
- `FolderDiffTree.vue`: `defineProps` `:33`, `defineEmits` `:42` (`select-folder`/`select-file`/`clear-filter`); folder click emit `:153`.
- `MonorepoPanel.vue` already calls `detectMonorepo` (`:3`/`:36`), emits `select-package` — reusable as picker base.
- `MonorepoPanel` and `CommitGraph` both mounted in `App.vue`.
- Locales: flat namespaced objects in `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`.

---

## Step 1 — Confirm `MonorepoPackage`/`MonorepoInfo` shape (Rust types)
- **Goal:** Verify existing structs suffice for all 6 managers; no schema change expected (`name`, `path`, `version`).
- **Files:** `types.rs:279-290`. `version` may be `""` for Cargo/go/nx — document that as acceptable.
- **Acceptance:** Compiles; no consumer requires non-empty version.

## Step 2 — Extend detection to 6 formats (Rust)
- **Goal:** Recognize pnpm, npm/yarn (existing) + Cargo `[workspace]`, `nx.json`, `turbo.json`, `go.work`. All glob expansion in Rust, zero Node.
- **Files:** `ops.rs:2551` (precedence: **pnpm > Cargo > go.work > nx > turbo > npm/yarn**); `parse.rs:623` (generalize `find_workspace_packages` with per-manager readers):
  - **Cargo:** parse `[workspace] members`/`exclude`, glob-expand, read each member `[package] name`/`version`.
  - **go.work:** parse `use (...)` + single-line `use ./x` → dirs; name = basename, version = `""`.
  - **nx:** scan `apps/`/`libs/` (respect `workspaceLayout.appsDir`/`libsDir`) for `project.json`/`package.json`.
  - **turbo:** `turbo.json` present → `manager: "turbo"`, reuse package.json `workspaces` enumeration.
  - Reuse `extract_json_string` (parse.rs:664) for JSON; TOML via minimal scanner or crate — see Open Decision 1.
- **Security:** every manifest-derived path through `safe_repo_path()` before FS read; malformed manifest → empty packages, never a hard error. `path` repo-relative.
- **Tests (real temp repos, one per format):** correct `manager` + package paths per format; precedence test (pnpm + Cargo → pnpm); malformed-manifest degrades to empty.

## Step 3 — `git_log` pathspec (Rust)
- **Files:** `read.rs:611`. Add `pathspec: Option<String>` (last param). After existing args (~`:662`), when `Some(p)` non-empty push `"--"` then `p`. Discrete `Vec<String>`, no interpolation. Return type unchanged.
- **Tests (real temp repo):** commits in `packages/a` vs `packages/b`; `pathspec="packages/a"` returns only `a`; `None` returns all.

## Step 4 — `git_rev_count` command (Rust)
- **Goal:** Unscoped (and scoped) total count for the badge; keeps `git_log` return type stable.
- **Files:** new `#[tauri::command] git_rev_count(cwd, branch: Option<String>, all: Option<bool>, pathspec: Option<String>) -> Result<usize, String>` in `read.rs`; register in `generate_handler!` (`lib.rs`).
- **Action:** `git rev-list --count` mirroring `git_log` ref selection, optional `-- <pathspec>`, discrete args; parse stdout → `usize`.
- **Tests (real temp repo):** count == unscoped `git_log` length for same ref; scoped count matches scoped `git_log`.

## Step 5 — Scoped `git_status` (Rust)
- **Files:** `read.rs:47` / `:291`. Add `pathspec: Option<String>`. `None` → current libgit2 fast-path. `Some(p)` → CLI path with `-- <p>` appended (discrete args). Add param to `git_status_cli` too.
- **Rationale:** preserves perf fast-path for the unscoped common case; parity tests unaffected when pathspec absent.
- **Tests (real temp repo):** dirty files in `packages/a`+`packages/b`; scoped reports only `a`; `None` reports both.

## Step 6 — Thread new commands through `backend.ts`
- **Files:** `backend.ts`.
  - `getGitLog` (`:512`): add `pathspec?: string`; pass `pathspec ?? null` in invoke (`:533`) + dev-server query (`:548`).
  - Add `getGitRevCount(cwd, branch?, all?, pathspec?)`.
  - `gitStatus` (`:340`): add optional `pathspec`, pass through.
  - `WorkspaceConfig` (`:2243`): add `scope?: string` (additive). `workspaceRead`/`workspaceWrite` unchanged.
  - Confirm Rust `WorkspaceConfig` tolerates the optional `scope` field — see Open Decision 2.

## Step 7 — New composable `useWorkspaceScope.ts`
- **Files:** new `apps/desktop/src/composables/useWorkspaceScope.ts`.
- **API:** module-scoped `activeScope: Ref<string | null>`; `setScope(path)` (persist via `workspaceRead` merge + `workspaceWrite`); `clearScope()`; `loadScope(repoPath)` (read persisted scope, validate it still exists, fall back to `null` + one-time non-blocking notice on invalid). Existence check — see Open Decision 3.
- **Constraint:** lives in `apps/desktop` (no Node-purity concern); no `AppSettings` field (locked).
- **Tests (TS):** persistence round-trip; invalid-scope fallback to whole repo (mock backend).

## Step 8 — Wire scope into `useGitRepo.ts`
- **Files:** `useGitRepo.ts`. Import `useWorkspaceScope`.
  - `loadLog` (`:451`)/`loadMoreLog` (`:482`): pass `activeScope.value ?? undefined` as `pathspec`.
  - Add `totalUnscopedCount` + `scopedTotalCount` from `getGitRevCount`; `hiddenCommitCount = computed(() => activeScope.value ? max(0, unscopedTotal − scopedTotal) : 0)` — see Open Decision 4.
  - `repoStats` (`:226`): feed scoped status (pass `pathspec` to `gitStatus` when scoped).
  - `watch(activeScope, …)` → reload log + status + rev counts. Shallow watch only (perf rule, no `deep`).
- **Tests:** scope change triggers refetch with pathspec (mock backend).

## Step 9 — Commit search (verify only)
- `useCommitSearch.ts:48`: confirm callers pass the already-scoped list. No edit. Search scoped for free.

## Step 10 — `ScopePicker.vue` (UI)
- **Files:** new `apps/desktop/src/components/ScopePicker.vue` (`<script setup>`), reuse `MonorepoPanel.vue`'s `detectMonorepo` as data source. Mount per Open Decision 5.
- **Behavior:** package → `setScope(pkg.path)`; "Whole repo" → `clearScope()`; "Custom folder…" → folder picker → `setScope`.
- **Constraint:** strings via `t('scope.*')`; lazy-load if behind `v-if`.

## Step 11 — Folder tree "Scope here" context menu
- **Files:** `FolderDiffTree.vue` (props/emits `:33`/`:42`). Add `@contextmenu` on folder rows + emit `scope-here: [path]` (parent wires to `setScope`); label `t('scope.here')`.

## Step 12 — Graph header chip + "N commits masqués" badge
- **Files:** `CommitGraph.vue` header (and/or App header). Chip shows `activeScope` + ✕ → `clearScope()`. Badge `t('scope.hidden', { count })` when `hiddenCommitCount > 0`; click → `clearScope()`. `computeDagLayout` unchanged on reduced set. No per-commit expansion (locked).

## Step 13 — i18n keys in all 5 locales
- **Files:** `locales/{en,fr,es,pt-BR,zh-CN}.ts`. Keys: `scope.picker`, `scope.wholeRepo`, `scope.here`, `scope.custom`, `scope.active`, `scope.hidden` (`{count}`), `scope.invalidNotice`. Use the `i18n-sync` skill; key-parity assertion passes.

## Step 14 — Release-time tasks (last, at tag time)
- `./scripts/bump-version.sh 2.21.0` (never hand-edit versions).
- `CHANGELOG.md`: `## [2.21.0] - <date>` Added entries (picker, 6-format detection, per-repo persistence, "Scope here").
- `website/changelog.md`: narrative mirror, frontmatter preserved, same commit.
- `roadmap.md`: move v2.21.0 block to Shipped; add any follow-ups (multi-package, partial expansion) to Planned.

---

## Resolved decisions (approved 2026-06-17)

1. **Cargo/nx parsing** — ✅ **hand-rolled scanner** in the `extract_json_string` style; no new Cargo dependency.
2. **Rust `WorkspaceConfig` tolerance** — ✅ add `scope: Option<String>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
3. **Invalid-scope existence check** — ✅ add a small `path_exists(cwd, rel)` backend command (via `safe_repo_path`).
4. **Hidden-count under pagination** — ✅ badge = `unscopedTotal − scopedTotal` (both via `git_rev_count`), stable across pagination. Supersedes the spec's earlier `total − scoped.length` wording (design doc updated).
5. **ScopePicker mount** — ✅ picker in `RepoSidebar.vue`; active-scope chip + hidden badge in `CommitGraph.vue` header.
