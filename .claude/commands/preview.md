# Preview merge conflicts before merging

Use this workflow to assess merge risk BEFORE actually merging a branch. This avoids surprises and lets you plan conflict resolution in advance.

## Workflow

### 1. Identify the source branch

Determine which branch you want to merge into the current branch. Example: merging `feature/auth` into `main`.

### 2. Simulate the merge (without modifying the working tree)

```bash
git merge --no-commit --no-ff <source-branch> 2>&1 || true
```

If conflicts arise, Git leaves conflict markers in the working tree without committing.

### 3. Analyze with GitWand

```bash
npx gitwand resolve --json --dry-run
```

The `--dry-run` flag ensures no files are modified. The JSON output shows:
- Total conflict count per file
- How many GitWand can auto-resolve (and with what confidence)
- Which hunks are `complex` and need human/LLM attention

### 4. Assess the risk

From the JSON output, evaluate:

| Metric | Low risk | Medium risk | High risk |
|--------|----------|-------------|-----------|
| Auto-resolvable % | > 80% | 50-80% | < 50% |
| Complex hunks | 0-1 | 2-5 | > 5 |
| Files affected | 1-3 | 4-10 | > 10 |

### 5. Decision

**If low risk:** proceed with `npx gitwand resolve` to auto-resolve, then handle remaining hunks.

**If medium/high risk:** review the complex hunks first. The `explanation` field in each unresolved hunk describes WHY it's complex (overlapping edits, both sides modified the same function, etc.).

### 6. Abort if needed

```bash
git merge --abort
```

This cleanly restores the working tree to its pre-merge state.

## Example: full preview flow

```bash
# Start the merge simulation
git merge --no-commit --no-ff feature/auth

# Analyze conflicts
npx gitwand resolve --json --dry-run | jq '.summary'

# If acceptable, resolve for real
npx gitwand resolve

# Handle remaining conflicts manually, then
git add -A && git commit

# If not acceptable, abort
git merge --abort
```

## Notes

- This workflow works for both `git merge` and `git rebase` conflicts
- GitWand's format-aware resolvers (JSON, YAML, lockfiles, imports) often resolve conflicts that look complex at the text level but are trivial at the semantic level
- The `.gitwandrc` config file controls resolution policies — check it before previewing if the repo has one
