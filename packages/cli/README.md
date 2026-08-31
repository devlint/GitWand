# @gitwand/cli

[![npm](https://img.shields.io/npm/v/@gitwand/cli?color=22c55e)](https://www.npmjs.com/package/@gitwand/cli)
[![License](https://img.shields.io/badge/license-MIT-8B5CF6)](../../LICENSE)

**Auto-resolve trivial Git merge conflicts from your terminal or CI.**

Part of [GitWand](https://github.com/devlint/GitWand). `@gitwand/cli` wraps the same conflict resolution engine as the desktop app and MCP server, exposing it as a single binary you can drop into any shell or pipeline.

## Install

```bash
# One-shot (no install)
npx @gitwand/cli resolve

# Global install
npm install -g @gitwand/cli
gitwand resolve
```

Requires Node.js ≥ 18.

A global install doesn't auto-update the way `npx @gitwand/cli` does, so `gitwand` checks once every 24h (cached, never more than once a day) whether a newer version is published and prints a one-line notice if so. It only runs in an interactive terminal — never in CI or when output is piped — and never delays or alters command output.

## Quickstart

```bash
# Mid-merge, from the repo root:
gitwand resolve              # Resolve every conflicted file GitWand can handle
gitwand resolve --dry-run    # Preview without touching files
gitwand status               # List conflicted files with auto-resolvability
```

## Commands

### `gitwand resolve [files...]`

Auto-resolves trivial conflicts. With no arguments, it picks up every conflicted file from `git diff --name-only --diff-filter=U`. Pass specific paths to scope the run.

**Flags**
- `--dry-run` — analyze without writing files
- `--verbose` — print the decision trace for each hunk
- `--no-whitespace` — skip whitespace-only resolutions
- `--concurrency=N` — parallel file workers (default: CPU count, min 1)
- `--ci` — CI mode: JSON output + semantic exit codes
- `--json` — force JSON output (implies `--ci` semantics)

**Exit codes**
- `0` — all conflicts resolved
- `1` — conflicts remain (in `--ci` / `--json` mode)
- `2` — internal error

### `gitwand status`

Lists conflicted files with per-file counts, detected pattern types, and the share GitWand can handle automatically.

### `gitwand --help`

Full help text.

## CI usage

The `--ci` flag emits a structured JSON report and uses semantic exit codes, so you can wire it into any pipeline:

```yaml
# .github/workflows/merge-check.yml
- name: Auto-resolve trivial conflicts
  run: |
    git merge origin/main || true
    npx @gitwand/cli resolve --ci
```

Exit `0` → everything auto-resolved, safe to continue. Exit `1` → there are complex conflicts that need human or LLM attention; the JSON output lists them with ours/theirs/base content.

## JSON output shape

```json
{
  "version": "1.6.0",
  "timestamp": "2026-05-20T12:00:00.000Z",
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
      "resolutions": [
        {
          "line": 15,
          "type": "one_side_change",
          "resolved": true,
          "confidence": { "score": 95, "label": "certain" },
          "trace": { "selected": "theirs", "summary": "..." }
        }
      ],
      "pendingHunks": []
    }
  ]
}
```

The `pendingHunks` array gives you everything needed for a downstream LLM or human review: ours/theirs/base content, classification trace, confidence breakdown.

## Configuration

Drop a `.gitwandrc` at the repo root:

```json
{
  "policy": "prefer-merge",
  "patternOverrides": {
    "*.lock": "prefer-theirs",
    "CHANGELOG.md": "prefer-ours"
  },
  "generatedFiles": ["src/generated/**", "**/*.pb.ts"]
}
```

Policies: `prefer-ours`, `prefer-theirs`, `prefer-safety`, `prefer-merge`, `strict`.

## What gets auto-resolved

GitWand only resolves when it's certain. It classifies each hunk against a registry of patterns (`same_change`, `one_side_change`, `non_overlapping`, `whitespace_only`, `reorder_only`, `insertion_at_boundary`, `value_only_change`, `generated_file`). Overlapping edits are flagged `complex` and never touched.

Format-aware resolvers apply to JSON, Markdown, YAML, Vue SFC, CSS, and lockfiles before pure text matching.

## Also available

- **[@gitwand/mcp](https://www.npmjs.com/package/@gitwand/mcp)** — same engine as an MCP server for Claude, Cursor, Windsurf.
- **[GitWand desktop app](https://github.com/devlint/GitWand#desktop-app)** — full Git client with built-in resolution, merge preview, and inline code review.

## Links

- 📖 [Documentation](https://github.com/devlint/GitWand#cli)
- 🐛 [Issue tracker](https://github.com/devlint/GitWand/issues)
- 🌐 [Website](https://devlint.github.io/GitWand/)
- 📜 [License — MIT](../../LICENSE)
