# CLI Commands

## `gitwand resolve`

Auto-resolve trivial merge conflicts.

```bash
gitwand resolve [files...] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `files...` | File paths to resolve. If omitted, auto-discovers via `git diff --name-only --diff-filter=U` |

### Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Analyze conflicts without writing files |
| `--verbose` | Show per-hunk details (line number, type, explanation) |
| `--no-whitespace` | Skip whitespace-only conflicts |
| `--ci` | CI mode: JSON output, exit code 1 if unresolved |
| `--json` | Alias for `--ci` |

### Examples

```bash
# Resolve all conflicts in the repo
gitwand resolve

# Dry run with details
gitwand resolve --dry-run --verbose

# Resolve specific files
gitwand resolve src/config.ts package-lock.json

# CI pipeline usage
gitwand resolve --ci || echo "Unresolved conflicts remain"
```

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All conflicts resolved or no conflicts found |
| `1` | Unresolved conflicts remain (CI mode only) |

### Human Output

```
✨ GitWand — Git's magic wand

  ✓ src/config.ts          2/2 resolved
  ◐ src/utils.ts           1/3 resolved
  ✗ src/complex.ts         0/1 resolved

  Summary: 3/6 conflict(s) auto-resolved across 3 file(s)
  1 conflict(s) remaining
```

With `--verbose`, each hunk shows:

```
  ✓ src/config.ts          2/2 resolved
    Line 15: one_side_change → resolved (Only one side modified this block)
    Line 42: same_change → resolved (Both sides made identical changes)
```

### CI/JSON Output

```json
{
  "version": "0.1.0",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "summary": {
    "files": 3,
    "totalConflicts": 6,
    "autoResolved": 3,
    "remaining": 3,
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

---

## `gitwand status`

Show the conflict status for the current repository.

```bash
gitwand status
```

Reports the number of conflicted files, total conflicts, and how many are auto-resolvable.

---

## `gitwand --help`

Show usage information.

```bash
gitwand --help
```
