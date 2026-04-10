# Configuration

GitWand is configured via a `.gitwandrc` file at the root of your repository, or via a `"gitwand"` key in `package.json`.

## File Format

```json
{
  "policy": "prefer-safety",
  "patterns": {
    "*.lock": "prefer-theirs",
    "package.json": "prefer-theirs",
    "src/**/*.ts": "prefer-ours"
  }
}
```

## Policies

A policy controls how aggressively GitWand auto-resolves conflicts.

| Policy | Behavior | Min Confidence |
|--------|----------|----------------|
| `prefer-ours` | Ambiguous choices resolve to ours | `high` |
| `prefer-theirs` | Ambiguous choices resolve to theirs **(default)** | `high` |
| `prefer-merge` | Resolve as much as possible | `medium` |
| `prefer-safety` | Only resolve very safe conflicts; skip whitespace and value-only | `high` |
| `strict` | Only `same_change`, `one_side_change`, and `delete_no_change` | `certain` |

### Policy Details

**`prefer-ours`**
- Whitespace conflicts: ours
- Value-only conflicts: ours
- Non-overlapping: allowed

**`prefer-theirs`** (default)
- Whitespace conflicts: theirs
- Value-only conflicts: theirs
- Non-overlapping: allowed

**`prefer-merge`**
- Lower confidence threshold (`medium`)
- All resolution types enabled
- Most aggressive — resolves the most conflicts

**`prefer-safety`**
- Disables whitespace-only and value-only resolution
- Non-overlapping: allowed
- Conservative — only resolves unambiguous conflicts

**`strict`**
- Only the three safest conflict types
- Requires `certain` confidence
- Disables whitespace, value-only, and non-overlapping resolution

## Pattern Overrides

Use glob patterns to apply different policies to specific files:

```json
{
  "policy": "prefer-safety",
  "patterns": {
    "*.lock": "prefer-theirs",
    "package.json": "prefer-theirs",
    "src/**/*.ts": "prefer-ours",
    "*.md": "prefer-merge"
  }
}
```

### Glob Syntax

| Pattern | Matches |
|---------|---------|
| `*` | Any character except `/` |
| `**` | Any character including `/` |
| `?` | Exactly one character except `/` |

- If a pattern has no `/`, it matches on the **basename** only (e.g., `*.lock` matches `path/to/yarn.lock`)
- If a pattern contains `/`, it matches on the **full path** (e.g., `src/**/*.ts`)

### Priority

When multiple patterns match a file:

1. **Most specific pattern** (longest match) wins
2. Falls back to the global `policy`
3. Falls back to `DEFAULT_POLICY` (`"prefer-theirs"`)

## Confidence Levels

The `minConfidence` setting (set implicitly by each policy) controls the minimum confidence score required for auto-resolution:

| Level | Score Threshold | Description |
|-------|----------------|-------------|
| `certain` | ≥ 92 | Only resolve when classification is near-certain |
| `high` | ≥ 68 | Resolve when classification is confident |
| `medium` | ≥ 44 | Resolve with moderate confidence |
| `low` | < 44 | Resolve even uncertain classifications |

## VS Code Extension Settings

When using the VS Code extension, you can also configure via VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `gitwand.resolveWhitespace` | `true` | Resolve whitespace-only conflicts |
| `gitwand.minConfidence` | `"high"` | Minimum confidence for auto-resolution |

These settings apply in addition to `.gitwandrc`. The more restrictive setting wins.
