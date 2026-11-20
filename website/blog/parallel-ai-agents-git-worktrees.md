---
title: "Running several AI agents in parallel with git worktree, without them stepping on each other"
description: "A practical guide to parallel agents on one repository: what a worktree isolates and what it quietly shares (branches, stash, config, hooks), the traps that only show up with three agents at once, and the part that decides whether the day was worth it: merging their branches back after predicting which ones collide."
date: 2026-11-17
head:
  - - meta
    - property: og:title
      content: "Running several AI agents in parallel with git worktree, without them stepping on each other"
  - - meta
    - property: og:description
      content: "What a worktree isolates and what it shares, the traps of running several agents at once, and how to predict which agent branches will conflict before you merge any of them."
---

# Running several AI agents in parallel with git worktree, without them stepping on each other

One agent in one worktree is a solved problem. You give it its own folder and its own branch, it works, you bring the work back. [Git worktrees in GitWand, step by step](/blog/worktrees-step-by-step) covers that lifecycle from creation to restore.

Three agents at once is a different problem, and it has two halves. The first is during the work: worktrees isolate less than people assume, and the shared parts are exactly where parallel agents collide. The second is at the end: you now have three branches that were each fine against `main` when they started, and nobody has checked them against *each other*. This guide is about those two halves.

Everything about plain Git below comes from the official [`git worktree`](https://git-scm.com/docs/git-worktree) and [`git merge-tree`](https://git-scm.com/docs/git-merge-tree) documentation. Everything about GitWand was checked against the code as it ships in 3.13.2.

---

## What a worktree isolates, and what it shares

A linked worktree is a second working directory attached to the same repository. Git's documentation puts the rule in one sentence: all pseudo-refs (such as `HEAD`) are per-worktree, and all refs starting with `refs/` are shared, with three exceptions (`refs/bisect`, `refs/worktree`, `refs/rewritten`).

| Per worktree | Shared by every worktree |
|---|---|
| The files on disk | The object database (commits, trees, blobs) |
| `HEAD` (which branch is checked out) | Branches, tags and remote-tracking refs |
| The index (what is staged) | `refs/stash`: the stash is **one stack for all worktrees** |
| An in-progress merge, rebase or bisect | The repository `config`, by default |
| | Hooks in `.git/hooks` |

Read the right-hand column as a list of the ways agents can affect each other:

- **An agent that runs `git stash` and another that runs `git stash pop`** can pop each other's work. The stash lives under `refs/`, so it is shared.
- **An agent that runs `git config`** changes the configuration of every worktree. If you really need per-worktree settings, Git has `extensions.worktreeConfig` and `git config --worktree`; the documentation warns that older Git versions refuse to open a repository with that extension.
- **An agent that deletes or renames a branch** does it for everyone. A branch is a shared ref; only which branch a worktree has checked out is private.

The practical consequence for agent instructions: **no stash, commit instead**. A work-in-progress commit on the agent's own branch is private to that branch; a stash entry is not. GitWand follows the same rule on its side: merge-back never stashes for you, and it commits what a task left uncommitted as a `wip(<name>)` commit rather than parking it somewhere shared.

## The five commands, as they behave with several agents

```bash
git worktree add -b task/billing ../myapp.worktrees/billing origin/main
git worktree list --porcelain
git worktree lock --reason "agent running" ../myapp.worktrees/billing
git worktree remove ../myapp.worktrees/billing
git worktree prune --dry-run
```

- **`add`** creates the folder and checks out a branch in it. It **refuses a branch that is already checked out in another worktree**. That is the rule that keeps two agents off the same branch, so do not reach for `--force` when you hit it: the error message (its wording varies between Git versions) is telling you that an agent is already on that branch. One agent, one branch.
- **`list --porcelain`** prints one record per worktree: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, plus `locked` or `prunable` with a reason when they apply. The documentation promises that this format stays stable across Git versions, so it is the one to parse in a script.
- **`lock`** marks a worktree so it cannot be pruned, moved or removed. `add --lock` does the same at creation time, without the window between the two commands.
- **`remove`** deletes the folder, but only for a clean worktree: no untracked files and no modified tracked files. An unclean one needs `--force`, a locked one `--force` twice. With agents, that refusal is a feature: a worktree that will not go away is usually one with work nobody has looked at yet.
- **`prune`** does not delete working trees. It removes Git's administrative entries for worktrees whose folders are already gone, which is what happens when someone (or something) runs `rm -rf` on a worktree instead of `git worktree remove`. `--dry-run` shows what it would remove.

## The traps that only show up with several agents

### Dependencies are not in the worktree

`node_modules`, `vendor`, `target`, virtual environments: anything ignored is absent from a new worktree. Every agent starts with a folder that does not build.

There are two ways out, and they are not equivalent:

- **Install in each worktree.** Slower, but each agent has its own copy. With pnpm the cost is lower than it sounds, because packages come from a [content-addressable store](https://pnpm.io/motivation) and are linked rather than copied.
- **Share one folder through a symlink.** Fast, and fine as long as no agent changes dependencies. The moment one does and runs an install, it rewrites the folder the other agents are building against.

GitWand's `.gitwandrc` supports both through `include`, with `"mode": "symlink"` for the second. The rule of thumb: link what no agent will modify, copy or install what one might. A task whose whole point is a dependency upgrade should never get a linked `node_modules`.

### Ports, containers and databases are not in Git at all

Two agents that both run `pnpm dev` both want port 3000. Two that run `docker compose up` in folders with the same name may end up in the same Compose project. Two test suites pointed at the same local database will delete each other's fixtures.

None of this is Git's business, so no Git command will help. What helps is deriving every external name from the worktree's name. GitWand passes that name to your `setup` and `teardown` commands as `{name}` and as `GITWAND_WORKTREE_NAME` in the environment, along with the path, branch and base, so `docker compose -p {name} up -d` gives each agent its own containers. The [step-by-step article](/blog/worktrees-step-by-step) shows a complete `.gitwandrc` for this.

### Shared refs mean concurrent writes to the same place

Branches and remote-tracking refs are shared, so two agents that fetch or push at the same moment are writing to the same ref store. In GitWand we hit one concrete case: two simultaneous pushes of new branches from the same repository could fail with "reference already exists". Since 3.13.1, the pushes GitWand runs are serialized per repository. A `git push` an agent types in its own terminal does not go through that lock.

The simpler policy is to keep agents from pushing at all. Worktree branches created by GitWand start from a commit and track nothing, so a reflexive `git push` from inside a task has no upstream to land on. You push once the work is merged and reviewed.

### Cleanup happens in the wrong order

Agents finish at different times, and worktrees accumulate. The usual mistakes: deleting the folder by hand (leaving entries for `prune` to find), removing a worktree while its dev server still runs, and losing uncommitted work with `remove --force`. GitWand's removal sequence (stop processes, snapshot, teardown, then remove) exists for exactly these, and the step-by-step article walks through it. If you script it yourself, the minimum is: commit or inspect what is uncommitted, stop what runs in the folder, `git worktree remove` without `--force`, and `git worktree prune` once in a while.

---

## The return: merging several agent branches

Here is the situation at the end of the day. Three branches, `task/billing`, `task/auth`, `task/docs`. Each was created from `origin/main`, each passes its own tests. You merge `task/billing` into `main`: clean. You merge `task/auth`: conflict, in a file `main` never touched. The conflict is between two agents, and you are discovering it one merge at a time, in whatever order you happened to pick.

Every agent branch was checked against its base. No branch was checked against its siblings. That check is cheap to do before merging anything.

### Step 1: make sure the work is committed

Every prediction below compares commits. Uncommitted files in an agent's worktree are invisible to it. Ask each agent to commit, or check with `git -C <worktree> status --short` before going further.

### Step 2: find which pairs collide, with plain Git

`git merge-tree --write-tree` performs a real merge (three-way content merge, rename detection, the same machinery as `git merge`) without touching any working tree or index. It writes the result as objects and exits `1` when the merge has conflicts, `0` when it is clean. With `--name-only`, it lists the conflicted files after the tree id.

So the whole pairwise check fits in a few lines:

```bash
branches=$(git for-each-ref --format='%(refname:short)' 'refs/heads/task/')
for a in $branches; do
  for b in $branches; do
    [ "$a" \< "$b" ] || continue
    if out=$(git merge-tree --write-tree --name-only "$a" "$b"); then
      echo "ok        $a + $b"
    else
      echo "CONFLICT  $a + $b"
      echo "$out" | sed -n '2,/^$/p' | sed '/^$/d; s/^/            /'
    fi
  done
done
```

On a test repository with three task branches, two of which edit the same line, it prints:

```
CONFLICT  task/a + task/b
            f.txt
ok        task/a + task/c
ok        task/b + task/c
```

Two details from the documentation matter here. Trust the exit status, not the file list: the docs say explicitly not to infer conflicts from an empty conflicted-file list. And an exit status other than 0 or 1 means the merge could not run at all; the script above would report that as a conflict, which errs on the safe side.

With `n` agents this is `n(n-1)/2` merges, all in memory. For a handful of branches it takes a moment.

### Step 3: find out how much of each collision is real work

A conflict reported by Git is not necessarily a decision. Many are the shapes in [the trivial-conflicts taxonomy](/blog/trivial-conflicts-taxonomy): the same change made twice, one side reformatting, two independent insertions. GitWand's Conflict Predictor answers the second question: of the conflicts this merge will produce, how many would its engine resolve on its own?

From the CLI, run it inside one agent's worktree and point it at the other agent's branch:

```bash
cd ../myapp.worktrees/a
npx @gitwand/cli preview --branch=task/b
npx @gitwand/cli preview --branch=task/b --json   # for a script
```

It simulates merging `task/b` into the current `HEAD`, never touching the working tree, the index or `HEAD`, and reports per file how many conflicts are auto-resolvable plus an overall risk (low, medium, high). The exit code is `0` when nothing would be left for you, including when every predicted conflict is auto-resolvable, `1` when at least one conflict would remain, and `2` on error. Run from the main checkout instead, the same command predicts a task against `main`.

Use the `--name=value` form. While writing this article we found that the CLI only parses flags written that way: `--branch task/b`, with a space, is read as `--branch` alone and fails with an error about a ref named `true`. The examples in our [v2.20 post](/blog/v2-20-scratch-worktree-conflict-predictor) used the space form; they are corrected.

Two limits, so you know which tool answers what. The predictor runs a three-way merge per file on files changed on both sides, so a file renamed on one branch is not paired with its edited original; `git merge-tree` does detect renames, which is why step 2 is worth keeping. And from an AI agent through the MCP server, `gitwand_preview_merge` with its default `merge` operation analyzes conflicts already present in the working tree; to simulate against another branch, an agent uses `operation: "rebase"` with `onto` set to that branch.

### Step 4: choose the order, then merge one at a time

The matrix tells you the order:

1. **Merge first the branches that conflict with nobody.** Each one is a clean merge, and each one moves `main` forward.
2. **For each conflicting pair, merge first the branch the other one should adapt to**: usually the larger or more structural change. The second branch is then merged against a `main` that already contains the first.
3. **Re-check before every merge.** The matrix was computed against the starting point; every merge changes the target.

In GitWand, the merge-back of each task already does step 3: it previews against the current state of the target, shows what will conflict and what the engine will resolve, and only then applies. A conflict the engine leaves stops the operation where it happened, without aborting it for you. If you would rather resolve it away from your main checkout, the merge preview's **Resolve in scratch worktree** gives you a throwaway worktree for it, as described in [the v2.20 post](/blog/v2-20-scratch-worktree-conflict-predictor).

---

## Where GitWand fits, and where it does not yet

Creating the agents' worktrees is one click. **New AI task**, introduced in [v3.2](/blog/v3-2-integrated-terminal-ai-tasks), creates a worktree and opens Claude Code in it; since 3.13 it goes through the same service as every other worktree: a `task/<name>` branch with no upstream, a freshly fetched base, your `include` files and `setup`. A second task with a name that is already taken gets `-2`, not a collision. The worktree panel itself dates back to [v1.6.3](/blog/worktrees-submodules-auto-update), when it was a list of `git worktree list` entries.

What is missing is the matrix. Today, predicting conflicts **between** parallel tasks means the script above plus `gitwand preview`, run by you. A view that runs the Conflict Predictor between every pair of tasks and against the target, before anything lands, is the headline of v3.16 in the [roadmap](https://github.com/devlint/GitWand/blob/main/ROADMAP.md), along with live agent status and a worktrees view. It is not shipped.

## The short version

Give each agent its own worktree and its own branch, and accept Git's refusal when a branch is already taken. Remember what is still shared: branches, the stash, config, hooks. Tell agents to commit instead of stashing, and not to push. Name every port, container and database after the worktree. Link only the dependencies no agent will change. At the end, get everything committed, run the pairwise `git merge-tree` check, ask the Conflict Predictor how much of each collision is real work, and merge the clean branches first, previewing each merge against the target as it is now.
