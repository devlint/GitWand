# Issue #149 — "Timeout on gl_list_mrs" — Implementation Plan

**Date:** 2026-08-11
**Branch:** `fix/149-glab-mr-list-timeout` (off `main`)
**Scope:** `apps/desktop/src-tauri/src/commands/gitlab.rs`, `apps/desktop/src-tauri/src/git/cmd.rs`, `apps/desktop/src/composables/usePrPanel.ts`, `apps/desktop/src/locales/*`, `CHANGELOG.md`

---

## 1. Confirmed root cause

Verified by reading the code, not inherited from the report.

### 1a. Blocking subprocess I/O on the Tokio async runtime

`gl_list_mrs` (`apps/desktop/src-tauri/src/commands/gitlab.rs:235-306`) is declared
`async fn` but runs its blocking `hidden_cmd("glab") … .output()` call directly in
the async body (`gitlab.rs:246-255`). `std::process::Command::output()` blocks the
calling thread until the child exits. Because the `#[tauri::command]` is `async`,
that thread is a Tokio worker.

The GitHub equivalent does not have this defect. `gh_list_prs`
(`gh.rs:127-137`) is a three-line wrapper:

```rust
tauri::async_runtime::spawn_blocking(move || gh_list_prs_inner(cwd, state, limit, offset))
    .await
    .map_err(|e| e.to_string())?
```

with all blocking work in the private sync `gh_list_prs_inner` (`gh.rs:33-103`).
The module header at `gh.rs:16-21` records exactly why:

> All Tauri commands here do blocking I/O … They are declared `async` and
> offloaded with `spawn_blocking` — matching `azure.rs` — so the Tokio executor
> thread is never held by a synchronous wait.

and the doc comment at `gh.rs:107-111` records the original incident: on a repo
with 100+ open PRs the query took >30s and tripped the IPC timeout.

`gitlab.rs` never received this fix. Density check:

| Module | `spawn_blocking` occurrences |
|---|---|
| `gh.rs` | 28 |
| `azure.rs` | 21 |
| `gitlab.rs` | **4** |

The four in `gitlab.rs` are `gl_request_reviewers` (`:1074`), `gl_list_reactions`
(`:1316`), `gl_add_reaction` (`:1333`), `gl_delete_reaction` (`:1350`) — added
later and piecemeal. The other 23 `gl_*` async commands block a worker directly.

### 1b. The frontend has a hard 30 s race, the backend has no bound at all

`tauriInvoke` (`apps/desktop/src/utils/backend-core.ts:71-90`) races the invoke
promise against `setTimeout(…, timeoutMs)`, default `IPC_TIMEOUT.DEFAULT = 30_000`
(`backend-core.ts:96-103`). `glListMrs` (`backend-gitlab.ts:36-44`) does not pass
an override, so it gets 30 s.

Losing that race only rejects the *JS promise*. The Rust side keeps running: the
`glab` child is never killed and the Tokio worker stays parked. There is no
subprocess-level timeout anywhere in `gitlab.rs`. So the user-visible symptom
("timeout") is the frontend giving up, while the real damage — a parked worker
thread and an orphaned `glab` process — persists and accumulates on every retry.

### 1c. `hidden_cmd` inherits parent stdin

`hidden_cmd` (`git/cmd.rs:272-306`) never calls `.stdin(...)`, so children inherit
the parent's stdin. Only two of the ~114 `hidden_cmd` call sites opt out
explicitly: `curl_util.rs:31-35` and `ops.rs:2677`. A `glab` that decides to read
stdin (interactive auth re-prompt, pager, TTY probe) blocks forever with nothing
to read it. This remains **unconfirmed** — `glab` is not installed here, so it
cannot be reproduced — but it is cheap to defend against and is handled by
Step 2 below.

### 1d. Why the small-repo / 0-MR reproduction rules out the fan-out

`gl_list_mrs` fans out one extra `glab api …/pipelines` subprocess per MR under
`rayon::par_iter` (`gitlab.rs:281-303`) when the list payload lacks
`head_pipeline`. On a repo with 0 open MRs that loop body never runs, so the
fan-out is not the cause of the reported case. It *is* a real aggravator
elsewhere: N unbounded network subprocesses, so total wall time is
`ceil(N / rayon_pool) × per_call_latency` — unbounded. Step 3 bounds it.

### 1e. Two adjacent findings

- **`gl_mr_count` is strictly worse than `gl_list_mrs`.** `gl_mr_count`
  (`gitlab.rs:311-328`) runs the same `glab mr list` with `--per-page 100`
  where `gl_list_mrs` uses `--per-page 10` (`gitlab.rs:242-244`, default limit 10
  from `backend-gitlab.ts:39`). Both are invoked from `GitLabProvider`
  (`listPRs` → `:124`, `prCount` → `:133`) on the automatic repo-open path with
  no user click. Fixing only `gl_list_mrs` leaves an identical, heavier hang
  reachable by simply opening a GitLab repo. This drives the scope decision in
  §2.
