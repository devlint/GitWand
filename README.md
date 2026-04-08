<p align="center">
  <img src="assets/logo.svg" alt="GitWand" width="120" height="120">
</p>

<h1 align="center">GitWand</h1>

<p align="center">
  <strong>A lightweight, elegant Git client with built-in smart conflict resolution</strong>
</p>

<p align="center">
  <a href="#desktop-app">Desktop app</a> &bull;
  <a href="#smart-conflict-resolution">Conflict resolution</a> &bull;
  <a href="#cli-usage">CLI</a> &bull;
  <a href="#vs-code-extension">VS Code</a> &bull;
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-8B5CF6">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-100%25-3178C6">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-FBBF24">
</p>

---

GitWand is a fast, minimal Git client built with Tauri and Vue 3. It gives you a clear view of your repository &mdash; changes, history, branches, push/pull &mdash; with a unique superpower: **automatic resolution of trivial merge conflicts**.

## Desktop app

The desktop app is GitWand's primary interface. It provides everything you need to work with a Git repo in a clean, focused UI.

**Repository view** &mdash; staged, unstaged, untracked and conflicted files in a sidebar, with inline diffs in the main area. Stage, unstage, discard and commit directly from the interface.

**Commit history** &mdash; browse the log in the sidebar, click a commit to see its full diff with a file list panel and scroll-spy highlighting.

**Branches** &mdash; click the branch name in the header to search, switch, create or delete branches. A spinner shows during branch switches.

**Push &amp; Pull** &mdash; one-click push and pull with badge counters showing ahead/behind status. Auto-fetch runs in the background every 30 seconds to keep counts accurate.

**Conflict resolution** &mdash; when merge conflicts are detected, clicking a conflicted file opens the built-in 3-way merge editor inline &mdash; no mode switch needed.

**i18n** &mdash; French and English, auto-detected from your OS. Override in Settings.

**Dark mode** &mdash; system, dark and light themes.

### Running the desktop app

```bash
git clone https://github.com/devlint/GitWand.git
cd GitWand
pnpm install
pnpm build

# Browser dev mode (no Tauri needed)
cd apps/desktop
pnpm dev:web

# Tauri dev mode (requires Rust toolchain)
pnpm tauri dev
```

## Smart conflict resolution

GitWand's core engine automatically resolves trivial Git merge conflicts &mdash; the ones that waste your time but don't need human judgment. Complex conflicts are never auto-resolved.

| Pattern | Description | Confidence |
|---|---|---|
| **Same change** | Both branches made the exact same edit | Certain |
| **One-side change** | Only one branch modified the block | Certain |
| **Delete + no change** | One branch deleted, the other didn't touch it | Certain |
| **Whitespace only** | Same code, different formatting | High |
| **Non-overlapping** | Additions at different locations (e.g. imports) | High |

Every auto-resolution comes with a human-readable explanation:

```
✓ src/config.ts — 3/3 resolved
  L12 [one_side_change] auto — Only the incoming branch modified this block.
  L25 [same_change] auto — Both branches made the exact same edit.
  L41 [delete_no_change] auto — Current branch deleted this block.
```

## CLI usage

```bash
# Use directly with npx
npx @gitwand/cli resolve

# Or install globally
npm install -g @gitwand/cli
```

```bash
gitwand resolve              # Resolve all conflicted files
gitwand resolve --dry-run    # Preview without writing
gitwand resolve --verbose    # Detailed explanations
gitwand status               # Show conflict status
gitwand resolve --ci         # CI mode: JSON output + exit codes
```

## VS Code extension

The extension integrates into VS Code's merge workflow with CodeLens annotations, diagnostics in the Problems panel, a status bar indicator, and commands to resolve conflicts in the current file or across the repo.

## Architecture

```
gitwand/
├── packages/
│   ├── core/       @gitwand/core — Resolution engine (TypeScript)
│   ├── cli/        @gitwand/cli — Command-line interface
│   └── vscode/     VS Code extension
├── apps/
│   └── desktop/    Desktop app — Tauri 2 + Vue 3
└── ...
```

The core engine is framework-agnostic and can be used as a library:

```ts
import { resolve } from "@gitwand/core";

const result = resolve(conflictedContent, "src/app.ts");
console.log(`${result.stats.autoResolved}/${result.stats.totalConflicts} resolved`);
```

## Roadmap

- [x] Core engine &mdash; conflict parser + 5 resolution patterns
- [x] CLI &mdash; `gitwand resolve` and `gitwand status`
- [x] VS Code extension &mdash; CodeLens, diagnostics, one-click resolve
- [x] CI integration &mdash; JSON output and exit codes
- [x] Desktop app &mdash; full Git client with repo view, history, branches, push/pull
- [x] i18n &mdash; French/English with OS auto-detection
- [x] Integrated conflict resolution &mdash; merge editor inline in the desktop app
- [ ] Plugin system &mdash; custom resolution strategies per language/framework
- [ ] Stash management
- [ ] Interactive rebase

## Contributing

```bash
git clone https://github.com/devlint/GitWand.git
cd GitWand
pnpm install
pnpm build
pnpm test    # 39 tests
```

### Internationalization

GitWand uses a type-safe i18n system with no external dependency. French (`fr.ts`) is the reference locale defined with `as const`. English (`en.ts`) must match the same structure. The `useI18n()` composable provides `t(key, ...args)` for dotted key resolution with positional interpolation. OS language is auto-detected; users can override in Settings (persisted in localStorage).

## License

MIT &mdash; [Laurent Guitton](https://github.com/devlint)
