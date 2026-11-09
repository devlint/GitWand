---
title: 'GitWand desktop app — native Git client for macOS, Linux, Windows'
description: 'A native ~8 MB Git client (Tauri 2 + Vue 3): staged/unstaged diffs, hunk-level staging, Git Tree history, branch and worktree management, PR review, and conflict auto-resolution.'
---

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

**Reset** offers four modes: soft, mixed, hard and **Keep** (v3.12.3), which drops commits like hard but keeps your uncommitted edits, and refuses, naming the files, if one of them would be overwritten. After rebasing a branch you had already pushed, the main action becomes **Force Push**, which refuses if someone else pushed in the meantime.

With **Auto fast-forward** on (Settings → Git, off by default), the background fetch moves your current branch forward when it is simply behind its upstream. It never merges, rebases or stashes, and when something holds it back the sync button's tooltip says what.

When a tracked file matches a `.gitignore` rule (so the rule has no effect on it), the sidebar says so and offers to untrack it: the file stays on disk and the removal is staged.

## Worktrees & AI tasks

A worktree is a second checkout of the same repository, on another branch, in another folder. GitWand 3.13 treats each one as an environment your repository knows how to bring up and tear down. A step-by-step walkthrough is on the blog: [Git worktrees in GitWand, step by step](/blog/worktrees-step-by-step).

### Creating a worktree

Open **Worktrees** from the header or the command palette.

- **⚡ New task** (`⌘⇧N`): type a name; the worktree is created and opened in a new tab.
- **New worktree**: the full form, to pick the path, the branch or the base yourself.
- **New AI task**, in the **+** menu of the terminal panel: the same worktree, with Claude Code started in it.

By default the worktree starts from the **freshly fetched remote default branch**. The dialog says which base it used ("Based on origin/main, fetched 2 s ago"); offline, it falls back to the local tracking branch, then to `HEAD`, and says so. It goes in `<repo>.worktrees/<name>` on a branch `task/<name>`, created without upstream tracking so a push from the task cannot land on `main`.

### Setup, teardown and URL

