# Conflict engine accuracy — findings and directions (2026-08-26)

**Status:** research / decision input. Not an implementation plan.

**Origin:** `benchmark/` now replays real merges and compares GitWand's output against
what the team actually committed. The first full run raised a question that coverage
had been hiding: *when the engine resolves a file on its own, how often does it produce
what the humans shipped?* Corpus-wide, **41.7 %** (411 of 986 files, byte-identical).

This document is the diagnosis behind that number. Every claim below is measured, and
the command that produced it is reproducible from `benchmark/`.

## The measurement that matters

Agreement broken down by what the classifier said about the file, on files the engine
resolved **end to end** (`mergedContent` non-null), excluding any file containing a
`complex` hunk:

| Hunk classification | laravel/framework | prettier/prettier |
|---|---|---|
| `generated_file` | 0 / 1 | **0 / 51 (0 %)** |
| `value_only_change` | **41 / 153 (27 %)** | 8 / 17 (47 %) |
| `non_overlapping` | 35 / 52 (67 %) | 31 / 65 (48 %) |
| any combination including `generated_file` | 0 / 2 | **0 / 77 (0 %)** |

Read that top row again. `generated_file` is a category the engine already recognises —
and it merges the file anyway, producing something the team never ships. Not once, in 77
attempts on prettier.

## Five findings

### 1. `generated_file` is resolved instead of regenerated — 0 % agreement

`package-lock.json`, `yarn.lock`, `go.sum`, Jest snapshots. The committed version of these
files is the **output of a tool**, not the merge of two texts. The team resolves
`package.json`, runs the installer, and commits whatever it produces. A structurally
perfect merge of two lockfiles is still not that file.

The engine has already identified these files. It just draws the wrong conclusion from it.

### 2. `value_only_change` guesses, and the guess is usually wrong — 27 % on laravel

The pattern's rule is "a scalar changed on both sides → keep the higher semver / later
timestamp". Measured against reality:

```
src/Illuminate/Foundation/Application.php
  GitWand : const VERSION = '12.54.1';
  humans  : const VERSION = '13.x-dev';
```

This is a back-merge from `12.x` into `13.x`. The correct answer is *always* the target
branch's value, and it is never the higher-looking number — `13.x-dev` doesn't even parse
as semver. Every one of laravel's version-bump merges hits this, which is most of the 112
disagreements.

The deeper point: **two sides setting the same scalar to different values is a decision,
not a triviality.** "Higher wins" is a heuristic wearing determinism's clothes — precisely
what the product promises not to do.

### 3. Format-aware resolvers bypass the classifier

On laravel, **116 of 325** fully-resolved files contained a hunk classified `complex` —
and were written anyway. 109 of them are `CHANGELOG.md`, resolved by the markdown
resolver's union.

```
stats: { totalConflicts: 1, autoResolved: 1, byType: { complex: 1 } }
```

`complex` means "overlapping edits, hand it back with a trace". A file whose only hunk is
`complex` must not come back fully resolved. Two consequences: the tier accounting
under-reports what actually gets applied, and these resolutions carry **no confidence
score and no decision trace** — the two things the product sells.

### 4. `validation` checks syntax, not format invariants

The changelog union produced a document with **two `## [Unreleased]` sections**, and
validation returned `isValid: true`. It looks for residual markers, syntax errors and
tree-sitter parse errors — all real checks, none of which can see that this document is
now nonsense for its own format.

### 5. The engine has no notion of merge direction

Nothing in `resolve(content, filePath, options)` knows which branch is being merged into
which, or whether this is a back-merge, a release train, or a feature merge. That context
is exactly what decides findings 1, 2 and 3 — the target branch's version wins, the
target branch's changelog structure wins, the installer decides the lockfile.

## Directions, ordered by yield

### A. Enforce the classifier contract (small, unblocks everything)

No hunk classified `complex` may be auto-applied. Format-aware resolvers stop being an
escape hatch and start returning a classification and a confidence like every other
pattern, so their output is traced and scored.

