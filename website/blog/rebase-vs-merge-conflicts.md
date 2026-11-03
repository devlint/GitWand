---
title: "Rebase or merge: which one gives you fewer conflicts?"
description: "A merge asks one three-way question about two end states. A rebase asks one per replayed commit, against a base that includes your previous answers. Why that makes rebase repeat some conflicts and avoid others, what git rerere actually removes, and how GitWand drives a paused rebase."
date: 2026-11-03
head:
  - - meta
    - property: og:title
      content: "Rebase or merge: which one gives you fewer conflicts?"
  - - meta
    - property: og:description
      content: "The mechanics behind the folklore: a merge compares two end states once, a rebase replays every commit against your previous resolutions. Three small reproducible scenarios, what rerere removes (decisions, not pauses), and how GitWand handles a paused rebase."
---

# Rebase or merge: which one gives you fewer conflicts?

The usual answer is "merge, because a rebase makes you resolve the same conflict over and over". It is half right. A rebase can make you resolve a conflict four times that a merge shows once. It can also skip a conflict that a merge cannot avoid. Which one happens is not luck; it follows from what each command actually compares.

This article is about that mechanism. If you are in the middle of a rebase that keeps stopping and you want the commands to get out, the short practical page is [Git rebase keeps asking for the same conflict](/fix/rebase-same-conflict-every-commit). This one is the why behind it, and the question to ask before you pick.

---

## Three different things people call "conflicts"

Before comparing, it helps to separate three costs that the word "conflict" mixes together:

- **Stops**: how many times Git halts and waits for you.
- **Decisions**: how many of those stops ask a question you have to think about.
- **Size**: how much code each decision covers, and how much context you have while making it.

A merge and a rebase trade these against each other. "Fewer conflicts" usually means fewer stops, but the thing that costs you an afternoon is decisions, and the thing that causes bad resolutions is size.

## What a merge compares

`git merge main` from your branch runs one three-way merge per file:

- **base**: the merge base, the last commit both branches share;
- **ours**: the tip of your branch;
- **theirs**: the tip of `main`.

Only end states matter. Your branch might have twelve commits that rewrote a function three times; the merge sees the net difference between the base and your tip, and the net difference between the base and `main`. Where those two diffs touch the same lines, you get a conflict. Once.

That has two consequences people tend to forget. Intermediate states on your branch are invisible: if you changed a line and changed it back, the merge never hears about it. And everything that touches the same region is folded into one hunk: a conflict in a merge is the sum of every commit on both sides that touched those lines, with no indication of which commit wanted what.

## What a rebase compares

`git rebase main` is closer to a loop of cherry-picks. For each of your commits, oldest first, Git runs a three-way merge where:

- **base**: the parent of that commit, as it was on your branch;
- **ours**: the new `HEAD`, which is `main` plus every commit already replayed, including the resolutions you just made;
- **theirs**: the commit being replayed.

(That is why "ours" and "theirs" look swapped during a rebase; [Reading a Git conflict marker](/blog/reading-git-conflict-markers) covers it in detail.)

Two things follow from the second bullet. Each step is compared against the result of your previous answers, not against the original history. And each step only sees one commit's worth of change, so its hunks are as small as the commit, and you have its message in front of you while you resolve.

## The rule that decides whether a rebase repeats itself

Here is the part the folklore skips. A rebase does not repeat a conflict because Git "forgets" between steps. It repeats it when **your resolution of step N is not what commit N+1 expected to find**.

Commit N+1 was written on top of commit N as it originally existed. Its diff says "change line 4 from X to Y". If after your resolution line 4 still reads X, the patch applies cleanly. If it reads something else, because you combined your change with `main`'s, that step conflicts too.

So the more your resolutions differ from your own commits, the more a rebase repeats. And a good resolution of a real conflict usually *does* differ from both sides: it keeps what `main` did and what you did.

## Three small scenarios, measured

To check this rather than assert it, we built three tiny repositories and counted. These are constructed toy cases, one file of eight lines each, run with Git 2.34.1 and a clean configuration. They show the mechanism; they are not a benchmark of real projects, and the numbers say nothing about how often each shape happens in practice.

**A. Your branch edits the same line in four successive commits; `main` edited it once.**

