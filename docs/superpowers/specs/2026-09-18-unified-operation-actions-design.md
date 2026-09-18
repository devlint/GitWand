# One operation model for merge, cherry-pick, revert and rebase

**Status:** approved, awaiting implementation plan
**Date:** 2026-09-18
**Follows:** `docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md` (PR #201, merged as `b85791b`)

## 1. Why

#197 fixed two symptoms — "Abort merge" claiming success on a refusal, and an
abort of cherry-pick that vanished in web mode. It did not touch the thing that
produced them. GitWand has four sibling git operations (merge, cherry-pick,
revert, rebase) and models each one differently:

| | abort | continue | skip | error convention |
|---|---|---|---|---|
| merge | `git_merge_abort` | `git_merge_continue` | not offered by git | `Ok(GitPushPullResult)`, `success: false` on failure |
| cherry-pick | `git_cherry_pick_abort` | `git_cherry_pick_continue` | never wired | `Err` for abort, `Ok(result)` for continue |
| revert | **missing** | **missing** | **missing** | — |
| rebase | `git_rebase_action(action)` | same | same | `Err` on any non-zero exit |

Three error conventions for one family of operations. Every gap below is a
consequence of that, not an independent bug:

1. **The app can start a revert it cannot finish.** `git_revert_commit` exists;
   nothing aborts or continues one. A conflicted revert shows the merge action,
   which is what #201 documented and deliberately left alone.
2. **`showMergeSuccess` is set without evidence.** `mergeContinue()` reads its
   result correctly but returns `void`, so `App.vue`'s
   `await doMergeContinue(); showMergeSuccess.value = true;` announces success
   whatever happened. Same shape as the #197 defect, one path further on.
3. **`isCherryPicking` survives as a fallback.** #201 made the banner read
   `git_repo_state`, keeping the frontend flag for when that read fails. With a
   single source of truth the fallback is a second answer to a settled question.
4. **A continue that lands on the next conflict is reported as a failure.**
   Found while specifying this work. `git rebase --continue` (and
   `cherry-pick --continue`) exits non-zero when the *next* commit conflicts.
   Both `git_rebase_action` and the dev-server route treat any non-zero exit as
   an error, so continuing a multi-commit operation through a second conflict
   surfaces an error toast for an operation that simply advanced.

## 2. Success criterion

**Every operation the app can start, it can also continue and abandon, and every
result is verified before it is shown.** Gaps 1-4 close as consequences of that
invariant rather than as four separate patches.

## 3. The contract: three outcomes, not two

The heart of the design, and what was missing everywhere. An operation action
ends in one of three ways:

- **it completed** — the merge/cherry-pick/revert/rebase finished;
- **it halted on a further conflict** — git did its work and stopped where it
  should. Not a failure;
- **it failed** — git refused, or could not run.

Collapsing the last two into one is what produces both a success toast on a
refusal and an error toast on progress.

The command therefore returns `Ok({ halted: bool })` and reserves `Err` for real
failure, carrying git's own message. `halted` is detected the way
`git_rebase_onto` already does it: `CONFLICT` or `could not apply` in git's
output. This is the same vocabulary as an initial `merge` that conflicts, which
the codebase already treats as a non-failure.

**The match is locale-pinned, defensively.** Matching git's own words makes the
check depend on how git was built: git ships translations (`git-l10n`), and a
build with NLS enabled under `LANG=fr_FR.UTF-8` can answer in French, which
would fail the `CONFLICT` test and report progress as an error — the exact
defect this section exists to remove.

Measured, not assumed: on the development machine (Apple git 2.50.1, `fr_FR`
locales installed) the output is **identical** under `LC_ALL=C` and
`LC_ALL=fr_FR.UTF-8`, because that build carries no translations. So this is not
a reproduced bug; it is a dependency on a build option we should not have. The
command pins `LC_ALL=C` and `LANGUAGE=`, which costs nothing and removes the
dependency. `git_rebase_onto` gets the same treatment.

The contract test is deliberately one-sided for the same reason: it asserts the
English markers, and only asserts that a translated run produces *some* output.
A machine without the locale — or with a git without NLS, like this one — must
not fail the suite over it.

## 4. Command layer

### 4.1 Rust

```rust
git_operation_action(cwd: String, operation: String, action: String)
    -> Result<OperationActionResult, String>   // { halted: bool }
```

- `operation` ∈ `merge | cherry_pick | revert | rebase`,
  `action` ∈ `continue | abort | skip`. Both validated against a whitelist
  before git runs; an unknown value is `Err`, never forwarded.
- Arguments are passed as an array, never interpolated (AGENTS.md § Security).
- **Impossible combinations are refused at the source.** `merge` + `skip` is not
  a git option (`error: unknown option 'skip'`, verified against git 2.50.1);
  `cherry-pick`, `revert` and `rebase` all support `--skip` (git ≥ 2.20).
- `GIT_EDITOR=true` and `GIT_TERMINAL_PROMPT=0`, as `git_rebase_action` sets
  today, so a `--continue` never blocks on an editor.
- Replaces `git_merge_abort`, `git_merge_continue`, `git_cherry_pick_abort`,
  `git_cherry_pick_continue` and `git_rebase_action`. Five commands become one;
  revert becomes a parameter value rather than a fifth pair.

The IPC surface is desktop-only — `packages/{cli,mcp,vscode}` contain no
reference to these commands — so removing them breaks no external consumer.

### 4.2 dev-server

One matching `POST /api/git-operation-action` route with the same validation and
the same `{ halted }` shape.

**Targeted fix while rewriting it:** the current `/api/git-rebase-action` runs
``execSync(`git rebase --${action}`, { shell: true })`` — a shell string, which
AGENTS.md forbids. Not exploitable (`action` is whitelisted first), but the new
route uses `spawnSync` with an argument array like its neighbours.

### 4.3 Parity

`apps/desktop/tests/parity/` gains coverage for the deterministic cases
(abort from each operation state, and the refusal when no operation is in
progress), per AGENTS.md § Testing.

## 5. Composable layer

`useGitRepo` exposes one function in place of four:

```typescript
runOperationAction(action: "continue" | "abort" | "skip",
                   opts?: { hasResolutionWork?: boolean }): Promise<boolean>
```

- Callers do not name the operation. The composable reads it from
  `git_repo_state` — the single source of truth established by #201 — and passes
  it to the command, which does take it as a parameter (§4.1). Nothing above the
  composable needs to know which operation is in progress.
- Returns `true` only when git actually did the thing. **No operation function
  returns `void` any more**, which is what closes gap 2 by construction rather
  than by vigilance — there is no longer a function whose caller *could* assume
  success.
- Keeps #201's two hard-won rules: `refresh()` runs before `error` is assigned
  on every failure path (`loadStatus()` writes into the same ref and would
  otherwise overwrite git's reason), and an abort that would discard resolution
  work confirms first via the injected `ConfirmFn`.
- `isCherryPicking` is **deleted**, not kept as a fallback.

## 6. UI layer

`RebaseProgressBanner` becomes the banner for every operation — it already takes
`RepoOperationState` as its prop and already emits `continue | abort | skip`.

- Continue and Abort for every operation; Skip only where git offers it.
- Rebase-specific rendering (step/total, `pendingSplit`, the whole-rebase
  auto-resolve) stays, conditional on the operation being a rebase.
- The separate conflict banner in `App.vue` and its abort button are removed.
- **No operation auto-continues.** The chain at `App.vue:811-825`, which ran
  `merge --continue` / `cherry-pick --continue` as soon as the last conflict was
  resolved, is deleted. One policy for everything: git writes a commit when the
  user says so. This intentionally changes existing merge and cherry-pick
  behaviour and aligns them with the rebase policy already justified in #128.
- New keys in all five locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) for the
  revert labels and the Continue button.

## 7. Testing

- **Real-git contract tests** (extending `mergeAbort.git.test.ts`): each
  operation × action, including the three outcomes — notably that
  `cherry-pick --continue` across a second conflicting commit exits non-zero
  *and* is not a failure. Real temporary repos; the git layer is never mocked.
- **Composable tests**: `runOperationAction` returns `true` only on a real
  success, surfaces git's message on refusal, confirms before discarding
  resolution work, and runs no git command at all when the user declines.
- **Parity tests**: see §4.3.
- **Manual QA** under `pnpm dev:web` on throwaway repos, including the case
  #201's QA surfaced: a repository opened while already mid-operation.

## 8. Implementation order

1. The contract + the Rust command.
2. dev-server route + parity.
3. Composable.
4. UI (banner generalisation, auto-continue removal, locales).

The banner generalisation is last on purpose: it touches the rebase flow, which
carries history (#128, the split at an edit stop) and is the riskiest part. If
it costs more than expected, work stops after step 3 with the invariant already
held at the command layer.

## 9. Deliberately out of scope

- **`--quit`.** git offers it for cherry-pick, revert and rebase. Nothing in the
  app asks for it; adding it would widen the surface with no caller.
- **A settings toggle for auto-continue.** One policy, no configuration.
- **Reworking `git_revert_commit` itself.** Starting a revert already works;
  this spec only makes it finishable.
