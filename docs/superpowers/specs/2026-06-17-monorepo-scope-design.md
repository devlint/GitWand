# v2.21.0 — Monorepo Scope — Design

> Status: approved (brainstorming) · Target version: 2.21.0 · Date: 2026-06-17

## Goal

Make GitWand ergonomic on large monorepos (pnpm, Cargo, Nx, Turbo, Go) by letting the
user pick a **single sub-workspace**. When a scope is active, the commit graph, commit
search, and repo stats all scope to that sub-tree. Scope is persisted per repo. The user
can also scope to an arbitrary folder via right-click, without any config.

This is the full v2.21.0 scope (all four roadmap sub-features in one iteration):
1. Workspace scope picker + filtering of graph / search / stats
2. Auto-detection of 5 workspace formats
3. Scope persisted per repo in `.gitwand-workspace.json`
4. Right-click on a folder → "Scope here"

## Decisions locked during brainstorming

- **Single scope at a time.** Roadmap says "select *a* sub-workspace" (singular). Data
  model is `scope: string | null` — a repo-relative directory path, never an array.
- **DAG behavior = filter + badge.** When scoped, the DAG shows only commits touching the
  sub-tree (git history simplification), plus a "N commits masqués" badge with the hidden
  count and a one-click clear. No partial per-commit expansion in v1.
- **Persistence is additive.** `scope` is a new optional field in the existing per-repo
  `.gitwand-workspace.json`. No migration, no new file.
- **No new `AppSettings` field.** Scope is per-repo state, not a global setting — the
  `useSettings.ts` ↔ `SettingsPanel.vue` sync rule does not apply.

## Non-goals (YAGNI)

- Multi-package / multi-path scope selection.
- Partial expansion of hidden commits inside the DAG (badge is count + clear only).
- Scoping the working-tree diff editor or PR views (out of roadmap scope for v2.21.0).
- Persisting scope globally or syncing it across machines.

---

## Architecture

### Data model

A scope is one repo-relative directory path (e.g. `packages/core`) or `null` (whole repo).

`.gitwand-workspace.json` (per repo root) gains an optional field:

```jsonc
{
  "name": "...",
  "repos": [ /* existing multi-repo config, untouched */ ],
  "scope": "packages/core"   // NEW — optional, absent === whole repo
}
```

`WorkspaceConfig` in `apps/desktop/src/utils/backend.ts` adds `scope?: string`.
Reading a file without the field yields `scope: undefined` → treated as whole repo.

### Units

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `detect_monorepo` (Rust, `commands/ops.rs`) | Detect workspace format + enumerate packages | filesystem, glob |
| `git_log` (Rust, `commands/read.rs`) | Return commits, now pathspec-aware, + total count | git CLI / libgit2 |
| `git_status` path variant (Rust, `commands/read.rs`) | Status scoped to a sub-tree | git CLI / libgit2 |
| `useWorkspaceScope.ts` (new composable) | Own reactive `activeScope`, persist via workspace read/write | `backend.ts` |
| `useGitRepo.ts` | Thread `activeScope` into log/status fetches | `useWorkspaceScope`, `backend.ts` |
| `ScopePicker.vue` (new) | Dropdown UI: detected packages + whole repo + custom folder | `useWorkspaceScope`, `detect_monorepo` |
| Folder tree context menu | "Scope here" entry → `setScope(path)` | `useWorkspaceScope` |
| Graph header chip + badge | Show active scope, hidden-count badge, clear | `useWorkspaceScope` |

---

## Component details

### 1. Auto-detection (Rust — extend `detect_monorepo`)

Today `detect_monorepo` in `apps/desktop/src-tauri/src/commands/ops.rs` handles 2 formats
(`pnpm-workspace.yaml`, `package.json` `workspaces`). Extend to 6, all glob-expanded in
Rust (no Node dependency):

- `pnpm-workspace.yaml` — existing
- `package.json` `workspaces` (npm / yarn) — existing
- **`Cargo.toml`** `[workspace].members` (+ exclude), glob-expand member globs
- **`nx.json`** — project detection via `workspaceLayout` / project globs (`project.json` /
  `package.json` scan under `apps/`, `libs/`)
- **`turbo.json`** — Turbo defers package definition to `package.json` workspaces; detect
  presence → `manager: "turbo"`, reuse the package.json workspace enumeration
- **`go.work`** — parse `use (...)` directives → package dirs

Returns the existing `MonorepoInfo { is_monorepo, manager, packages: [{ name, path, version }] }`,
now populated for all 6 managers. `path` is repo-relative (the scope value). When several
manifests coexist, prefer the most specific workspace manifest (documented precedence:
pnpm > Cargo > go.work > nx > turbo > npm/yarn).

