---
title: Fix a Git conflict — practical guides by symptom
description: Straight answers to the Git conflicts you actually hit: the CONFLICT (content) message, lockfile conflicts, rebases that repeat the same conflict, and git rerere.
head:
  - - meta
    - property: og:title
      content: Fix a Git conflict — practical guides by symptom
  - - meta
    - property: og:description
      content: Guides indexed by the message git printed, not by concept. Commands first, explanation second.
---

# Fix a Git conflict

Guides indexed by the thing that just happened, not by concept. Commands first, the reasoning after, and an honest note on where [GitWand](/) removes the problem instead of documenting it.

## By symptom

| What you're seeing | Guide |
|---|---|
| `CONFLICT (content): Merge conflict in <file>` — a merge stopped and you need to read the markers | [Merge conflict in a file](/fix/merge-conflict-in-file) |
| `CONFLICT (content): Merge conflict in package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `Cargo.lock` | [Lockfile conflicts](/fix/package-lock-json-merge-conflict) |
| The same conflict comes back on every commit of a rebase | [Rebase repeats the same conflict](/fix/rebase-same-conflict-every-commit) |
| You want git to remember a resolution and replay it | [git rerere explained](/fix/git-rerere) |
| `CONFLICT (modify/delete)` — one side deleted the file | [Merge conflict in a file → delete/modify](/fix/merge-conflict-in-file) |

## Two settings worth applying now

Whatever brought you here, these two lines make every future conflict easier to read and every rebase shorter:

```bash
git config --global merge.conflictStyle zdiff3   # show the common ancestor in the markers
git config --global rerere.enabled true          # replay resolutions you've already made
```

The first turns "two similar-looking blocks" into "here is who changed what". The second stops you resolving the same conflict twelve times during one rebase. Neither is on by default.

## Going further

- [How GitWand's conflict engine works](/guide/conflict-resolution) — the classification pipeline, patterns and confidence scoring
- [The state of automatic merge conflict resolution in 2026](/blog/state-of-merge-conflict-resolution-2026) — a survey of the field: textual, AST-based, semantic, refactoring-aware and LLM approaches
- [Auto-merge failure modes](/blog/auto-merge-failure-modes) — where automatic resolution goes wrong, catalogued honestly
- [Compare Git clients](/compare/) — how the mainstream clients handle conflicts, side by side
