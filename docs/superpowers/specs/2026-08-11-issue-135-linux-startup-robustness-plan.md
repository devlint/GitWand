# Issue #135 — Linux startup robustness (implementation plan)

Design (source of truth, do not re-litigate):
`docs/superpowers/specs/2026-08-11-issue-135-linux-startup-robustness-design.md`
(committed on this branch as `d4e8280`).

Branch: `fix/135-linux-startup-robustness` (already created, off `main`). Do not
create a branch.

## Goal

Ship the two confirmed, low-risk fixes from the design:

1. **Component 1** — remove the telemetry flush-on-exit Tokio panic (cross-platform)
   by fixing `flush_blocking()` in the vendored `tauri-plugin-aptabase` fork and
   bumping the pinned `rev` in GitWand.
2. **Component 2** — broaden the Linux render fallback with `LIBGL_ALWAYS_SOFTWARE=1`,
   guarded so it never overrides an already-set value.

## Non-goals

- The AppImage self-re-exec fix for GitWand's own library resolution (design
  "Follow-up" section — explicitly deferred pending reporter feedback).
- Any version bump. `bump-version.sh` runs at release time only.
- Removing the now-unused `futures` dependency from the fork (see Risks).

## Verified facts (re-checked against the working tree, 2026-08-11)

| Fact | Location |
|---|---|
| Patch pin currently `rev = "a868ab1db74b6ae6616389022680881a2c352e1c"` | `apps/desktop/src-tauri/Cargo.toml:136-137` |
| Comment block above it documents only the `start_polling` fix, branch `fix/tokio-runtime-panic` | `apps/desktop/src-tauri/Cargo.toml:125-135` |
| `Cargo.lock` pins the same rev in the `source = "git+…#…"` line | `apps/desktop/src-tauri/Cargo.lock:4955-4957` |
| Linux env-var block to extend | `apps/desktop/src-tauri/src/lib.rs:297-301` (comment at `286-296`) |
| Crate is `edition = "2021"` → `std::env::set_var` needs no `unsafe` | `apps/desktop/src-tauri/Cargo.toml:7` |
| Fork tip `a868ab1` still has the unpatched `futures::executor::block_on` in `flush_blocking()` | `~/.cargo/git/checkouts/tauri-plugin-aptabase-f96b82873dbf22fc/a868ab1/src/client.rs:143-147` |
| `flush_blocking()` is called unconditionally from `RunEvent::Exit` | same checkout, `src/lib.rs:92-95` |
| **The aptabase plugin is registered only in release builds** (`#[cfg(not(debug_assertions))]`) | `apps/desktop/src-tauri/src/lib.rs:323-324` |
| GitWand does **not** install the plugin's panic hook (`with_panic_hook` unused) | `apps/desktop/src-tauri/src/lib.rs:324` |
| No local clone of `devlint/tauri-plugin-aptabase` exists on this machine; only cargo's bare db + read-only checkout | `~/.cargo/git/{db,checkouts}/tauri-plugin-aptabase-f96b82873dbf22fc` |
| `gh` auth is broken in this environment (invalid keyring token) **and** `api.github.com` fails TLS verification through the sandbox | `gh auth status`, `gh api …` |
| PR CI does **not** compile the Rust backend — the `desktop` job is gated `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` | `.github/workflows/ci.yml:47-50` |

### Two corrections the plan applies to the design's testing section