- **`gl_mr_annotations` (`gitlab.rs:533`) is not `async` at all.** Per
  `tauri-macros-2.6.3/src/command/wrapper.rs:249-266`, a non-`async` command
  defaults to `ExecutionContext::Blocking` → the `"sync"` wrapper, executed
  inline in the invoke handler rather than dispatched to the async runtime or a
  threadpool. It issues up to 2 + N_jobs `glab api` calls
  (`glab_api_json`, `gitlab.rs:507-519`). Converting it to `async fn` +
  `spawn_blocking` is strictly safer regardless of which thread the invoke
  handler runs on.

### 1f. False comment to correct

`gitlab.rs:14-16`:

> **Pattern**: mirrors `commands/gh.rs` exactly — every command is a thin
> synchronous `hidden_cmd("glab")` wrapper with JSON parsing.

Self-contradictory and actively misleading: `gh.rs`'s pattern is *not* a thin
synchronous wrapper, it is `spawn_blocking` + sync `_inner`. This comment is
plausibly why the defect was reproduced 23 times. Step 5 fixes it.

---

## 2. Scope decision (explicit — this plan expands beyond `gl_list_mrs`)

**Decision: fix all of `gitlab.rs`, split into two independently reviewable
steps.** The issue only reports the MR list, so this is a deliberate expansion
and is called out as such.

Justification:

1. **A `gl_list_mrs`-only fix does not fix the reported bug.** `gl_mr_count`
   runs the same `glab mr list` with a 10× larger page on the same automatic
   repo-open path (§1e). Ship only Step 3 and the user still sees the app stall
   on opening a GitLab repo, files a follow-up, and we do this twice.
2. **Worker starvation is a whole-module property.** Tauri's async runtime has a
   bounded worker pool. The GitLab PR panel issues list + count + detail +
   pipelines concurrently. Fixing one of four concurrent blockers does not
   restore responsiveness; the pool still fills.
3. **The transformation is mechanical and uniform.** Extract body → private sync
   `_inner`, wrap in `spawn_blocking`. Exactly what `gh.rs` and `azure.rs`
   already look like. Reviewable by pattern-match, not by reasoning per command.
4. **It makes the header comment true** rather than requiring a comment that
   documents a known-broken module.

Split for review:

- **Step 3** — `gl_list_mrs` + `gl_mr_count` + the timeout wiring. This is the
  behavioral fix for #149. Reviewable on its own merits.
- **Step 4** — the remaining 21 async commands + `gl_mr_annotations`. Purely
  mechanical sweep. A reviewer can skim it as a diff shape.

Same PR (one branch, separate commits). Splitting into two PRs would leave `main`
in a state where half the module has the defect and the header comment is wrong
in a new way.

**Explicitly out of scope** (name them in the PR description, do not do them):

- Making `.stdin(Stdio::null())` the default in `hidden_cmd` itself. ~114 call
  sites including every git write operation; blast radius far exceeds this bug.
  Step 2 scopes stdin-null to the new opt-in helper only.
- `bitbucket.rs` (0 `spawn_blocking` occurrences — same defect class, different
  forge, different issue).
- Replacing the naïve `--per-page (limit+offset)` + client-side slice pagination
  (`gitlab.rs:242-244`, `:272-276`). Pre-existing, orthogonal.
- Batching the per-MR pipeline fan-out into one API call. Step 3 bounds it;
  making it efficient is a separate perf task.

---

## 3. Timeout mechanism — decision and rationale

### Mechanisms considered

| Option | Verdict |
|---|---|
| Rely on the frontend's 30 s IPC race | **Insufficient** — §1b: it never kills the child or frees the thread. This is the status quo and it is the bug. |
| `wait_timeout` crate | **Rejected** — `apps/desktop/CLAUDE.md` ("Build & CI") requires measuring compile-time and binary-size impact for every new Cargo dep. Not worth it for ~50 lines of `std`. |
| `tokio::process::Command` + `tokio::time::timeout` | **Rejected** — the work now runs *inside* `spawn_blocking`, i.e. off the async runtime, with no reactor to drive a `tokio` future. Would require restructuring every command back onto the async runtime, undoing Step 3/4. |
| `std::process::Child::try_wait()` + deadline poll + `kill()` | **Chosen.** No new dependency, and the pattern already exists in this codebase. |

### Existing precedent to follow

