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
`pnpm run test:scripts-lib` from the repo root, which runs every
`scripts/lib/*.test.mjs` file, including `seed-index.test.mjs`) — fast, no
network, no real installs: hand-built lockfile pairs that are
identical-modulo-volatile-values (must match) and pairs with a genuinely
different dependency graph (must not).

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

### Pilot run (2026-08-27) — superseded by the full sweep below

Before the merge-index-seeding fix (a follow-up plan's tasks 2–3:
`replay-regenerate.mjs` and the CLI's disposable worktree both now overlay
every already-resolved (stage-0) path of the real 3-way merge index onto the
`HEAD` worktree, in place of the `HEAD`-only scaffold this pilot ran against
— this makes `theirs`-only files visible to the installer; it does not, and
never did, change the seed state of the still-conflicted lockfile itself,
which stays at its `HEAD` content either way — see the fix's own doc comment
in `packages/cli/src/regenerate-runner.ts` for the precise scope), a bounded pilot
(`prettier/prettier`, yarn-berry, `--max-real 5`) measured **66.7 % (2/3)**
agreement, n = 3, and flagged the `HEAD`-only seeding as hypothesis (d) for
why the number might be low. That pilot's full write-up (including the
`laravel/framework`/`symfony/symfony` composer infeasibility finding, which
still stands unchanged) is preserved in git history; see the section below for
the real, full-scale numbers gathered after the fix.

### Full corpus sweep (2026-08-28) — post merge-index-seeding fix

> **This section's numbers are INVALIDATED, not corrected — do not treat any
> figure below as reliable.** The harness that produced this sweep had a real
> bug: `scripts/lib/seed-index.mjs`'s `seedScratchIndex` built its scratch
> index via `git read-tree <treeOid>` of a single tree, which puts EVERY path
> in that tree at stage 0 — including paths that were genuinely conflicted in
> the 3-way merge. `merge-tree --write-tree`'s conflicted blobs hold literal
> diff3 conflict-marker text as their content, so `checkout-index --all
> --force` wrote marker-laden content into the disposable worktree for every
> conflicted path in each candidate merge — a worktree state the real
> production CLI can never produce (a genuine in-progress merge's index keeps
> conflicted paths at stages 1/2/3, which `checkout-index --all` always
> skips). This most likely explains the dominant `spawn-failed` failure mode
> in the numbers below (11 of 13 runnable `prettier/prettier` candidates
> failed inside `yarn install` itself). The bug is now fixed (see the final
> review fix wave that added `skipPaths` to `seedScratchIndex` and
> `conflictedPaths` to candidate discovery in `scripts/replay-regenerate.mjs`)
> — but **a fresh full sweep against the fixed harness is required before this
> gate can be evaluated at all.** No estimate of what the corrected numbers
> would be is given here; none is implied by anything below.

