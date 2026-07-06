# Telemetry Provider Migration (Umami → Aptabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Umami launch-telemetry ping with an equivalent anonymous launch event sent through the official `tauri-plugin-aptabase`, preserving the existing GDPR-compliant `install_id` mechanism.

**Architecture:** The anonymous "launch" ping today lives entirely in the Rust backend (`apps/desktop/src-tauri/src/lib.rs`), fired from a detached thread inside `.setup()` and gated on `#[cfg(not(debug_assertions))]`. We keep the exact same semantics — one anonymous ping per launch, release-only, fire-and-forget — but swap the transport: register `tauri_plugin_aptabase` on the Tauri builder and call `app.track_event("launch", …)` via the plugin's `EventTracker` trait instead of a raw `ureq` POST. The `install_id` file logic (random UUID v4 at `{data_local_dir}/gitwand/install_id`) is unchanged and passed as a custom event property; app version and system locale are dropped from our payload because the Aptabase plugin captures them automatically.

**Tech Stack:** Rust, Tauri 2, `tauri-plugin-aptabase` 1.0.0 (crate `tauri-plugin-aptabase`, official repo `github.com/aptabase/tauri-plugin-aptabase`, MIT, edition 2021, MSRV 1.70).

## Global Constraints

- **Versions are never hand-edited.** Do NOT touch `Cargo.toml` `version`, `package.json` versions, or `tauri.conf.json` version. Adding a `[dependencies]` line is allowed; changing the package `version` field is not.
- **`[[example]]` not `[[bin]]`** for secondary binaries — not relevant here (Aptabase is a normal plugin dep), but do not introduce any `[[bin]]`.
- **No shell string interpolation, `safe_repo_path()` untouched** — this task adds no filesystem-on-user-path or git-subprocess code, so those rules are automatically satisfied; do not regress them.
- **Never log secrets** — the Aptabase App Key is a public identifier (see "Open decisions"), not a secret; the anonymous `install_id` is not personal data. No secret handling changes.
- **Telemetry stays release-only:** every new telemetry line must remain under `#[cfg(not(debug_assertions))]`. Debug builds must send nothing.
- **No opt-out toggle** — do NOT add anything to `useSettings.ts` / `SettingsPanel.vue`. This is a backend transport swap, not a new feature.
- **Do NOT touch** `website/changelog.md`, `roadmap.md`, or any version file — those are handled by the `/release` flow at tag time. Only the root `CHANGELOG.md` `[Unreleased]` section is edited here.
- **New Cargo dep must be justified with measured impact** (`apps/desktop/CLAUDE.md` build rule) — this plan includes an explicit compile-time + binary-size measurement step because `tauri-plugin-aptabase` pulls in `reqwest` and `tokio` transitively.

---

## Research Findings (verified, do not re-derive)

These were verified during planning against the live crate registry and the plugin repo. The executor can trust them.

