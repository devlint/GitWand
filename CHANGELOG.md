# Changelog

All notable changes to GitWand will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/devlint/GitWand/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/devlint/GitWand/releases/tag/v0.0.1
