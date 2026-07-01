# File Explorer/Editor panel — design

Status: approved (brainstorming), ready for implementation plan.
Related roadmap entry: `roadmap.md` → "Later (unscheduled)".

## Problem

GitWand has no way to browse the full repo tree or view/edit an arbitrary file
without leaving the app. The existing `useFileTree` composable only builds a
tree from the list of *changed* files (Changes/History sidebar) — it has no
notion of the full working tree. The only related roadmap item
("In-app folder-browser + right-click 'Scope here'") is motivated by
Monorepo Scope, not by general file browsing, and its old substrate
(`FolderDiffTree`, a diff tree) has already been ruled out and unmounted.

## Goal

A Terminal-style panel, per repo, that lets the user:

1. Browse the full repo file tree (respecting `.gitignore`).
2. Open a file in a tab, see it with syntax highlighting.
3. Edit and save it (`⌘S`).
4. See at a glance (via a status dot) whether a file is staged / unstaged /
   untracked, without leaving the panel.

Explicitly **not** a goal for v1: staging, discarding, reverting, or
right-click "scope here" from this panel. Those stay in the existing Changes
view / the deferred folder-browser roadmap item, to avoid scope creep and
logic duplication.

## Non-goals / out of scope (v1)

- No Git actions (stage/unstage/discard/revert) from this panel.
- No "scope here" / monorepo-scope integration.
- No binary file preview (image/PDF renderer) — a binary file shows a
  "not editable" placeholder instead of attempting to load it as text.
- No LSP, autocomplete, multi-cursor, or other IDE-grade editing features —
  CodeMirror 6 with basic language-aware syntax highlighting only.

## Architecture

### Backend (Rust) — `apps/desktop/src-tauri/src/commands/files.rs`

New command:

```rust
#[tauri::command]
pub(crate) async fn list_repo_tree(cwd: String) -> Result<FolderNode, String>
```

- Built from `git ls-files --cached --others --exclude-standard -z`, invoked
  via the existing `git_cmd` helper (args array, never string interpolation —
  per `AGENTS.md` security rules) and split on NUL bytes.
- `--exclude-standard` makes this `.gitignore`-aware for free — no new crate
  (`ignore`, `walkdir`) needed, and it stays consistent with what `git status`
  already considers trackable.
- Tree construction reuses the existing `insert_change` / `sort_node` helpers
  in `files.rs` (already used by `folder_diff`), applied to a flat list of
  paths instead of `Change` entries.
- Every path is still resolved through `safe_repo_path()` before any
  filesystem touch — this command only returns paths, it doesn't read content.

No new read/write commands: `read_file` / `write_file` (already in
`files.rs`, already `safe_repo_path`-guarded) are reused as-is for opening and
saving tabs.

### Frontend state — `apps/desktop/src/composables/useFileExplorer.ts`

Mirrors `useTerminalSessions.ts`:

- `tabsByRepo: Map<string, FileTab[]>`, `activeByRepo: Map<string, string | null>`
  — one set of open-file tabs and one active tab per repo.
- `FileTab { path: string; content: string; originalContent: string; dirty: boolean }`
  — `dirty` is derived from `content !== originalContent`.
- Open-tab list and folder-expansion state persist per repo the same way
  terminal tabs do, so switching repos or restarting the app restores the
  previous session.
- `⌘S` saves the active tab (calls `write_file`, resets `originalContent`),
  `⌘W` closes the active tab (prompts via `askConfirm` if `dirty` — never the
  native `confirm()`), `⌘1..9` switches tabs, matching the terminal's
  existing shortcut scheme.

### Frontend tree building — `apps/desktop/src/composables/useRepoFileTree.ts`

- Calls `list_repo_tree`, exposes the same `TreeRow` shape
  (`kind: "folder" | "file"`, `path`, `name`, `depth`) that `useFileTree.ts`
  already defines, so the existing tree-row rendering markup/CSS can be
  reused for both the Changes tree and this one instead of writing a new
  renderer.
- Status dots read from the already-loaded `useGitRepo().status` (staged /
  unstaged / untracked) — no extra Tauri call, no polling.

### UI — `apps/desktop/src/components/FileExplorerPanel.vue`

Structural clone of `TerminalPanel.vue`:

- Same three layout modes — floating (draggable/resizable), docked bottom
  (full-width, resizable height), fullscreen — persisted in `localStorage`
  under `gitwand-explorer-{height,left,width,top}`.
- Mounted via `KeepAlive` in `App.vue` alongside `TerminalPanel`, so open
  tabs and scroll/cursor position survive hide/show.
- Left column: repo tree (`useRepoFileTree`). Right column: tab strip +
  CodeMirror 6 editor for the active tab.
- Tab strip: single-click opens in a reusable "preview" tab (replaced by the
  next single-click, VS Code-style); double-click or an edit pins it as a
  permanent tab. Dirty tabs show a dot instead of the close ✕ until hovered.
- CodeMirror 6 is lazy-loaded on first panel open (same pattern as xterm.js
  for the terminal) to keep cold-start cost down. Language mode picked from
  file extension.

### AppDock

New "Files" tile next to the existing Terminal tile in `AppDock.vue`, with
the same dropdown shape: layout picker (floating/bottom), fullscreen toggle,
hide-on-nav toggle.

### i18n

New keys added to all 5 locales (`apps/desktop/src/locales/`): panel title,
tab tooltips, AppDock tile label/tooltip, unsaved-changes confirmation
dialog text, binary-file placeholder text.

## Error handling

- File read/write errors (permission denied, file deleted externally) surface
  as a toast, not a crash; the tab stays open with its last-known content so
  the user doesn't lose in-progress edits.
- If a file is externally modified while open with unsaved local edits, the
  next save wins (no merge UI in v1) — acceptable since this is a lightweight
  viewer/editor, not the primary conflict-resolution surface.

## Testing

- Rust: a test spinning up a real temporary git repo (per `AGENTS.md` — no
  mocked git layer) with a `.gitignore` excluding a directory, asserting
  `list_repo_tree` omits ignored paths and includes tracked + untracked ones.
- `dev:web`: a mock route for `list_repo_tree` in the dev server, plus a
  typed wrapper in `backend.ts` — required in the same PR per the existing
  "every new Tauri command needs dev:web parity" rule.
- Frontend: unit tests for `useFileExplorer` covering per-repo tab isolation,
  dirty-state derivation, and the close-with-unsaved-changes confirmation
  path.

## Follow-ups (not in this design)

- Binary/image preview.
- Git actions from the panel (stage/discard/revert), if user feedback asks
  for it — would need explicit re-scoping to avoid duplicating the Changes
  view's logic.
- The deferred "folder-browser + right-click 'Scope here'" roadmap item
  remains separate; this panel's tree could later be reused as its substrate,
  but that's an explicit future decision, not implied by this design.
