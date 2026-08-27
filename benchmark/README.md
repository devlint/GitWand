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

### Corpus v2 (pinned 2026-08-26) — selected on measured merge history

The v1 corpus indicted itself: cargo contributed zero conflicted merges, django
ten, vue thirty-five. v2 was re-pinned after **probing** candidates
(`rev-list --merges` + a merge-tree conflict-rate sample): kubernetes, rails and
godot were rejected at 0 conflicted merges per 60 (merge queues); symfony
(back-merge culture, composer.json in half its conflicts), git/git (integration
branches, maintainer-resolved conflicts — the best human ground truth available)
and bootstrap (an adversarial `_variables.scss` family no resolver special-cases)
came in. vue was dropped *despite* being the 92–95 % showcase — keeping it would
have been flattering rather than informative.

Current-engine baseline on v2 (`results/v3.8.0-corpus2-baseline.json`):
**1 927 merges, 634 with conflicts, 5 675 hunks — 59.2 % of end-to-end-resolved
files byte-identical to the human merge (391/660), per-repo spread 17.5–65.4 %.**
This file is the reference the CI gate compares against.

### The CI gate (lot G)

`.github/workflows/benchmark-gate.yml` replays the corpus on every PR touching
the engine and fails via [`compare.mjs`](compare.mjs) when agreement drops
beyond noise (−1.5 pts corpus-wide, −5 pts on any repo) or coverage collapses
(>−25 % files resolved end-to-end) — a deliberate decline policy must update
the baseline in the same PR, with the reasoning in the commit message. Clones
are cached keyed on the corpus hash, so only the first run after a re-pin pays
the cloning. This generalizes the `token_level_merge` trial (PR #117): no
pattern ships if the corpus says it makes the engine less right.

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

Re-run on the v2 corpus additions (symfony, git/git, bootstrap): still flat —
each half of their histories yields too few per-question samples to clear the
evidence floors. The verdict stands, and sharpens: the layer will prove itself
either on repos with *dense* lockfile/changelog conflict histories, or once
pathPolicies graduate from report-only to applied (lot F v2).

## Regenerate-tier replay (accuracy lot D, task 4)

The agreement metric above (`run.mjs`/`replay-conflicts.mjs`) replays merges with
`git merge-tree --write-tree`, which never touches a working tree — it can score
whether a *textual* merge would match the human's, but it cannot score
regeneration, because regeneration is "resolve `package.json`/`composer.json`,
then re-run the ecosystem's installer and take *its* output as the answer".
That needs a real checkout and a real `npm install`/`composer update`/`yarn
install` invocation. `scripts/replay-regenerate.mjs` is that harness:

1. **Cheap stage** — same `merge-tree --write-tree` (diff3) sweep as
   `replay-conflicts.mjs`, over the already-cloned corpus repo, to find
   candidate merges: ones whose conflict set includes a lockfile from the v1
   registry (`packages/core/src/regenerate/registry.ts` — npm, pnpm,
   yarn-berry, composer, cargo).
2. **Expensive stage**, bounded to `--max-real` merges per ecosystem (the
   plan's own ceiling: ≤ 20) — for each candidate: settle the ecosystem's
   `sourcesOfTruth` from the merge-tree result (clean, or resolved via
   `@gitwand/core`'s `resolve()`; a still-conflicted source makes the plan
   non-runnable, exactly as `buildRegenerationPlan` decides for the real
   CLI), then run the **actual production executor** —
   `runRegeneration()` from `packages/cli/src/regenerate-runner.ts` — in a
   disposable `git worktree`, and structurally compare the regenerated
   lockfile against the one the team actually committed
   (`scripts/lib/regenerate-compare.mjs`).

Reusing `runRegeneration` (rather than reimplementing the executor for the
harness) means this measures the exact code path the CLI ships, not a stand-in.

### Structural comparison

Byte-exact comparison almost never holds — dependency resolvers vary resolved
URLs, integrity hashes and key ordering run-to-run even with unchanged inputs.
`regenerate-compare.mjs` extracts the `name@version` identity set from each of
the five registry lockfile formats (`packages`/`dependencies` for npm,
`packages`/`packages-dev` for composer, the `packages` map keys for pnpm, the
locator blocks for yarn-berry, `[[package]]` tables for cargo) and compares
those sets — ignoring hashes, resolved URLs and ordering by construction. If
format-aware parsing fails (corrupt output, an unexpected variant),
it falls back to a text compare via `stripVolatileValues`
(`@gitwand/core`, exported from `packages/core/src/resolver/generated-detection.ts`
for this purpose) rather than crashing the run. Both paths are covered by
fixture tests — `node --test scripts/lib/regenerate-compare.test.mjs` (also
`pnpm run test:regenerate-compare` from the repo root) — fast, no network, no
real installs: hand-built lockfile pairs that are identical-modulo-volatile-values
(must match) and pairs with a genuinely different dependency graph (must not).

### Running it

```bash
pnpm --filter @gitwand/core build   # replay imports the built engine
pnpm --filter @gitwand/cli build    # replay reuses the real runRegeneration() executor
node scripts/replay-regenerate.mjs <repo-path> \
  [--max-merges N] [--max-real N] [--ecosystem npm,composer,...] [--timeout-ms N] [--json]
```

`<repo-path>` must already be a local clone with the target commit reachable
(bare + blobless + pinned, exactly like `benchmark/run.mjs`'s `prepare()` — this
script does not clone for you, same separation of concerns as
`replay-conflicts.mjs`). Requires the ecosystem's own toolchain in `PATH`
(`npm`/`pnpm`/`yarn`/`composer`/`cargo`) and network access to the relevant
package registry; a missing toolchain or offline registry is reported as a
graceful per-candidate skip, not a crash.

### Why this lives outside the CI gate

Same reasoning as `replay-conflicts.mjs`/`run.mjs` being operator-run tools:
this script needs the corpus repos already cloned, needs real network access to
package registries, spawns real installers with real wall-clock timeouts, and a
dependency resolver's output is not byte-for-byte deterministic run to run —
none of that belongs in a required CI check. `scripts/replay-regenerate.mjs`
is run manually/in the container, same as its siblings.

### Pilot run (2026-08-27) — SMALL SAMPLE, read the caveat before the numbers

Per the task-4 plan, a full ≤ 20-merges-per-ecosystem sweep was explicitly
**not** run — this is a bounded pilot (≤ 5 real attempts per ecosystem) meant
to decide whether a full run and the desktop surface (task 5) are worth
building at all. Both named corpus v2 repos (`benchmark/corpus.json`, cloned
bare+blobless, pinned to their corpus SHA, same recipe as `run.mjs`'s
`prepare()`) were used, with one correction and one hard blocker discovered
along the way:

- **`laravel/framework` (composer) — INFEASIBLE, not just slow.** `git log
  --all -- composer.lock` returns **zero commits, ever**, in the entire
  history. `laravel/framework` is a Composer *library* package, and library
  packages deliberately do not commit a lockfile (only applications do) — this
  is architectural, not an environment or toolchain problem. The same check
  against `symfony/symfony` (the corpus's other PHP repo) confirms it has no
  `composer.lock` either. **Corpus v2 currently has no repository that can
  measure the composer leg of this gate at all** — a future re-pin needs an
  application-shaped PHP repo (the way `prettier/prettier`/`vuejs/core` are
  application-shaped for npm-family ecosystems).
- **`prettier/prettier` — the brief's "npm ecosystem" label was wrong.**
  `git ls-tree` shows no `package-lock.json` anywhere in the repo, ever; the
  repo has a root `.yarnrc.yml` with `yarnPath: .yarn/releases/yarn-4.18.0.cjs`
  and a root `yarn.lock` — it is a **yarn-berry** repo. The pilot used the
  correctly-identified ecosystem for the same named repo rather than
  fabricating an npm measurement that has no basis in this repo's history.
  (Confirmed the delegation works in this environment: only yarn classic
  1.22.x was installed via `npm install -g yarn`, and running `yarn
  --version` inside a checkout of the repo correctly reports `4.18.0` —
  yarn's `yarnPath` respawn works even from a classic binary.)

Result, `prettier/prettier`, yarn-berry, 237 merges scanned, `--max-real 5`:

| Metric | Value |
|---|---:|
| Candidate merges found (conflicting `yarn.lock`) | 85 |
| Attempted (the pilot's own cap) | 5 |
| Runnable plans (source resolvable) | 3 |
| Ran successfully (real `yarn install --mode=update-lockfile`, no toolchain/timeout/spawn failure) | 3 |
| Comparable (regenerated + actual committed content both available) | 3 |
| Structurally matched | 2 |
| **Agreement rate** | **66.7 % (2/3)** |

The two non-runnable candidates declined because `@gitwand/core`'s `resolve()`
could not fully settle `package.json` on its own (genuine overlapping edits,
correctly not auto-resolved) — exactly the behaviour the real CLI would show
for those same two merges.

### The gate verdict

**n = 3.** That is not a corpus, it is barely a sample, and it is the honest
result of following Ruling P-9's bound (≤ 5 real attempts per ecosystem) against
a repo where two of five candidates were correctly declined before reaching
comparison. The measured rate, 66.7 %, is **below the ≥ 80 % target**, and one
of the two named corpus repos (`laravel/framework`) could not be measured on
the composer leg **at all** — not "below target", but no data.

Per the plan's own instruction for this outcome: **keep CLI opt-in only**
(already true — `--regenerate`/`.gitwandrc` `regenerate: true` already gate
every regeneration behind explicit consent, since tasks 1–3), **document
findings, stop here.** The desktop surface (task 5) and any default-on
regeneration behaviour are **not** justified by this evidence. This is a
pilot-scale, single-ecosystem, n = 3 result — it does not prove regeneration is
unreliable at 66.7 % either; it proves the question isn't answered yet. Before
revisiting: (a) re-pin the corpus with at least one application-shaped PHP repo
so the composer leg is measurable, (b) run the plan's full ≤ 20-merges-per-ecosystem
sweep across npm, pnpm, yarn-berry, composer and cargo, and (c) characterise
the one observed mismatch (which package(s) diverged, and why) rather than
treating a single data point as noise.

## Results

`results/` holds one JSON file per measured GitWand version, plus the corpus pin
date that produced it. Keep old files: the whole reason for pinning is to be able
to say "the same 2 300 merges, one version later".

The per-repo breakdown is in every file, so a surprising headline can always be
traced to the repository that moved it.
