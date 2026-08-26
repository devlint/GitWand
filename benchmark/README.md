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

## What it does NOT measure

Stated plainly, because this is the limitation that matters:

**It measures decidability, not correctness.** An auto-resolved hunk is one the
engine claims is provably decidable. This run does not verify that the result
matches what the humans actually committed in the real merge.

That check is possible — the real merge commit is right there in the history, so
the engine's output can be diffed against the recorded resolution — and it is the
next thing to build here. Until it exists, read the headline as *"share of
conflicted hunks that carry no decision"*, not *"share resolved correctly"*.

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
by the same classifier doing the resolving. This benchmark uses a denominator
nobody chooses after the fact — **every conflicted hunk in the corpus** — and on
that basis the measured figures are the ones in the table above.

Both statements can be true at once, but only one of them is falsifiable. If a
number from this benchmark and a number on the website ever appear side by side,
the difference in denominator has to be visible, or the benchmark reads as a
refutation of the marketing rather than the source of it.

## Results

`results/` holds one JSON file per measured GitWand version, plus the corpus pin
date that produced it. Keep old files: the whole reason for pinning is to be able
to say "the same 2 300 merges, one version later".

The per-repo breakdown is in every file, so a surprising headline can always be
traced to the repository that moved it.