1. **Crate:** `tauri-plugin-aptabase = "1.0.0"` is the current release (published 2025-03-27, MIT, edition 2021, `rust_version = 1.70`). Repo: `https://github.com/aptabase/tauri-plugin-aptabase`. It is Tauri v2 compatible (depends on `tauri ^2.2.5`).
2. **Registration API:** `tauri_plugin_aptabase::Builder::new("<APP_KEY>").build()` returns a plugin to pass to `.plugin(...)`. (`tauri_plugin_aptabase::init("<key>".into())` is an equivalent shorthand; use the `Builder` form to match the other plugins' style in `lib.rs`.)
3. **Tracking API:** import the trait `tauri_plugin_aptabase::EventTracker`; then `App`, `AppHandle`, and `Window` gain `track_event(&self, name: &str, props: Option<serde_json::Value>)`. Custom property values may only be strings or numbers. Tracking is non-blocking / runs in background — no manual thread needed. There is also `flush_events_blocking()` on the handle (used in Exit handlers); we do not need it for a launch ping.
4. **Auto-captured properties:** the plugin automatically enriches every event with OS, **app version**, and **locale**, plus other system properties. Therefore our payload no longer needs to send `version` or `language` — only `install_id` as a custom property.
5. **App Key format & visibility:** keys look like `A-EU-xxxxxxxxxx` (EU) or `A-US-xxxxxxxxxx` (US). The README/llms.txt document embedding the key inline as a compile-time string constant (or via `dotenv!`), i.e. it is treated as a public client identifier, exactly like the old Umami website ID. See "Open decisions" for where the executor gets the actual key.
6. **Transitive deps added:** `reqwest ^0.12`, `tokio ^1.43`, `os_info`, `time`, `rand`, `futures`, `log`, plus `serde`/`serde_json`/`sys-locale` (already in tree). `reqwest` + `tokio` are the material additions — hence the measurement step (Task 5). The plugin crate itself is tiny (~10 KB, 449 LOC).
7. **`ureq` is used in exactly one place** — the Umami POST at `apps/desktop/src-tauri/src/lib.rs:308`. The only other match, `apps/desktop/src-tauri/src/commands/network.rs:8`, is a **comment** ("we deliberately do NOT add an HTTP client … no `reqwest`, `ureq`"). So `ureq` can be fully removed from `Cargo.toml` after this migration. NOTE: that comment in `network.rs` becomes slightly stale (an HTTP client now exists transitively via the plugin), but `network.rs` itself still adds no direct HTTP dep — leave the comment as-is; optionally the executor may append a one-line clarification (see Task 4, optional sub-step).
8. **`uuid` (v4)** is used only by `get_or_create_install_id` (`lib.rs:256`); the `bitbucket.rs:1112` match is a JSON field-name string, not the crate. `uuid` stays — we keep our own persistent install ID.
9. **`sys-locale`** is used only by the telemetry block (`lib.rs:306`). After migration the plugin captures locale automatically, so `sys-locale` as a **direct** dep is removable. (It remains in the tree transitively via the plugin, which is fine.)
10. **ACL permission:** `aptabase:allow-track-event` is only required for the **JavaScript** guest binding (`@aptabase/tauri`), which calls the Rust backend over IPC. We track from Rust only, so it is NOT required. Do not add the npm package and do not add the ACL entry unless a future frontend-tracking need arises. (Documented in Task 2 as explicitly skipped.)
11. **Latent bug (context):** `#[cfg_attr(mobile, tauri::mobile_entry_point)]` at `lib.rs:237` is attached to `get_or_create_install_id()` instead of `pub fn run()` (mis-moved in commit `0e02f83`). Harmless on desktop, would break a future mobile build. Task 3 fixes it as a trivial, zero-risk move since we are already rewriting these exact lines.

## Current Code Map (verified line references)

- `apps/desktop/src-tauri/src/lib.rs:237` — `#[cfg_attr(mobile, tauri::mobile_entry_point)]` (misplaced, above `get_or_create_install_id`).
- `apps/desktop/src-tauri/src/lib.rs:238-262` — `#[cfg(not(debug_assertions))] fn get_or_create_install_id() -> String`.
- `apps/desktop/src-tauri/src/lib.rs:264` — `pub fn run()`.
- `apps/desktop/src-tauri/src/lib.rs:274-281` — `tauri::Builder::default().plugin(...)` chain.
- `apps/desktop/src-tauri/src/lib.rs:282` — `.setup(|app| {`.
- `apps/desktop/src-tauri/src/lib.rs:300-324` — Umami comment + `std::thread::spawn` + `ureq::post(...)` block.
- `apps/desktop/src-tauri/Cargo.toml:79-88` — comment + `ureq`, `uuid`, `sys-locale` deps.
- `apps/desktop/src-tauri/src/main.rs` — minimal, calls `gitwand_desktop_lib::run()`; NOT modified.
- `apps/desktop/src-tauri/src/CLAUDE.md` — subdir doc; NOT part of build, optional doc-accuracy note (Task 6).
- `CHANGELOG.md` (repo root) — `[Unreleased]` section at line 8.

## File Structure

- **Modify:** `apps/desktop/src-tauri/Cargo.toml` — add `tauri-plugin-aptabase`, remove `ureq` and `sys-locale` direct deps (keep `uuid`).
- **Modify:** `apps/desktop/src-tauri/src/lib.rs` — register the plugin, replace the telemetry block, fix the `mobile_entry_point` attribute placement.
- **Modify:** `CHANGELOG.md` (repo root) — one `[Unreleased]` entry.
- **Modify (optional, doc only):** `apps/desktop/src-tauri/CLAUDE.md` — line ~142 ("Pas de dépendances HTTP/async") becomes stale.

No new files. No frontend files. No capabilities/ACL changes.

---

### Task 1: Add the Aptabase dependency and remove dead HTTP/locale deps in Cargo.toml

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml:79-88`

**Interfaces:**
- Consumes: nothing.
- Produces: makes `tauri_plugin_aptabase::{Builder, EventTracker}` available to `lib.rs` (Task 2/3); removes `ureq::` and `sys_locale::` availability (Task 3 must not reference them).

- [ ] **Step 1: Edit the dependency block**

Replace the block currently at `apps/desktop/src-tauri/Cargo.toml:79-88`:

```toml
# Lightweight blocking HTTP client for the anonymous launch-count ping.
# No async/tokio dependency — runs in a detached thread. Only used in
# release builds (cfg(not(debug_assertions))).
ureq = { version = "2", default-features = false, features = ["tls", "json"] }

# Anonymous install ID generation (v4 random UUID, stored on first launch).
uuid = { version = "1", features = ["v4"] }

# Cross-platform system locale detection (macOS / Linux / Windows).
sys-locale = "0.3"
```

with:

```toml
# Anonymous launch telemetry via Aptabase (privacy-first analytics for
# desktop/Tauri apps). Replaced the previous Umami ping: Umami Cloud
# filters non-browser User-Agents and silently dropped every event
# (HTTP 200 + `{"beep":"boop"}` decoy, nothing recorded). Aptabase
# authenticates by App Key, so there is no UA/bot filtering. Only used in
# release builds (cfg(not(debug_assertions))). Pulls in reqwest + tokio
# transitively — see Task 5 measurement note in the migration plan.
tauri-plugin-aptabase = "1.0.0"

# Anonymous install ID generation (v4 random UUID, stored on first launch).
uuid = { version = "1", features = ["v4"] }
```

Note: `ureq` and the `sys-locale` **direct** dep are removed. `sys-locale` still resolves transitively via `tauri-plugin-aptabase` — that is expected and requires no action.

- [ ] **Step 2: Verify the manifest parses and resolves**

Run: `cd apps/desktop/src-tauri && cargo metadata --no-deps --format-version 1 >/dev/null && cargo tree -i ureq 2>&1 | head -5`
Expected: `cargo metadata` succeeds (exit 0). `cargo tree -i ureq` prints `error: package ID specification 'ureq' did not match any packages` (or "nothing depends on it") — confirming `ureq` is gone from the tree.

- [ ] **Step 3: Confirm the version field was not touched**

Run: `cd apps/desktop/src-tauri && git diff Cargo.toml | grep -E '^[-+]version'`
Expected: NO output (the `version = "3.2.0"` line at `Cargo.toml:3` was not modified).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml
git commit -m "chore(desktop): swap ureq/sys-locale for tauri-plugin-aptabase dep"
```

---

### Task 2: Register the Aptabase plugin on the Tauri builder

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:274-281` (the `.plugin(...)` chain)

**Interfaces:**
- Consumes: `tauri-plugin-aptabase` from Task 1.
- Produces: an initialized Aptabase plugin instance on the running app, so `app.track_event(...)` in Task 3 has a live client. Introduces the module-level constant `APTABASE_APP_KEY`.

- [ ] **Step 1: Add the App Key constant near the entry-point section**

Insert this constant immediately above the `#[cfg_attr(mobile, ...)]`/`get_or_create_install_id` block (i.e. just after the `// ─── Tauri entry point ───` divider around `lib.rs:235`):

```rust
/// Aptabase App Key for anonymous launch telemetry. This is a public client
/// identifier (format `A-EU-*` / `A-US-*`), not a secret — same trust model
/// as the previous public Umami website ID. Only used in release builds.
#[cfg(not(debug_assertions))]
const APTABASE_APP_KEY: &str = "A-EU-REPLACE_WITH_REAL_KEY";
```

> The executor MUST replace `A-EU-REPLACE_WITH_REAL_KEY` with the real key from the Aptabase dashboard before release. See "Open decisions". A build with the placeholder compiles and runs fine (events just go to an invalid app id), so this does not block earlier verification steps.

- [ ] **Step 2: Register the plugin in the builder chain (release only)**

In the `.plugin(...)` chain at `lib.rs:274-281`, add the Aptabase plugin after the existing plugins. Because the constant is `#[cfg(not(debug_assertions))]`, the registration line must be gated the same way. Change the tail of the chain from:

```rust
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
```

to:

```rust
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    // Anonymous launch telemetry (release builds only). Registered
    // conditionally because APTABASE_APP_KEY is compiled out in debug.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_aptabase::Builder::new(APTABASE_APP_KEY).build());

    builder
        .setup(|app| {
```

To make that compile, the chain head at `lib.rs:274` must bind to a `let builder`. Change:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
```

to:

```rust
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
```

(Rationale: `tauri::Builder` methods consume and return `self`, so conditionally chaining requires rebinding `builder` under `#[cfg]`. This is the standard Tauri pattern for release-only plugins.)

- [ ] **Step 3: Confirm we did NOT add the JS binding or ACL entry**

Run: `cd apps/desktop && grep -R "aptabase" package.json src-tauri/capabilities/ 2>/dev/null; echo "exit:$?"`
Expected: no `aptabase` matches (grep exits non-zero / prints nothing). We track from Rust only; `@aptabase/tauri` and `aptabase:allow-track-event` are intentionally omitted.

- [ ] **Step 4: Type-check the crate (will still reference old telemetry block — expect the OLD block's errors only if any; plugin registration itself must be sound)**

Run: `cd apps/desktop/src-tauri && cargo check --release 2>&1 | tail -20`
Expected: compiles. (At this point the old `ureq`/`sys_locale` telemetry block at `lib.rs:300-324` still exists and now FAILS to compile because Task 1 removed `ureq`/`sys-locale`. That is expected — Task 2 and Task 3 land together in the same working session; do not commit Task 2 alone in a broken state.) If splitting commits is desired, the executor should perform Task 2 and Task 3 edits before running any `cargo check` and before committing. Treat Task 2 + Task 3 as a single compile/commit unit.

> Handoff note: Tasks 2 and 3 form one atomic compile unit (removing `ureq` in Task 1 breaks the old block until Task 3 replaces it). Do the Task 3 edits, then run checks, then commit once (commit lives in Task 3).

---

### Task 3: Replace the telemetry block and fix the mobile_entry_point attribute

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:237` (attribute placement)
- Modify: `apps/desktop/src-tauri/src/lib.rs:300-324` (telemetry block inside `.setup()`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:264` (add attribute to `run()`)

**Interfaces:**
- Consumes: registered Aptabase plugin (Task 2), `get_or_create_install_id()` (unchanged), `tauri_plugin_aptabase::EventTracker` trait (Task 1 dep).
- Produces: a single anonymous "launch" event per release launch carrying `{ "install_id": <uuid> }`.

- [ ] **Step 1: Add the `EventTracker` trait import**

At the top of `lib.rs`, with the other `use` statements, add (gated so debug builds don't warn about an unused import):

```rust
#[cfg(not(debug_assertions))]
use tauri_plugin_aptabase::EventTracker;
```

- [ ] **Step 2: Move the `mobile_entry_point` attribute off `get_or_create_install_id`**

At `lib.rs:237-243`, the block currently reads:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(not(debug_assertions))]
/// Returns the anonymous install ID, creating it on first launch.
///
/// Stored at `{data_local_dir}/gitwand/install_id` as a plain UUID v4.
/// Random, not derived from hardware — not personal data under GDPR.
fn get_or_create_install_id() -> String {
```

Remove the misplaced attribute line so it becomes:

```rust
#[cfg(not(debug_assertions))]
/// Returns the anonymous install ID, creating it on first launch.
///
/// Stored at `{data_local_dir}/gitwand/install_id` as a plain UUID v4.
/// Random, not derived from hardware — not personal data under GDPR.
fn get_or_create_install_id() -> String {
```

- [ ] **Step 3: Attach `mobile_entry_point` to `run()` where it belongs**

At `lib.rs:264`, change:

```rust
pub fn run() {
```

to:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
```

- [ ] **Step 4: Replace the Umami telemetry block inside `.setup()`**

At `lib.rs:300-324`, replace the entire Umami comment + `std::thread::spawn` block:

```rust
            // Anonymous launch telemetry via Umami — fire-and-forget POST.
            // No personal data: UUID is random (not hardware-derived), IP is
            // anonymised server-side by Umami. Skipped in debug builds.
            #[cfg(not(debug_assertions))]
            std::thread::spawn(|| {
                let install_id = get_or_create_install_id();
                let language = sys_locale::get_locale().unwrap_or_else(|| "en".to_string());
                let version = env!("CARGO_PKG_VERSION");
                let _ = ureq::post("https://cloud.umami.is/api/send")
                    .set("Content-Type", "application/json")
                    .send_json(serde_json::json!({
                        "payload": {
                            "website": "171a9307-29ca-4524-8772-6187daacd9ca",
                            "hostname": "app.gitwand.devlint.fr",
                            "url": "/launch",
                            "language": language,
                            "name": "launch",
                            "data": {
                                "version": version,
                                "install_id": install_id
                            }
                        },
                        "type": "event"
                    }));
            });
```

with:

```rust
            // Anonymous launch telemetry via Aptabase — fire-and-forget.
            // Replaced Umami: Umami Cloud filters non-browser User-Agents and
            // silently dropped every event (HTTP 200 + `{"beep":"boop"}` decoy,
            // nothing recorded), and spoofing a browser UA to bypass it was
            // rejected as fragile / against Umami's ToS. Aptabase authenticates
            // by App Key, so there is no UA/bot filtering. No personal data:
            // install_id is a random UUID (not hardware-derived). The plugin
            // auto-captures OS, app version and locale, so only install_id is
            // sent as a custom property. track_event runs in the background.
            // Skipped in debug builds.
            #[cfg(not(debug_assertions))]
            {
                let install_id = get_or_create_install_id();
                app.track_event(
                    "launch",
                    Some(serde_json::json!({ "install_id": install_id })),
                );
            }
```

Notes for the executor:
- `app` is the `&mut App` bound by `.setup(|app| { ... })`; `track_event` comes from the `EventTracker` trait imported in Step 1.
- Do NOT wrap this in `std::thread::spawn` — the plugin already dispatches non-blockingly. The old thread was needed only because `ureq` is synchronous.
- Property value is a string (`install_id`), which satisfies Aptabase's "strings and numbers only" rule.

- [ ] **Step 5: Build the whole crate in release mode**

Run: `cd apps/desktop/src-tauri && cargo check --release 2>&1 | tail -25`
Expected: compiles with no errors and no `unused import` / `unused variable` warnings for the telemetry path. If a warning about `get_or_create_install_id` being unused appears, it means the `#[cfg(not(debug_assertions))]` gating diverged — recheck that both the function and its single caller share the same cfg.

- [ ] **Step 6: Sanity-check debug build compiles telemetry OUT**

Run: `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -25`
Expected: compiles cleanly with no warnings. In debug, `APTABASE_APP_KEY`, `get_or_create_install_id`, the plugin registration, the `EventTracker` import, and the `track_event` call are ALL compiled out. If the compiler complains about an unused `builder` binding or an unused import in debug, the cfg gating from Task 2/Step-1-here is wrong — fix until debug is warning-free.

- [ ] **Step 7: Grep to confirm all Umami/ureq/sys_locale traces are gone from source**

Run: `cd apps/desktop/src-tauri && grep -RnE "umami|cloud\.umami|ureq::|sys_locale::|app\.gitwand\.devlint\.fr|171a9307" src/`
Expected: no matches (exit non-zero). The only remaining `ureq` reference anywhere is the descriptive comment in `src/commands/network.rs:8`, which is acceptable (see Task 4).

- [ ] **Step 8: Commit (covers Task 2 + Task 3)**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): send anonymous launch telemetry via Aptabase instead of Umami"
```

---

### Task 4: Confirm the `network.rs` comment and no stray references

**Files:**
- Inspect only: `apps/desktop/src-tauri/src/commands/network.rs:1-24`
- Optional modify: `apps/desktop/src-tauri/src/commands/network.rs:6-9`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (verification/optional-doc task).

- [ ] **Step 1: Re-read the comment context**

Run: `cd apps/desktop/src-tauri && sed -n '6,9p' src/commands/network.rs`
Expected: shows the comment `//! We deliberately do NOT add an HTTP client dependency (no reqwest, // ureq, etc.)`.

- [ ] **Step 2 (OPTIONAL, low value — skip unless the reviewer asks):** append a one-line clarification so the comment isn't misleading now that the Aptabase plugin brings `reqwest`/`tokio` into the tree. If done, change the comment at `network.rs:7-9` to add:

```rust
//! (This module still adds no direct HTTP dependency; an HTTP client only
//! exists transitively via the Aptabase telemetry plugin.)
```

If skipped, no action. Do NOT change any code in this file.

- [ ] **Step 3: If Step 2 was done, commit**

```bash
git add apps/desktop/src-tauri/src/commands/network.rs
git commit -m "docs(desktop): clarify network.rs no-HTTP-dep note post-Aptabase"
```

---

### Task 5: Measure the dependency's build/binary impact (perf invariant)

`apps/desktop/CLAUDE.md` requires measuring compile-time and binary-size impact for any new Cargo dep. `tauri-plugin-aptabase` pulls in `reqwest` + `tokio`, so this is non-trivial and must be recorded in the PR description.

**Files:**
- No files modified. Produces numbers for the PR description.

**Interfaces:**
- Consumes: the built crate from Task 3.
- Produces: before/after `cargo build --release` wall-time and `target/release` binary size, to paste into the PR.

- [ ] **Step 1: Full release build, timed**

Run: `cd apps/desktop/src-tauri && cargo build --release 2>&1 | tail -3 && echo "--- built ---"`
Expected: `Finished release [optimized] target(s) in <N>s`. Record `<N>`.

- [ ] **Step 2: Record the release binary size**

Run: `cd apps/desktop/src-tauri && du -h target/release/gitwand-desktop 2>/dev/null || du -h target/release/gitwand_desktop* 2>/dev/null | head`
Expected: a size figure (the lib/app binary). Record it.

- [ ] **Step 3: Note the transitive additions for the PR**

No command. In the PR description, state: "Adds `tauri-plugin-aptabase` (+ transitive `reqwest 0.12`, `tokio 1.x`, `os_info`, `time`, `rand`). Removed direct `ureq` and `sys-locale`. Net binary delta: `<from Step 2 vs a baseline build of main>`; release build time delta: `<Step 1 vs baseline>`." If a baseline (main branch) build number isn't already known, run the same two commands on a clean `main` checkout/worktree to get the before figures. This is reporting only — no code change, no commit.

---

### Task 6: Update the root CHANGELOG and (optional) subdir doc note

**Files:**
- Modify: `CHANGELOG.md` (repo root), `[Unreleased]` section (currently starts at line 8, has a `### Fixed` subsection).
- Optional modify: `apps/desktop/src-tauri/CLAUDE.md:142`

**Interfaces:**
- Consumes: nothing.
- Produces: release-history entry. (Do NOT touch `website/changelog.md`, `roadmap.md`, or version files.)

- [ ] **Step 1: Add a `### Changed` entry under `[Unreleased]`**

In `CHANGELOG.md`, under `## [Unreleased]`, add a `### Changed` subsection (place it before the existing `### Fixed` per Keep a Changelog ordering: Added, Changed, Deprecated, Removed, Fixed, Security):

```markdown
### Changed

- **Anonymous launch telemetry moved from Umami to Aptabase** — Umami Cloud silently dropped every launch ping (it filters non-browser User-Agents, replying HTTP 200 with a `{"beep":"boop"}` decoy and recording nothing). GitWand now sends the same anonymous, release-only "launch" event through Aptabase (App-Key authenticated, no UA/bot filtering). The GDPR-safe random `install_id` is unchanged; app version and locale are captured automatically by the Aptabase plugin. Dropped the direct `ureq` and `sys-locale` Rust dependencies.
```

- [ ] **Step 2: Verify no forbidden files were touched**

Run: `git status --porcelain | grep -E 'website/changelog|roadmap|package\.json|Cargo\.toml.*version|tauri\.conf\.json'`
Expected: no output (none of those files are staged/modified beyond the allowed `Cargo.toml` dependency edit from Task 1 — and that edit did not touch the `version` field, confirmed in Task 1/Step 3).

- [ ] **Step 3 (OPTIONAL): correct the stale doc line in the subdir CLAUDE.md**

`apps/desktop/src-tauri/CLAUDE.md:142` currently reads "Pas de dépendances HTTP/async — Tauri gère la fenêtre, git est synchrone", which is no longer accurate (Aptabase brings reqwest+tokio). If updating, change it to:

```markdown
- Une seule dépendance HTTP/async : `reqwest` + `tokio`, tirés transitivement par `tauri-plugin-aptabase` (télémétrie de lancement anonyme, release-only). Le reste du backend reste synchrone.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md apps/desktop/src-tauri/CLAUDE.md
git commit -m "docs: changelog + note Aptabase telemetry migration"
```

---

### Task 7: End-to-end verification

**Files:** none modified.

- [ ] **Step 1: Release build is green**

Run: `cd apps/desktop/src-tauri && cargo build --release 2>&1 | tail -3`
Expected: `Finished release`.

- [ ] **Step 2: Debug build is green and telemetry-free**

Run: `cd apps/desktop/src-tauri && cargo build 2>&1 | tail -3 && grep -RnE "umami|ureq::|sys_locale::" src/ ; echo "grep_exit:$?"`
Expected: `Finished dev`; `grep_exit:1` (no matches in `src/` except the acceptable comment in `network.rs` which does not match `ureq::` — it's `ureq,` in prose).

- [ ] **Step 3: Confirm event semantics by reading the final code**

Run: `cd apps/desktop/src-tauri && grep -n "track_event\|APTABASE_APP_KEY\|Builder::new(APTABASE" src/lib.rs`
Expected: exactly one `track_event("launch", …)` call, one `APTABASE_APP_KEY` const, one `Builder::new(APTABASE_APP_KEY)` registration — all inside `#[cfg(not(debug_assertions))]` regions.

- [ ] **Step 4: Manual runtime check (optional, requires the real App Key)**

With `APTABASE_APP_KEY` set to the real key, run a release build (`cd apps/desktop && pnpm tauri build`) and launch the app once; confirm one "launch" event appears in the Aptabase dashboard within a few minutes. If still on the placeholder key, skip — code-level verification (Steps 1-3) is sufficient for merge; the dashboard check is a pre-release gate.

---

## Self-Review

**Spec coverage:**
- Keep same functional event (anonymous "launch", once/launch, release-only, fire-and-forget) → Task 3 Step 4 (single `track_event` under `#[cfg(not(debug_assertions))]`, no thread). ✔
- Keep `install_id` (random UUID v4, `{data_local_dir}/gitwand/install_id`) → `get_or_create_install_id` unchanged; only its stray attribute removed. ✔
- Keep same data in spirit (version, locale, install_id) → install_id sent explicitly; version + locale now auto-captured by plugin (Research #4), documented in code comment + changelog. ✔
- Remove all Umami-specific code + `ureq` if unused elsewhere → Task 1 (dep) + Task 3 (code) + Task 3 Step 7 grep + verified `ureq` used only in the Umami POST (Research #7). ✔
- Use `tauri-plugin-aptabase`, verified exact crate/API → Research #1-#6, Task 2/3. ✔
- Note user must create Aptabase app + provide key; key is public-ish constant → "Open decisions" + Task 2 Step 1 + Research #5. ✔
- No opt-out toggle in Settings → Global Constraints; no frontend files touched. ✔
- Update the comment explaining the service choice / why Umami dropped → Task 3 Step 4 comment (concise, factual). ✔
- Add `CHANGELOG.md` `[Unreleased]` entry; do NOT touch website changelog/roadmap/version files → Task 6 + Task 6 Step 2 guard. ✔
- Respect perf invariant (measure new Cargo dep) + declare plugin correctly (normal plugin, no `[[bin]]`) → Task 5 + Task 2. ✔
- Register plugin in `tauri::Builder` like other plugins → Task 2 Step 2. ✔
- Latent `mobile_entry_point` bug: fix since we touch these lines → Task 3 Steps 2-3. ✔

**Placeholder scan:** The only intentional placeholder is `A-EU-REPLACE_WITH_REAL_KEY`, explicitly flagged as an executor action and an "Open decision" (the real value is external/human-supplied, not derivable in-plan). No "TBD"/"handle edge cases"/"similar to Task N" placeholders.

**Type consistency:** `track_event(name: &str, props: Option<serde_json::Value>)`, `Builder::new(&str).build()`, `EventTracker` trait, `APTABASE_APP_KEY: &str` — used identically everywhere referenced.
