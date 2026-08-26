---
title: git rerere explained — reuse recorded conflict resolutions
description: What git rerere actually stores, how to enable it safely, how to inspect and forget a bad recording, and where it stops helping.
head:
  - - meta
    - property: og:title
      content: git rerere explained — reuse recorded conflict resolutions
  - - meta
    - property: og:description
      content: The one git config that stops you resolving the same conflict twelve times — what it stores, and where it stops helping.
---

# git rerere

`rerere` stands for **reuse recorded resolution**. When it is enabled, git records how you resolved a conflict, and the next time it meets *the same conflict* it applies your resolution automatically.

It is off by default. For anyone who rebases a branch more than once, it is the highest-value line in a git config.

```bash
git config --global rerere.enabled true
git config --global rerere.autoUpdate true
```

`rerere.enabled` does the recording and replaying. `rerere.autoUpdate` also stages the replayed file, so `git rebase --continue` does not stop to tell you the file is unstaged. Both are safe to turn on globally.

## What it actually stores

When a merge or rebase conflicts, git computes a normalised hash of the **conflict itself** — the pre-image: the conflicting hunks, stripped of noise, without the surrounding file. That hash becomes a directory under `.git/rr-cache/`:

```
.git/rr-cache/<hash>/preimage     # the conflict as git saw it
.git/rr-cache/<hash>/postimage    # the conflict as you resolved it
```

Next time a conflict hashes to the same value, git finds the directory and replays the postimage:

```
Resolved 'src/api/client.ts' using previous resolution.
```

Two consequences follow from this design, and both matter:

- **The cache is per-repository and local.** `.git/rr-cache/` is not pushed, not fetched, and not shared with your team. Every developer builds their own.
- **The match is exact.** It is a hash lookup, not an analysis. A conflict that is *conceptually* the one you just resolved but differs by a line of context is a different hash, and you resolve it again from scratch.

## Inspecting and undoing

```bash
git rerere status              # which paths have a recorded pre-image in this operation
git rerere diff                # what your resolution changed, vs the recorded conflict
git rerere remaining           # paths still needing you
```

If `rerere` replayed something wrong — the same textual conflict with a different correct answer — drop that recording:

```bash
git rerere forget path/to/file
```

Run it while the conflict is present in the working tree; git needs the conflict in order to compute the hash to forget. Then resolve it correctly, and the new resolution is recorded in its place.

Housekeeping is automatic: `git gc` prunes unused entries (60 days for resolved, 15 for unresolved, via `gc.rerereResolved` / `gc.rerereUnresolved`).

## Where it stops helping

`rerere` is a cache with an exact-match key. That gives it a precise shape of usefulness — and a precise set of blind spots.

- **First occurrence, every time.** It never resolves a conflict you have not already resolved by hand. On a fresh conflict it does nothing.
- **Nothing is shared.** Your teammate resolving the identical conflict on the identical branch gets no benefit from your cache.
- **Context sensitivity.** A rebase that shifts surrounding lines produces a new hash. The long tail of "almost the same conflict" is exactly what makes a rebase feel repetitive, and it is exactly what `rerere` misses.
- **It replays confidently.** If the same conflict legitimately resolves differently in a different commit, `rerere` will not notice; with `autoUpdate` on it stages the wrong answer silently. Reviewing the staged diff on long-lived branches is worth the seconds.

None of this is an argument against enabling it. It is an argument that `rerere` solves the *repetition*, not the *resolution*.

## Solving the resolution

The complementary approach is to classify the conflict rather than remember it.

[GitWand](/)'s [engine](/guide/conflict-resolution) evaluates every conflicted hunk against a prioritised registry of deterministic patterns: both sides made the identical edit, only one side changed anything inside the conflict region, the same lines reordered, insertions at a hunk boundary, a scalar value bumped on both sides, structural entity merges via tree-sitter, dedicated resolvers for JSON, YAML, TypeScript import blocks, Vue SFCs, CSS and lockfiles. Where a pattern proves there is nothing to decide, the hunk is resolved — with a confidence score and a full decision trace. Where there is a real decision, it is handed back to you, not guessed at.

Because the classification is computed from the conflict's structure rather than looked up by hash, it works on the first occurrence, on every near-identical variant, and for every member of the team without anyone priming a cache. The two mechanisms compose: leave `rerere` on for your hand-resolutions, and let the engine remove the ones that never needed a human.

It runs as a [desktop app](/guide/desktop), a [CLI](/guide/cli) for hooks and CI, a [VS Code extension](/guide/vscode) and an [MCP server](/guide/mcp). Free, MIT, entirely local.

## FAQ

### Can I share a rerere cache with my team?
Not through git itself — `.git/rr-cache/` is deliberately local. Teams sometimes sync it out of band, but the cache keys on exact conflict text, so hit rates across different working states are low enough that it rarely repays the plumbing.

### Is rerere safe to enable globally?
Yes. It only ever replays a resolution you produced yourself in that repository, and `git rerere forget` undoes any recording.

### Does rerere work for merges as well as rebases?
Yes. Any conflicted merge, rebase, cherry-pick or revert records and replays. It is most visible during rebases simply because that is where the same conflict recurs.

### Why is rerere off by default?
It changes the working tree without being asked — replaying a resolution you did not explicitly request in this operation. Git's default is to never surprise you; the cost is that most people never discover it.

---

[More conflict fixes →](/fix/) · [Why rebases repeat conflicts →](/fix/rebase-same-conflict-every-commit) · [Download GitWand →](https://github.com/devlint/GitWand/releases/latest)
