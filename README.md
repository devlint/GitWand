<p align="center">
  <img src="assets/logo.svg" alt="GitWand" width="300" height="120">
</p>

<h1 align="center">GitWand</h1>

<p align="center">
  <strong>A fast, native Git client with built-in smart conflict resolution</strong>
</p>
aasd
<p align="center">
  <a href="#desktop-app">Desktop</a> &bull;
  <a href="#conflict-resolution-engine">Conflict engine</a> &bull;
  <a href="#cli">CLI</a> &bull;
  <a href="#mcp-server">MCP Server</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="./ROADMAP.md">Roadmap</a> &bull;
  <a href="#code-signing-policy">Code signing</a>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-8B5CF6">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-100%25-3178C6">
  <img alt="Version" src="https://img.shields.io/badge/version-3.3.0-22c55e">
</p>

---

GitWand is a lightweight, native Git client built with Tauri 2 and Vue 3. It covers the full daily workflow — changes, history, branches, push/pull — and goes further with **automatic resolution of trivial merge conflicts**, **integrated PR code review** with inline comments, and a **Git Tree** as the primary history view. Since v1.3, AI assists every step of the workflow — branch naming, PR writing, hunk-level review, semantic squash, and natural-language commit search. v2.7+ adds multi-repo Workspaces and Worktrees; v2.8 adds Agent Sessions (MCP); v2.9 adds a cross-repo Launchpad; v2.10 brings multi-forge pull requests across **GitHub, GitLab, Bitbucket and Azure DevOps**; v2.13 adds inline AI code review; v2.18 overlays CI check annotations directly on the diff; v2.19 adds **OAuth device-flow sign-in for GitHub and Azure DevOps** (no `gh` CLI required) plus **cross-fork pull requests**. The 3.x line makes GitWand a daily driver for AI-assisted work: v3.0 turns the cross-repo dashboard into **Today**, a triaged action inbox, and publishes the **VS Code extension on the Marketplace**; v3.2 adds an **integrated terminal with AI agent tabs** — including one-click AI tasks in isolated worktrees — and a dockable **File Explorer / Editor panel**.

## Desktop app

### Git Tree

The **Git Tree** is the primary history view — a full-resolution DAG that renders the branch topology as an SVG with trunk-pinning, lane cooldowns, WIP node, and ref badges. Click any commit to see its diff; right-click to checkout, reset, branch, tag, or cherry-pick. Branches, stashes, and tags are all managed from here without a separate panel. A **filter mode** (v3.2) recalculates the DAG to show only matching commits, with quick branch/author toggles, date-bucket separators, branch-name autocomplete, and `#<PR number>` lookup that resolves straight to the PR's branch.

### Repository view

Staged, unstaged, untracked, and conflicted files in a sidebar with inline diffs in the main area. Stage, unstage, discard, and commit without leaving the interface. Partial staging at the line or hunk level.

### Commit workflow

Summary + description fields, optional commit signature, Ctrl+Enter shortcut. **Unpushed commits can be amended** directly from the Git Tree — a pencil icon appears on hover, opening an overlay pre-filled with the existing message.

### Branches

Click the branch name in the header to search, switch, create, or delete branches. Merge any branch from the dedicated merge button. Each non-current branch shows a **merge preview button** that simulates the merge result before committing.

### Merge preview

Before merging a branch, GitWand predicts the outcome without touching the working tree — using `git merge-base`, `git show`, and `git merge-file -p --diff3`. The result shows a per-file breakdown:

- **Auto-resolvable** — GitWand can handle it automatically
- **Partial** — some hunks need manual resolution
- **Manual** — complex conflicts requiring human judgment
- **Add/delete** — file added on one side, deleted on the other

A badge summarises the overall result: `Clean merge`, `100% auto-resolvable`, or `N conflicts to review`.

### Push & Pull

One-click push and pull with badge counters showing ahead/behind commits. Auto-fetch runs in the background every 30 seconds.

### Diff viewer