`try_open_linux` (`ops.rs:3576-3640`) already does deadline-bounded child
supervision with `std::process`: `spawn()` with piped stderr, a
`deadline = start + Duration::from_millis(400)`, a `loop { match child.try_wait() … }`,
and — critically — a **detached drain thread** for the pipe
(`ops.rs:3624-3630`) with the comment "discard as it arrives … never buffer it".
The new helper generalizes exactly this shape.

### Pipe-buffer deadlock — the hazard to get right

The naïve `spawn` + `try_wait` loop deadlocks whenever the child writes more than
the OS pipe buffer (~64 KB): the child blocks on `write()`, never exits,
`try_wait()` returns `Ok(None)` forever. `glab mr list --per-page 100 --output json`
routinely exceeds 64 KB. **The helper must drain stdout and stderr on dedicated
threads while polling.** This is the one part of Step 2 that is easy to get
subtly wrong and it has a dedicated test (§5, `captures_large_stdout_without_deadlocking`).

### Timeout budget

Values must leave headroom under the frontend's 30 s so the *Rust* error surfaces
(diagnostic: "timed out") instead of the frontend's generic
`IPC timeout after 30000ms: gl_list_mrs`.

| Constant | Value | Applies to |
|---|---|---|
| `GLAB_TIMEOUT` | 20 s | primary `glab` invocation of a command |
| `GLAB_API_TIMEOUT` | 5 s | best-effort `glab api` helpers (`gl_pipeline_rollup`, `glab_api_json`) |
| `ROLLUP_BUDGET` | 5 s | overall wall-clock budget for the whole per-MR pipeline fan-out in `gl_list_mrs` |

`gl_list_mrs` worst case: 20 s (list) + 5 s (fan-out budget) = 25 s < 30 s. ✓

The fan-out needs its own *overall* budget, not just a per-call cap: 100 MRs at
5 s each over an 8-thread rayon pool is 13 waves ≈ 65 s. The budget is enforced
by a guard in the rayon closure, not by cancellation — rollups are already
declared best-effort ("empty on any error", `gitlab.rs:486-487`), so degrading to
"no CI dot" past the deadline is a behavior the code already supports.

---

## 4. Implementation steps

### Step 1 — Branch

```bash
git switch -c fix/149-glab-mr-list-timeout main
```

**Acceptance:** `git rev-parse --abbrev-ref HEAD` = `fix/149-glab-mr-list-timeout`;
`git status` clean.

---

### Step 2 — Add `output_with_timeout` to `git/cmd.rs`

**File:** `apps/desktop/src-tauri/src/git/cmd.rs` — new `pub(crate) fn` placed
immediately after `hidden_cmd` (i.e. after `:306`, before `git_cmd` at `:309`),
so it reads as the natural companion to `hidden_cmd`.

Exported automatically: `git/mod.rs` already does `pub(crate) use cmd::*;`.

**Signature — deliberately `io::Result<Output>`:**

```rust
pub(crate) fn output_with_timeout(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output>
```

Matching `Command::output()`'s return type means every call site is a one-token
edit:

```rust
// before
    .output()
    .map_err(|e| format!("glab mr view: {}", e))?;
// after  (cmd built into a `let mut cmd = …;` binding first)
let output = output_with_timeout(cmd, GLAB_TIMEOUT)
    .map_err(|e| format!("glab mr view: {}", e))?;
```

No error-handling restructure, no new `Result` plumbing in 24 commands.

**Behavior contract:**

1. Force `.stdin(Stdio::null())`, `.stdout(Stdio::piped())`, `.stderr(Stdio::piped())`.
   stdin-null addresses §1c, scoped to opt-in callers only.
2. `spawn()`; propagate the spawn error unchanged — this preserves the
   `No such file or directory (os error 2)` text that the frontend's
   CLI-missing detection depends on (§6, and `usePrPanel.ts:605-611`).
3. `take()` stdout and stderr; spawn one `std::thread` per pipe doing
   `read_to_end` into a `Vec<u8>`; keep the `JoinHandle`s.
4. Poll `child.try_wait()` in a loop with `thread::sleep(Duration::from_millis(25))`
   against `deadline = Instant::now() + timeout`.
5. On `Ok(Some(status))`: `join()` both reader threads, return
   `Ok(Output { status, stdout, stderr })`.
6. On deadline expiry: `child.kill()`, then `child.wait()` to reap (avoid a
   zombie), then return
   `Err(io::Error::new(io::ErrorKind::TimedOut, format!("timed out after {}s", timeout.as_secs())))`.
   **Do not join the reader threads on this path** — a child that spawned a
   grandchild holding the pipe would not hit EOF, and joining would defeat the
   entire point of the timeout. The threads exit on their own at EOF; drop the
   handles. Add a one-line comment saying so (this is the non-obvious "why").