```bash
# on feature, four commits:
sed -i '4s/.*/d-feature-v1/' f.txt   # f1
sed -i '4s/.*/d-feature-v2/' f.txt   # f2  ...and so on to v4
# on main, one commit:
sed -i '4s/.*/d-main/' f.txt
```

**B. Your branch changes a line, does something else, then reverts the line; `main` changed that line.**

**C. Your first commit was also cherry-picked to `main`; your second commit builds on it.**

For the rebase, we resolved each stop two ways: by taking the replayed commit's version ("theirs"), and by writing a line that is neither side, which is what a person merging both intents produces ("combine"). Manual stops counted:

| Scenario | `git merge main` | `git rebase main`, resolve = take commit | `git rebase main`, resolve = combine |
|---|---:|---:|---:|
| A. same line, four commits | 1 | 1 | **4** |
| B. change then revert | **0** | 1 | 2 |
| C. commit already upstream | 1 | **0** | **0** |

Each row is one of the mechanisms above:

- **A** is the rule in action. Taking your commit's line every time keeps every later patch applicable, so the rebase stops once. Combining, which is the realistic case, makes each later commit find a line it did not expect: four stops, four decisions, where the merge asked once.
- **B** is the intermediate-state problem. The merge sees your branch's net effect on line 4, which is nothing, and merges cleanly. The rebase replays the change and the revert separately, and both collide with `main`.
- **C** is where rebase wins. Before replaying, a rebase drops commits whose patch is already in the target branch (Git compares patch IDs; see `--reapply-cherry-picks` in the [git-rebase documentation](https://git-scm.com/docs/git-rebase)). Commit 1 vanishes, commit 2 now applies on top of the same line it was written against, and there is nothing to resolve. The merge only sees that both sides changed line 4 to different values, and stops.

## What `git rerere` removes, and what it does not

`rerere` ("reuse recorded resolution") records, for each conflict, the conflicted hunk and the version you resolved it to. The next time Git produces the same conflict, it applies your recorded answer instead of asking ([git-rerere documentation](https://git-scm.com/docs/git-rerere)). It is off by default; `rerere.enabled` turns it on, and `rerere.autoUpdate` also stages what it replays.

The key word is *same*. Run scenario A with rerere on and you still get four stops on the first pass, because each step's conflict is different: different base, different "theirs". Rerere has nothing to replay yet. It records four entries.

Where it pays is the second time the identical conflict happens. We then put the branch back where it was before the rebase and ran the same rebase again:

| Scenario A, combine, rerere on | Stops | Stops needing a decision |
|---|---:|---:|
| First rebase | 4 | 4 |
| Same rebase again | 4 | **0** |

Rerere removed every decision and none of the stops. Git still halted at each of the four commits; each time the file was already resolved and staged, and each time it waited for `git rebase --continue`.

So rerere fits a specific shape: the same conflict recurring. Redoing a rebase after an abort. Rebasing a long-lived branch, throwing the result away, and doing it again later. Test-merging a long-lived topic branch again and again before it lands, which is the workflow the git-rerere documentation itself walks through. It does not make the first resolution cheaper, and because it matches conflicts exactly, a near-identical conflict with one line of different context is a miss. [git rerere explained](/fix/git-rerere) covers the cache and when it replays something you did not mean.

## When each one costs the least

From the mechanics, not from taste:

**A merge costs less when** your branch touches the same lines in several commits, especially when the right resolution combines both sides (scenario A); when your branch contains experiments it later undid (scenario B); and when you will update from `main` more than once and do not want to re-resolve, because a merge resolution is made once and stored in the merge commit.

**A rebase costs less when** some of your commits are already upstream (scenario C); when your commits are small and each touches a different area, so each step is a small, well-labelled question; and when you are going to squash anyway. Squashing first (`git rebase -i` with `fixup`, or `git reset --soft main`) turns a multi-step rebase into a single step, which has the stop count of a merge without a merge commit.

**The two answer different "size" questions.** A merge gives you fewer, larger hunks with no history attached. A rebase gives you more, smaller hunks with a commit message next to each. If the conflict is genuinely hard, small and labelled can be worth the extra stops.

**`rerere` belongs in both.** It helps any repeated conflict, merge or rebase, and costs nothing when it misses.

## What we have not measured

GitWand's benchmark replays real history, but it replays **merges**: for each historical merge commit it re-merges the two parents with `git merge-tree` and classifies every conflicted hunk ([benchmark/README.md](https://github.com/devlint/GitWand/blob/main/benchmark/README.md); the replay of 2,000 merges on one PHP/Vue monorepo described in [From four tools to one](/blog/from-four-tools-to-one) works the same way). Neither measures what the same branches would have cost as rebases, so we do not have a real-world ratio of rebase stops to merge stops, and we are not going to quote one. The scenarios above explain the mechanism; how often each shape occurs in your repository is a property of your repository.

## How GitWand handles a paused rebase

When a rebase stops, the desktop app shows a banner above the changes view rather than a modal, so the files and the merge editor below stay reachable. It shows the commit being replayed, the target branch, and the step counter (`3 / 7`). Its buttons map to Git's own: **Continue**, **Skip**, **Abort**.

- **Continue** is disabled while any file is still conflicted. You resolve, the hint switches to "ready to continue", then you continue.
- **Skip** is the right answer when the commit's change is already in the target, the case rebase usually catches itself with patch IDs but not always.
- **Abort** asks for confirmation when you have already done resolution work that an abort would discard. Without that work, it just aborts.

The fourth button is **Auto-resolve**, and it drives the whole rebase, not one step. Each iteration runs the engine on the current step (with the LLM fallback only if you configured one), applies the resolutions that clear the confidence gate, stages the files that are now conflict-free, and runs `--continue`. A step that pauses without conflicts, an `edit` stop or one rerere already resolved, is simply continued. The loop stops when the rebase finishes, or at the first step that still has a conflict it would not decide on its own, and leaves that step to you with the rebase still in progress. It never aborts on your behalf, and it is bounded so a step that makes no progress cannot loop forever.

Two limits are worth stating plainly, because scenario A runs straight into both.

**GitWand does not learn your resolutions.** At step 2 of scenario A, the base is your original `d-feature-v1`, ours is your combined line from step 1, theirs is `d-feature-v2`. Both sides changed the same line differently: that is a `complex` hunk, and the engine hands it back. It does not remember that you combined at step 1 and do it again. That is deliberate: a resolution that depends on history is a new way to be confidently wrong, which is why the engine's decisions are a function of the hunk alone ([the failure-mode catalogue](/blog/auto-merge-failure-modes) explains the trade). Turn rerere on alongside it; Auto-resolve walks through the steps rerere has already resolved.

**The Conflict Predictor tells you which files, not how many stops.** Before a rebase, the predictor replays each of your commits against the target and reports per file. We ran it on the three scenarios, using the same per-commit replay the CLI exposes:

| Scenario | Rebase preview | Merge preview | Actual stops (rebase / merge) |
|---|---|---|---|
| A | 1 file, 1 conflict, high risk | 1 file, 1 conflict, high risk | 4 / 1 |
| B | 1 file, 1 conflict, high risk | clean, low risk | 2 / 0 |
| C | clean, low risk | 1 file, 1 conflict, high risk | 0 / 1 |

It points the right way in all three, which is the decision you actually need: B says merge, C says rebase. What it does not do is count steps. Results are deduplicated per file, and each commit is simulated against the target alone, not against the resolutions you will make along the way, so the "four" in scenario A only appears once you are in it.

## From the CLI and from an agent

The same predictor runs from the terminal. Compare both before choosing:

```bash
gitwand preview --onto=main     # rebase HEAD onto main, commit by commit
gitwand preview --branch=main   # merge main into HEAD
```

`--json` gives you the machine-readable summary used for the tables above. Once the rebase has stopped, `gitwand resolve` reads the markers on disk and knows it is inside a rebase (it detects `rebase-merge` / `rebase-apply` and reads `REBASE_HEAD`), so the ours/theirs orientation is the rebase's, not a merge's. See the [CLI guide](/guide/cli).

For a coding agent, the [MCP server](/guide/mcp) exposes the same thing as `gitwand_preview_merge` with `operation: "rebase"` and `onto`, and `gitwand_resolve_conflicts` for the stop it is sitting on. An agent that previews both operations before picking one avoids most of the rebases it would otherwise get stuck in.

---

The short version: a merge asks about two end states once; a rebase asks about every commit, against your own previous answers. Rebase repeats when your answers differ from your commits, and skips what is already upstream. Rerere removes repeated decisions, not stops. And the cheapest way to choose is to ask both questions before running either.
