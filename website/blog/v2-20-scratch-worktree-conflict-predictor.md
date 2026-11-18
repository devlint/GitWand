---
title: "Resolve in a scratch worktree, and predict rebase & cherry-pick conflicts: GitWand v2.20"
description: "v2.20 adds a scratch worktree for isolated conflict resolution — spin up a throwaway worktree, resolve away from your live checkout, bring it back in one click — and extends the Conflict Predictor to rebase and cherry-pick across the desktop app, the MCP server, and the CLI."
date: 2026-06-17
head:
  - - meta
    - property: og:title
      content: "Resolve in a scratch worktree, and predict rebase & cherry-pick conflicts: GitWand v2.20"
  - - meta
    - property: og:description
      content: "A scratch worktree for isolated conflict resolution, and a Conflict Predictor that now sees rebases and cherry-picks — side-effect-free, across the desktop app, MCP, and CLI."
  - - meta
    - name: twitter:title
      content: "Scratch worktree + extended Conflict Predictor: GitWand v2.20"
---

# Scratch worktree + extended Conflict Predictor: GitWand v2.20

`@gitwand/desktop@2.20.0` is about doing risky Git operations with a net under you. Two features, one theme: **know what a merge, rebase, or cherry-pick will do before you commit to it — and when it does conflict, resolve it somewhere safe.**

Both build directly on machinery GitWand already had. The Conflict Predictor extends the existing side-effect-free `preview_merge`. The scratch worktree extends the first-class worktree support from v2.7. Inspired, like a few recent features, by what [GitSquid](https://gitsquid.dev) does well — reimplemented on top of GitWand's deterministic resolution engine.

---

## Resolve conflicts in a scratch worktree

Some conflicts are easier to untangle away from your live checkout — without an in-progress merge sitting in your working tree, blocking everything else you'd like to do in the repo.

From the merge preview, **"Resolve in scratch worktree"** now spins up a temporary, isolated worktree named `gitwand-scratch-<timestamp>` as a sibling of your repo, and opens it as its own tab. Your active checkout is never touched. You resolve in the sandbox, then:

- **Bring changes back** — the resolved tree is overlaid onto your main checkout in one operation (the two worktrees share the same object database, so nothing is fetched or pushed — the content crosses over directly), and the scratch is removed and pruned.
- **Discard** — the scratch is torn down (`worktree remove --force` + `prune`) with nothing brought back.

Either way there's no dangling worktree registration left behind.

Two design decisions are worth calling out:

- **The lifecycle is anchored to the origin repo.** Once you switch into the scratch tab, the app's "current repo" follows that tab — so merge-back captures the *origin* checkout's path at creation time and always targets it, rather than the tab you happen to be looking at. Without that, "bring changes back" would overlay the scratch onto itself. It's the kind of bug that only shows up once you actually wire the tab-switching, which is exactly why it's covered by a unit test now.
- **Merge-back refuses to clobber an in-progress resolution.** If your main checkout has its own unmerged index entries (a half-finished merge or rebase), bring-back errors out instead of silently overwriting them. A merely *dirty* working tree is fine — receiving the resolution is the whole point.

---

## The Conflict Predictor now sees rebases and cherry-picks

Since the Conflict Predictor shipped, GitWand could tell you how a **merge** would land before you ran it — how many conflicts, how many it can auto-resolve, and an overall risk level — all without touching your working tree. v2.20 extends that to **rebase** and **cherry-pick**.

The two new Tauri commands, `preview_rebase` and `preview_cherry_pick`, return the same `FileMergePreview` shape as `preview_merge` (which is left untouched). Both are strictly side-effect-free: they never modify the working tree, the index, or HEAD.

- **Rebase** replays each commit in `merge-base(HEAD, onto)..HEAD` as a per-commit 3-way against `onto`, then deduplicates by the highest conflict signal per file. This matters: a *squashed* approximation — diffing the net change of your branch against the target in one shot — can both miss conflicts that only arise mid-stack and invent conflicts that never coexist in the real sequence. Replaying per commit is faithful to what `git rebase` actually does.
- **Cherry-pick** runs a 3-way with `commit^` as the ancestor, HEAD as ours, and `commit` as theirs — exactly the merge `git cherry-pick` performs.

Both fail fast and clearly on unknown refs, a missing merge-base, or a root commit (which has no parent to diff against).

In the desktop app, the merge-preview panel gains an **operation selector** (merge / rebase / cherry-pick), a colour-coded **risk badge** (low / medium / high), and an expandable **hunk-by-hunk view** of exactly what would conflict — surfaced from the same per-file `resolve()` output the engine already produces. For cherry-pick, a commit picker lets you choose which commit to simulate.

---

## The same prediction, from the CLI and from AI agents

The predictor isn't desktop-only. The resolution engine lives in `@gitwand/core`, and the two thin wrappers around it both gained the new surface.

**`@gitwand/cli`** ships a new `gitwand preview` command:

```bash
gitwand preview --onto=main          # will rebasing onto main conflict?
gitwand preview --commit=a1b2c3d      # will cherry-picking this commit conflict?
gitwand preview --branch=feature/x    # will merging this branch conflict?
gitwand preview --onto=main --json    # machine-readable, for CI
```

It exits `0` when the operation is predicted clean, `1` when conflicts are predicted, and `2` on error — so it drops straight into a CI gate. Under the hood it runs `git merge-file` on temporary blob snapshots — no checkout, no index mutation.

**`@gitwand/mcp`** extends the `gitwand_preview_merge` tool with an `operation` parameter (`merge` | `rebase` | `cherry-pick`) plus `onto` / `commit` arguments, so a connected agent — Claude Code, Cursor, Windsurf — can ask *"would this rebase conflict, and how much of it can you resolve?"* before it acts. The engine stays Node-free; the git plumbing lives in the MCP package.

> One subtlety we fixed along the way: `git merge-file` exits with a non-zero status equal to the number of conflicts it found. An early version of the JS predictors treated any non-zero exit as failure and discarded the output — which meant a real conflict was reported as *clean*. The conflict-marked content is now read from that non-zero exit, and a regression test asserts a genuine conflict is detected rather than swallowed.

---

## Upgrading

Desktop auto-update will offer v2.20.0, or grab it from [GitHub Releases](https://github.com/devlint/GitWand/releases). `@gitwand/cli` and `@gitwand/mcp` are on npm at `2.20.0`. Nothing to migrate — both features are additive, and the prediction commands are read-only by construction.