7. On `try_wait()` returning `Err`: propagate.

**Error-message wording constraints** (`usePrPanel.ts:605-621` string-matches the
message; verified by reading the predicate):

- must **not** contain `No such file or directory`, `program not found`, `ENOENT`
  → else a timeout is misreported as "GitLab CLI not installed";
- must **not** contain the substring `gh` (line 611 is
  `msg.includes("gh") && msg.includes("installed")`) — note `"glab"` does not
  contain `"gh"`, which is why the existing GitLab path works;
- must **not** contain `token`, `authentication`, `401`, `404`
  (lines 616-618 would misclassify it).

`"timed out after 20s"` satisfies all of these.

**Acceptance:** `cargo build` clean; `cargo clippy` no new warnings; the four
tests in §5.1 pass.

---

### Step 3 — Fix `gl_list_mrs` and `gl_mr_count` (the #149 fix)

**File:** `apps/desktop/src-tauri/src/commands/gitlab.rs`

**3a. Constants** — add after the imports (`:18-21`), with a comment stating the
30 s IPC-timeout relationship (that number is the reason the budget exists and
is otherwise invisible from this file):

```rust
const GLAB_TIMEOUT: Duration = Duration::from_secs(20);
const GLAB_API_TIMEOUT: Duration = Duration::from_secs(5);
const ROLLUP_BUDGET: Duration = Duration::from_secs(5);
```

Add `use std::time::{Duration, Instant};` and extend the `crate::git` import to
bring in `output_with_timeout`.

**3b. `gl_list_mrs` (`:234-306`)** — split into `gl_list_mrs_inner` (sync,
private, holding the entire current body) + the async command:

```rust
#[tauri::command]
pub(crate) async fn gl_list_mrs(
    cwd: String,
    state: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || gl_list_mrs_inner(cwd, state, limit, offset))
        .await
        .map_err(|e| e.to_string())?
}
```

Byte-for-byte the `gh_list_prs` shape (`gh.rs:127-137`). Place `_inner` above the
command, matching `gh.rs`'s layout (`gh.rs:28-31` documents that convention).

Inside `_inner`, change `:246-255` to build the command into a binding and call
`output_with_timeout(cmd, GLAB_TIMEOUT)`. **Keep the existing
`format!("Failed to run glab mr list (is glab installed?): {}", e)` wrapper
unchanged** — it is what `usePrPanel-cli-missing.test.ts:68` asserts against, and
the underlying `e` is what distinguishes ENOENT from timeout.

`rayon::par_iter` inside `spawn_blocking` is correct and needs no change: rayon
has its own thread pool, independent of the Tokio runtime.

**3c. Bound the fan-out (`:289-298`)** — capture a deadline before the
`par_iter` and add a guarded match arm:

```rust
let rollup_deadline = Instant::now() + ROLLUP_BUDGET;
let rollups: HashMap<i64, String> = mrs
    .par_iter()
    .filter_map(|mr| {
        let rollup = match embedded.get(&mr.number) {
            Some(s) => gl_status_to_rollup(s),
            None if Instant::now() < rollup_deadline => gl_pipeline_rollup(&cwd, mr.number),
            None => String::new(),
        };
        …
```

Two lines, no signature change to `gl_pipeline_rollup`, and the degradation
(no CI dot) is already a supported state.

**3d. `gl_pipeline_rollup` (`:487-503`) and `glab_api_json` (`:507-519`)** —
switch `.output()` → `output_with_timeout(cmd, GLAB_API_TIMEOUT)`. Both already
swallow all errors, so a timeout needs no new handling; a timeout now simply
yields `""` / `None` instead of hanging.

**3e. `gl_mr_count` (`:311-328`)** — same `_inner` + `spawn_blocking` split,
plus `output_with_timeout(cmd, GLAB_TIMEOUT)`. Returns `Ok(0)` on
non-success already, so a timeout degrades to a zero badge instead of a hang.

**Acceptance:**
- `cargo build` clean, `cargo clippy` no new warnings.
- `gl_list_mrs` and `gl_mr_count` bodies contain no `.output()` call.
- Both are three-line `spawn_blocking` wrappers over private sync `_inner` fns.
- No change to any command signature → `backend-gitlab.ts` and `backend.ts`
  are untouched (verify with `git diff --stat`).
- `cd apps/desktop && pnpm test` still green (in particular
  `usePrPanel-cli-missing.test.ts`).

---

### Step 4 — Mechanical sweep: remaining `gitlab.rs` commands

Same transformation, one commit. Full list, verified by
`grep -n "^#\[tauri::command\]" -A 1 gitlab.rs`.

