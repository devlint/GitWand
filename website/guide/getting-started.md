---
title: Getting Started — GitWand
description: Install GitWand as a desktop app, CLI tool, or VS Code extension. All three share the same conflict resolution engine. macOS, Linux, Windows.
---

# Getting Started

GitWand is available as a desktop app, a CLI tool, and a VS Code extension. Install whichever fits your workflow — they all share the same conflict resolution engine.

## Desktop App

Download the latest release for your platform:

- **macOS** — `.dmg` (Universal: Apple Silicon + Intel)
- **Linux** — `.AppImage` or `.deb` (also available in the AUR as `gitwand-bin`)
- **Windows** — `.msi` or `.exe`

👉 [Download from GitHub Releases](https://github.com/devlint/GitWand/releases)

Or use your package manager:

```bash
# macOS — Homebrew
brew install --cask devlint/tap/gitwand

# Windows — winget
winget install Devlint.GitWand

# Arch Linux — AUR
yay -S gitwand-bin
```

Open the app, select a Git repository, and you're ready to go. GitWand checks for updates on launch and installs them in one click.

## CLI

Use it directly with npx, no install, always the latest version:

```bash
npx @gitwand/cli resolve
```

Or install globally via npm (or pnpm):

```bash
npm install -g @gitwand/cli
# pnpm add -g @gitwand/cli
```

Verify the installation:

```bash
gitwand --help
```

## VS Code Extension

Install from the VS Code marketplace:

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for "GitWand"
4. Click **Install**

The extension activates automatically when it detects conflict markers in your files.

## MCP Server (AI Agents)

GitWand exposes its engine as an MCP server for Claude Code, Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.

```bash
npx -y @gitwand/mcp
```

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["@gitwand/mcp", "--cwd", "/path/to/your/repo"]
    }
  }
}
```

See the [MCP Server guide](/guide/mcp) for the full tool and resource reference.

## Quick Start

### Resolve conflicts with the CLI

```bash
# Auto-discover and resolve all conflicted files
gitwand resolve

# Resolve specific files
gitwand resolve src/config.ts package.json

# Preview without writing changes
gitwand resolve --dry-run --verbose

# Check conflict status
gitwand status
```

### Resolve conflicts in VS Code

When you open a file with conflict markers, GitWand shows:

- **CodeLens** above each conflict with the resolution type
- **Status bar** showing how many conflicts are auto-resolvable
- Click the CodeLens or status bar to resolve

### Resolve conflicts in the desktop app

1. Open a repository with merge conflicts
2. Conflicted files appear in the sidebar with a conflict icon
3. Click a file to see the diff with conflict markers highlighted
4. GitWand shows which conflicts it can auto-resolve, each with a confidence score
5. Review the summary (untick any hunk you want to keep for yourself) and apply

## A first tour of the desktop app

Once a repository is open, these are the places worth knowing. Each one links to its full description in the [Desktop App guide](/guide/desktop).

### Commit your work from the Git Tree

The **Git Tree** is the main view: your history as a graph, with your uncommitted changes as a **WIP row** at the top whenever there are any. Select that row and the right rail becomes the files and commit pane: stage files, hunks or single lines, write the summary (or let the AI draft it), and commit with `⌘↩` / `Ctrl+Enter`.

Right-click any commit for checkout, reset (soft, mixed, hard, or **Keep**, which drops commits but refuses to overwrite your uncommitted edits), revert, new branch, tag, cherry-pick, or **Cherry-pick as WIP**, which brings the commit's changes in without committing them.

### Merge without surprises

Before you merge or rebase, the **Conflict Predictor** simulates the operation without touching your working tree and tells you file by file what will conflict and what GitWand can resolve on its own. **Merge & auto-resolve** then runs the real merge, applies the resolutions that clear your confidence bar, and stops on whatever needs you. It never aborts behind your back, and every operation (merge, rebase, cherry-pick, revert) ends with the same Continue and Abort banner.

To be stricter than the defaults, set a minimum score in **Settings → AI (Core & Setup) → Resolution confidence**, or `minConfidenceScore` in `.gitwandrc` (see below).

### Review pull requests

Sign in under **Settings → Accounts** and the PR tab works on **GitHub, GitLab, Bitbucket, Azure DevOps, Gitea and Forgejo**: list, diff, CI checks, inline comments and suggestions, create, merge, checkout. A PR whose checks are still running can be set to **merge itself once they pass** (GitHub, GitLab, Azure DevOps).

### Work in parallel with worktrees

A worktree is a second checkout of the same repository, on another branch, in another folder. Open **Worktrees** in the header and choose **⚡ New task** (`⌘⇧N`): type a name, and GitWand creates `task/<name>` in `<repo>.worktrees/<name>`, starting from a freshly fetched `origin/main`, and opens it in a new tab.

If your project needs more than a checkout to run (an `.env`, dependencies, containers), describe it once in `.gitwandrc` and GitWand brings each worktree up for you, then tears it down when you remove it:

```json
{
  "worktree": {
    "include": [".env"],
    "setup": "docker compose -p {name} up -d",
    "teardown": "docker compose -p {name} down -v",
    "url": "echo http://{name}.localhost:3000"
  }
}
```

GitWand asks once before running these commands, and asks again if they change. When the work is done, **Merge back** brings it into your branch as a merge, a rebase or a squash, through the same preview as any other merge. Removing a worktree snapshots it first, so the **Time Machine** can restore it later.

The full walkthrough is in [Worktrees & AI tasks](/guide/desktop#worktrees-ai-tasks), and step by step in the blog post [Git worktrees in GitWand](/blog/worktrees-step-by-step).

### Run an AI agent on its own branch

The integrated **terminal** has typed tabs for a shell and for the coding-agent CLIs you already have installed (Claude Code, Codex, opencode, Antigravity). From its **+** menu, **New AI task** creates a worktree and starts Claude Code in it, so the agent never writes in the checkout you are working in. Bring its work back with **Merge back**, with the agent's commits kept.

### Browse and edit files

The **Files** tile in the dock opens the File Explorer: your working tree with a badge on every changed file and on every folder above it, a diff or editor per tab, blame, and **Scope here** to narrow the whole app to one folder.

### Undo with the Time Machine

Before anything that rewrites your files (a discard, a reset, a merge-back, a worktree removal), GitWand takes a snapshot. The **Time Machine** lists them, so a wrong click is never final.

## Configuration

Create a `.gitwandrc` file at the root of your repository to customize behavior. It is JSON:

```json
{
  "policy": "prefer-safety",
  "minConfidenceScore": 80,
  "patterns": {
    "*.lock": "prefer-theirs",
    "package.json": "prefer-theirs"
  },
  "worktree": {
    "include": [".env"],
    "setup": "pnpm install"
  }
}
```

The file is committed with the repository, so these settings apply to everyone who works on it, in the desktop app, the CLI, VS Code and the MCP server alike.

See the [Configuration reference](/reference/config) for all options.
