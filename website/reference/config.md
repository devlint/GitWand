---
title: 'GitWand configuration reference — .gitwandrc options'
description: 'Every GitWand configuration option: policies, per-glob pattern overrides, confidence thresholds and LLM fallback settings, via .gitwandrc or a "gitwand" key in package.json.'
---

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

## Generated Files

Lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`…),
minified bundles and `dist/` outputs are detected as **generated files**. By
default GitWand declines to auto-resolve them and tells you why: the committed
version of a generated file is a tool's output, not a merge of two texts —
[measured on 1,662 real merges](https://github.com/devlint/GitWand/tree/main/benchmark),
auto-merging them diverged from what teams actually shipped in almost every
case. Resolve the source file (`package.json`, `composer.json`…), re-run the
installer or build, and the conflict disappears.

Only the patterns that fabricate nothing still apply automatically on these
files: identical edits on both sides, a change on one side only, a deletion
against an untouched side, whitespace-only differences.

To extend detection to your own generated paths:

```json
{
  "generatedFiles": ["src/**/*.generated.ts", "*.pb.go", "api/openapi-client/**"]
}
```

To restore full auto-resolution (semantic lockfile merges, accept-theirs) — for
example if your team genuinely merges lockfiles rather than regenerating them:

```json
{
  "resolveGeneratedFiles": true
}
```

The CLI equivalent is `gitwand resolve --resolve-generated`. This is a
repository convention, so it lives in `.gitwandrc` rather than in the app
settings.

### Regenerate tier

Merging a lockfile textually is wrong in almost every real case — the
committed version is a tool's output, not the union of two edits. Rather than
guess, GitWand can instead resolve the *source* file (`package.json`,
`composer.json`, `Cargo.toml`…) and re-run the ecosystem's own installer to
regenerate the lockfile, then take that as the resolution.

This never happens automatically. It requires explicit opt-in, per invocation
or per repository:

```bash
gitwand resolve --regenerate
```

```json
{
  "regenerate": true
}
```

When declined without the flag, `gitwand resolve` now suggests it by default
whenever a lockfile ecosystem is recognized:

```
Some declined file(s) could be auto-resolved by regenerating their lockfile — re-run with --regenerate.
```

**What runs.** A small, deliberately narrow registry of ecosystems that each
expose a lockfile-only, script-suppressed mode — never a full install:

| Ecosystem | Command |
|---|---|
| npm | `npm install --package-lock-only --ignore-scripts` |
| pnpm | `pnpm install --lockfile-only --ignore-scripts` |
| Yarn (Berry only) | `yarn install --mode=update-lockfile` |
| Composer | `composer update --lock --no-scripts --no-install` |
| Cargo | `cargo generate-lockfile` |

The command runs inside a disposable `git worktree` — never your real working
tree — populated only with the already-resolved source files, under a
wall-clock timeout (120s by default). The command and its duration are folded
into the resolution reason; the full trace (binary, arguments, duration, exit
code) is visible with `--verbose`. The script-suppression flags in the table
above are registry constants; nothing you configure can remove them.

**What never runs.** No full `install` (dependencies aren't actually
downloaded beyond what resolving the lockfile requires), no lifecycle scripts
(`postinstall` and friends), and no attempt at all when the ecosystem needs
network access and the machine is offline — that case declines with the same
interim message as always, never a partial or guessed lockfile. Any failure
(missing toolchain, timeout, non-zero exit, invalid output) hands the conflict
back untouched, with the failure detail appended to the reason.

**Interaction with measured conventions.** The `gitwand conventions` CLI command
can measure, from a repository's own merge history, whether its team actually
regenerates or textually merges its generated files. A measured `"regenerate"`
verdict is only ever a *hint* — the extra provenance text visible via
`gitwand resolve --verbose` and the default summary offer above — it never
runs the regenerate tier by itself. A measured `"merge"` verdict, by contrast,
can flip the textual path on (equivalent to `resolveGeneratedFiles: true`) when
nothing more specific overrides it. Precedence, most to least specific:

1. `gitwand resolve --resolve-generated` / `--regenerate` (explicit, per invocation)
2. `.gitwandrc` `resolveGeneratedFiles` / `regenerate` (explicit, per repository)
3. A measured `generatedFiles` convention (`gitwand conventions`)
4. The engine's own default — decline, with an actionable message

## Merge Context

GitWand's engine accepts an optional **merge context** — which operation is in
progress (merge, rebase, cherry-pick, revert) and which side of the conflict
markers is the target branch. You normally never set this: the desktop app, the
CLI and the MCP server detect it from the repository's `.git` state.

It changes one class of decision. A version scalar set differently on both
sides (`'13.x-dev'` vs `'12.54.1'`) is a real decision, not a volatile value —
and with context, the answer is deterministic: **the target branch keeps its
version identity**. Measured on laravel/framework's real merge history, this
took agreement with the humans' own resolutions from 36.6 % to 81.9 %. Without
context, GitWand proposes instead of applying. Ordinary dependency bumps
(orderable versions on both sides) keep the "newest wins" rule either way.

API consumers can pass it explicitly:

```ts
resolve(content, filePath, {
  mergeContext: { operation: "merge", targetSide: "ours", oursRef: "13.x", theirsRef: "12.x" },
});
```

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
