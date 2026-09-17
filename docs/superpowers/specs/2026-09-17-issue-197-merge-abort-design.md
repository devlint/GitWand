# Abort merge: telling the truth about what happened: design

**Date:** 2026-09-17
**Issue:** [#197](https://github.com/devlint/GitWand/issues/197) ("abort merge does nothing")
**Out of scope:** [#196](https://github.com/devlint/GitWand/issues/196), shipped separately as the AI hunk queue.

---

## 1. What the issue reports, and what the code actually shows

The report is that clicking "Abort merge" in the conflict banner does nothing. It
does something: it runs `git merge --abort`, and then it says the merge was
aborted whether or not git agreed. The visible symptom of "nothing happened" is a
green toast over an unchanged conflict banner.

**`abortMerge` discards the only evidence it has.** `useGitRepo.ts:1141` awaits
`gitMergeAbort`, throws away the returned `GitPushPullResult`, and sets
`successMessage = "merge-aborted"` unconditionally. `App.vue:764` maps that slug
to `header.mergeAborted` — "Merge aborted". The `catch` never fires, because
`git_merge_abort` (`ops.rs:576`) does not fail on a failing git: it reads
`output.status.success()` into the `success` field and returns `Ok`, putting
git's stderr in `message`. A failed abort and a successful one are the same value
at that call site, and the one thing that distinguishes them is the field nobody
reads. The `refresh()` that follows repaints the same conflicted status, so the
toast and the banner contradict each other.

The dev-server route (`dev-server.mjs:3075`) has the same shape — 200 with
`success: false` and git's output in `message` — so this defect is identical in
both backends.

**`cherryPickAbort` fails differently in each backend.** In Tauri,
`git_cherry_pick_abort` (`ops.rs:1534`) returns `Err` on a non-zero exit, so
`tauriInvoke` rejects and the `catch` at `useGitRepo.ts:1223` sets `error`: that
path is correct today. In web mode the dev-server route (`dev-server.mjs:3119`)
answers 200 with `{ success: false, message }` and `gitCherryPickAbort`
(`backend.ts:1734`) discards the body entirely, so the failure is swallowed
exactly like the merge case. Same function, opposite behaviour depending on which
backend is behind it.

**`cherryPickAbort` also leaves the UI in a state the repo is not in.** Its
`finally` sets `isCherryPicking = false` unconditionally. After a failed abort
the sequencer is still on disk, but the banner has stopped believing a
cherry-pick is in progress and now offers "Abort merge" for it.

**Two cherry-pick toasts print their own slug.** The `meta` map in `App.vue:759`
has no entry for `cherry-pick-aborted` or `cherry-pick-done`, and the fallback is
`successToast.value = val` — the raw, untranslated slug in the toast.

**A successful abort leaves resolution state behind.** Nothing clears `useGitWand`
after the merge is gone. `files`, `undoStack` and `redoStack` survive, so
`canUndo` stays true and points at resolutions for a merge that no longer exists.

So the issue is one bug reported ("it does nothing") sitting on top of four: a
success message that is not checked, a backend divergence, a mode flag cleared on
failure, and stale resolution state.

## 2. Scope

**In scope.** Making both aborts report what git actually did; the confirmation
before an abort that would discard resolution work; clearing `useGitWand` after a
successful abort; the `isCherryPicking` fix; the two missing toast keys; and
aligning `gitCherryPickAbort`'s web path with its Tauri path.

**Out of scope.** Aborting a rebase (`useInteractiveRebase` has its own path and
its own defects, if any). Changing the `GitPushPullResult` contract or making
`git_merge_abort` return `Err` — the frontend can read the field that is already
there. Any recovery from a refused abort beyond showing git's reason.

## 3. Decisions

### 3.1 The aborts return a boolean; the caller decides what to say

`abortMerge` and `cherryPickAbort` become
`(opts?: { hasResolutionWork?: boolean }) => Promise<boolean>`: true only when
git aborted. `successMessage` is set on that branch alone, `error` carries git's
`message` verbatim on the other. The return value is what App.vue needs anyway to
decide whether to clear resolution state, so the same value serves both.

Rejected: keeping `void` and having App.vue watch `error`. The watcher cannot
tell a fresh abort failure from an error already on screen, and it makes the
ordering between `refresh()`, the toast and the reset implicit.

### 3.2 The confirmation reuses the injected `confirm`, and only when there is work to lose

`useGitRepo` already takes `opts.confirm` and already uses it for exactly this
kind of second thought — `deleteBranch` (`useGitRepo.ts:1431`) offers the forced
`-D` through it. The aborts use the same injection point, with `danger: true`.

The prompt appears only when `opts.hasResolutionWork` is true. Aborting a merge
where the user has resolved nothing is cheap and reversible enough that a modal
would be noise; aborting one where they have resolved eight hunks is not.

The signal for "there is work" is `canUndo` from `useGitWand`, passed down by
App.vue at the call site. **Assumed limitation:** the undo stack lives in memory,
so after an app restart a repo with a half-resolved merge reports no work and the
abort goes through unprompted. Deriving the signal from disk state instead
(comparing working-tree content against the conflicted blobs) is a much larger
piece of work for a case that costs the user a re-resolution, not data.

### 3.3 "Entry not uptodate" is shown, never worked around

`git merge --abort` refuses when the working tree holds changes it would have to
overwrite, and says so on stderr. That message goes into `error` as git wrote it.
GitWand does not offer a forced reset here: the whole point of git's refusal is
that the user has edits it cannot put back, and a "force" button in a conflict
banner is exactly where that costs someone an afternoon.

### 3.4 `isCherryPicking` is cleared only on success

The `finally` becomes a conditional on the abort's return value. A failed abort
leaves the flag true, so the banner keeps offering "Abort cherry-pick" for a
cherry-pick that is still in progress.

### 3.5 `useGitWand` gains a `reset()`

A new exported `reset()` clears `files`, `selectedPath`, `undoStack` and
`redoStack`. App.vue calls it when an abort returns true, then sets `viewMode = "graph"` — the merge the user was working in is gone, and the
changes view has nothing left to show.

Rejected: having `useGitRepo` reach into `useGitWand`. The two composables are
independent by design, and App.vue is already the place that wires them together.

### 3.6 The web path of `gitCherryPickAbort` throws, like the Tauri path

`gitCherryPickAbort` — the `backend.ts` wrapper, not the composable function of
§3.1 — keeps its `Promise<void>` signature and its Tauri branch untouched; the
dev-server branch reads the body and throws when `success` is false, with git's
message. That removes the divergence in section 1 without touching the Rust
contract, and it means the composable's `catch` is the single failure path for
cherry-pick abort in both backends.

## 4. Architecture

| Layer | File | Change |
|---|---|---|
| Composable | `src/composables/useGitRepo.ts` | `abortMerge` / `cherryPickAbort` return `boolean`, check `success`, confirm when there is work; `isCherryPicking` cleared on success only |
| Composable | `src/composables/useGitWand.ts` | New exported `reset()` |
| IPC | `src/utils/backend.ts` | `gitCherryPickAbort` web branch throws on `success: false` |
| Component | `src/App.vue` | Abort handlers pass `canUndo`, call `reset()` and switch to `graph` on true; two new entries in the toast `meta` map |
| i18n | `src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | Confirmation strings + the two missing toast strings |
| Tests | `src/composables/__tests__/useGitRepo-abort.test.ts` | New: the decision table of §3 against a mocked backend |
| Tests | `src/composables/__tests__/mergeAbort.git.test.ts` | New: the git behaviours §3 depends on, on real repos |

### 4.1 The composable's contract

```ts
interface AbortOptions {
  /** When true, a successful abort would discard resolution work: confirm first. */
  hasResolutionWork?: boolean;
}

/** @returns true only when git actually aborted. */
function abortMerge(opts?: AbortOptions): Promise<boolean>;
function cherryPickAbort(opts?: AbortOptions): Promise<boolean>;
```

Both return false without running git when the user declines the confirmation,
which is the same value a refused abort returns — App.vue treats them
identically, because in both cases the merge is still there.

### 4.2 New i18n keys

Under `header`: `abortMergeConfirmTitle`, `abortMergeConfirmMessage`,
`abortCherryPickConfirmTitle`, `abortCherryPickConfirmMessage`,
`abortConfirmLabel`, `cherryPickAborted`, `cherryPickDone`. Five locales each.

## 5. Interface

**The banner is unchanged.** Same two buttons, same placement.

**With resolution work, a danger modal.** Title, a message naming what is lost
("your resolutions for this merge will be discarded"), and a destructive confirm
label — the shape `deleteBranch` already produces.

**On success.** The "Merge aborted" toast, now truthful, and the view switches to
the graph. The conflict banner disappears on its own, because `refresh()` finds
nothing conflicted.

**On failure.** No toast. Git's own sentence in the error surface, which is where
"Entry 'x' not uptodate, cannot merge" reaches the user — a reason, where today
they got a green success message.

## 6. Error handling

Every failure path ends in `error` holding git's message and the function
returning false. There are three: git refused (`success: false`), the IPC call
itself threw, or the user declined the confirmation — the last one silently,
since declining is not an error.

`refresh()` still runs after a failed abort. The repo state may have changed even
when the abort did not complete, and showing the real state next to git's
complaint is what makes the complaint legible.

## 7. Testing

**`useGitRepo-abort.test.ts`**, mocked backend, one case per decision:

- `success: false` → returns false, `error` holds git's message, `successMessage`
  untouched.
- `success: true` → returns true, `successMessage === "merge-aborted"`.
- The IPC call rejecting → returns false, `error` set.
- `hasResolutionWork: true` → `confirm` called once; declining returns false and
  the backend is never called.
- `hasResolutionWork` absent or false → `confirm` never called.
- `cherryPickAbort` failing → `isCherryPicking` stays true.
- `cherryPickAbort` succeeding → `isCherryPicking` false.

**`mergeAbort.git.test.ts`**, real temporary repos per AGENTS.md, modelled on
`pullAutostash.git.test.ts` (same `gitEnv()` hygiene, same 60s timeout). It is a
drift lock on the git behaviours the design leans on, not a test of the UI:

- `git merge --abort` during a conflicted merge exits 0 and removes `MERGE_HEAD`.
- With no merge in progress it exits non-zero and writes to stderr — the case
  §3.1 needs to be distinguishable.
- With a conflicted merge plus a working-tree modification git would have to
  overwrite, the abort exits non-zero with non-empty stderr. The assertion is on
  the exit code and that stderr is non-empty, not on git's exact wording, which
  varies across versions.
- `git cherry-pick --abort` with no sequencer exits non-zero — the divergence in
  §3.6 exists because this case is reachable.

No App.vue test. The wiring it adds (pass `canUndo`, call `reset()`, set
`viewMode`) is three lines whose interesting behaviour is already covered by the
composable tests, and a component test for it would mock everything it asserts
on.

## 8. Risks

- **The reporter may have hit the "Entry not uptodate" case specifically.** If
  so, this design gives them a message rather than a working abort, which is the
  correct outcome but not necessarily the one they wanted. Whether GitWand should
  offer to stash-and-retry is a real question; it is deliberately not answered
  here, and the error text is what tells us if it needs answering.
- **The confirmation's blind spot is real.** Per §3.2, a restarted app reports no
  resolution work and aborts without asking. The failure mode is losing
  resolutions silently, which is what the confirmation exists to prevent — just
  in the narrower window.
- **Changing two signatures from `void` to `Promise<boolean>`** touches the two
  template call sites in App.vue, which currently pass the function reference to
  `@click` directly. They become wrapper handlers; a missed one would compile
  fine and silently skip the reset.