Side-by-side or inline toggle, persisted across sessions. Syntax highlighting for 30+ languages, word-level diff using LCS, collapsible unchanged regions, canvas minimap, hunk navigation (prev/next), double-column line numbers.

### File history & blame

Full file history with `git log --follow`, blame view grouped by commit, time-travel diff between any two versions of a file.

### Repo switcher & Workspaces

The current repo name in the header opens a dropdown showing recently opened repositories. Pin favourites, switch instantly — no file picker needed. **Workspaces** (v2.7) group multiple repos into a single dashboard with cross-repo status, coordinated push/pull, and quick-create worktrees (`⌘⇧N`). Each project tab carries a **worktree submenu** (v3.2) listing `main` plus every worktree — select one to switch that project's checkout in place, no extra tab.

### Today

**Today** (`⌘L`; introduced as Launchpad in v2.9, reworked in v3.0) is a cross-repo **triaged action inbox**: everything in flight — WIP, PRs, Issues, Team — sorted into urgency tiers, each row carrying a state-aware primary action (Merge · Review · Resolve · Reply · See failure). Pin or snooze any item; the Team tab loads lazily for performance on large workspaces.

### Pull Requests & Code Review

Browse, create, checkout, and merge pull/merge requests across **GitHub, GitLab, Bitbucket and Azure DevOps** without leaving the app. GitWand auto-detects the forge from the remote and routes to the right provider; accounts are managed once in Settings. The PR list sits in the sidebar and the full detail — diff, CI checks, comments, inline review — fills the main area.

- **Sign in with OAuth** — "Sign in with GitHub" and "Sign in with Azure DevOps" use the OAuth device flow; tokens are stored in the OS keychain and the GitHub PR workflow runs tokenless over the REST API, with **no `gh` CLI required** (the CLI path still works when no token is configured)
- **Cross-fork pull requests** — when `origin` is a fork, open a PR straight against the upstream parent (default), and see the PRs you opened upstream listed alongside your fork's own
- **Inline comments** — read and write review comments anchored to diff lines, with full threading and code suggestions (` ```suggestion ``` ` blocks applicable in one click)
- **Inline CI check annotations** — failed-check annotations overlay the diff with gutter icons (❌/⚠/ℹ) and hover tooltips, with a per-file count in the sidebar (GitHub, GitLab and Bitbucket)
- **Review submission** — Approve / Request changes / Comment, with a draft queue to accumulate comments before sending
- **🧠 Intelligence panel** — conflict prediction (`git merge-tree` before merging), hotspot analysis, review scope, static AI suggestions, file review history

### Agent Sessions

The **Agents panel** (v2.8) shows active MCP sessions and lets you launch Claude Code directly from GitWand — the agent's changes appear live in the diff viewer. The MCP catalog (`Settings > MCP`) lets you install any MCP server in one click.

### Integrated terminal & AI tasks

The **terminal panel** (v3.2) renders through WebGL with inline search (`Ctrl+F`), clickable links, and typed tabs — `shell`, `claude`, `codex` — each with its own icon and an unread-output dot. "Launch Claude Code" / "Launch Codex" open a real PTY tab, and **"New AI task"** creates a scratch git worktree and opens a Claude Code tab in it in one click — the agent works in isolation, and when it's done you either **merge the work back or delete the worktree** from the project tab's submenu. Hardened with a shell-executable whitelist, `safe_repo_path()` on all filesystem operations, and PTY orphan prevention.

### File Explorer / Editor

A dockable **Files panel** (v3.2, drag/resize/fullscreen) lists the full repo tree — gitignore-aware, via `git ls-files` — and opens files in a lazy-loaded CodeMirror 6 editor with syntax highlighting, per-tab undo history, and a lock/undo/save toolbar. Reachable from the Files tile in the AppDock, with per-repo layout settings.

### Settings

