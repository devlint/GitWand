# Desktop App

The GitWand desktop app is a lightweight, native Git client built with Tauri 2 and Vue 3. It covers the full daily workflow and adds smart conflict resolution on top.

## Repository View

The main interface shows staged, unstaged, untracked, and conflicted files in a sidebar. The main area displays inline diffs. You can stage, unstage, and discard changes without leaving the interface.

**Partial staging** is supported at the line or hunk level — select exactly what goes into your next commit.

## Commit Workflow

- Summary and description fields
- Optional commit signature
- `Ctrl+Enter` / `Cmd+Enter` shortcut to commit
- **Amend unpushed commits** — a pencil icon appears on hover in the history log, opening an overlay pre-filled with the existing message

## Branches

Click the branch name in the header to:

- Search branches
- Switch to a branch
- Create a new branch
- Delete a branch
- Merge any branch via the merge button

## Merge Preview

Before merging, GitWand predicts the outcome **without touching the working tree** using `git merge-base`, `git show`, and `git merge-file -p --diff3`.

The preview shows a per-file breakdown:

| Status | Meaning |
|--------|---------|
| Auto-resolvable | GitWand can handle it automatically |
| Partial | Some hunks need manual resolution |
| Manual | Complex conflicts requiring human judgment |
| Add/delete | File added on one side, deleted on the other |

A badge summarises the overall result: `Clean merge`, `100% auto-resolvable`, or `N conflicts to review`.

## Push & Pull

One-click push and pull with badge counters showing ahead/behind commits. Auto-fetch runs in the background every 30 seconds.

## History & Graph

Browse the full commit log in the sidebar. Click any commit to see its diff with a file list and scroll-spy highlighting.

Long commit descriptions collapse to 2 lines with an expand toggle.

A separate **DAG graph view** renders the full branch topology as an SVG with lane layout and ref badges.

## Diff Viewer

- Side-by-side or inline toggle (persisted across sessions)
- Syntax highlighting for 30+ languages
- Word-level diff using LCS
- Collapsible unchanged regions
- Canvas minimap
- Hunk navigation (prev/next)
- Double-column line numbers

## File History & Blame

- Full file history with `git log --follow`
- Blame view grouped by commit
- Time-travel diff between any two versions of a file

## Repo Switcher

Click the repo name in the header to open a dropdown with all recently opened repositories. Pin favorites, remove entries, and switch instantly.

## Pull Requests

Browse, create, checkout, and merge GitHub PRs without leaving the app:

- PR list in the sidebar
- Full detail view: diff, CI checks, comments, inline review
- Inline comments anchored to diff lines with full threading
- Code suggestions via ` ```suggestion ``` ` blocks, applicable in one click

## Settings

- **Language**: French / English
- **Theme**: Light / Dark
- **Commit signature**: Optional GPG signing
- **Diff mode**: Side-by-side or inline (default)