A `worktree` section in `.gitwandrc` tells GitWand how to prepare a worktree (see the [configuration reference](/reference/config#worktrees)):

- `include` copies (or links) ignored files such as `.env` from your main checkout. A `.worktreeinclude` file is read too.
- `setup` runs once the worktree exists, in a read-only terminal tab, **Setup · &lt;name&gt;**. If it fails, the worktree is kept with **Retry setup**, **Open the log** and **Remove**. An AI task's agent starts only after setup succeeds.
- `url` prints the environment's address, shown on the worktree with an **Open** button.
- `teardown` runs before the worktree is removed.

The first time GitWand is about to run these commands in a repository, it shows them verbatim and asks: **Trust and run**, **Skip commands this time** or **Cancel**. The trust is remembered per repository, outside the repository, and asked again whenever the commands change. They are always read from the main checkout, never from the worktree's own copy.

### Merging the work back

**Merge back**, on an AI task or on a worktree in the manager, brings the work into a branch (by default the one the task started from), in one of three modes:

| Mode | Result |
|------|--------|
| **Merge** | A merge commit on the target; the task's commits are kept |
| **Rebase** | The task's commits replayed onto the target, which then fast-forwards |
| **Squash** | The changes staged on the target, uncommitted, for you to write the commit |

GitWand refuses, and says why, when your main checkout is on another branch (it offers to switch when the checkout is clean), in the middle of an operation, or has uncommitted changes to files the task also changes. It never stashes for you. It then stops the task's processes, commits what the task left uncommitted as `wip(<name>): uncommitted work at merge-back`, snapshots both checkouts, shows the usual merge preview and applies. Conflicts the engine leaves stay for you in the right checkout, never aborted; the dialog waits with **Resume**.

### Removing a worktree

Every removal (worktree manager, AI-task close, Git Tree, cleanup after a merge-back) follows the same sequence:

1. **Guards.** A locked worktree is never touched (an **Unlock** button is offered). Neither is one with a `.worktree-keep` file, unless GitWand created it, nor one that another tool (Claude Code, Conductor, Superset) manages.
2. **Processes.** GitWand closes the worktree's terminals and stops what it started there. Other processes still running inside it are listed, not killed, with **Retry** and **Stop all**.
3. **Snapshot** of the worktree's files, committed or not.
4. **Teardown**, in a read-only tab. If it fails, the worktree is kept, with **Retry teardown**, **Open the log** and **Remove anyway**.
5. **Removal.** A `task/` branch that is fully merged is deleted with it.

A worktree GitWand did not create asks for one more confirmation. Ignored files are not in the snapshot: `include` brings them back, and outside state (containers, databases) is teardown's job.

### Restoring a removed worktree

The **Time Machine** lists removed worktrees, and tasks as they were before a merge-back, under **Removed worktrees**. **Restore as worktree** creates `<name>-restored` on `restore/<name>`, puts the uncommitted files and the index back, copies the `include` files and runs `setup` again.

## Time Machine

GitWand snapshots your working tree and index before the operations that rewrite them: discard, reset, checkout, applied resolutions, merge-back and worktree removal. The **Time Machine** lists these snapshots alongside git's own reflog, and **Restore** puts the working tree, index and branch back to any of them, after taking a snapshot of the current state, so a restore is itself undoable.

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

The preview also covers **rebase** (replayed commit by commit) and **cherry-pick**.

### Merge & auto-resolve (v3.11)

**Merge & auto-resolve** runs the real operation, re-runs the engine against what git actually produced, applies every resolution that clears your confidence bar, stages it, and stops with the operation still in progress on whatever needs you. It never aborts on your behalf and never continues past a conflict left for you. The button says "Estimated N of M hunks" because the preview is a simulation; if the real merge differs, the report says so.

The merge editor lists every proposed resolution with its score and a checkbox, so you can decline one hunk without declining the rest. Set a minimum score in **Settings → AI (Core & Setup) → Resolution confidence**, or `minConfidenceScore` in `.gitwandrc`.

Merge, rebase, cherry-pick and revert share one banner with **Continue** and **Abort**. Nothing continues by itself when the last conflict is resolved, and an abort that would discard resolution work asks first.

## Push & Pull

One-click push and pull with badge counters showing ahead/behind commits. Auto-fetch runs in the background every 30 seconds.

## History & Graph

Browse the full commit log in the sidebar. Click any commit to see its diff with a file list and scroll-spy highlighting.

Long commit descriptions collapse to 2 lines with an expand toggle.

A separate **DAG graph view** renders the full branch topology as an SVG with lane layout and ref badges.

### Git Tree

The **Git Tree** is the main history view. Your uncommitted changes are a **WIP row** at the top of the graph, shown only when there are any (v3.12.1). Selecting it turns the right rail into the files and commit pane; a diff opens once you pick a file. The graph follows every ref move as soon as it happens, including resets, checkouts and branches created on older commits, even when you run them from a terminal (v3.12.5).

The commit context menu includes **Cherry-pick onto current branch as WIP** (v3.12.0): the commit's changes land in your index and working tree without being committed, so you can trim, split or fold them into your own work first.

## Diff Viewer

- Side-by-side or inline toggle (persisted across sessions)
- Syntax highlighting for 30+ languages
- Word-level diff using LCS
- Collapsible unchanged regions
- Canvas minimap
- Hunk navigation (prev/next)
- Double-column line numbers

## Image Diff Viewer (v1.6)

Binary image files in a commit diff render side-by-side instead of the opaque "Binary file changed" line. Four comparison modes are available via a toggle:

| Mode | What it does |
|------|--------------|
| Side-by-side | Before / after with dimension + size metadata overlay |
| Overlay | Stacked images with an opacity slider |
| Blink | Alternates between the two images to reveal pixel-level deltas |
| Slider | Draggable reveal between before and after |

Supported formats: **PNG, JPG, WebP, GIF, SVG**. GIFs get an "animated" badge. SVGs render as raster (so you see the actual image) — the text diff remains available via the file history. Images larger than 20 MB per side are skipped with an explicit notice to keep the viewer snappy.

Under the hood, a new `read_file_at_revision(path, rev)` backend command (available in both the Rust/Tauri and Node dev-server paths) fetches file bytes at any git revision, so the viewer can compare `HEAD^` vs `HEAD`, across branches, stashes, or arbitrary refs.

## Folder Tree in Commit Diff (v1.6)

The file list on the right of the commit diff has a **flat ↔ tree** toggle. Tree mode collapses deeply-nested changes into an expandable folder tree with per-folder aggregates (files changed, additions, deletions), making a 200-file commit navigable at a glance.

- Click any folder to **filter the list** down to its descendants
- Breadcrumb at the top surfaces the active filter with a clear (×) button
- Sidebar is **resizable** — drag its left edge, or double-click to reset. Width is clamped 180–600 px and persisted across sessions
- Keyboard navigation throughout (arrow keys, Enter, Esc)
- Available in all five UI locales

The backing `folder_diff` backend command (Rust/Tauri + Node dev-server + TypeScript wrapper) builds the aggregated tree.

## File Explorer (v3.11.2)

The **Files** tile in the dock opens the File Explorer, with the working tree on the left and your open files on the right. You can also open it from the command palette (**Toggle File Explorer**) and, on macOS, the **View** menu. It can float, dock at the bottom or go full-screen.

- **Status at a glance.** Changed files carry a letter (M, A, D, R, U, C), and every folder above a change carries a count, even a folder you have not opened. Deleted files stay in place, struck through.
- **Ignored files on demand.** They are hidden by default. **Show ignored** shows them greyed out, and they are still loaded one folder at a time. A folder lists its first 5,000 entries.
- **Keyboard.** Use ↑ ↓ to move. → expands a folder and then steps into it, and ← collapses it and then climbs to the parent. Enter opens a file in the preview tab or toggles a folder, and a double click pins the tab. Home and End jump to the ends, and you can type the start of a name to jump to it. ⇧F10 opens the context menu.
- **Diff or file.** A changed file opens on its inline diff, with a **Working tree | Index** switch when it is both staged and modified. **Diff | File** in the toolbar switches to the editor, where you can edit, save and show blame. The diff always shows the file on disk, so **Diff** is available again once you save. Unchanged files open in the editor. A conflicted file offers **Open in merge editor**.
- **Context menu.** On a file: **Open in editor**, **Copy path** and **Reveal in Finder**. On a folder: **Scope here**, which narrows the app to that folder and re-roots the tree (**Whole repo** goes back), **Copy path** and **Reveal**.
- **Live.** The tree and an open diff follow changes on disk through the Live Repo watcher.

Staging stays in **Changes**.

## File History & Blame

- Full file history with `git log --follow`
- Blame view grouped by commit
- Time-travel diff between any two versions of a file

## Repo Switcher

Click the repo name in the header to open a dropdown with all recently opened repositories. Pin favorites, remove entries, and switch instantly.

## Pull Requests & Merge Requests

Browse, create, checkout, and merge PRs without leaving the app. GitWand supports **GitHub**, **GitLab**, **Bitbucket Cloud**, **Azure DevOps**, and self-hosted **Gitea** and **Forgejo** (v3.11, personal access token) — detected automatically from the remote URL.

- PR/MR list in the sidebar
- Full detail view: diff, CI checks, comments, inline review
- Inline comments anchored to diff lines with full threading
- Code suggestions via ` ```suggestion ``` ` blocks, applicable in one click
- **Draft → Ready** — convert a draft PR/MR to ready-for-review in one click
- **Auto-merge** (v3.11) — a PR whose checks have not finished can be set to merge itself once they pass, on GitHub, GitLab and Azure DevOps
- **Act on comments** (v3.12.3, GitHub) — reply to a review thread, edit or delete your own comments, resolve a conversation, copy a comment's link
- **Edit the title and description** (v3.12.1), by hand or redrafted by the AI from the commits and diff; nothing reaches the forge until you apply it
- Images in descriptions and comments load only when you click **Show images**, so their host cannot tell when you read them

### Multi-account support (v2.10)

Connect multiple accounts per forge — personal + work GitHub, GitLab on multiple instances, Bitbucket Cloud. GitWand resolves the right account for each repo automatically. Credentials are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Configure in **Settings → Accounts**. Gitea and Forgejo servers connect with a personal access token.

## AI Everywhere (v1.3)

AI is woven into every step of the workflow. Each suggestion is opt-in (explicit button or shortcut) and traceable (the prompt and provider used are visible). Works with any configured AI provider — Claude Code CLI, Claude API, OpenAI-compatible, or Ollama.

### PR & branch workflow

- **AI branch name** — propose a `feat/…` / `fix/…` name from a description or the staged diff instead of typing one
- **AI PR title & description** — `PrCreateView` analyses the commits in `currentBranch..base` and drafts a structured title + body (summary, test plan, breaking changes)
- **Hunk-level critique in the PR Intelligence panel** — per-hunk feedback on risks, regressions, and concrete suggestions (replaces the static-heuristics panel)

### Merge & rebase insight

- **Natural-language conflict explanation** — in the merge editor, the `DecisionTrace` is rendered in plain English ("this hunk changes the `login()` signature on both sides — manual required")
- **Pre-merge AI risk summary** — the merge preview complements the `merge-tree` simulation with an AI risk read ("3 files touch auth, high regression probability if untested")
- **Semantic squash in interactive rebase** — AI groups candidate commits by intent and proposes a combined message

### Commit & stash

- **AI stash message** — before `git stash` (and in the switch-branch flow), AI proposes a message from the unstaged diff
- **AI-ranked Absorb target** — when the selected lines span multiple commits, AI ranks candidates semantically instead of taking the first `git blame` hit

### History & search

- **Natural-language commit search** — query the log with plain-English questions ("when did we introduce log pagination?")
- **Blame context** — "why did this line change?" button on each blame block, answered with context from neighbouring commits
- **AI release notes generator** — produce structured markdown (Added / Changed / Fixed) from `git log <tag>..<tag>`, ready to paste into a GitHub release

### Dashboard

- **Rotating feature tips** — the empty state before repo selection cycles through ~20 localised tips every 30 s to surface features you might not have discovered

## MCP Catalog (v2.10)

The **MCP** tab in Settings is a built-in browser for the MCP ecosystem. It lets you install any MCP server into your AI client's config file without opening a terminal or editing JSON manually.

**Supported config targets** — detected and written automatically:

| Config file | Client |
|-------------|--------|
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop (macOS) |
| `~/.claude.json` | Claude Code (global) |
| `~/.cursor/mcp.json` | Cursor |
| `~/.windsurf/mcp.json` | Windsurf |

**Smart search input** — the search bar understands three input types:

- **URL** (`https://registry.modelcontextprotocol.io/servers/…`) — deep-links directly to that server's install card
- **Package** (`@scope/name` or `name`) — installs the npm package directly without searching
- **Text** — searches names, descriptions, and package identifiers

**Installed detection** — each config file is scanned at open time. Servers already configured anywhere show an "Installed" badge on their card so you never add a duplicate entry.

**`@gitwand/mcp` is pinned at the top** — with a "Reconfigure" button that pre-fills the install fragment with `--cwd /path/to/current/repo` automatically.

See [MCP Server guide](/guide/mcp) for full documentation of the server itself.

## Auto-update & version

On launch, GitWand checks for a newer version and shows a toast when one is available. You can also check by hand with **Check for updates**, at the bottom of the Settings menu: the button shows a spinner while checking, a green "Up to date" confirmation for a few seconds, or opens the update modal immediately if a new version is found.

## Settings

Settings (`⌘,` / `Ctrl+,`) fills the window, with a menu on the left and a title and one-line description on every page. The menu is grouped into five sections:

**Application**
- **General** — interface language, theme, notifications, update channel, privacy (images in PRs and READMEs, Gravatar, anonymous launch event), and on Linux, software rendering
- **Dock** — which views appear in the dock, in what order, and where the app opens
- **Dashboard** — which sections the repository dashboard shows, and whether the README comes first
- **Editor** — external editor and how diffs and code are displayed
- **Terminal** — integrated terminal layout, shell and appearance

**Repository**
- **Git** — Git executable, identities, commit templates, pull, branch switching, blame, and Auto fast-forward
- **Hooks** — scripts that run on Git events in the current repository
- **Accounts** — connect GitHub, GitLab, Bitbucket, Azure DevOps, Gitea and Forgejo accounts (credentials in the OS keychain)

**AI & Agents**
- **AI (Core & Setup)** — enable AI, choose a provider and model, and set the resolution confidence bar
- **MCP** — browse and install MCP servers (see [MCP Catalog](#mcp-catalog-v2-10) above)
- **Automations** — opt-in tasks that run on Git events or on a schedule

**AI Templates**
- **Commit message**, **Pull request**, **Release notes** — the prompt template and output language for each kind, per repository

**System**
- **Logs** — recent errors and warnings, with copy-all and clear actions
