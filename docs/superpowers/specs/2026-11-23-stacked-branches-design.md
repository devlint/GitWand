# Stacked Branches (v3.14.0) — design

**Date:** 2026-11-23
**Roadmap:** `ROADMAP.md` § v3.14.0 — Stacked Branches (native). This version delivers the restack core only; the rest of that section moves to a later minor (see §2).

Decisions the user made are stated plainly. Everything marked **(spec call)** is mine. Check those while reading.

---

## 1. Intent

The user works in stacks on Dendreo (GitHub, PRs **merged by squash**). Step 1 creates a new component and waits for review. Meanwhile step 2, an evolution of step 1, is built on top of it. Today two moments force a manual rebase:

1. **Step 1 changes under step 2.** A review fix is committed on `step-1`, and `step-2` must be rebased onto the new `step-1`.
2. **Step 1 is merged by squash.** `main` gets one new commit that git cannot match to step 1's commits. `step-2` must be moved with `git rebase --onto main <old step-1 tip> step-2`, and its PR retargeted from `step-1` to `main`.

v3.14 succeeds when those two manual rebases disappear: GitWand notices each moment, previews the conflicts, and restacks in one click.

## 2. Goals, non-goals, anti-goals

**Goals**
- Know which branch a branch is stacked on, and the parent commit it was last placed on.
- Detect moment 1 (parent moved) and moment 2 (parent merged, squash included).
- One-click restack of the whole stack above the moved/merged layer, with a conflict preview first.
- After moment 2: retarget the child's GitHub PR to the merged parent's base, and offer to delete the merged local branch.
- Offer to push the restacked layers.

