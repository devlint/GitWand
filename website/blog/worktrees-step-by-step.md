---
title: "Git worktrees in GitWand, step by step"
description: "A hands-on walkthrough of worktrees in GitWand 3.13: create one from a fresh base, let your repository bring its environment up, run an agent in it, merge its work back as real commits, remove it without orphaning anything, and get it back if you change your mind."
date: 2026-11-09
head:
  - - meta
    - property: og:title
      content: "Git worktrees in GitWand, step by step"
  - - meta
    - property: og:description
      content: "Create a worktree, run your repo's setup, merge an agent's work back with its commits intact, tear the environment down, and restore it from a snapshot: the whole worktree lifecycle in GitWand 3.13."
---

# Git worktrees in GitWand, step by step

A worktree is a second checkout of the same repository, in another folder, on another branch. Same object store, same history, no second clone. You can keep `main` open in one window while a fix sits half-done in another, or let an AI agent work on a branch without it touching the files you are editing.

Plain `git worktree add` gives you the folder. It does not give you the `.env` file, the dependencies, the containers, the database or the URL that make the folder something you can actually run. And when you are done, `git worktree remove` deletes the folder and leaves all of that behind.

GitWand 3.13 treats a worktree as an **environment your repository knows how to bring up and tear down**. This article walks through the whole lifecycle, in the order you would meet it.

---

## Step 0 — The two commands worth knowing anyway

You do not need the command line for anything below, but it helps to know what GitWand drives:

```bash
git worktree add ../myapp.worktrees/fix-login -b task/fix-login origin/main
git worktree list
git worktree remove ../myapp.worktrees/fix-login
```

The rule worth remembering: **a branch can be checked out in only one worktree at a time.** If GitWand tells you a branch is "already checked out in another worktree", that is git, not GitWand, and the answer is to open that worktree rather than switch to the branch.

## Step 1 — Tell GitWand how your repository starts

This step is optional. Without it, worktrees work exactly as they do in git. With it, they come up ready to use.

Add a `worktree` section to the `.gitwandrc` at the root of your repository (it is JSON):

```json
{
  "worktree": {
    "include": [".env", { "path": "node_modules", "mode": "symlink" }],
    "setup": "docker compose -p {name} up -d && pnpm db:migrate",
    "teardown": "docker compose -p {name} down -v",
    "url": "echo http://{name}.localhost:3000"
  }
}
```

| Key | What it does |
|---|---|
| `dir` | Where new worktrees go. Defaults to a sibling folder, `<repo>.worktrees/`. |
| `include` | Ignored files and folders to copy (or link, with `"mode": "symlink"`) from your main checkout into each new worktree. |
| `setup` | Runs once the worktree exists. |
| `teardown` | Runs before the worktree is removed. |
| `url` | Prints the environment's address; GitWand shows its first line on the worktree. |

A few details that matter:

- **`include` only touches ignored files.** A tracked path is skipped with a warning, since the checkout already has it. A missing path is skipped silently. Nothing that resolves outside the repository is accepted. If you already have a `.worktreeinclude` file (the convention Claude Code and others use), GitWand reads it too.
- **Placeholders.** `{name}` is the worktree's slug (lowercase letters, digits and dashes). `{path}`, `{branch}` and `{base}` are inserted shell-quoted, so a path with spaces does not break your command. The same values are also in the environment, as `GITWAND_WORKTREE_NAME`, `GITWAND_WORKTREE_PATH`, `GITWAND_WORKTREE_BRANCH`, `GITWAND_WORKTREE_BASE`, plus `GITWAND_REPO_ROOT`.
- **The commands run in the new worktree**, through your login shell, so the tools on your usual `PATH` are there.
- **They are always read from the main checkout.** An agent working inside a worktree can edit that worktree's copy of `.gitwandrc` as much as it likes; GitWand never runs it. Otherwise an agent could rewrite the `teardown` of the very worktree it is about to have removed.

If your project already has a script for this (many do: a `bin/worktree`, a `make env`), point the three commands at it and let it own the details: ports, subdomains, databases.

## Step 2 — Say yes once, knowingly

A `.gitwandrc` arrives with `git clone`. Running its commands silently would mean any repository you clone can run code on your machine the first time you create a worktree.

So the first time GitWand is about to run them, it stops and shows them, word for word: **"Run this repository's worktree commands?"**, with three choices:

- **Trust and run**: GitWand remembers the decision for this repository.
- **Skip commands this time**: the worktree is created (or removed) without them.
- **Cancel**.

The trust is tied to the exact text of the three commands. If someone changes `setup` in a commit you pull, GitWand asks again. It is stored in GitWand's own data, never in the repository.

`include` needs no trust: it only copies your own files from one of your folders to another.

## Step 3 — Create the worktree

Open **Worktrees** from the header (or the command palette). You have two ways to create one:

- **⚡ New task** (`⌘⇧N`): type a name, press Enter. That is all.
- **New worktree**: the full form, if you want to choose the path, the branch or the base yourself.

For an agent, open the **+** menu of the terminal panel and choose **New AI task**. It creates the same kind of worktree, then launches Claude Code in it.

Whichever path you take, the defaults are the same:

- **The base is fresh.** GitWand fetches the remote's default branch first and starts from it, so the work begins from what your team has actually merged, not from whatever your local `main` was last week. The dialog says what it used: *"Based on origin/main, fetched 2 s ago"*. Offline, it falls back to your local tracking branch, then to `HEAD`, and says so (*"Offline: based on …"*). You can always pick another base.
- **The folder** is `<repo>.worktrees/<name>`, or your `dir`.
- **The branch** is `task/<name>`, created **without upstream tracking**, so a reflexive `git push` from inside the task cannot land on `main`.
- **Your `include` files** are copied or linked in.

