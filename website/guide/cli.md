# CLI

The `@gitwand/cli` package provides conflict resolution from the command line. Use it interactively or integrate it into CI pipelines and Git hooks.

## Commands

### `gitwand resolve [files...]`

Auto-resolve trivial merge conflicts.

```bash
# Auto-discover conflicted files via git
gitwand resolve

# Resolve specific files
gitwand resolve src/config.ts src/utils.ts

# Preview without writing
gitwand resolve --dry-run

# Verbose output with per-hunk details
gitwand resolve --verbose
```

If no files are specified, GitWand discovers conflicted files automatically via `git diff --name-only --diff-filter=U`.

### `gitwand status`

Show the conflict status for the current repository.

```bash
gitwand status
```

## Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Analyze conflicts without writing files |
| `--verbose` | Show details for each resolution (line, type, explanation) |
| `--no-whitespace` | Don't resolve whitespace-only conflicts |
| `--ci` | CI mode: JSON output + exit code 1 if unresolved conflicts remain |
| `--json` | Output results as JSON (same behavior as `--ci`) |

## CI Integration

Use `--ci` or `--json` for machine-readable output and proper exit codes:

```bash
gitwand resolve --ci
```

**Exit codes:**
- `0` — All conflicts resolved (or no conflicts found)
- `1` — Unresolved conflicts remain

**JSON output format:**

```json
{
  "version": "0.1.0",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "summary": {
    "files": 3,
    "totalConflicts": 5,
    "autoResolved": 4,
    "remaining": 1,
    "allResolved": false
  },
  "files": [
    {
      "path": "src/config.ts",
      "totalConflicts": 2,
      "autoResolved": 2,
      "remaining": 0,
      "resolutions": [
        {
          "line": 15,
          "type": "one_side_change",
          "resolved": true,
          "explanation": "Only one side modified this block"
        }
      ]
    }
  ]
}
```

## Git Hook Integration

Add GitWand to your merge workflow with a `post-merge` hook:

```bash
#!/bin/sh
# .git/hooks/post-merge

# Check for remaining conflicts and auto-resolve what's possible
if git diff --name-only --diff-filter=U | grep -q .; then
  gitwand resolve --verbose
fi
```

Or use it in a `prepare-commit-msg` hook after a merge:

```bash
#!/bin/sh
# .git/hooks/prepare-commit-msg

if [ "$2" = "merge" ]; then
  gitwand resolve 2>/dev/null
fi
```