**Already correct — do not touch (4):** `gl_request_reviewers` (`:1073`),
`gl_list_reactions` (`:1310`), `gl_add_reaction` (`:1326`),
`gl_delete_reaction` (`:1343`).

**Async, blocking directly — wrap (21 remaining after Step 3):**

| Line | Command | Note |
|---|---|---|
| 221 | `detect_glab` | returns bare `bool`, not `Result` — see below |
| 332 | `gl_get_mr` | |
| 371 | `gl_mr_diff_refs` | |
| 399 | `gl_mr_diff` | |
| 421 | `gl_mr_pipelines` | |
| 661 | `gl_list_issues` | |
| 699 | `gl_create_mr` | write op |
| 762 | `gl_merge_mr` | write op |
| 791 | `gl_checkout_mr` | write op |
| 809 | `gl_convert_draft_to_ready` | write op |
| 831 | `gl_mr_notes` | |
| 857 | `gl_mr_create_note` | write op |
| 882 | `gl_mr_update_note` | write op |
| 909 | `gl_mr_delete_note` | write op |
| 935 | `gl_approve_mr` | write op |
| 955 | `gl_list_reviews` | |
| 977 | `gl_current_user` | |
| 1004 | `gl_reviewer_candidates` | |
| 1107 | `gl_branches` | |
| 1149 | `gl_mr_files` | |
| 1191 | `gl_mr_create_discussion` | write op |

**Non-async — convert to `async fn` + `spawn_blocking` (1):**
`gl_mr_annotations` (`:533`), per §1e. Signature stays
`Result<Vec<CIAnnotation>, String>`, so the frontend is unaffected.

**`detect_glab` needs a different wrapper** (no `Result` to propagate the
`JoinError` into):

```rust
#[tauri::command]
pub(crate) async fn detect_glab(cwd: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || detect_glab_inner(cwd))
        .await
        .unwrap_or(false)
}
```

`false` on `JoinError` matches the function's existing `.unwrap_or(false)`
philosophy (`:227`).

**Timeout assignment for the sweep:** `GLAB_TIMEOUT` for all of them, except
`detect_glab` which should get a short cap (`GLAB_API_TIMEOUT`, 5 s) — it is a
`--version` probe on the repo-open path and a 20 s hang there stalls forge
detection for every panel.

Also switch `glab_api` (`:1282`, the shared helper behind the reaction commands)
to `output_with_timeout(cmd, GLAB_TIMEOUT)`.

**Acceptance:**
- `grep -c "\.output()" gitlab.rs` → `0`.
- Every `#[tauri::command]` in `gitlab.rs` is `async fn` and its body's only
  statement is a `spawn_blocking(...).await` expression.
- `cargo build` + `cargo clippy` clean.
- No command signature changed → zero diff in `apps/desktop/src/utils/`.
- `pnpm test` green.

---

### Step 5 — Correct the module header

**File:** `apps/desktop/src-tauri/src/commands/gitlab.rs:14-16`

Replace the false "**Pattern**: mirrors `commands/gh.rs` exactly — every command
is a thin synchronous `hidden_cmd("glab")` wrapper …" block with an accurate
statement of the post-Step-4 reality, covering (a) `spawn_blocking` + sync
`_inner`, cross-referencing `gh.rs:16-21`; (b) the `output_with_timeout` budget
and the 30 s IPC-timeout relationship; (c) issue #149 as the reason. Keep it
short — this is a header comment, not an essay.

**Acceptance:** the header no longer claims "thin synchronous wrapper" or
"mirrors … exactly"; the claim it does make is true of the code as merged.

---

### Step 6 — Frontend: classify the timeout + i18n (5 locales)

**This is the one addition beyond the requested scope.** Justification: the
timeout produces a *new user-visible English string*. Today it would fall through
`usePrPanel.ts:620-621` (`error.value = msg`) and render
`glab mr list failed: timed out after 20s` verbatim, in English, in all five
locales. `AGENTS.md` § i18n requires every user-visible string to have a key in
all five locale files, so a raw passthrough is not acceptable for a string we are
introducing. Small: one predicate branch + one key × 5 files.

**6a.** `apps/desktop/src/composables/usePrPanel.ts` — add a branch between the
CLI-missing check (`:612-615`) and the auth check (`:616`):

```ts
} else if (msg.includes("timed out")) {
  error.value = t("pr.error.timedOut");
  errorAction.value = "retry";
```

Ordering matters: it must come *after* `isGhMissing` (so a genuine ENOENT still
wins) and *before* the `token`/`authentication` branch.

Verify `"retry"` is a valid `errorAction` value in this composable before using
it; if not, leave `errorAction` unset — `pr.error.retry` already exists in the
locale files (`en.ts:1056`), so the retry affordance likely already renders.