Per this follow-up plan's task 4: the fix from tasks 2–3 is merged, so this is
the real ≤ 20-real-attempts-per-ecosystem sweep the pilot deferred, run against
all four corpus v2 repos whose language makes a v1-registry lockfile plausible
(`prettier/prettier`, `tauri-apps/tauri`, `expressjs/express`,
`twbs/bootstrap` — `laravel/framework`/`symfony/symfony` are still excluded,
confirmed infeasible for composer per the pilot's finding above;
`gohugoio/hugo`/`git/git` are outside the v1 registry's ecosystems entirely).
Each repo was cloned bare+blobless and pinned to its exact `benchmark/corpus.json`
SHA (`prepare()`'s recipe), then run through
`node scripts/replay-regenerate.mjs <repo> --max-real 20 --json`.

| Repo | Merges scanned | Ecosystem | Candidates found | Attempted | Runnable plans | Ran | Comparable | Matched | Agreement rate |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| `expressjs/express` | 485 | *(none)* | 0 | — | — | — | — | — | no candidates |
| `twbs/bootstrap` | 500 | *(none)* | 0 | — | — | — | — | — | no candidates |
| `prettier/prettier` | 237 | yarn-berry | 85 | 20 | 13 | 1 | 1 | 1 | 100.0 % (1/1) |
| `tauri-apps/tauri` | 56 | cargo | 22 | 20 | 0 | 0 | 0 | 0 | n/a (0 runnable) |
| `tauri-apps/tauri` | 56 | yarn-berry | 10 | 10 | 0 | 0 | 0 | 0 | n/a (0 runnable) |

**TOTAL, weighted by comparable attempts across all repos/ecosystems: 1/1 matched = 100.0 %.**

Detail per repo, exactly as measured, no rounding or omission:

- **`expressjs/express`** — 485 merges scanned, **zero** candidate merges
  across all five v1-registry ecosystems. `git ls-tree -r HEAD` confirms this
  repo carries **no lockfile at all** (no `package-lock.json`,
  `pnpm-lock.yaml`, `yarn.lock`, `composer.lock` or `Cargo.lock`) at the
  pinned commit — the regenerate tier has literally nothing to measure here.
  This matches corpus.json's own framing of `expressjs/express` as a control
  repo ("a repo where the engine should have little to do").
- **`twbs/bootstrap`** — 500 merges scanned, **zero** candidate merges, despite
  a committed `package-lock.json` existing in the tree (confirmed via
  `git ls-tree`). None of the 500 scanned merges happened to conflict on it.
- **`prettier/prettier`** — 237 merges scanned (unchanged from the pilot, same
  pin), 85 yarn-berry candidates found (unchanged from the pilot — candidate
  discovery is deterministic and pin-stable). Of the 20 attempted (the
  script's own cap): 7 **not-runnable** (`package.json` didn't fully settle via
  `resolve()`), 13 runnable, and of those 13: **11 `spawn-failed`** (`yarn
  install --mode=update-lockfile` exited 1), **1 `error`** (an unrelated
  partial-clone/promisor-fetch failure on one historical blob, not a
  regeneration-logic failure), and **1 `success`** — which also
  structurally matched the human-committed `yarn.lock`. Comparable sample:
  **n = 1**, agreement **100.0 %**.
- **`tauri-apps/tauri`** — only **56** merge commits are reachable from the
  pinned SHA (`rev-list --merges` walked the real, smaller history at this
  pin; not a truncation bug). 22 cargo candidates and 10 yarn-berry candidates
  were found (**32 candidates found**), but cargo's attempts were capped at
  `--max-real 20`, so only **30 candidates attempted** (20 cargo + all 10
  yarn-berry) — **all 30 attempted candidates across both ecosystems came back
  `not-runnable`** — `@gitwand/core`'s `resolve()` never fully settled
  `Cargo.toml`/`package.json` for any of them, so zero plans ever reached the
  regeneration step. Zero runnable, zero ran, zero comparable.

### The gate verdict

**n = 1, comparable.** The literal number, `1/1 = 100.0 %`, is arithmetically
above the ≥ 80 % target — but reporting that as "target met" would be exactly
the kind of rounding-up this project's discipline forbids. One data point is
not evidence of reliability in either direction. **Verdict: genuinely
inconclusive**, not "met." The real, full-scale sweep this task ran produced
a *smaller* comparable sample (n = 1) than the pilot it was meant to supersede
(n = 3) — running the harness against real network access and all four
in-scope corpus repos did not produce more comparable data; it mostly
produced a different, larger population of **non-comparable** outcomes
(`not-runnable`, `spawn-failed`, zero candidates).

Per the plan's own instruction for an inconclusive/below-target outcome:
**keep CLI opt-in only** (already true — `--regenerate`/`.gitwandrc`
`regenerate: true` already gate every regeneration behind explicit consent,
since tasks 1–3 of the original plan), **document findings, stop here.** The
desktop surface (task 5 of the original plan) is **not** justified by this
evidence — n = 1 justifies nothing either way. Do not read this section as
"the fix worked" or "the fix didn't work"; neither claim is supportable from
one data point.

On hypothesis (d) specifically (does merge-index seeding move the number):
**this sweep cannot confirm or refute it.** The fix from tasks 2–3 was
exercised (`replay-regenerate.mjs` now seeds its scratch index from the real
merge-tree result, per its module header), but the bottleneck this sweep hit
is a *different* failure surface than the one hypothesis (d) targeted: 11 of
13 runnable `prettier/prettier` candidates failed at the `yarn install
--mode=update-lockfile` step itself — before ever reaching the comparison the
seeding fix was meant to improve. Manually reproducing `yarn install
--mode=update-lockfile` against one of the same merges' unmodified checkout
(no `resolvedSources` overlay applied) succeeds cleanly in this environment,
so the toolchain itself is not broken; the failures are specific to the
regenerated worktree state for those particular candidates and were not
further root-caused here (out of scope for an operator-run measurement task).
Whether this `spawn-failed` surface is itself a side effect of seeding from a
more realistic (and more heterogeneous) merge-index state — as opposed to the
old `HEAD`-only worktree, which by construction produced closer-to-trivial
installs — is a plausible hypothesis, not a confirmed finding.

Before revisiting: (a) a corpus re-pin adding an application-shaped PHP repo
so the composer leg becomes measurable at all is still needed and is
explicitly out of scope for this plan; (b) the new dominant bottleneck,
`spawn-failed` on 11 of 13 runnable `prettier/prettier` candidates, needs its
own root-cause pass (capture full `yarn` stdout/stderr per failure, not just
the truncated 3-line `reason` string) before any further accuracy conclusion
is possible; (c) `tauri-apps/tauri`'s 100 % `not-runnable` rate across both
its ecosystems (32 candidates found, 30 attempted — cargo capped at
`--max-real 20`, all 10 yarn-berry attempted) suggests `resolve()`'s handling
of `Cargo.toml`/`package.json` conflicts in a large mixed-language monorepo
may itself be a bigger practical ceiling on this feature than the
regeneration step being measured here — worth its own investigation; (d) once
(b) is understood, a re-run with a materially larger comparable sample (not
just a larger attempted count) is needed before the ≥ 80 % target can be
honestly called met or missed.

## Results

`results/` holds one JSON file per measured GitWand version, plus the corpus pin
date that produced it. Keep old files: the whole reason for pinning is to be able
to say "the same 2 300 merges, one version later".

The per-repo breakdown is in every file, so a surprising headline can always be
traced to the repository that moved it.
