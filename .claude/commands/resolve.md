# Resolve Git conflicts with GitWand

Use the GitWand CLI to automatically resolve trivial merge conflicts, then handle remaining complex hunks manually.

## Workflow

### 1. Check conflict status

```bash
npx gitwand status --json
```

This returns a JSON report showing each conflicted file, how many conflicts it has, and how many are auto-resolvable.

### 2. Auto-resolve what GitWand can handle

```bash
npx gitwand resolve --json
```

GitWand resolves conflicts with `certain` or `high` confidence automatically (patterns: `same_change`, `one_side_change`, `delete_no_change`, `whitespace_only`, `non_overlapping`, `value_only_change`, `generated_file`). Files are written in-place.

Use `--dry-run` to analyze without modifying files.

### 3. Interpret the JSON output

The `resolutions` array in each file entry contains:
- `line`: start line of the conflict in the original file
- `type`: the conflict pattern detected
- `resolved`: whether GitWand auto-resolved it
- `explanation`: human-readable reason for the decision
- `pendingHunks` (if present): unresolved hunks with `ours`/`theirs`/`base` content for manual review

### 4. Handle remaining conflicts

For hunks with `"resolved": false` (type `complex`):
- Read the hunk content from `pendingHunks` if available, or open the file
- Understand the semantic intent of both sides using the `explanation` field
- Write the correct resolution considering both changes
- Stage the resolved file with `git add`

### 5. Verify

```bash
npx gitwand status
```

Confirm all conflicts are resolved, then `git commit` to complete the merge.

## Tips

- GitWand has specialized resolvers for JSON, YAML, Markdown, Vue SFC, CSS, TypeScript imports, and lockfiles (npm/yarn/pnpm). It resolves these at the semantic level, not just line-by-line.
- The `.gitwandrc` file in the repo root can configure merge policies (`prefer-ours`, `prefer-theirs`, `prefer-safety`, `prefer-merge`, `strict`) and per-path overrides.
- Confidence scoring uses a composite of `typeClassification`, `dataRisk`, and `scopeImpact` — not just the conflict type.