**6b.** Add `timedOut` to the `pr.error` object in all five locale files —
`en.ts` (nested block at `:1049-1057`), `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`.
There is no `i18n-sync` script in this repo (checked `package.json` at both the
root and `apps/desktop`), so all five are edited by hand in the same commit.

English: `"GitLab took too long to respond — check your network or VPN, then retry."`

Note the string must be forge-neutral in the *key* name but the copy mentions
GitLab. `usePrPanel` already has forge-aware copy via `CLI_MISSING_INFO`
(`:613`); prefer reusing `forge.value.name` for the forge label if that reads
cleanly, otherwise keep the copy generic ("The forge took too long to respond").
Decide at implementation time — flag which you chose in the PR description.

**Acceptance:** `pnpm test` green; `grep -c "timedOut" src/locales/*.ts` returns
1 for each of the five files; no hardcoded user-facing text added to any
component.

---

### Step 7 — CHANGELOG

**File:** `CHANGELOG.md` — add a `### Fixed` bullet under the existing
`## [Unreleased]` (line 8, currently empty).

Content: GitLab MR list no longer times out / freezes the app; all `glab`
commands now run off the async runtime and carry a 20 s subprocess timeout that
kills the child instead of orphaning it; reference `(#149)`.

**Do not touch `website/changelog.md` in this PR.** `AGENTS.md` § Changelog
requires the two to be updated in the same commit *"at every tag"*; this work
lands as `[Unreleased]` with no tag, so the narrative mirror is written at
release time.

**Do not touch `roadmap.md`.** Checked — no planned/in-progress item covers
this; `AGENTS.md` only requires a roadmap move when a *feature* ships.

**Do not run `./scripts/bump-version.sh`.** No version change in a bug-fix PR;
versions are bumped only at release time.

**Acceptance:** `CHANGELOG.md` `[Unreleased]` has a `### Fixed` entry citing
`#149`; `git diff --name-only` includes no `package.json`, `Cargo.toml`, or
`tauri.conf.json`.

---

## 5. Tests

### 5.1 Strong automated tests — `output_with_timeout` (real subprocesses)

This is where the real coverage lives. The helper is the load-bearing new logic,
and it *is* directly testable with real subprocesses (satisfying `AGENTS.md`
§ Testing "do not mock the git layer") because it takes a plain
`std::process::Command`.

**Location:** the existing `#[cfg(test)] mod` in
`apps/desktop/src-tauri/src/git/cmd.rs` (starts at `:435`).

Gate the process-spawning tests with `#[cfg(unix)]` — they rely on `sleep`,
`false`, `head`, `/dev/zero`. CI's Rust job matrix is Linux/macOS
(`.github/workflows/ci.yml`), so they will actually run. Do **not** use
`sh -c` for the large-output case; `head -c 2000000 /dev/zero` needs no shell,
which keeps the tests aligned with the repo's no-shell-interpolation rule even
where the input is a literal.

| Test | Setup | Assertion |
|---|---|---|
| `returns_output_for_a_fast_command` | `hidden_cmd("echo")`, args `["hi"]`, timeout 5 s | `Ok`, `status.success()`, `stdout == b"hi\n"` |
| `kills_and_errors_when_the_command_exceeds_the_timeout` | `hidden_cmd("sleep")`, args `["30"]`, timeout 300 ms | `Err` with `kind() == ErrorKind::TimedOut`, message contains `"timed out"`; and `start.elapsed() < Duration::from_secs(5)` — **this is the actual regression assertion for #149**: the call returns promptly instead of blocking for the child's full lifetime |
| `captures_large_stdout_without_deadlocking` | `hidden_cmd("head")`, args `["-c", "2000000", "/dev/zero"]`, timeout 10 s | `Ok`, `stdout.len() == 2_000_000` — guards the pipe-buffer deadlock in §3; without the drain threads this test hangs until the timeout and fails |
| `propagates_nonzero_exit_status` | `hidden_cmd("false")`, timeout 5 s | `Ok`, `!status.success()` — a failing command is not conflated with a timeout |
| `spawn_failure_error_text_is_preserved` | `hidden_cmd("gitwand-no-such-binary-149")`, timeout 5 s | `Err` whose message contains `"No such file or directory"` (or `kind() == NotFound`) — locks in the contract that `usePrPanel.ts:605-611`'s CLI-missing detection depends on |

The timeout test must assert on **elapsed wall time**, not just on the error
value. An implementation that returned `TimedOut` only *after* the child finished
would satisfy a value-only assertion while still exhibiting the bug.

Run: `cd apps/desktop/src-tauri && cargo test --lib`.

### 5.2 Frontend regression test — timeout is not misreported as "CLI missing"