### 2. Path filtering — `git_log` (Rust)

`commands/read.rs::git_log` gains `pathspec: Option<String>`:

- When `Some(p)`, append `-- <p>` after all existing args (count/all/author/offset/branch).
  Git performs history simplification automatically.
- Return both the scoped commit list **and** an unscoped total so the UI can compute the
  hidden count. Two viable shapes — pick one in the plan:
  - (a) extend the return type with `total_unscoped: usize`, computed via a cheap
    `git rev-list --count <range>` without the pathspec, or
  - (b) a separate lightweight `git_rev_count(cwd, branch, all)` command the UI calls once.
  Recommendation: (b) — keeps `git_log`'s return type stable and the count cache cheap.

`getGitLog` in `backend.ts` and the call in `useGitRepo.ts` thread `pathspec` through.
Graph re-fetches when `activeScope` changes (watcher).

### 3. Path filtering — stats (Rust)

`repoStats` (computed in `useGitRepo.ts` from `git_status`) must scope to the sub-tree.
Add a pathspec arg to `git_status` (or a `git_status_in_path` variant) that limits the
porcelain v2 status to the scoped directory. `repoStats` recomputes from the scoped status.
Keep the libgit2 fast-path; fall back to CLI with pathspec when scoped.

### 4. Path filtering — commit search

`useCommitSearch` / `filterCommitsLocal` already operate on whatever commit list they
receive. Because the graph feeds them the already-scoped list, search is scoped for free —
no code change beyond confirming it consumes the scoped `commits` ref.

### 5. DAG behavior (filter + badge)

- `computeDagLayout` runs unchanged on the reduced (scoped) commit set; git already
  reconnects parent/child edges across omitted commits.
- The graph header renders a **"N commits masqués"** badge where
  `N = unscopedTotal − scopedTotal`, both obtained from `git_rev_count` (with and without
  pathspec) so the count stays stable across pagination. Clicking the badge calls
  `clearScope()` (full reveal). No per-commit partial expansion in v1.

### 6. UI surfaces

- **`ScopePicker.vue`** in the repo sidebar header: dropdown listing detected packages
  (from `detect_monorepo`), a "Whole repo" reset entry, and "Custom folder…" (opens the
  folder tree / native picker). Active scope shown as a chip.
- **Folder tree context menu**: add a "Scope here" entry on folder nodes →
  `setScope(node.path)`. Enables arbitrary, non-detected folders.
- **Graph header chip**: shows active scope path with an ✕ to clear; sits next to the
  hidden-count badge.

### 7. i18n

New keys in all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) under a `scope.*` namespace:
`scope.picker`, `scope.wholeRepo`, `scope.here`, `scope.custom`, `scope.hidden` (with count
interpolation), `scope.active`. No hardcoded UI strings.

---

## Data flow

```
detect_monorepo (Rust)  ──► ScopePicker options
                                  │ user selects, or right-click "Scope here"
                                  ▼
                         useWorkspaceScope.setScope(path)
                                  │ persists → .gitwand-workspace.json (scope field)
                                  ▼  activeScope ref changes
                         useGitRepo watcher re-fetches
                          ├─ git_log(..., pathspec)        ──► scoped commits ──► CommitGraph + search
                          ├─ git_rev_count(...)            ──► total ──► "N masqués" badge
                          └─ git_status(..., pathspec)     ──► repoStats (scoped)
```

## Error handling

- Invalid / deleted scope path (folder removed since persisted): detect on load, fall back
  to whole repo, surface a one-time non-blocking notice. Never block the repo from opening.
- All filesystem reads of user-supplied paths go through `safe_repo_path()` — no inline
  path validation.
- Git commands built as discrete arg arrays (`--` separator), never string interpolation.
- `detect_monorepo` failures (malformed manifest) degrade gracefully: that format yields no
  packages rather than erroring the whole detection.

## Testing

- **Rust (real temp repos, one per format):** `detect_monorepo` enumerates the correct
  packages for pnpm / npm / Cargo / nx / turbo / go.work; `git_log` with pathspec returns
  only commits touching the sub-tree; `git_rev_count` matches unscoped total; scoped
  `git_status` reports only sub-tree changes.
- **TS:** `useWorkspaceScope` persistence round-trip (set → write → read → restore);
  scoped commit list drives search correctly; invalid-scope fallback to whole repo.
- **Parity / i18n:** confirm all 5 locales carry the new `scope.*` keys.

## Rollout

Single feature branch, full v2.21.0. Version bump via `./scripts/bump-version.sh 2.21.0` at
release time (never hand-edit version files). Update `CHANGELOG.md` + `website/changelog.md`
in the same commit at tag time, and move the v2.21.0 roadmap block into Shipped.