**Non-goals (later minor, user decision)**
- "Stacks" tab in Today, sidebar stack banner, `⌘⇧S`.
- "Submit stack" (create/update every layer's PR at once).
- Stale-head `sha` guard on every in-app PR merge.
- Archived-branches "merged" hint.
- Retargeting on GitLab / Azure DevOps **(spec call)**: moment 1 works there (pure git), moment 2 is detected only by the git fallback (§5.3) and the retarget is left to the user with a message.

**Anti-goals** — it is a failure even if it "works" when:
- A restack leaves one layer behind while reporting success (see §4, worktrees).
- A restack replays the old parent commits after a squash and floods the user with phantom conflicts.
- A restack rewrites a branch the user did not see in the preview.
- Pushes happen without the user asking.

## 3. Approaches considered

| | How GitWand knows the stack | Trade-off |
|---|---|---|
| **A. Explicit, stored in local git config** (picked) | "Stack on…" records `branch.<b>.gitwandParent` and `branch.<b>.gitwandStackBase` (parent commit) in `.git/config` | Reliable, offline, works before any PR exists. Needs one declaration per layer. |
| B. Inferred from GitHub | Parent = the PR's base branch; old parent tip = the merged PR's `headRefOid` | Nothing to declare, but needs PRs, network, everything pushed; misses moment 1 before a push. |
| C. Inferred from git (`merge-base --fork-point`) | Old parent tip from the parent's reflog | Nothing to store, but the reflog expires and is empty for branches fetched from elsewhere, and it fails silently. |

**Picked: A, plus a bridge from B** (user decision). When a local branch's open GitHub PR targets another local branch that is not the trunk, GitWand offers "Stack `step-2` on `step-1`?". The merged PR's `headRefOid` is also a fallback for the old parent tip when `gitwandStackBase` is missing. Stored config stays the source of truth.

The roadmap said "metadata in `.gitwand-workspace.json`". That file is a multi-repo workspace descriptor (`commands/workspace.rs`), not per-repo branch data, so it is not used.

## 4. Constraints

- **Git version.** `--update-refs` needs git ≥ 2.38. Below it, restack falls back to rebasing each layer in turn, bottom-up, with `--onto` **(spec call)**; the builder may instead refuse with a clear message if the fallback is costly. Say which in the plan.
- **Worktrees: verified on git 2.54.** When a layer of the stack is checked out in another worktree, `git rebase --update-refs` silently skips that ref: the layer stays on the old base and the stack is broken without a word. This is common in GitWand (Agent Workspaces). Before restacking, check every layer to be moved against `git worktree list --porcelain`. If any is checked out elsewhere (except the current worktree), refuse and name the branch and worktree path.
- **Clean working tree.** Restack checks out the top layer. Refuse when the tree is dirty, exactly like the existing rebase entry points do.
- **Existing rebase plumbing.** `git_rebase_onto` (`ops.rs:1048`) runs plain `git rebase <target>`, not a real `--onto`. `preview_rebase` (`read.rs:1971`) previews HEAD against a merge-base. Both need an `upstream` (old base) and a `branch` argument, or new sibling commands. Halted rebases continue/skip/abort through the existing path (`RebaseProgressBanner.vue`).
- **AGENTS.md.** Every new Tauri command gets its `backend.ts` wrapper, a `commandRegistry.ts` entry, a `dev-server.mjs` route, and parity coverage when deterministic. Git args as arrays, never interpolated; branch names starting with `-` refused. All strings in the 5 locales. Tests on real temp git repos.

## 5. Design

### 5.1 Data model

Per layer, in the repo's local git config (`.git/config`, shared by all its worktrees):

```
[branch "step-2"]
    gitwandParent = step-1
    gitwandStackBase   = <sha of step-1 that step-2 currently sits on>
```

- A branch is **stacked** when `gitwandParent` is set and names a branch other than the trunk.
- **Linear stacks only** (user decision, for now): a branch has at most one stacked child. "Stack on…" refuses a parent that already has a stacked child, and explains why. The bridge (§5.2) does not offer it either. Trees are a possible later extension.
- The trunk is the repo's default branch (the one GitWand already resolves for PR creation).
- **Self-healing base** **(spec call)**: on every stack refresh, when the parent tip is an ancestor of the layer and differs from `gitwandStackBase`, set `gitwandStackBase` to the parent tip. A rebase the user finished by hand, or one that halted and was continued through the banner, then leaves correct metadata without special bookkeeping.
- **Rename or delete of a branch.** A layer whose parent no longer exists locally shows "parent missing" and offers Unstack. If the parent's PR is known merged, it takes the moment-2 path instead.

### 5.2 Declaring a stack

- Branch context menu: **"Stack on…"** (choose the parent from local branches) and **"Unstack"**. When declared, `gitwandStackBase = merge-base(layer, parent)`.
- **Bridge from GitHub**: when the PR list loads, for every local branch with an open PR whose base is a local non-trunk branch and with no `gitwandParent`, show a dismissible prompt on that branch: "Stack `step-2` on `step-1`?". A dismissal is remembered per branch **(spec call)**.
- Cycles (A on B on A) are refused.

### 5.3 Detection

For each stacked layer, in order of precedence:

1. **Parent merged.** True when either:
   - GitHub reports the parent's PR (head = parent branch) as merged, or
   - git fallback: every commit of `gitwandStackBase`'s side is already in the trunk by patch-id (`git cherry <trunk> <parent>` prints only `-` lines).

   The fallback catches merge commits, rebase merges and single-commit squashes, but **not** multi-commit squashes. Only the forge catches those. Say so in the UI's empty state for non-GitHub repos.

   → state **"parent merged"**, action *Restack on `<trunk>`*.
2. **Parent moved.** The parent tip is not an ancestor of the layer, and `gitwandStackBase` is still an ancestor of the layer. → state **"out of date"**, action *Restack on `step-1`*.
3. Otherwise **up to date**.

A layer whose parent is out of date or merged makes everything above it out of date too. The action is always offered on the **lowest** affected layer and moves the whole stack above it.

Refresh happens with the existing ref-move watcher and when the PR list is refreshed. No new polling.

### 5.4 Restack

**Fetch first; remote trunk** **(spec call)**. Restack runs `git fetch` before the preview.

- Moment 2 rebases onto `origin/<trunk>`, not the local trunk. After a GitHub squash, the squash commit exists only on the remote, and local `main` is usually behind. Rebasing onto it would "succeed" without step 1's work.
- Local `main` is not touched. The existing opt-in auto fast-forward stays the only thing that moves it.
- Moment 1 rebases onto the local parent. When the local parent is behind its own upstream (e.g. a GitHub suggestion committed on the remote), the banner asks to pull the parent first and does not restack.
- The `git cherry` fallback (§5.3) compares against `origin/<trunk>`.

**Pending record (spec call).** Before running the rebase, GitWand writes `gitwandRestack = <moment> <onto sha> <old base sha>` on the top layer. A restack that halts on a conflict is continued or aborted through the existing banner, outside this code path. So on every stack refresh while no rebase is in progress:
- **The layer now contains the recorded `onto` sha.** The restack completed. Run the post-success steps below (metadata update, then the retarget/push/delete offers) and clear the record.
- **Otherwise.** The rebase was aborted, so clear the record and change nothing.

This makes a halted restack end exactly like an uninterrupted one. It also stops a stale `gitwandParent` from re-offering moment 2 with an old tip.

**Branch afterwards** **(spec call)**. A successful restack returns to the branch that was checked out before. When the rebase halts, git leaves the layer being rebased checked out, as with any rebase. On completion through the banner, GitWand switches back to the original branch, which is stored in the pending record.

**Moment 1 — parent moved:**
`git rebase --onto <parent> <gitwandStackBase> <top-of-stack> --update-refs`
Then for each moved layer, `gitwandStackBase` = new tip of its parent.

**Moment 2 — parent merged:**
`git rebase --onto origin/<trunk> <old parent tip> <top-of-stack> --update-refs`
- Old parent tip = the child's `gitwandStackBase`. When it is missing, use the merged PR's `headRefOid`. With neither, refuse and ask the user to restack by hand.
- Afterwards:
  - the child's `gitwandParent` becomes the merged parent's own parent;
  - when that parent is the trunk, the metadata is removed, because the layer is now an ordinary branch;
  - the bases above are updated as in moment 1.
- **Retarget** the child's open GitHub PR to its new parent (PATCH the pull's `base`; with the `gh` transport, `gh pr edit --base`). On failure, keep the local restack and show the error with a "Retry retarget" action.
- Offer **"Delete local `step-1`"**. Never automatic.