**Location:** extend
`apps/desktop/src/composables/__tests__/usePrPanel-cli-missing.test.ts` (it
already has the exact harness: `forgeStub.current.listPRs` throwing a chosen
error string, then asserting on `panel.error.value`).

New case: `listPRs` throws `new Error("glab mr list failed: timed out after 20s")`
on a GitLab remote. Assert:

- `panel.error.value` does **not** contain `"not installed"`;
- `panel.error.value` matches the new `pr.error.timedOut` copy;
- `panel.error.value` does not contain `"cli.github.com"`.

This is a genuine behavior test at the error-classification boundary, and it
guards a real trap: `usePrPanel.ts:605-618` is a chain of substring matches, and
a carelessly worded timeout message would be silently swallowed by the
CLI-missing or auth branch. It also pins the §4 wording constraints from the
frontend side, so a future reword of the Rust message breaks a test rather than
shipping a wrong error banner.

### 5.3 Existing tests kept green

- `gl_state_flag_tests` (`gitlab.rs:1389-1414`) and the
  `gl_issue_to_issue` test above it — untouched by this work; must still pass.
- `usePrPanel-cli-missing.test.ts:68` asserts against the literal
  `"Failed to run glab mr list (is glab installed?): No such file or directory (os error 2)"`.
  Step 3b deliberately preserves that `format!` wrapper. **If this test breaks,
  the fix has changed the error contract and Step 3b was done wrong** — do not
  edit the test to match.
- `cd apps/desktop && pnpm test:parity` — should be unaffected (no `git`
  command touched, no new `#[tauri::command]`) but run it to confirm.

### 5.4 What is NOT automatable — stated plainly

**There is no feasible automated test asserting that `gl_list_mrs` runs on a
blocking thread rather than a Tokio worker.** Concretely:

- The repo has no Tauri command harness (no `tauri::test`, no mock `AppHandle`);
  `gl_list_mrs` is `pub(crate)` and unreachable without a running `App`.
- Asserting on thread identity or on Tokio internals from a `cargo test` unit
  test would test the mock, not the app.
- A grep-based "every `gl_*` body contains `spawn_blocking`" test is a
  code-shape assertion: it passes for a body that calls `spawn_blocking` and
  *also* blocks elsewhere, and it fails on any legitimate future refactor. It
  would create maintenance drag while catching nothing real. **Rejected —
  deliberately not written.**

What §5.1 *does* cover, and it is the substantive half: the timeout actually
fires, the child is actually killed, and the call actually returns promptly. The
`spawn_blocking` placement is covered by review (a three-line, pattern-matchable
wrapper) plus §5.5 manual verification.

### 5.5 Manual verification

**A. Fake slow `glab` (no GitLab account needed, no `glab` install needed).**
Verifies end-to-end that the timeout fires and the UI stays responsive.

```sh
mkdir -p /tmp/fake-bin
cat > /tmp/fake-bin/glab <<'EOF'
#!/bin/sh
# --version must succeed fast or forge detection never reaches the MR list.
case "$1" in --version) echo "glab version 1.0.0"; exit 0 ;; esac
sleep 300
EOF
chmod +x /tmp/fake-bin/glab
PATH=/tmp/fake-bin:$PATH pnpm --filter @gitwand/desktop tauri dev
```

Open a repo with a GitLab remote, open the PR panel. Expect:

1. The panel shows the localized timeout message at ~20 s — **not** at 30 s, and
   **not** "GitLab CLI not installed".
2. The rest of the UI stays interactive throughout: switch tabs, expand the
   commit graph, run a `git status` refresh. This is the actual #149 symptom
   check — pre-fix, concurrent IPC stalls.
3. `pgrep -f "fake-bin/glab"` returns nothing after the error appears — the
   child was killed, not orphaned. Pre-fix it survives.
4. Retry 3-4 times; worker threads are not cumulatively consumed (the app does
   not get progressively less responsive).

Why this is manual: putting a fake binary on `PATH` from inside a Rust unit test
requires mutating process-global `PATH`, which races cargo's parallel test
threads, and `hidden_cmd` reads `std::env::var("PATH")` at call time
(`git/cmd.rs:255-269`). The deterministic half of this check is already automated
as `kills_and_errors_when_the_command_exceeds_the_timeout` (§5.1).

**B. Real GitLab repo (if a `glab`-authenticated account is available).**
Open a GitLab repo with open MRs; confirm the MR list loads, CI dots render, and
`gl_mr_count`'s badge is correct — i.e. Steps 3/4 did not regress the happy path.
On a repo with many MRs, confirm that if the fan-out exceeds `ROLLUP_BUDGET` the
list still returns (some MRs simply show no CI dot) rather than timing out.

