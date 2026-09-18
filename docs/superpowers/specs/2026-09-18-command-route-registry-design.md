# A declared registry for the Tauri ↔ dev-server correspondence

**Status:** approved, awaiting implementation plan
**Date:** 2026-09-18
**Roadmap:** `ROADMAP.md` → v3.11.0, lot "Audit the remaining dev-server routes for Rust-behaviour drift"

## 1. Why

`pnpm dev:web` is where manual QA happens. It runs `dev-server.mjs`, not the
Rust backend, so a command whose dev-server route is missing or behaves
differently makes QA test something other than what ships. Two defects already
came from this:

- **`read_file` diverged silently.** Rust rejected non-UTF-8; the dev-server
  substituted `U+FFFD` and succeeded. They agreed on the happy path and
  disagreed on failure, which is the shape that hides best. Fixed with a parity
  test in #189.
- **`gl_merge_mr` has no dev-server route at all.** It is a `#[tauri::command]`
  the frontend calls. The broken `--delete-source-branch` flag (fixed in the
  `[Unreleased]` section) survived because the only environment that could have
  caught it never ran that code.

### The measurement that shapes this design

Taken on `main` at `f33f9f1`:

| | count |
|---|---|
| `#[tauri::command]` declared | 283 |
| registered in `generate_handler!` | 283 |
| invoked by the frontend (`tauriInvoke("…")`) | 139 |
| dev-server routes | 169 |
| commands taking `repo_lock::write` | 36 (35 of them frontend-invoked) |

**A second finding, which decides how the guard is written.** That 139 was
first measured as 122 by a regex of the form `tauriInvoke<?[^>]*>?\(\s*"(\w+)"`.
It silently missed 18 commands — among them `git_status`, `git_diff`, `git_log`
and `git_blame` — because their type parameter contains a nested generic
(`tauriInvoke<Array<{ hash_full: string; … }>>(…)`) and `[^>]*` stops at the
first `>`. A guard that under-counts invocations passes while the audit it
claims to perform is incomplete, which is worse than no guard. §4 therefore
specifies the parse rather than leaving it to whoever writes it.

**The finding that decides the approach:** there is no rule mapping a command
name to a route name. All of these are real:

| command | route |
|---|---|
| `get_conflicted_files` | `/api/conflicted-files` |
| `git_add_to_gitignore` | `/api/git-gitignore` |
| `watch_repo_start` | `/api/watch-repo` |
| `gh_issue_set_state` | `/api/gh-issue-state` |

So no heuristic can answer "is a route missing?" — which is exactly why the
drift is invisible, and why the correspondence has to be **declared** rather
than inferred.

## 2. Success criterion

**Every command the frontend invokes either names its dev-server route or says
why it has none, and a test fails when that stops being true.** The audit is
then a by-product of the registry rather than a one-off sweep that decays.

## 3. The registry

`apps/desktop/src/utils/commandRegistry.ts` — a data file, not executed in
production, one entry per frontend-invoked command. An entry
either names a `route` or declares itself `desktopOnly` — never both, never
neither. `cliPathOnly` is an optional modifier on an entry that has a route:

```typescript
export const COMMAND_REGISTRY: Record<string, CommandRegistryEntry> = {
  git_merge: { route: "/api/git-merge" },
  az_merge_pr: { desktopOnly: "Azure sign-in is an Entra device flow held in the OS keychain; a Node process cannot reach it." },
  gh_merge_pr: { route: "/api/gh-merge-pr", cliPathOnly: "The dev-server always shells out to `gh`; the Rust command uses the REST API whenever a token is configured." },
};
```

- `desktopOnly` and `cliPathOnly` carry a **mandatory free-text reason**. An
  entry that says "desktop only" without saying why is worth no more than a
  missing route: the next person still cannot tell a deliberate choice from an
  oversight.
- `cliPathOnly` is **documentation, not behaviour**. The dev-server keeps
  answering as it does today (§6).

**Seeding the table.** 139 entries is too many to write by hand from nothing,
and too few to justify a generator kept around afterwards. The initial table is
produced once by a throwaway script that pairs each invoked command with a route
of a matching name, then **every unpaired command is resolved by hand** — that
handful is the actual audit this lot is named after, and it is where the
`desktopOnly` reasons get written. The script is not committed: after the table
exists, the guard (§4) is what keeps it true.

## 4. The guard

A vitest test reads `src/utils/backend.ts`, `src/utils/backend-core.ts` and
`dev-server.mjs` as text and asserts four things.

**How the invocations are found**, because a regex over the type parameter is
demonstrably wrong (see §1): scan for each occurrence of the identifier
`tauriInvoke`, skip the ones that are its own definition, an import, or a
mention inside a comment (`* Timeout presets for tauriInvoke.` is one), then
take the first `(` that follows and read what comes after it. A string literal
is the command name; anything else fails assertion 4. Route declarations need
no such care: all 171 of them are `url.pathname === "/api/…"`, with no
`startsWith` or regex variant.

1. **Every invoked command has an entry.** A command added to `backend.ts`
   without one fails the suite — this is what stops the drift recurring.
2. **Every declared `route` exists** in `dev-server.mjs`.
3. **No entry is stale** — an entry naming a command nothing invokes any more
   fails, so the registry cannot rot into fiction.
4. **Every `tauriInvoke(` call passes a string literal.** Without this, a
   dynamically built command name escapes the audit silently, and the registry
   becomes *wrong* rather than merely incomplete. A dynamic invocation is
   refused with a message pointing here.

Reading source with regexes is acceptable because it reads *our* code, whose
idiom (`tauriInvoke<T>("name", …)` and `url.pathname === "/api/name"`) is
stable — and assertion 4 is what keeps that assumption honest instead of
assumed.

## 5. Failure parity for the write commands

The 35 frontend-invoked commands that take `repo_lock::write`. The set is
chosen by a criterion already in the code rather than by judgement, so it does
not need re-litigating as commands are added.

Each gets **one** failure case in `apps/desktop/tests/parity/`, on the model of
`git-operation-action.test.mjs`: both sides refuse, **and both leave the same
state behind**. Asserting only "both failed" is too weak — two implementations
can agree on refusal while leaving different working trees, and the state is
what the caller acts on next.

**Cost, stated rather than discovered.** The parity suite is 81 tests across 24
files today and boots a dev-server. One case per command, with fixtures shared
per family (stash, submodule, worktree), keeps the addition proportionate. If a
command already has a parity file, its failure case joins that file rather than
creating a new one.

## 6. Out of scope

- **Reimplementing the token path in Node.** Making the dev-server take the
  same branch as Rust means rewriting the GitHub/GitLab/Gitea REST calls in
  JavaScript and proving *those* at parity. That is larger than the rest of
  this lot combined. It is declared via `cliPathOnly`, not fixed.
- **Failure modes of read commands.** A read that disagrees is visible on
  screen; a write that disagrees leaves a repository in the wrong state.
- **Commands the frontend does not invoke.** 144 of the 283 are unreachable
  from the UI; they are not a parity problem until something calls them.
- **Making the dev-server refuse when a token is configured.** Considered and
  rejected: it would make `dev:web` unusable for forge commands for anyone with
  a token, which is most of the people who would run it.