Coverage will drop. That is the point: today's coverage counts resolutions the product's
own contract says it should not have made. The [earlier decision](../../../benchmark/README.md)
to stop advertising a coverage percentage makes this cost-free.

### B. Per-format semantic validation (small, high trust)

Extend `ValidationResult` from "does it parse" to "does it satisfy the format's
invariants". Changelog: exactly one Unreleased section, version keys unique and
descending. `package.json` / `composer.json`: no duplicate keys, one value per key. YAML:
unique keys per mapping. A resolution that breaks an invariant is not applied, whatever
the pattern said.

This alone would have caught the two-`Unreleased` changelog and a good share of the
`non_overlapping` failures on `composer.json`, where the same key ends up twice with
different constraints.

### C. Merge context as a first-class input (biggest correctness win)

Pass the engine what it is doing: source ref, target ref, operation (merge / rebase /
cherry-pick / back-merge), and whether the target is the long-lived branch. Then:

- `value_only_change` on a version scalar → take the target branch's value, or decline.
  On laravel's corpus that turns ~112 wrong answers into right ones.
- Changelog → the target branch's structure wins; the incoming branch's release sections
  are a policy question, not a union.
- `--ours` / `--theirs` inversion during rebase stops being a footgun the docs warn about
  and becomes something the engine knows.

This is also the point where GitWand stops being a text tool and starts being a *merge*
tool.

### D. A regenerate tier for generated files (fixes the 0 %)

For declared-generated paths, don't merge — **resolve the source, then regenerate**:
resolve `package.json`, run `npm install --package-lock-only`, take the output. Same for
`composer.lock`, `go.sum`, `Cargo.lock`, `jest -u`.

Design constraints that make this non-trivial and worth speccing separately: a per-
ecosystem command registry, explicit user consent (this runs a tool that touches the
network and the disk), a sandbox and timeout, an offline fallback that declines rather
than merging, and a way to say "regeneration failed, here is the conflict back".

The honest interim: for these paths, **decline and explain** — "this file is generated;
resolve `package.json` and re-run your installer". Declining is worth more than a merge
that is wrong 100 % of the time.

### E. Key-aware merging for structured configs

`composer.json` and `package.json` conflicts are dependency-map merges, not line merges.
`non_overlapping` currently unions lines, which is why `"illuminate/reflection": "^12.0"`
and `"^13.0"` can both survive. The lockfile resolvers already merge by key; the same
treatment belongs on the manifests, where the same key changed on both sides is a
conflict, not two additions.

### F. Learn the repository's own conventions (the moat)

`scripts/replay-conflicts.mjs` already replays a repository's history. Point it at the
user's own repo and it can *derive* their policy: which side wins version scalars here,
whether this team regenerates or merges lockfiles, how their changelog is maintained —
measured on their own merges rather than assumed.

Nobody else in this market can do that, and the mechanism already exists. It is the
strongest form of the product's core claim: not "we know what's trivial" but "we measured
what your team does".

### G. Agreement as a CI gate

The benchmark becomes a regression test: a new pattern, or a change to an existing one,
must not lower agreement on the pinned corpus. Any pattern whose per-type agreement sits
below a threshold is a candidate for demotion from auto-apply to propose.

`token_level_merge` was already put on trial this way (PR #117). This generalises it.

## Suggested order

1. **A + B** — stop being confidently wrong. Small, and they make every later number
   meaningful.
2. **D's interim** — decline on generated files. One condition, removes the 0 % row.
3. **C** — merge context. The largest single correctness gain, and an architectural
   change worth its own plan.
4. **E**, then **D** in full, then **F**.
5. **G** alongside, from A onwards.

## Corpus caveat

`benchmark/corpus.json` needs re-pinning before any of this is scored: `rust-lang/cargo`
contributes zero conflicted merges, `django/django` ten, `vuejs/core` thirty-five. Four
repositories carry the whole result, and laravel's back-merge pattern is over-represented
in exactly the findings above. Select the next corpus on
`git rev-list --merges --count HEAD`, and re-run these tables before treating any of the
per-pattern percentages as settled.