**C. Frontend-only smoke.** `pnpm dev:web` — GitLab commands throw
"requires Tauri" by design (`backend-gitlab.ts:42`), so no `dev-server.mjs` route
is needed. No new `#[tauri::command]` is added by this plan, so the
dev-server-parity obligation for new commands does not apply. Confirm no console
errors from the `usePrPanel.ts` change.

---

## 6. Constraint checklist

| Constraint | Status |
|---|---|
| No `invoke()` outside `backend.ts` / typed wrapper per new command | ✓ No new command; no signature change; `apps/desktop/src/utils/` untouched except nothing |
| dev-server route + fetching wrapper per new `#[tauri::command]` | ✓ N/A — no new command |
| i18n key in all 5 locales for user-visible strings | ✓ Step 6b (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) |
| Settings field in both `useSettings.ts` and `SettingsPanel.vue` | ✓ N/A — no new setting |
| Versions only via `./scripts/bump-version.sh` | ✓ Step 7 forbids version edits |
| Secondary Rust binaries under `[[example]]` | ✓ N/A — no new binary |
| No Node.js modules in `packages/core` | ✓ N/A — `packages/core` untouched |
| No shell string interpolation in commands | ✓ Argument arrays preserved; tests avoid `sh -c` |
| `safe_repo_path()` not bypassed | ✓ N/A — no new filesystem path handling |
| No secrets logged / in argv | ✓ Timeout message contains no `cwd`, no token; `hidden_cmd`'s existing `GH_TOKEN`/`GITHUB_TOKEN` propagation untouched |
| New Cargo dep → measure compile + binary impact | ✓ No new dep (that is why `wait_timeout` was rejected, §3) |
| Rust ↔ TS resolution parity | ✓ N/A — the parity probe covers *git commands* only; there is no Rust resolution engine (`AGENTS.md` § Parity tests). Run `pnpm test:parity` as a no-regression check. |
| Real git repos in tests, no mocked git layer | ✓ §5.1 spawns real subprocesses |

---

## 7. Open decisions for the human checkpoint

1. **Scope (§2) — the main one.** This plan fixes all 24 commands in
   `gitlab.rs`, not just `gl_list_mrs`. Rationale: `gl_mr_count` is on the same
   automatic repo-open path and is strictly heavier, so a `gl_list_mrs`-only fix
   does not fix the reported symptom. Reject this and Step 4 is dropped —
   accepting that #149 likely reopens.
2. **Timeout values.** 20 s primary / 5 s API / 5 s fan-out budget, chosen to
   land under the frontend's 30 s. If 20 s is too aggressive for large
   self-hosted GitLab instances behind a VPN, the alternative is raising
   `IPC_TIMEOUT` for `glListMrs` specifically (e.g. 60 s) and setting
   `GLAB_TIMEOUT` to 50 s. Not recommended — a 20 s wait already reads as broken
   to a user.
3. **Step 6 (frontend i18n) is beyond the requested scope.** Included because
   the timeout introduces a new user-visible string and `AGENTS.md` requires all
   five locales. Drop it and the raw English Rust message renders in every
   locale.
4. **Forge-neutral vs GitLab-specific timeout copy** (Step 6b). Recommend
   reusing `forge.value.name` so the same key serves a future
   `bitbucket.rs` / `azure.rs` fix.
5. **`hidden_cmd` stdin default.** §1c is unconfirmed (no `glab` available to
   reproduce). Step 2 scopes `Stdio::null()` to the new helper. Making it
   `hidden_cmd`'s global default would also protect ~114 git call sites from
   credential-prompt hangs — a plausibly valuable follow-up, deliberately not
   bundled here.
6. **`bitbucket.rs` has zero `spawn_blocking`** — same defect class, not
   reported by any issue. Worth a follow-up issue?

---

## 8. Execution order summary

1. Branch `fix/149-glab-mr-list-timeout` off `main`.
2. `git/cmd.rs`: add `output_with_timeout` + the five tests in §5.1. **Commit.**
   (`cargo test --lib` must pass before proceeding — the helper is the foundation
   for everything after.)
3. `gitlab.rs`: constants, `gl_list_mrs`, `gl_mr_count`, fan-out budget,
   `gl_pipeline_rollup`, `glab_api_json`. **Commit** — this is the #149 fix.
4. `gitlab.rs`: mechanical sweep of the remaining 22 commands + `glab_api`.
   **Commit.**
5. `gitlab.rs`: header comment correction. Fold into commit 4.
6. `usePrPanel.ts` + 5 locale files + the §5.2 test. **Commit.**
7. `CHANGELOG.md` `[Unreleased]`. **Commit.**
8. Verify: `cargo test --lib`, `cargo clippy`, `pnpm test`, `pnpm test:parity`,
   then manual §5.5 A (and B if a GitLab account is available).