- The design says to verify Component 1 by launching **a debug build**. That cannot
  work: the plugin is not registered in debug builds (`cfg(not(debug_assertions))`),
  so neither the panic nor its absence is observable there. Verification must use a
  **release** build — which matches the precedent set when the fork was first
  introduced (commit `9dcf91a`: "Verified with a real `pnpm tauri build` + launching
  the produced binary"). Step 6 is written accordingly.
- The design says both fixes land as "a single `[Unreleased]` entry". This plan puts
  both bullets under the same `## [Unreleased]` / `### Fixed` block (design intent
  preserved) but writes each bullet in the step where that fix actually lands, so the
  tree never claims a fix it doesn't contain while Step 4's human gate is open.

## Constraints checklist (all non-applicable, confirmed)

- No new `#[tauri::command]` → no `backend.ts` wrapper, no `dev-server.mjs` route.
- No user-visible string → no i18n keys, no `i18n-sync`.
- No settings field → no `useSettings.ts` / `SettingsPanel.vue` change.
- No `packages/core` change → no browser-compat concern, no parity probe impact.
- No `[[bin]]` added.
- **The `rev` bump in `[patch.crates-io]` is not a version field.** AGENTS.md's
  "never hand-edit `Cargo.toml`" rule targets the `version = ` fields managed by
  `bump-version.sh`. Do **not** run `bump-version.sh` for this work.

---

## Step 1 — Component 2: broaden the Linux render fallback

**File:** `apps/desktop/src-tauri/src/lib.rs`, the `#[cfg(target_os = "linux")]`
block at lines 297-301.

**Change** (exactly as designed — keep the existing two `set_var` calls first):

```rust
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        // #135 follow-up: the two vars above only steer WebKitGTK's compositing
        // path, not EGL *display acquisition* itself — force Mesa's software
        // rasterizer as a broader fallback for systems where EGL_BAD_PARAMETER
        // originates earlier (e.g. native Wayland/Gnome). Never override a value
        // the user or environment already set deliberately.
        if std::env::var("LIBGL_ALWAYS_SOFTWARE").is_err() {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
    }
```

Leave the existing comment block at `lib.rs:286-296` untouched.

**Acceptance criteria**

- The two pre-existing `set_var` calls are unchanged and still first in the block.
- `LIBGL_ALWAYS_SOFTWARE` is set only when `std::env::var(...)` returns `Err`
  (covers both "unset" and "not valid unicode" — either way we don't clobber).
- `git diff apps/desktop/src-tauri/src/lib.rs` shows this block and nothing else.

**Verification**

- `cd apps/desktop/src-tauri && cargo check` — passes. **Note this does not compile
  the changed block** (it is `cfg`-gated to Linux and we are on macOS), and PR CI
  won't either (`ci.yml:50`). It only proves nothing else broke.
- Because nothing compiles this block before it reaches `main`, do a cheap isolated
  syntax check: write the block's body (the three statements, no `cfg` attribute)
  into a scratch file under the session scratchpad and run
  `rustc --crate-type lib --edition 2021 <scratchfile>`; expect zero errors. Delete
  the scratch file. Do **not** add anything to the repo for this.

## Step 2 — CHANGELOG: Component 2 bullet

**File:** `CHANGELOG.md`, under the existing `## [Unreleased]` heading (line 8).
Create a `### Fixed` subsection under it (there is none yet — `[Unreleased]` is
currently empty).

```markdown
## [Unreleased]

### Fixed

- Linux: broadened the startup render fallback with `LIBGL_ALWAYS_SOFTWARE=1` (never overriding a value already set in the environment) alongside the existing `WEBKIT_DISABLE_COMPOSITING_MODE`/`WEBKIT_DISABLE_DMABUF_RENDERER`. The two WebKitGTK vars only steer compositing; they don't affect EGL *display acquisition*, which is where `Could not create default EGL display: EGL_BAD_PARAMETER` originates on some native-Wayland/Gnome setups (#135).
```

**Acceptance criteria**

- Entry sits under `[Unreleased]`, above `## [3.6.1]`. No existing entry touched.
- Wording does not contradict the v3.6.1 `#135` entry (line 20) — it extends it.
- `website/changelog.md` is **not** touched (per AGENTS.md that mirror is updated at
  tag time, and this is an `[Unreleased]` entry).

## Step 3 — Prepare the fork-side change as a handoff artifact

The fix belongs to `devlint/tauri-plugin-aptabase`, a separate repository that is
not part of this checkout and cannot be pushed to from this environment (`gh` token
invalid, `api.github.com` TLS verification fails through the sandbox). Nothing in
this step modifies GitWand.

**The change** — in the fork's `src/client.rs:143-147`:

```rust
    /// Flushes the event queue, blocking the current thread.
    pub fn flush_blocking(&self) {
-       futures::executor::block_on(async {
+       tauri::async_runtime::block_on(async {
            self.flush().await;
        });
    }
```

**Recommendation (primary): the human makes this edit via the GitHub web UI.**
It is a one-token change on a two-line function, and the web editor returns the new
commit SHA immediately — no clone, no local Rust toolchain, no push credentials
needed from this sandbox. Concretely, for the human:

1. Open `https://github.com/devlint/tauri-plugin-aptabase/blob/fix/tokio-runtime-panic/src/client.rs`
2. Edit line 144: `futures::executor::block_on` → `tauri::async_runtime::block_on`
3. Commit to branch `fix/tokio-runtime-panic` (the branch already pinned by the
   comment in `Cargo.toml:134`) with message:
   `fix: replace futures::executor::block_on with tauri::async_runtime::block_on in flush_blocking`
4. Copy the resulting **full 40-character SHA** and hand it back.

**Alternative (git CLI), if preferred:**

```bash
git clone https://github.com/devlint/tauri-plugin-aptabase /tmp/tpa
cd /tmp/tpa && git checkout fix/tokio-runtime-panic
# apply the one-line edit in src/client.rs
git commit -am "fix: replace futures::executor::block_on with tauri::async_runtime::block_on in flush_blocking"
git push origin fix/tokio-runtime-panic && git rev-parse HEAD
```

**What the executor produces in this step:** the unified diff above written to the
session scratchpad (not committed to GitWand — a patch for a foreign repo has no
business in this tree), and the same diff pasted inline in the handoff message to
the human, together with the two options above.

**Acceptance criteria**

- No change to any file under `/Users/laurent/Documents/GitHub/GitWand`.
- Handoff message states plainly: this is human action **outside** the normal GitWand
  PR checkpoint, and Steps 5-6 are blocked until the new SHA comes back.

## Step 4 — HUMAN GATE (blocking, outside the GitWand PR flow)

Stop here and wait. Required input to proceed: the new commit SHA on
`devlint/tauri-plugin-aptabase`, branch `fix/tokio-runtime-panic`.

If the human declines to touch the fork, Steps 5-6 are dropped and the PR ships
Component 2 only — say so explicitly rather than silently narrowing scope, and drop
the Component 1 bullet from the CHANGELOG. Do **not** invent a workaround (e.g.
vendoring the plugin under a local `path =` patch, or suppressing the panic) without
a new design and explicit approval: that trades the design's audited one-line fix for
a permanent maintenance burden.

## Step 5 — Component 1: bump the pinned rev in GitWand

**File:** `apps/desktop/src-tauri/Cargo.toml:125-137`. Replace the comment block and
the `rev` value (`<NEW_SHA>` = the SHA from Step 4; `<SHORT>` = its first 7 chars):

```toml
# ─── Patch: tauri-plugin-aptabase tokio runtime panic ────────
#
# Upstream 1.0.0 reaches for raw `tokio::spawn` / `futures::executor::block_on`
# in `src/client.rs` instead of the `tauri::async_runtime` equivalents, which
# panics with "there is no reactor running, must be called from the context of a
# Tokio 1.x runtime" — see aptabase/tauri-plugin-aptabase#16 and #22. The fix is
# queued upstream in PR #30 (unmerged as of this writing). Rather than depend on
# a random third-party fork carrying that unreviewed PR, we cherry-picked the
# minimal fixes onto a fork under our own GitHub account
# (`devlint/tauri-plugin-aptabase`, branch `fix/tokio-runtime-panic`) with no
# other changes and no dependency bumps:
#   - `start_polling` → `tauri::async_runtime::spawn` (rev a868ab1) — panicked at
#     startup in release builds.
#   - `flush_blocking` → `tauri::async_runtime::block_on` (rev <SHORT>) — the
#     remaining unpatched call site; it fires from the plugin's `RunEvent::Exit`
#     handler on the main thread, so the same panic hit *exit* whenever the
#     process quit before the 60s background flush had drained the queue (#135).
[patch.crates-io]
tauri-plugin-aptabase = { git = "https://github.com/devlint/tauri-plugin-aptabase", rev = "<NEW_SHA>" }
```

Then regenerate the lockfile:

```bash
cd apps/desktop/src-tauri && cargo check
```

**Acceptance criteria**

- `Cargo.toml`'s `rev` is the full 40-char SHA from Step 4.
- `Cargo.lock`'s `tauri-plugin-aptabase` `source` line (~4957) now reads
  `…?rev=<NEW_SHA>#<NEW_SHA>`. Verify with
  `grep -n 'tauri-plugin-aptabase' -A 3 apps/desktop/src-tauri/Cargo.lock`.
- `git diff --stat` for this step shows exactly `Cargo.toml` + `Cargo.lock`. If
  `Cargo.lock` picked up unrelated dependency churn (a transitive bump from a
  refreshed registry index), revert the lockfile and redo with
  `cargo update -p tauri-plugin-aptabase --precise` semantics or `--offline` so the
  diff stays limited to the aptabase entry. An unrelated dep bump smuggled into a
  Linux-startup fix is not acceptable.
- No `version = ` field anywhere was touched.

## Step 6 — Manual verification of Component 1 (release build required)

The panicking path only exists at process-exit time inside a running Tauri app with
the telemetry plugin registered — i.e. release builds only. Not unit-testable.

**Before (optional but cheap, confirms the bug is real on this machine):** launch the
already-installed v3.6.1 from a terminal so its stderr is visible, then quit within a
few seconds (well under the 60s flush interval):

```bash
/Applications/GitWand.app/Contents/MacOS/gitwand-desktop
```

Expect `there is no reactor running, must be called from the context of a Tokio 1.x
runtime` on quit. (Per the design, this bug is cross-platform — Linux just exposes it
reliably because EGL aborts cause near-instant exits.)

**After:**

```bash
cd apps/desktop && pnpm tauri build
```

then launch the produced binary from a terminal and quit within a few seconds.

**Acceptance criteria**

- Build succeeds.
- No `there is no reactor running` panic (and no other panic) on quit.
- Report the observed before/after output verbatim in the PR body. If the "before"
  step was skipped, say so.

**Known side effect to state, not hide:** a release build sends a real anonymous
`launch` event to Aptabase from this machine. That is the intended behaviour of a
release build, and it is in fact what makes the flush path observable at all.

## Step 7 — CHANGELOG: Component 1 bullet, and final sweep

Add, under the same `### Fixed` block created in Step 2:

```markdown
- Telemetry no longer panics on exit (`there is no reactor running, must be called from the context of a Tokio 1.x runtime`). The vendored `tauri-plugin-aptabase` fork still flushed its queue through `futures::executor::block_on`, which provides no Tokio reactor, so quitting within 60s of launch — before the background flush had drained the queued `launch` event — panicked on any platform. This was the second half of the crash reported on Linux, where EGL failures make the app exit almost immediately (#135).
```

**Final sweep**

- `git diff --stat` against `main`: expected files only —
  `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/Cargo.toml`,
  `apps/desktop/src-tauri/Cargo.lock`, `CHANGELOG.md` (plus the design and plan docs
  already committed under `docs/superpowers/specs/`).
- `git status` clean of stray files (no scratch patch, no build artifacts).
- `cd apps/desktop/src-tauri && cargo check` passes.
- No TypeScript touched → the JS test suites are unaffected; skip `pnpm -r run test`
  unless the sweep shows an unexpected TS/JSON diff.

**PR body must state, plainly:**

1. Component 1 was verified manually (quick-exit on a release build); there is no
   automated test for it, and that is a deliberate limitation, not an oversight.
2. Component 2 is **unverified against the reporting environment** (Fedora 44 /
   Gnome / AppImage). There is no Linux GPU/EGL harness in CI and none available
   locally. It ships as a broader fallback and needs a report-back from affected
   users — the same loop that confirmed the v3.6.1 fix for the Ubuntu reporter.
3. The Rust backend is **not** compiled by PR CI (`ci.yml:47-50` gates the `desktop`
   job to pushes on `main`), so the Linux-only block gets its first real compile
   after merge. Reviewers should read that block carefully.
4. The AppImage `LD_LIBRARY_PATH` self-re-exec theory remains an open follow-up, with
   the `ldd` diagnostic request to the reporter as the next concrete action.

---

## Risks & notes

- **`tauri::async_runtime::block_on` from inside a Tokio worker thread would panic**
  ("cannot block the current thread from within a runtime"). Not reachable for
  GitWand: the only live call site is the plugin's `RunEvent::Exit` handler, which
  runs on the event-loop/main thread. The plugin's *other* `flush_blocking()` caller
  is its optional panic hook (fork `src/lib.rs:83`), and GitWand never installs one
  (`lib.rs:324` builds the plugin with no `with_panic_hook`). Worth knowing if a
  panic hook is ever added.
- **`futures` becomes an unused dependency in the fork** after this change (it was
  the only usage). Leave `futures = "0.3.31"` in the fork's `Cargo.toml`:
  `unused_crate_dependencies` is off by default, so there is no warning, and removing
  it would widen a deliberately one-line audited patch.
- **Component 2 could regress rendering for users who have working GPU acceleration**
  — `LIBGL_ALWAYS_SOFTWARE=1` forces software rasterization on *all* Linux users, not
  just broken ones. This is the design's accepted trade-off (correctness of startup
  over rendering speed, consistent with the already-unconditional
  `WEBKIT_DISABLE_COMPOSITING_MODE`), and the `is_err()` guard leaves an escape hatch:
  a user can export `LIBGL_ALWAYS_SOFTWARE=0` to opt out. Do not silently upgrade
  this to conditional detection — that would be a new design.
- **Step 4 is the only external dependency** and it sits outside GitWand's PR flow.
  Everything else in this plan is self-contained in this repo.
