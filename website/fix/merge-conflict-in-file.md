---
title: "CONFLICT (content): Merge conflict in <file> — what it means and how to fix it"
description: Git stopped mid-merge with "CONFLICT (content): Merge conflict in". Here is exactly what git did to your working tree, how to read the markers, the four ways out, and how to make the next one resolve itself.
head:
  - - meta
    - property: og:title
      content: "CONFLICT (content): Merge conflict in <file> — how to fix it"
  - - meta
    - property: og:description
      content: What git actually did to your files, how to read the markers, and the four ways out — with the commands.
---

# CONFLICT (content): Merge conflict in \<file\>

```
Auto-merging src/api/client.ts
CONFLICT (content): Merge conflict in src/api/client.ts
Automatic merge failed; fix conflicts and then commit the result.
```

This is not an error. It is git telling you that it merged everything it could and needs a decision on the rest. Two things are true right now:

- **The merge is in progress, not failed.** `MERGE_HEAD` exists, the index holds three versions of the conflicted file, and nothing has been lost.
- **Only the conflicted hunks need you.** The rest of the file — often the rest of the merge — is already merged in your working tree.

## First, see the actual scope

```bash
git status --short          # UU = both modified, the conflicted ones
git diff --name-only --diff-filter=U   # just the conflicted paths
```

`UU` means both sides changed the file. `AA` means both sides added it. `UD` / `DU` mean one side deleted it while the other edited it — those are resolved differently (see below).

## How to read the markers

```
<<<<<<< HEAD
const timeout = 5_000
=======
const timeout = 30_000
>>>>>>> feature/slow-endpoints
```

Between `<<<<<<<` and `=======` is **your** side (`HEAD`, the branch you are on). Between `=======` and `>>>>>>>` is **their** side, the branch being merged in. Everything outside the markers merged cleanly.

By default git shows you two sides and hides the third: the **common ancestor**. That is the version both branches started from, and it is usually the piece of information that makes the decision obvious — it tells you *who changed what*, instead of leaving you to guess from two similar-looking blocks.

Turn it on, permanently:

```bash
git config --global merge.conflictStyle zdiff3
```

Now the same conflict reads:

```
<<<<<<< HEAD
const timeout = 5_000
||||||| base
const timeout = 10_000
=======
const timeout = 30_000
>>>>>>> feature/slow-endpoints
```

Both sides changed it, from 10s. That is a real decision. Without the base you could not tell that apart from "one side changed it, the other didn't" — which needs no decision at all.

`zdiff3` (git 2.35+) is the same as `diff3` but trims lines common to both sides out of the conflict region, so the hunks are smaller. There is no downside; the only reason it is not the default is backwards compatibility.

## The four ways out

**1. Edit the file.** Remove the markers, leave the code you want. Then:

```bash
git add src/api/client.ts
git merge --continue          # or: git commit
```

**2. Take one side wholesale**, when the file is generated or one branch is authoritative:

```bash
git checkout --ours   path/to/file    # keep HEAD's version
git checkout --theirs path/to/file    # keep the incoming version
git add path/to/file
```

Note the trap: during a **rebase**, "ours" and "theirs" are swapped relative to intuition — `--ours` is the branch you are replaying *onto* (usually `main`), `--theirs` is your own commit being replayed. Check with `git status` before reaching for either.

**3. Re-run the merge with a different strategy**, when one side should win on every conflicted hunk:

```bash
git merge --abort
git merge -X ours   feature/slow-endpoints   # prefer HEAD on conflicts only
git merge -X theirs feature/slow-endpoints   # prefer incoming on conflicts only
```

`-X ours` is not `--strategy=ours`. `-X` only breaks ties inside conflicted hunks; the other side's clean changes still come in. `--strategy=ours` discards the other branch's changes entirely — almost never what you want.

**4. Back out.** `git merge --abort` returns the working tree to exactly where it was. It is always safe while the merge is unfinished.

### Delete/modify conflicts

```
CONFLICT (modify/delete): src/legacy.ts deleted in feature/cleanup and modified in HEAD
```

There is no hunk to edit — the decision is "does this file still exist". Pick one:

```bash
git rm src/legacy.ts        # accept the deletion
git add src/legacy.ts       # keep your modified version
```

## Verify before you commit

The markers are plain text, and a leftover `=======` compiles in more languages than you would like. Before committing:

```bash
git diff --check                       # flags conflict markers git can see
git grep -n '^<<<<<<< \|^>>>>>>> '     # catches the rest
```

Then run your tests. A conflict resolved to something that builds is not the same as a conflict resolved correctly — the classic failure is keeping both sides of a rename and shipping a duplicated function.

## Most of these never needed you

Replay a few thousand real merges and a pattern appears: the large majority of conflicted hunks are not decisions at all. Both sides made the identical edit. Only one side actually changed anything inside the conflict region. The lines are the same, reordered. Two imports were added at the same boundary. A version string moved on both sides. Git flags them because it compares lines and cannot tell.

[GitWand](/) is a Git client built around that observation: it classifies every conflicted hunk against a [prioritised registry of deterministic patterns](/guide/conflict-resolution), auto-resolves the ones where there is provably nothing to decide, and hands back the genuinely ambiguous ones with a confidence score and a trace of why. No model guesses at your code — the [LLM fallback](/guide/llm-fallback) exists but is opt-in, labelled and audited.

It runs as a [desktop app](/guide/desktop), a [CLI](/guide/cli) you can drop into a hook or CI, a [VS Code extension](/guide/vscode), and an [MCP server](/guide/mcp) so coding agents can resolve their own merges. Free, MIT, local-first.

## FAQ

### Does resolving a conflict lose the other branch's work?
No. The commit that ends the merge has both branches as parents, so both histories are preserved regardless of which lines you kept in the file. What you choose affects the file's content, not the history.

### Can I see the three versions separately?
Yes: `git show :1:path` is the common ancestor, `:2:path` is your side, `:3:path` is theirs. Useful for diffing one side against the base to see exactly what it changed.

### Why does the same conflict come back on every rebase?
Because a rebase replays each commit in turn, so each commit meets the conflict again. Enable `git rerere` so git replays your resolution automatically — see [rebase repeats the same conflict](/fix/rebase-same-conflict-every-commit).

### Is there a way to know a merge will conflict before starting it?
`git merge --no-commit --no-ff` then `git merge --abort` is the manual version. GitWand ships a Conflict Predictor that simulates a merge, rebase or cherry-pick and reports the risk per file before you act.

---

[More conflict fixes →](/fix/) · [How the engine works →](/guide/conflict-resolution) · [Download GitWand →](https://github.com/devlint/GitWand/releases/latest)
