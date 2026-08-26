# GitWand merge benchmark

A reproducible measurement of how much of a real merge conflict is *not actually
a decision*.

Every claim GitWand makes about auto-resolution comes from this: a fixed corpus
of public repositories, pinned to exact commits, whose historical merges are
replayed and fed through the engine. The runner, the corpus and the results are
all in this folder. If a number on the website disagrees with a file in
`results/`, the file is right.

## What it measures

For each merge commit in the corpus, the two parents are re-merged with
`git merge-tree --write-tree` (conflict style `diff3`, so the common ancestor is
always available), and every conflicted hunk is classified by
[`@gitwand/core`](../packages/core). Each hunk lands in one of four tiers:

| Tier | Meaning |
|---|---|
| `trivial` | A pattern proves there is nothing to decide — identical edits, one-sided change, reorder, boundary insertion, whitespace, scalar bump. Auto-applied. |
| `advancedDeterministic` | A structural resolver handled it — lockfile, JSON, YAML, import block, Vue SFC, CSS. Auto-applied. |
| `model` | Only reachable by the opt-in LLM fallback. Never auto-applied. |
| `unresolved` | Genuine overlapping edits. Handed back with a trace. |

The headline number is `trivial + advancedDeterministic` over total hunks,
**weighted by hunk count, not averaged per repository** — averaging per-repo
percentages is the standard way to make a benchmark say whatever you want.

### Read the per-repo numbers first

The first two repositories measured (GitWand 3.8.0, corpus pinned 2026-08-26)
came out like this:

| Repo | Merges replayed | Hunks | Auto-resolved |
|---|---:|---:|---:|
| `expressjs/express` | 200 | 586 | **23.4 %** |
| `vuejs/core` | 35 | 401 | **76.1 %** |

That spread is the most important thing in this document. It is not noise: the
two repositories genuinely differ in what their conflicts are made of. Express's
residual is 76 % `complex` — real overlapping edits in a small, old, hand-tuned
codebase. Vue's conflicts are dominated by the mechanical kind a monorepo
produces.

So **a single corpus-wide percentage is close to meaningless on its own** — it
mostly reports which repositories are in the corpus. The per-repo table is the
result; the aggregate is a summary of the corpus, not a property of the engine.
Any published number should carry the corpus pin date and the spread.

`vuejs/core` also illustrates a corpus hazard worth naming: it yields only 35
merge commits, because the project squash-merges. The runner prints a warning
when a repository returns fewer than half the merges asked for — a repo that
contributes 35 merges looks like a full participant in the list and is a rounding
error in the total.

## Agreement with the human merge — the number that matters

Coverage says how much work the engine removes. It does not say whether you
should trust the result. That second question has an answer available for free:
the real merge commit is right there in the history, so when the engine resolves
a file **end to end** (`mergedContent` non-null — no conflict left), its output
can be compared byte-for-byte with what the team actually committed.

Full corpus, GitWand 3.8.0, pinned 2026-08-26 — **1 662 merges replayed, 568 with
conflicts, 5 631 hunks**:

| Repo | Hunks | Auto-resolved | Files resolved end-to-end | Byte-identical |
|---|---:|---:|---:|---:|
| `vuejs/core` | 401 | 76.1 % | 226 | **92.5 %** |
| `expressjs/express` | 586 | 23.4 % | 47 | **59.6 %** |
| `tauri-apps/tauri` | 2 129 | — | 143 | **26.6 %** |
| `prettier/prettier` | 1 281 | — | 179 | **25.3 %** |
| `laravel/framework` | 696 | — | 325 | **24.3 %** |
| `gohugoio/hugo` | 507 | — | 63 | **15.9 %** |
| `django/django` | 31 | — | — | — |
| `rust-lang/cargo` | 0 | — | — | — |
| **Corpus** | **5 631** | **55.5 %** | **986** | **41.7 %** |

### What the disagreements actually are

Look at *which* files disagree before reading any percentage. On
`laravel/framework` and `tauri-apps/tauri` the list is almost entirely
`CHANGELOG.md`. On `prettier/prettier` and `gohugoio/hugo` it is `yarn.lock`,
`go.sum` and docs. On `vuejs/core`, `pnpm-lock.yaml` and Jest snapshots.

