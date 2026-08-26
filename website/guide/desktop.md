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

## File History & Blame

- Full file history with `git log --follow`
- Blame view grouped by commit
- Time-travel diff between any two versions of a file

## Repo Switcher

Click the repo name in the header to open a dropdown with all recently opened repositories. Pin favorites, remove entries, and switch instantly.

## Pull Requests & Merge Requests

Browse, create, checkout, and merge PRs without leaving the app. GitWand supports **GitHub**, **GitLab**, and **Bitbucket Cloud** — detected automatically from the remote URL.

- PR/MR list in the sidebar
- Full detail view: diff, CI checks, comments, inline review
- Inline comments anchored to diff lines with full threading
- Code suggestions via ` ```suggestion ``` ` blocks, applicable in one click
- **Draft → Ready** — convert a draft PR/MR to ready-for-review in one click

### Multi-account support (v2.10)

Connect multiple accounts per forge — personal + work GitHub, GitLab on multiple instances, Bitbucket Cloud. GitWand resolves the right account for each repo automatically. Credentials are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Configure in **Settings > Comptes**.

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

On launch, GitWand checks for a newer version and shows a toast when one is available. You can also trigger a manual check from **Settings > Système > Vérifier les mises à jour** — the button shows a spinner while checking, a green "Up to date" confirmation for a few seconds, or opens the update modal immediately if a new version is found.

## Settings

The Settings panel (keyboard shortcut: `⌘,` / `Ctrl+,`) has a left-side navigation sidebar grouped into four sections:

**Application**
- **Général** — language, theme, notifications, update channel, Launchpad options
- **Éditeur** — font size, tab size, diff mode

**Dépôt**
- **Git** — default branch, pull mode, switch behavior, commit signature, blame algorithm
- **Hooks** — manage Git hooks for the current repo
- **Comptes** — connect GitHub, GitLab, and Bitbucket accounts (credentials in OS keychain)

**IA & Agents**
- **IA** — enable AI, choose provider (Claude Code CLI / Claude API / OpenAI-compatible / Ollama), API key
- **MCP** — browse and install MCP servers (see [MCP Catalog](#mcp-catalog-v2-10) above)
- **Automations** — auto-resolve, nightly pull, release notes, AI commit batch

**Système**
- **Logs** — activity log with copy-all and clear actions
- **Vérifier les mises à jour** — manual update check