## Step 4 — Watch setup, then open the URL

Once you have trusted the commands, `setup` runs in its own terminal tab, **Setup · fix-login**. It is read-only: you watch it, you do not type into it. It ends on a clear line: finished, or *"Setup failed (exit code 1)"*.

When it succeeds, GitWand runs `url` and shows the address on the worktree with an **Open** button.

When it fails, nothing is thrown away. The worktree stays, marked **Setup failed**, with **Retry setup**, **Open the log** and **Remove**. For an AI task, the agent is only launched once setup has succeeded: an agent starting work in an environment that never came up would spend its first ten minutes debugging your Docker install.

## Step 5 — Work, and let `main` move on

This is the part worktrees exist for. Open the worktree in its own tab, let the agent run, keep working on `main` in yours. Commit in both. Your teammates keep merging.

None of that blocks anything later. Before 3.13, bringing a task back required your `main` to still be where the task started; a long agent session made that the exception. That requirement is gone.

## Step 6 — Merge the work back

Choose **Merge back**, on the task or on the worktree in the manager. You pick two things:

**Into**: the branch the task started from, by default.

**How**:

| Mode | What you get |
|---|---|
| **Merge** | A merge commit on the target. The agent's commits are kept as they are. |
| **Rebase** | The agent's commits replayed onto the target, which then fast-forwards. Linear history. |
| **Squash** | All the changes staged on the target, uncommitted, for you to write one commit. |

Before anything changes, GitWand checks your main checkout, and refuses when it should, saying why:

- it is on another branch (*"Switch the main checkout to main"* is offered when it is clean);
- it is in the middle of a merge, rebase or other operation;
- it has uncommitted changes to files the task also changes. **GitWand never stashes for you**: a stash you did not ask for is a stash you forget.

Unrelated local changes do not block it.

Then it prepares, in this order:

1. **It stops the task's processes.** An agent still writing files during a merge is exactly what this whole flow guards against.
2. **It commits what the task left uncommitted**, as `wip(fix-login): uncommitted work at merge-back`, so nothing lying around in the worktree is lost.
3. **It snapshots both checkouts**, the task's and yours.

Then you see the same **preview** as any other merge in GitWand: what will conflict, what the engine will resolve on its own, how confident it is. You confirm, and it applies.

If a conflict is left that the engine will not decide for you, the merge stops there, in the checkout where it happened: your main checkout for a merge, the task's for a rebase. **Nothing is aborted on your behalf.** Resolve it the usual way, finish the operation, and come back to the dialog with **Resume**.

## Step 7 — Remove the worktree, and everything around it

GitWand does not remove the worktree right after a merge-back. You may want to look at the result first. When you are ready, **Remove the worktree** (or delete it from the manager) runs one sequence, whatever button you used:

1. **Guards.** A worktree that is locked (`git worktree lock`) is never touched; you get an **Unlock** button, as a separate, deliberate step. One that another tool manages (Claude Code, Conductor, Superset) and GitWand did not create is left alone. One with a `.worktree-keep` file is left alone too, unless GitWand created it: setup scripts often drop that file to protect a worktree from *another* tool's cleanup, and honouring it there would make your own worktrees impossible to remove.
2. **Processes.** GitWand closes the worktree's terminals and stops what it started there. Anything else still running with its working directory inside the folder (a dev server you launched by hand, say) is **listed, not killed**: *"These processes are still running in this worktree"*, with **Retry** and **Stop all**. Killing them is your call.
3. **Snapshot.** The worktree's files, committed or not, are saved first.
4. **Teardown.** Your `teardown` runs in a read-only tab, **Teardown · fix-login**. If it fails, **the worktree is kept**, marked so, with **Retry teardown**, **Open the log** and **Remove anyway**. The last one asks again, and names what may be left behind: containers, volumes, databases, subdomains.
5. **Removal.** Only now is the folder removed. The `task/` branch is deleted with it if it is fully merged, which is never the case after a squash, so after a squash the dialog asks.

A worktree GitWand did not create can still be removed from GitWand; it just asks for one more confirmation that says so.

One thing to know: **ignored files are not in the snapshot.** Your `.env` comes back from `include`. Containers and databases are your `teardown`'s and `setup`'s job, which is why GitWand insists that teardown succeeds.

## Step 8 — Changed your mind? Restore it

Open the **Time Machine**. Under **Removed worktrees**, you will find every worktree GitWand removed, and every task as it was just before a merge-back. Choose **Restore as worktree**.

GitWand creates `<name>-restored` on a branch `restore/<name>`, from the snapshot's commit, then puts the uncommitted files and the index back exactly as they were. It copies your `include` files again and, if you trust the repository's commands, runs `setup`: you get the environment back, not just the files.

The restore never overwrites your current checkout. That is why these snapshots are not offered for an in-place restore.

---

## The whole thing in one paragraph

Describe your environment once in `.gitwandrc`. Trust it once. Create a worktree from a freshly fetched base and let `setup` bring it up. Work in it, or let an agent work in it, while `main` moves. Bring the work back as a merge, a rebase or a squash, through the same preview as any other merge, with both sides snapshotted and nothing aborted behind your back. Remove it with a teardown that has to succeed. And if you needed it after all, restore it from the Time Machine.

What comes next is in the [roadmap](https://github.com/devlint/GitWand/blob/main/ROADMAP.md): a full worktrees view in place of the dialog, live agent status, a choice of agent beyond Claude Code, and conflict prediction across worktrees, before two tasks collide in the same file.
