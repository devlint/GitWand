---
title: "An integrated terminal built for AI agents, and a file editor in your Git client: GitWand v3.2"
description: "v3.2 rebuilds the terminal panel on WebGL with typed agent tabs, adds one-click AI tasks that run Claude Code in isolated scratch worktrees, ships a dockable File Explorer / Editor panel backed by CodeMirror 6, and gives the Git Tree a filter mode with #PR lookup."
date: 2026-07-02
head:
  - - meta
    - property: og:title
      content: "An integrated terminal built for AI agents, and a file editor in your Git client: GitWand v3.2"
  - - meta
    - property: og:description
      content: "WebGL terminal with agent tabs, one-click AI tasks in isolated worktrees, a dockable File Explorer / Editor, and a Git Tree filter mode with #PR lookup."
  - - meta
    - name: twitter:title
      content: "Integrated terminal + AI tasks in isolated worktrees: GitWand v3.2"
---

# An integrated terminal built for AI agents, and a file editor in your Git client: GitWand v3.2

`@gitwand/desktop@3.2.0` is about closing the loop between *deciding* to delegate work to an AI agent and *seeing that work land safely in your repo*. The centerpiece: a rebuilt terminal panel with first-class agent tabs, and a **"New AI task"** button that spins up an isolated git worktree and drops Claude Code into it — one click, zero risk to your working tree.

Around it, v3.2 ships a second big piece of daily-driver furniture — a dockable **File Explorer / Editor** panel — plus a Git Tree filter mode, submodule update actions, per-author churn stats, and a rebase editor that accepts any ref.

---

## The terminal grows up

The terminal panel was functional; now it's fast and agent-aware.

Rendering moved to **WebGL**, so heavy output — the kind an AI agent produces when it's chewing through a codebase — scrolls without jank. Inline **search** (`Ctrl+F`, with prev/next), clickable links, and a cleaner tab strip round out the basics.

The interesting part is what tabs *are* now. Each tab carries a type — `shell`, `claude`, or `codex` — with a distinct icon and an **unread-output dot** when something happened in a tab you're not looking at. "Launch Claude Code" and "Launch Codex" used to be non-functional stubs; they now open a real PTY shell tab running the agent.

Under the hood, this got a proper hardening pass: `safe_repo_path()` guards every terminal filesystem operation, shell executables are whitelisted, orphaned PTYs are reaped when a tab closes, keystroke input is bounded, and a UTF-8 carry-buffer fixes multibyte characters straddling PTY read chunks — no more mojibake mid-emoji.

## One-click AI tasks, in isolated worktrees

Here's the workflow v3.2 is really about. You're mid-feature, and you want an agent to handle something orthogonal — a refactor, a test backfill, a docs pass. You don't want it touching your working tree while it works.

**"New AI task"** does the whole setup in one click: it creates a scratch `gitwand-scratch-*` worktree (the same isolation machinery introduced for conflict resolution in v2.20) and opens a Claude Code terminal tab already `cd`'d into it. The agent works in a parallel checkout; your files never move.

The lifecycle is managed, not fire-and-forget. Every project tab now has a **worktree submenu** — a caret (▼) listing `main` plus every worktree, with AI-task worktrees marked by a sparkle. From there you switch checkouts in place (no extra tab), and when the task is done, the delete action asks the only question that matters: **merge the work back into the project, or discard the worktree** — branch cleanup included. No more orphaned scratch directories accumulating on disk.

## A File Explorer / Editor, dockable like the terminal

Sometimes the file you want to touch isn't in the diff. The new **Files panel** — reachable from a Files tile in the AppDock, with the same drag / resize / fullscreen behavior as the Terminal panel — lists the full repo tree, gitignore-aware via `git ls-files`, with folder file-counts precomputed in a single tree walk.

Click a file and it opens in a lazy-loaded **CodeMirror 6** editor: syntax highlighting, per-tab undo history, and a lock / undo / save toolbar. It's deliberately a viewer-editor, not an IDE — but it means quick edits no longer require a round-trip to an external editor, and it gives agent-generated changes a place to be inspected file-by-file.

## Git Tree: filter mode and `#1234`

The Git Tree toolbar gains a **filter mode** that doesn't just highlight matches — it recalculates the DAG to show only matching commits, with quick-toggle branch/author filters and date-bucket separators in the timeline.

The branch search box got smarter too: a branch-name autocomplete dropdown, and — the one you'll use daily if you review PRs — type `#<PR number>` and it resolves straight to the branch that PR is on. Cache-first against the already-loaded PR list, debounced fallback fetch when needed, and a `#1234` badge on branches with a known PR.

## The rest of the release

- **Submodule updates** — the Submodules panel shows update-available indicators and lets you pull remote submodule changes (rebase) or discard them, backed by new Rust commands.
- **Per-author line churn** — the contributor dashboard aggregates insertions/deletions per author via `git log --numstat`, alongside commit counts; GitHub API usage drops thanks to ETag caching and consolidated PR detail queries.
- **Rebase onto any ref** — the rebase editor accepts remote branches, tags, and raw SHAs as the base; when there's nothing to replay, it offers a branch reset through the standard confirmation flow.
- **Antigravity CLI provider** — the `agy` CLI joins Claude Code, Codex, opencode, and Copilot CLI as a selectable local AI provider.
- **Unified Changes section** — "Unstaged" and "Untracked" merged into a single, conventional "Changes" section in the sidebar.
- **Guardrails** — closing a project tab now asks for confirmation (worktrees stay on disk), and PR creation restricts the base branch to a `<select>` of valid targets.

Among the fixes: checking out a **fork PR** now resolves the real source repository and fetches `pull/N/head` from upstream; deleting a branch checked out in a worktree offers "Delete worktree" instead of a doomed "Delete branch"; and ~20 catch blocks in `useGitRepo.ts` now surface the *actual* git error instead of "undefined" — Tauri rejects with a plain string, not an `Error`.

---

Download GitWand 3.2.0 for macOS, Linux, or Windows from [GitHub Releases](https://github.com/devlint/GitWand/releases), or read the [full changelog](/changelog). If the AI-task workflow resonates, the [AI & agents page](/ai-agents) shows how the same resolution engine is exposed to Claude Code, Cursor, and any MCP client.
