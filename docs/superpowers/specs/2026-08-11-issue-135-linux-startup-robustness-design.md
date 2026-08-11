# Issue #135 — Linux startup robustness (design)

## Context

Issue #135 ("GitWand starts and displays a blank window only!") was reported fixed in
v3.6.1 via commit `3c88519` ("fix: force WebKitGTK software rendering fallback on
Linux (#135, #139) (#143)"), which sets `WEBKIT_DISABLE_COMPOSITING_MODE` and
`WEBKIT_DISABLE_DMABUF_RENDERER` before the webview is created. The original reporter
(Ubuntu 26.04, amd64) confirmed the fix worked.

A second report on the same issue (Fedora 44, Gnome, AppImage —
[comment](https://github.com/devlint/GitWand/issues/135#issuecomment-5251070396))
shows the *identical* crash, unchanged by the v3.6.1 fix:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...

thread 'main' panicked at .../core/src/ops/function.rs:250:5:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
```

Investigation (see repo-exploration notes from this design session) established that
this single-looking crash report is actually **two independent bugs** that happen to
co-occur:

1. **The Tokio panic is not Linux-specific at all.** GitWand's telemetry plugin
   (`tauri-plugin-aptabase`, patched via a fork pinned in
   `apps/desktop/src-tauri/Cargo.toml`'s `[patch.crates-io]`) enqueues a `"launch"`
   event synchronously during `.setup()` (`lib.rs:355-361`). The fork's
   `start_polling()` was already patched to use `tauri::async_runtime::spawn` (safe
   from any thread), but a sibling method, `flush_blocking()`
   (`client.rs:142-147`), was missed:
   ```rust
   pub fn flush_blocking(&self) {
       futures::executor::block_on(async { self.flush().await; });
   }
   ```
   This runs on the main/event-loop thread from the plugin's `RunEvent::Exit`
   handler, unconditionally, on **any** process exit. `futures::executor::block_on`
   provides no Tokio reactor context, so if the queued `"launch"` event hasn't been
   flushed yet by the 60s background poll (`config.rs:19-20`'s default interval) —
   guaranteed true if the process exits within 60s of launch, for *any* reason — the
   real `reqwest` call inside `flush()` panics with exactly the reported message.
   This can happen on macOS/Windows too, any time the app exits quickly after launch;
   it's just reliably exposed on Linux because EGL failures cause near-instant exits.

2. **The EGL abort itself may be under-covered by the v3.6.1 fix.**
   `WEBKIT_DISABLE_COMPOSITING_MODE`/`WEBKIT_DISABLE_DMABUF_RENDERER` steer
   WebKitGTK's *compositing* subsystem — they don't affect the earlier step of
   acquiring an EGL *display* (`eglGetPlatformDisplay`/`eglInitialize`), which is
   where a native-Wayland/Gnome-specific EGL_BAD_PARAMETER can originate before
   compositing is ever reached. This is consistent with the fix working for the
   Ubuntu reporter (presumably a compositing-path failure) but not the Fedora/Gnome
   reporter (presumably an EGL-display-acquisition failure).

   A third, separate contributing theory — AppImage's `AppRun` wrapper rewrites
   `LD_LIBRARY_PATH` and related search-path variables process-wide before exec'ing
   the real binary (documented in `git/cmd.rs:119-172` for issue #48/#52, but only
   corrected there for *spawned subprocesses*, never for GitWand's own process) — is
   plausible but **unconfirmed**: fixing it properly requires a self-re-exec early in
   `main()` (env-var pollution from `AppRun` is baked into dynamic-linker resolution
   at process load time, before any Rust code runs, so an in-process `set_var` can't
   retroactively fix already-loaded libraries). This is out of scope for this design
   — see Follow-up.

## Scope

This design fixes the two confirmed, low-risk issues:

1. The telemetry flush-on-exit panic (cross-platform bug, real root cause identified).
2. Broadens the Linux render-fallback env vars to also cover the EGL-display class,
   not just compositing.

Out of scope (documented as follow-up, not designed or implemented here):
the AppImage self-re-exec fix for GitWand's own process's library resolution.

## Component 1 — Fix the telemetry flush-on-exit panic

**Where:** the vendored fork `devlint/tauri-plugin-aptabase` (pinned via
`apps/desktop/src-tauri/Cargo.toml`'s `[patch.crates-io]`, currently at rev
`a868ab1db74b6ae6616389022680881a2c352e1c`) — not GitWand's own source tree.

**Change:** in `client.rs`, `flush_blocking()`:

```rust
// before
pub fn flush_blocking(&self) {
    futures::executor::block_on(async { self.flush().await; });
}

// after
pub fn flush_blocking(&self) {
    tauri::async_runtime::block_on(async { self.flush().await; });
}
```

`tauri::async_runtime::block_on` lazily enters Tauri's own global multi-thread Tokio
runtime (`RUNTIME.get_or_init(default_runtime)`) — the same mechanism that already
makes `start_polling()` safe from any calling thread. This is a one-line change,
mirroring a fix already proven correct elsewhere in the same file.

**Steps:**
1. Commit the fix to the `devlint/tauri-plugin-aptabase` fork.
2. Bump the `rev` in `apps/desktop/src-tauri/Cargo.toml`'s `[patch.crates-io]` entry
   to the new commit, and update the comment block above it (it currently references
   only the `start_polling` fix — extend it to note `flush_blocking` was the
   remaining unpatched call site).
3. `cargo build` (or `cargo check`) picks up the new pinned rev automatically since
   the `rev` value itself changed; confirm `Cargo.lock`'s entry for
   `tauri-plugin-aptabase` updated to the new commit hash.

**Error handling:** none needed — this removes the panic at its source rather than
catching or suppressing it.

**Testing:** this path only exists at process-exit time inside a running Tauri app,
which isn't practically unit-testable. Verification is manual: launch a debug build,
quit within a few seconds (before the 60s poll would have flushed the queue), confirm
no panic appears in the terminal. This will be called out explicitly as a manual
verification step in the PR, not silently skipped.

## Component 2 — Broaden the Linux render-fallback env vars

**Where:** `apps/desktop/src-tauri/src/lib.rs`, next to the existing
`#[cfg(target_os = "linux")]` block (~line 284-301).

**Change:**

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

**Error handling:** none — this is a preventive env-var setting, not a
recoverable-error code path (WebKitGTK/EGL failures currently abort the process
before any Rust-level error handling could intervene).

**Testing:** no automated test is feasible (no Linux GPU/EGL harness in CI, and this
sandboxed dev environment can't reproduce a native EGL failure). The PR will state
plainly that this is unverified against the specific Fedora/Gnome/AppImage
combination, and ask for a report-back from affected users — the same pattern that
confirmed the original v3.6.1 fix worked for the first reporter.

## Follow-up (not in this design)

- Ask the Fedora reporter (or future similar reports) to run something like
  `ldd <extracted-appimage-binary> | grep -iE "webkit|egl|gtk|mesa"` to confirm
  whether their AppImage run is resolving GTK/WebKit/EGL/Mesa against the bundle's
  own libraries vs. the host's. This data point would confirm or rule out the
  AppImage-`LD_LIBRARY_PATH`-pollution theory before investing in a self-re-exec fix.
- If confirmed, a future design would cover: detecting AppImage-injected
  `LD_LIBRARY_PATH` pollution early in `main()` (reusing the existing
  `APPIMAGE_POLLUTED_VARS` logic from `git/cmd.rs`, currently only applied to spawned
  subprocesses) and self-`exec`'ing the process once with a corrected environment
  before any GTK/WebKit code runs. This is meaningfully riskier than Component 1/2 —
  a wrong re-exec could turn "sometimes fails on some distros" into "never starts on
  Linux" — and deserves its own design, testing plan, and probably a beta-channel
  rollout before shipping broadly.

## CHANGELOG / versioning

Both fixes land as a single `[Unreleased]` entry in `CHANGELOG.md`, referencing
#135. No version bump (handled at release time via `bump-version.sh`). The
`tauri-plugin-aptabase` fork rev bump is not itself a GitWand version change.
