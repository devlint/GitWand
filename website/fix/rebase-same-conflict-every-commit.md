---
title: Git rebase keeps asking for the same conflict — why, and how to stop it
description: A rebase replays every commit, so one conflict can come back a dozen times. Why it happens, how git rerere makes it resolve itself, and the three ways to avoid the replay entirely.
head:
  - - meta
    - property: og:title
      content: Git rebase keeps hitting the same conflict — how to stop it
  - - meta
    - property: og:description
      content: Why one conflict comes back on every commit of a rebase, and the four ways out — rerere, squash-first, merge instead, or an engine that resolves it.
---

# Git rebase keeps asking for the same conflict

You resolve a conflict, run `git rebase --continue`, and the same conflict in the same file appears again. And again. Twelve commits, twelve identical resolutions.

Nothing is broken. This is what a rebase does.

## Why it repeats

A rebase does not move your branch. It **replays each of your commits, one at a time**, onto the new base. Each commit is applied as a patch, in isolation, against the result of the previous one.

So if `main` changed a function that eight of your commits also touch, that same textual clash is presented eight times — once per replayed commit. Git has no memory between steps. From its point of view these are eight unrelated patch applications that happen to look identical.

Two variants of the same pain:

- **Same conflict, every commit.** `main` changed something your whole branch touches.
- **Conflict, then the *inverse* conflict.** A commit later in your branch already fixed what you are being asked about. You resolve it forward, then a later commit conflicts because the file no longer looks the way that commit expected.

## Fix 1: let git remember — `rerere`

`rerere` ("reuse recorded resolution") records how you resolved a given conflict and replays that resolution automatically the next time git sees the identical conflict.

```bash
git config --global rerere.enabled true
git config --global rerere.autoUpdate true   # also stage the replayed resolution
```

Enable it and restart the rebase:

```bash
git rebase --abort
git rebase main
```

Resolve the conflict **once**. On every subsequent commit that hits the same conflict, git resolves it for you and prints:

```
Resolved 'src/api/client.ts' using previous resolution.
```

With `rerere.autoUpdate` on, the file is staged too, so `git rebase --continue` just works. This is the single highest-value git config for anyone who rebases regularly, and it is off by default. See [git rerere explained](/fix/git-rerere) for how the cache works and when it misfires.

## Fix 2: give it fewer commits to replay

The conflict repeats once per commit. Collapse the commits and it happens once.

```bash
git rebase -i main       # mark the noisy commits as `squash` / `fixup`
```

If your branch is going to be squash-merged anyway, squashing before the rebase costs you nothing and turns twelve conflicts into one. The pragmatic version, when history does not need preserving:

```bash
git reset --soft main    # one commit's worth of changes, staged
git commit -m "feat: the whole branch"
```

## Fix 3: merge instead of rebase

A merge resolves the conflict exactly once, because it compares two end states rather than replaying a sequence:

```bash
git merge main           # instead of: git rebase main
```

The cost is a merge commit in your branch's history. If your team squash-merges PRs, that merge commit disappears at merge time anyway — in which case rebasing to keep history linear is buying you nothing during review.

Whichever you choose, **be explicit**:

```bash
git pull --rebase        # or: git pull --no-rebase
```

A bare `git pull` inherits whatever `pull.rebase` happens to be configured, locally or globally, which is how people end up in a rebase they did not ask for and cannot explain.

## Fix 4: get out of the one you are in

```bash
git rebase --skip        # drop the commit being replayed (it's already applied upstream)
git rebase --abort       # back to where you started, always safe
git rebase --continue    # after staging your resolution
```

`--skip` is the right answer more often than people think: if the commit's change is already present in the new base, replaying it is genuinely a no-op and the conflict is an artefact.

Also remember that "ours" and "theirs" are **inverted during a rebase**: `--ours` is the branch you are rebasing onto (`main`), `--theirs` is your own commit being replayed.

## The structural fix

`rerere` works by hashing the conflict and matching it exactly. Change one line of context and the cache misses — you resolve it again. It is a lookup table, not an understanding of the conflict.

[GitWand](/) attacks the same problem from the other end. Its [engine](/guide/conflict-resolution) classifies each conflicted hunk against a prioritised registry of deterministic patterns — identical edits on both sides, changes on one side only, reorderings, boundary insertions, structural merges via tree-sitter, lockfile-aware resolvers — and auto-resolves the ones where there is provably nothing to decide. That classification does not depend on having seen the conflict before, so it fires on the first commit of the rebase and on every one after it, including the near-identical variants `rerere` misses.

Each resolution carries a confidence score and a decision trace you can audit, and anything genuinely ambiguous is handed back to you rather than guessed at. There is also a **Conflict Predictor**: simulate the rebase, cherry-pick or merge and see which files will fight before you start — which often turns "should I rebase or merge" from a habit into a decision with an answer.

It runs as a [desktop app](/guide/desktop), a [CLI](/guide/cli), a [VS Code extension](/guide/vscode) and an [MCP server](/guide/mcp) for coding agents that need to survive their own rebases. Free, MIT, local-first.

## FAQ

### Does rerere ever replay a wrong resolution?
It can, when the same textual conflict has a different correct answer in a different commit. `rerere.autoUpdate` stages the replay, so review the staged diff before continuing if the branch is long-lived. `git rerere forget <path>` drops a bad recording.

### Is rebasing bad practice?
No, but the trade-off is real: linear history in exchange for replayed conflicts and rewritten commit hashes. Never rebase a branch other people have based work on.

### Why did my rebase conflict on a commit I never touched that file in?
Because each commit is replayed against the result of the previous one. A resolution you made earlier changes the context later commits are applied to, which can produce a conflict that would not exist in the original history.

### How do I see how far through a rebase I am?
`git status` reports the current step, and `cat .git/rebase-merge/msgnum` / `end` gives the raw counters.

---

[More conflict fixes →](/fix/) · [git rerere explained →](/fix/git-rerere) · [Download GitWand →](https://github.com/devlint/GitWand/releases/latest)