Language (English, French, Spanish, Brazilian Portuguese, Simplified Chinese — OS auto-detected), theme (dark/light/system), commit signature, diff mode, external editor, Git binary path, and switch behavior (stash/ask/refuse). **AI providers** cover API backends (Claude / OpenAI-compatible / Ollama) and local CLI agents (Claude Code, Codex, opencode, GitHub Copilot CLI), each with its own model picker. **Accounts** manages forge sign-in — OAuth device flow for GitHub and Azure DevOps, App Passwords / CLI for the others. All persisted in app settings.

### Installing

Download the latest build for your platform from [GitHub Releases](https://github.com/devlint/GitWand/releases):

- **macOS** — `.dmg` (Universal: Apple Silicon + Intel, Developer ID signed + Apple-notarized)
- **Linux** — `.AppImage` or `.deb`
- **Windows** — `.msi` or `.exe`

### Running from source

```bash
git clone https://github.com/devlint/GitWand.git
cd GitWand
pnpm install

# Browser dev mode — no Rust needed
cd apps/desktop && pnpm dev:web

# Tauri desktop mode — requires Rust toolchain
# Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Desktop Dev Build (In the apps/desktop/ folder)
pnpm --filter desktop tauri dev

# On linux you may have to run
WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm --filter desktop tauri dev
```

---

## Conflict resolution engine

GitWand's core engine (`@gitwand/core`) automatically resolves trivial Git merge conflicts. It never touches complex or ambiguous hunks.

### Resolution patterns

GitWand uses a **pattern registry** — the classifier evaluates patterns in priority order, each declaring whether it requires diff3 (base available), diff2, or works on both.

| Pattern | Description | Confidence |
|---|---|---|
| **same_change** | Both branches made the exact same edit | Certain |
| **one_side_change** | Only one branch modified the block | Certain |
| **delete_no_change** | One branch deleted, the other didn't touch it | Certain |
| **non_overlapping** | Additions at different locations in the block | High |
| **whitespace_only** | Same logic, different indentation/spacing | High |
| **reorder_only** | Same lines, different order — pure permutation | High |
| **insertion_at_boundary** | Pure insertions on both sides, base intact | High |
| **value_only_change** | Scalar value update (version number, constant) | Medium |
| **generated_file** | File matches a known generated-file path pattern | High |
| **complex** | Overlapping edits — never auto-resolved | — |

### Composite confidence score

Every resolution carries a `ConfidenceScore` object rather than a simple label:

```ts
{
  score: 84,           // 0–100 composite score
  label: "high",       // "certain" | "high" | "medium" | "low"
  dimensions: {
    typeClassification: 90,  // certainty of the detected pattern
    dataRisk: 20,            // risk of data loss if auto-resolved
    scopeImpact: 10,         // impact of change size
  },
  boosters: ["Path matches generated-file pattern: lockfile"],
  penalties: ["Content will be regenerated — theirs assumed more recent"],
}
```

Score formula: `score = typeClassification − dataRisk×0.4 − scopeImpact×0.15`

### Format-aware resolvers

For structured files, GitWand uses semantic resolvers before falling back to text matching:

- **JSON / JSONC** — recursive key-by-key merge using `JSON.parse`/`JSON.stringify`. Handles nested objects, detects unresolvable scalar conflicts, strips comments in `.jsonc`.
- **Markdown** — section-aware merge by ATX heading (H1–H6). Merges independent sections, falls back to text if the same section is modified on both sides.

### Configurable merge policies

Create a `.gitwandrc` file at the project root to define resolution strategies:

```json
{
  "policy": "prefer-merge",
  "patternOverrides": {
    "*.lock": "prefer-theirs",
    "src/generated/**": "prefer-theirs",
    "CHANGELOG.md": "prefer-ours"
  }
}
```

Available policies: `prefer-ours`, `prefer-theirs`, `prefer-safety`, `prefer-merge`, `strict`.

### Decision trace

Every classification step is logged in a `DecisionTrace` for auditing and debugging:

```
✓ src/config.ts — 3/3 resolved
  L12 [one_side_change] certain — Only the incoming branch modified this block.
  L25 [same_change] certain — Both branches made the exact same edit.
  L41 [value_only_change:json] high — Scalar value updated on one side (version field).
```

---

## CLI

[![npm](https://img.shields.io/npm/v/@gitwand/cli?color=22c55e&label=%40gitwand%2Fcli)](https://www.npmjs.com/package/@gitwand/cli)

```bash
# Use directly with npx
npx @gitwand/cli resolve

# Or install globally
npm install -g @gitwand/cli
```

```bash
gitwand resolve              # Resolve all conflicted files in the repo
gitwand resolve --dry-run    # Preview without writing
gitwand resolve --verbose    # Detailed decision trace
gitwand status               # Show conflict status per file
gitwand resolve --ci         # CI mode: JSON output + semantic exit codes
```

### Enriched JSON output

The `--ci` / `--json` flag returns a full structured report with composite confidence scores, decision traces, and pending hunks for LLM-assisted resolution:

```json
{
  "version": "0.1.0",
  "timestamp": "2026-04-14T12:00:00.000Z",
  "summary": {
    "files": 2,
    "totalConflicts": 5,
    "autoResolved": 4,
    "remaining": 1,
    "allResolved": false
  },
  "files": [
    {
      "path": "src/config.ts",
      "totalConflicts": 3,
      "autoResolved": 3,
      "remaining": 0,
      "validation": {
        "isValid": true,
        "hasResidualMarkers": false,
        "syntaxError": null
      },
      "resolutions": [
        {
          "line": 15,
          "type": "one_side_change",
          "resolved": true,
          "explanation": "Only one side modified this block",
          "confidence": {
            "score": 95,
            "label": "certain",
            "typeClassification": 100,
            "dataRisk": 5,
            "scopeImpact": 10
          },
          "trace": {
            "selected": "theirs",
            "hasBase": true,
            "summary": "One-side change detected — incoming accepted.",
            "steps": ["..."]
          }
        }
      ],
      "pendingHunks": []
    }
  ]
}
```

The `pendingHunks` array gives AI agents and CI scripts everything they need to handle the conflicts that GitWand can't auto-resolve — the ours/theirs/base content, the classification trace, and the confidence breakdown.

---

## MCP Server

[![npm](https://img.shields.io/npm/v/@gitwand/mcp?color=22c55e&label=%40gitwand%2Fmcp)](https://www.npmjs.com/package/@gitwand/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-22c55e)](https://registry.modelcontextprotocol.io/?search=gitwand)

GitWand ships an MCP (Model Context Protocol) server that exposes its conflict resolution engine to AI agents — Claude Code, Claude Desktop, Cursor, Windsurf, and any MCP-compatible client.

### Setup

Add this to your MCP client configuration (e.g. `claude_desktop_config.json` or `.claude/settings.json`):

```json
{
  "mcpServers": {
    "gitwand": {
      "command": "npx",
      "args": ["-y", "@gitwand/mcp"]
    }
  }
}
```

The server defaults to the working directory of the client. To pin it to a specific repo, add `"--cwd", "/absolute/path/to/repo"` to the `args` array. With Claude Code, install in one line:

```bash
claude mcp add gitwand -- npx -y @gitwand/mcp
```

### Tools

| Tool | Description |
|------|-------------|
| `gitwand_status` | List conflicted files with their complexity and auto-resolvability |
| `gitwand_resolve_conflicts` | Auto-resolve trivial conflicts, return DecisionTrace + pendingHunks |
| `gitwand_preview_merge` | Dry-run resolution — stats and risk assessment without writing files |
| `gitwand_explain_hunk` | Explain why a specific hunk was classified its type (full trace + context) |
| `gitwand_apply_resolution` | Apply a custom (LLM-provided) resolution to a specific complex hunk |
| `gitwand_resolve_hunk` | Ask the connected agent to propose a resolution for one pending hunk (ours/theirs/base + trace returned) |
| `gitwand_resolve_hunk_llm` | Validate an LLM-proposed resolution through the post-merge gate, then apply it to disk |

### Resources

| URI | Description |
|-----|-------------|
| `gitwand://repo/conflicts` | Current conflict state — files, counts, types |
| `gitwand://repo/policy` | Active `.gitwandrc` configuration |
| `gitwand://hunk/{file}/{line}` | Raw hunk content for a specific conflict |

### The human ↔ LLM collaboration loop

The MCP server enables a powerful workflow where GitWand handles the trivial conflicts automatically and the LLM tackles the complex ones:

1. **LLM calls `gitwand_preview_merge`** — sees how many conflicts exist and how many GitWand can handle
2. **LLM calls `gitwand_resolve_conflicts`** — GitWand auto-resolves the easy ones, returns `pendingHunks` for the rest
3. **LLM reads the `pendingHunks`** — each one contains ours/theirs/base content and a full decision trace
4. **LLM calls `gitwand_apply_resolution`** for each pending hunk — writes its resolution directly

### Claude Code slash commands

GitWand also ships `.claude/commands/` for Claude Code:

```bash
/resolve   # Full conflict resolution workflow
/preview   # Merge preview and risk assessment
```

---

## Architecture

```
gitwand/
├── packages/
│   ├── core/       @gitwand/core — Resolution engine (TypeScript, browser-safe)
│   │               parser, resolver, classifier, format resolvers,
│   │               confidence scoring, tree-sitter structural dispatch
│   ├── cli/        @gitwand/cli — Command-line interface
│   ├── mcp/        @gitwand/mcp — MCP server (stdio transport)
│   │               tools (7), resources (3), Claude Code commands
│   └── vscode/     VS Code extension — CodeLens, diagnostics, status bar
├── apps/
│   └── desktop/    Tauri 2 + Vue 3 desktop app
│                   src-tauri/  Rust backend (git commands, IPC, libgit2)
│                   src/        Vue frontend (stores, composables, panels)
└── .claude/
    └── commands/   Claude Code slash commands (/resolve, /preview)
```

The core engine is framework-agnostic and usable as a library:

```ts
import { resolve } from "@gitwand/core";

const result = resolve(conflictedContent, "src/app.ts");
console.log(`${result.stats.autoResolved}/${result.stats.totalConflicts} resolved`);

// With options
const result = resolve(content, "package.json", {
  policy: "prefer-merge",
  minConfidence: "medium",
  patternOverrides: { "*.lock": "prefer-theirs" },
});
```

---

## Development

```bash
git clone https://github.com/devlint/GitWand.git
cd GitWand
pnpm install
pnpm build          # Build all packages
pnpm test           # Tests across all workspaces
```

### Running benchmarks

```bash
cd packages/core
pnpm test:bench     # vitest bench — ops/s per fixture size
```

Baseline results on Apple M-series:

| Input | Throughput |
|---|---|
| 1 conflict / ~30 lines | ~249 000 ops/s |
| 5 conflicts / ~140 lines | ~40 000 ops/s |
| 50 conflicts / ~1350 lines | ~4 500 ops/s |
| JSON/Markdown format-aware | ~137 000 ops/s |

### Internationalization

GitWand uses a zero-dependency type-safe i18n system across five languages — English (`en`, default), French (`fr`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), and Simplified Chinese (`zh-CN`). `en.ts` is the canonical reference, defined with `as const`; the `Locale` and `LocaleKey` types are derived from it, so every other locale must match its structure — TypeScript enforces it. The `useI18n()` composable provides `t(key, ...args)` with dotted key resolution and positional interpolation. OS language is auto-detected; users can override in Settings.

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full phased plan — upcoming features, competitive analysis, and shipped version history.

---

## Code signing policy

Windows builds of GitWand are code-signed. Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

| Role | Member |
|------|--------|
| Committers / Reviewers | [Laurent Guitton](https://github.com/devlint) |
| Approvers | [Laurent Guitton](https://github.com/devlint) |

This program will not transfer any information to other networked systems unless specifically requested by the user.

---

## License

MIT — [Laurent Guitton](https://github.com/devlint)
