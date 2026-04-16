# Changelog

All notable changes to GitWand will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-04-16

### Added

- **Interactive rebase** (Phase 1.2.1) — drag-and-drop reorder in the log, per-commit actions (squash, edit message, drop, fixup), multi-select squash with combined message, rebase onto branch from the UI, in-flight conflict handling (continue/abort/skip).
- **Absorb** (Phase 1.2.2, inspired by GitButler) — right-click a modified file to absorb it into an existing commit, automatic candidate detection via `git blame`, partial absorb through hunk selection (`useAbsorb.ts`).
- **AI commit messages** (Phase 1.2.3) — dropdown in the commit area analyses the staged diff and produces summary + description. Provider-agnostic: Claude Code CLI, Claude API, OpenAI-compatible, Ollama. Regenerate, shorten, expand, switch language.
- **Universal Undo** (Phase 1.2.4) — operation stack covering commit, merge, rebase, cherry-pick, stash, discard. One-click undo via `git reset` / `git reflog`. History panel lets you jump back to any prior state.
- `gh-merge-pr` endpoint in the desktop dev-server plus a TypeScript wrapper.
- Website homepage: new LLM/MCP section and FAQ.

### Changed

- `@gitwand/core`, `@gitwand/cli`, `@gitwand/mcp`, `gitwand-vscode`, `gitwand-website` versions aligned to `1.2.0`.
- Desktop app (`@gitwand/desktop`) and Tauri bundle bumped to `1.2.0`.

## [1.1.0] - 2026-04

### Added

- **MCP server** (`@gitwand/mcp`) — 5 tools (`gitwand_status`, `gitwand_resolve_conflicts`, `gitwand_preview_merge`, `gitwand_explain_hunk`, `gitwand_apply_resolution`) and 3 resources, stdio transport, compatible with Claude Code, Claude Desktop, Cursor, Windsurf.
- **Claude Code slash commands** — `/resolve` and `/preview` workflows.
- **Enriched CLI JSON output** — confidence scores, decision traces, `pendingHunks` with ours/theirs/base, post-merge validation.
- **Partial resolution** in the desktop app — apply resolvable hunks even when others remain manual.
- **Merge success modal** with Close and Push actions, light/dark themed via design tokens.
- **Dashboard README improvements** — GitHub-style header parsing, GFM tables, checkboxes, anchor navigation, relative image handling.
- **Website MCP Server page** and FR/EN homepage toggle.
- **New 3D hexagonal cube logo**; Tauri app icons regenerated (ico, icns, multi-size PNG).

## [1.0.0] - 2026

### Added

- Core conflict resolution engine: 8 patterns (same_change, one_side_change, delete_no_change, whitespace_only, non_overlapping, value_only_change, generated_file, complex), LCS 3-way, diff2 + diff3.
- Composite confidence scoring (`ConfidenceScore` 0–100), configurable merge policies via `.gitwandrc`, decision trace, explain-only mode.
- Format-aware resolvers: JSON/JSONC, Markdown, YAML, Vue SFC, CSS/SCSS, TS/JS imports, npm/yarn/pnpm lockfiles.
- CLI (`gitwand resolve`, `gitwand status`) with `--ci` / `--json` structured output.
- VS Code extension: diagnostics, CodeLens, status bar, `resolveFile` / `resolveAll` commands.
- Desktop app (Tauri 2 + Vue 3): complete Git workflow — staging, commit, push/pull, branches, merge editor, advanced diff, history, DAG graph, file history, blame, time-travel diff, merge preview, cherry-pick, stash, amend, repo switcher, multi-tabs, terminal, PR workflow via `gh` CLI, inline code review, intelligence panel, AI suggestions (Claude / OpenAI / Ollama), i18n FR/EN, theme dark/light/system.
- 332 tests, 20 fixtures corpus, benchmarks (249k ops/s on single conflict).
- CI/CD multi-OS (macOS universal, Linux, Windows), Tauri updater, VitePress documentation site.

## [0.0.1] - 2026-04-03

### Added

- **Core engine** (`@gitwand/core`) with 5 automatic conflict resolution patterns:
  - `same_change` — both branches made the exact same edit (certain)
  - `one_side_change` — only one branch modified a block (certain)
  - `delete_no_change` — one branch deleted, the other didn't touch (certain)
  - `whitespace_only` — same code, different formatting (high)
  - `non_overlapping` — additions at different locations, LCS-based 3-way diff (high)
- **CLI** (`@gitwand/cli`) with commands:
  - `gitwand resolve` — auto-resolve trivial conflicts
  - `gitwand status` — show conflict status
  - `--ci` / `--json` mode with structured JSON output and exit codes
  - `--dry-run`, `--verbose`, `--no-whitespace` options
- **VS Code extension** (`gitwand-vscode`) with:
  - DiagnosticsProvider — inline warnings on each conflict
  - CodeLensProvider — clickable annotations above each conflict marker
  - StatusBarItem — conflict count with auto-resolvable ratio
  - Commands: `resolveFile`, `resolveAll`
- **Desktop app placeholder** (Tauri + Vue 3, Phase 4)
- CI pipeline via GitHub Actions (Node 18, 20, 22)
- 28 tests covering all patterns + real-world scenarios (package.json, Laravel routes, Vue SFC, CSS, .env files)

[Unreleased]: https://github.com/devlint/GitWand/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/devlint/GitWand/releases/tag/v1.2.0
[1.1.0]: https://github.com/devlint/GitWand/releases/tag/v1.1.0
[1.0.0]: https://github.com/devlint/GitWand/releases/tag/v1.0.0
[0.0.1]: https://github.com/devlint/GitWand/releases/tag/v0.0.1