These are files whose committed version is **regenerated, not merged** — the team
ran the release tool, the installer, or `--update-snapshot` after resolving. No
merge algorithm reproduces a regenerated artefact, so a mismatch there is not
proof the engine was wrong.

But it is not nothing either, and this is the uncomfortable half:

> GitWand auto-resolves those files today, and its answer differs from what the
> team shipped in roughly three cases out of four. A user whose convention is
> "regenerate the changelog" gets a merged one instead, quietly.

That is a product finding, not a measurement artefact — and digging into it turned
up four more, including a `generated_file` classification that the engine
recognises and then merges anyway, at **0 % agreement over 77 attempts**. The
diagnosis and the directions that follow from it are in
[`docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md`](../docs/superpowers/specs/2026-08-26-conflict-engine-accuracy.md).

Either way, **the number should not be published until that is decided** — quoting
41.7 % without this paragraph is misleading, and quoting only `vuejs/core`'s
92.5 % is cherry-picking.

The same caution applies in the other direction: a recorded merge may contain
edits the human made while resolving — an "evil merge" — which nothing could
reproduce. So the metric is a **lower bound on correctness**, not a score, and it
is reported as exact and whitespace-normalised counts with retained examples
rather than as a single grade.

### The corpus needs re-pinning

This run also indicts the corpus. `rust-lang/cargo` contributed **zero** merges
with conflicts, `django/django` ten, `vuejs/core` thirty-five — these projects
squash-merge or use a merge queue, so there is almost nothing to replay. Four
repositories carry the entire result.

The next pin should select for *projects that actually merge feature branches*,
verified by `git rev-list --merges --count HEAD` before adding them, rather than
for language coverage. Language diversity is worth nothing if the repository has
no conflicted merges in it.

## What it does NOT measure

Two smaller caveats:

- Files above 1 MB and binary-ish extensions are skipped; `skippedFiles` reports
  how many, and it is part of the output rather than quietly excluded.
- `merge-tree` failures are counted (`mergeTreeErrors`), so a systematic failure
  can't masquerade as "this repo had no conflicts".

## The corpus

Eight public repositories, ~2 300 merges, spread across TypeScript, Rust, Python,
JavaScript, Go, PHP and mixed monorepos. Two are in there deliberately to work
*against* the engine: `prettier/prettier`, whose code is already normalised so
`whitespace_only` should find almost nothing, and `expressjs/express`, small and
quiet enough to act as a control.

Each entry is pinned to a commit SHA, never a branch. Re-pinning is a deliberate
act — bump `pinnedAt`, update the SHAs, keep the old results file. A corpus that
drifts silently makes two results incomparable, which defeats the point.

See [`corpus.json`](corpus.json) for the list, the pins, and why each repo is in
it.

## Running it

```bash
pnpm --filter @gitwand/core build     # the replay imports the built engine
node benchmark/run.mjs                # whole corpus
node benchmark/run.mjs --repo vuejs/core
node benchmark/run.mjs --refactoring  # include the opt-in refactoring-aware pass
```

Requires **git ≥ 2.38** (`merge-tree --write-tree`) and Node ≥ 22.

The first run clones the corpus into `benchmark/.cache` as bare, blobless
repositories — several GB and a long wait. Later runs fetch nothing, because the
SHAs are pinned. Results are written to `results/v<version>.json`.

## Running it against a different tool

The corpus and the method are the reusable part, and we would rather be measured
against them than have everyone publish their own unfalsifiable percentage.

The interface a competing resolver needs is small: **given a file containing
`diff3`-style conflict markers on stdin, write the resolved file to stdout, or
exit non-zero to decline the hunk.** That is enough to slot any tool into the
same replay and produce a directly comparable number.

That adapter is **not implemented yet** — today `run.mjs` calls `@gitwand/core`
directly. It is a small change to
[`scripts/replay-conflicts.mjs`](../scripts/replay-conflicts.mjs) and a PR adding
it, with another tool wired up, is very welcome. Being shown a repo where we do
worse is more useful to us than another repo where we do well.

## A note on the "95 %" claim

GitWand's marketing says it auto-resolves "~95 % of *trivial* conflicts". Note
the denominator: that sentence is close to circular, since "trivial" is defined
by the same classifier doing the resolving. This benchmark uses denominators
nobody can choose after the fact — every conflicted hunk in the corpus for
coverage, every end-to-end resolved file for agreement — and on that basis the
measured figures are the ones in the tables above.