**Preview first.** Both moments open the existing merge-preview panel (`MergePreviewPanel.vue` / `useMergePreview.ts`), fed by a rebase preview that takes `onto`, `upstream` and `branch`. Above the files, the panel lists every layer that will move, so the anti-goal "a branch the user did not see" holds. *Apply* runs the restack; a halt hands over to the existing rebase banner.

**Push.** After a successful restack, a non-blocking toast offers **"Push N branches"**. It force-pushes each moved layer that has an upstream, with an explicit lease on the remote sha read **before** the restack (`gitPush(…, force, lease)` already supports this), and reports per-branch success/failure. Layers without an upstream are skipped and listed **(spec call)**.

**Abort.** `git rebase --abort` restores every ref `--update-refs` touched. Metadata is written only after success, after self-healing (§5.1) or when a pending record is finalized. An abort only leaves a pending record behind, and the next refresh clears it.

### 5.5 UI

Branch list (sidebar), stacked branches only:

```
  main
  step-1            ↳ main  PR #812
  step-2            ↳ step-1  ● out of date        [Restack]
```

When the current branch, or a branch below it in its stack, needs a restack, a banner shows above the commit area **(spec call)**:

```
┌──────────────────────────────────────────────────────────────┐
│ step-1 was merged into main (PR #812, squash).               │
│ step-2 still contains its old commits.                       │
│                              [Preview restack]  [Later]      │
└──────────────────────────────────────────────────────────────┘
```

Context menu: *Stack on…*, *Unstack*, *Restack…* (when applicable).

## 6. Left to the builder

- Whether to extend `git_rebase_onto` / `preview_rebase` or add sibling commands (`git_restack`, `preview_restack`).
- The fallback below git 2.38 (bottom-up `--onto` loop or a refusal); state the choice in the plan.
- Exact placement of the badges and banner inside the existing sidebar and commit-area components, following `apps/desktop/src/CLAUDE.md`.
- Composable split (a `useStacks.ts` is the obvious home for detection and orchestration).
- Test matrix. At minimum, on real temp repos:
  - moment 1;
  - moment 2 with a multi-commit squash;
  - a 3-layer stack;
  - a layer checked out in another worktree (refusal);
  - a dirty tree (refusal);
  - a conflict halt, then continue, with the pending record finalized (moment 1 and moment 2);
  - a local trunk behind `origin/<trunk>` after a squash;
  - a refused second child on the same parent;
  - abort;
  - a missing `gitwandStackBase` with and without `headRefOid`.
- Dev-server routes and parity probe entries for the new deterministic commands.
- CHANGELOG `[Unreleased]` entry and the roadmap update (move the deferred items to a new planned minor) at ship time.