Both statements can be true at once, but only one of them is falsifiable. If a
number from this benchmark and a number on the website ever appear side by side,
the difference in denominator has to be visible, or the benchmark reads as a
refutation of the marketing rather than the source of it.

The measurements also settled which claim is worth making — by ruling both out
for now. Coverage is largely a property of *your codebase* (0 % to 76 % across
this corpus). Agreement is a property of the engine, but at 41.7 % it is not
publishable until the changelog/lockfile question above is decided.

So the site stopped claiming a percentage at all. It says the thing that is true
in every repository — some conflicts carry no decision, and those are the ones
GitWand answers — and points here for the numbers, with their denominators
attached. When the corpus is re-pinned and the regenerate-by-convention paths are
settled, there will be a figure worth putting on a landing page.

## Measured impact of the engine changes

The corpus is already earning its keep. Same pins, three engine states
(files resolved end-to-end that are byte-identical to the human merge):

| Repo | v3.8.0 baseline | + lot 1 (contract/invariants/decline) | + merge context | + key-wise manifests |
|---|---:|---:|---:|---:|
| `laravel/framework` | 24.3 % | 36.6 % | 81.9 % | **83.3 %** (245 files) |
| `prettier/prettier` | 25.3 % | 45.0 % | 45.0 % | **49.6 %** (117 files) |
| `vuejs/core` | 92.5 % | 95.0 % | 90.0 %* | **90.1 %** (222 files) |
| `expressjs/express` | 59.6 % | 59.2 % | 59.2 % | **61.3 %** (62 files) |

The key-wise manifest merge (lot E) is the first change that raises **both**
metrics at once: more files resolved end-to-end (laravel 216 → 245, express
49 → 62) *and* a higher share of them byte-identical — because merging
`"key": value` fragments by key, with a bounded same-operator version
arbitration, replaces the line-level union that produced plausible-but-wrong
dependency blocks.

\* vue's apparent drop is a **denominator artefact, not a regression**: a
per-file flip scan found zero files where the previous engine agreed and the
new one doesn't. Fixing the version-identity hunk pulls previously-excluded
files into the comparable set, where they disagree on *other* hunks — all 11
in one merge, dominated by a `workspace:*` protocol migration the humans did
while merging (an evil merge nothing reproduces).

The merge-context rule also went through one refinement this table forced:
its first version sent *orderable* semver pairs to the target side too, and
agreement regressed on prettier (45.0 → 39.0), vue and express — teams do take
the newer dependency brought by the source branch. Target-wins now applies
only to unorderable version pairs (the file's version identity: `13.x-dev`,
`2.9.0-dev`), which is where all of laravel's gain lives. This is exactly the
kind of decision the benchmark exists to make.

## Split-half validation of derived conventions (lot F gate)

Lot F derives a repo's own merge conventions from its history. Gate protocol:
derive on the older half of each corpus repo's merges, measure agreement on
the recent half with and without the derived conventions applied.

Result (engine at lot E): **flat everywhere — zero regressions, zero gains.**
prettier and vue derive `generatedFiles: regenerate` at 100 % agreement (16
and 5 samples); laravel and express clear no evidence floor. Nothing changes
behaviour because every verdict *confirms the engine's defaults*.

That is not a null result — it is a circularity warning worth recording: the
defaults were calibrated on this corpus, so conventions derived from the same
corpus can only agree with them. The layer's value is (a) **provenance** — 
"declined because your repo regenerates lockfiles, measured on 16 merges" is a
different product than "declined because we say so" — and (b) repos that
**diverge** from the defaults: a team that genuinely merges its lockfiles gets
its auto-resolution back (verdict `merge`), a tool-rebuilt changelog gets its
unions declined. Both behaviours are pinned by unit tests on fabricated
histories; demonstrating them on real public repos needs corpus candidates
*selected for divergent conventions*, which the next re-pin should include.

Per the gate, the desktop surface is deferred; core + CLI ship (the
measurement itself, `gitwand conventions`, has standalone value).

## Results

`results/` holds one JSON file per measured GitWand version, plus the corpus pin
date that produced it. Keep old files: the whole reason for pinning is to be able
to say "the same 2 300 merges, one version later".

The per-repo breakdown is in every file, so a surprising headline can always be
traced to the repository that moved it.
