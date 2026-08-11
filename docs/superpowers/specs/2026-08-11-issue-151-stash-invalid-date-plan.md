# Issue #151 — "Invalid Date" in the Stash Manager — Implementation Plan

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends with a green test run and a commit.

**Goal:** Make the stash list (and the tag list, same root cause) emit a strictly-parseable ISO 8601 `date` from the Rust backend so the UI stops rendering "Invalid Date", and lock the fix in with a Rust test, a parity assertion, and a component test.

**Architecture:** One-token fix at the source. The Rust backend asks git for a *lenient* date format (`%ai` / `%(taggerdate:iso)`), which `new Date()` is not required to parse; we switch it to git's *strict* ISO 8601 format (`%aI` / `%(taggerdate:iso-strict)`), which every JS engine parses. The Node `dev-server.mjs` equivalents are aligned onto the exact same placeholders so both backends emit byte-identical `date` strings, which lets us un-blank the field the parity harness was silently ignoring. The frontend keeps a working (rather than dead) fallback for an unparseable date.

**Tech stack:** Rust (Tauri 2 backend, `std::process::Command` + git CLI, `regex` crate in tests), Node (`dev-server.mjs`), Vue 3 `<script setup>`, Vitest (jsdom + parity config), `cargo test`.

**Branch:** `fix/151-stash-invalid-date`, created off `main` at execution time.

---

## Global Constraints

- **No version edits.** Do not touch `package.json`, `Cargo.toml`, or `tauri.conf.json` version fields. Versioning happens at release time via `./scripts/bump-version.sh X.Y.Z`.
- **No new `#[tauri::command]`** in this work → no new wrapper needed in `apps/desktop/src/utils/backend.ts`. The existing `StashEntry.date: string` (`backend.ts:2078-2084`) and `GitTag.date: string` (`backend.ts:1788-1797`) TS types already match; **do not change them**.
- **No new user-visible strings** → **no i18n work**, no locale files touched. If you find yourself wanting a "Unknown date" label, stop: the fallback is the raw string (see Task 4 rationale).
- **No settings field** added → `useSettings.ts` / `SettingsPanel.vue` untouched.
- **Real git repos in tests.** Never mock the git layer. The one place a fetch stub is allowed is the jsdom component test in Task 4, and only because it is asserting *rendering*, not git behaviour (justified inline in that task).
- **No shell string interpolation** in git commands — keep passing discrete `.args([...])` arrays.
- **`packages/core` is not involved.** Do not add anything there.
- **Rust secondary binaries stay under `[[example]]`** — this plan adds none, just don't "helpfully" restructure `Cargo.toml`.

---

## Verified root cause

Facts below were each verified by reading the code / running git 2.50.1 locally.

1. `apps/desktop/src-tauri/src/commands/ops.rs:978` runs:
   ```rust
   .args(["stash", "list", "--format=%H%x00%gd%x00%gs%x00%ai"])
   ```
   and `ops.rs:1020` stores the raw 4th field into `StashEntry.date` (struct at `apps/desktop/src-tauri/src/types.rs:295-302`) with **no reformatting**.

2. `%ai` renders `2026-08-11 09:16:44 +0200` — space instead of `T`, `+HHMM` with no colon. This shape is **not** in the ES spec's Date Time String Format, so `new Date()` behaviour is implementation-defined: V8 (Chromium/WebView2/Node) parses it via a lenient fallback parser, JavaScriptCore (macOS/Linux WKWebView, i.e. the shipped Tauri webview on those platforms) does not and yields `Invalid Date`. This is why the bug is invisible in `pnpm dev:web` (Chromium) and in Node, and why it shipped unnoticed.

3. `apps/desktop/src/components/StashManager.vue:164-176` does `new Date(dateStr).toLocaleDateString(...)` inside a `try/catch`. `new Date()` **never throws** on a bad string — it returns an `Invalid Date` object whose `toLocaleDateString()` returns the literal `"Invalid Date"`. So the existing `catch` is dead code and the intended fallback never fires. Rendered at `StashManager.vue:297` (`<span class="sm-date">{{ formatDate(stash.date) }}</span>`).

4. `apps/desktop/dev-server.mjs:2701` uses a *different* format for the same IPC command (`%ct`, a Unix timestamp) and converts it at `dev-server.mjs:2717` with `new Date(parseInt(ts, 10) * 1000).toISOString()` → real ISO 8601. So the two backends were already diverging on both the *field* (author vs committer date) and the *format*.

5. `apps/desktop/tests/parity/normalize.mjs:96-98` blanks `date` for `git-stash-list` ("`date` peut varier subtilement en format ISO selon les implémentations"), which is precisely what stopped the parity suite (`apps/desktop/tests/parity/git-stash-list.test.mjs`) from catching #4.

6. **Same bug, sibling call site:** `ops.rs:1295` (`git_list_tags`) uses `%(taggerdate:iso)` / `%(creatordate:iso)` — the same lenient shape — and `apps/desktop/src/components/TagsPanel.vue:74-84` `relativeDate()` computes `Math.floor((now - d) / 86400000)` on it. With an unparseable date that is `NaN`, every `<` comparison is false, and the function falls through to `t("date.yearsAgo", NaN)` → **"NaN years ago"**. Mirrored in `dev-server.mjs:5816`.

### Measured git behaviour (do not re-derive, but do not contradict)

```
$ git stash list --format=%ai   → 2026-08-11 09:16:44 +0200     (lenient — the bug)
$ git stash list --format=%aI   → 2026-08-11T09:16:44+02:00     (strict ISO 8601)
$ git tag -l --format='%(taggerdate:iso-strict)' → 2026-08-11T09:21:14+02:00
```

Two behaviours that matter for the tests:

- For a **UTC** commit, `%aI` emits `2024-01-01T00:00:02Z` — a bare `Z`, **not** `+00:00`. Any regex you write must accept both `Z` and `±HH:MM`.
- `%aI` renders the offset **stored in the commit object**, so its output is independent of the process `TZ` env var (verified identical under `TZ=UTC`, `TZ=America/New_York`, and unset). This is what makes the parity comparison in Task 3 deterministic.
- `git stash push` honours `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, so `apps/desktop/tests/parity/fixtures.mjs` `fixtureStash()` (which passes `commitEnv(2)` / `commitEnv(3)`) yields stash commits anchored at `2024-01-01T00:00:02Z` / `…:03Z`.

`%aI` requires git ≥ 2.2 (2014). `iso-strict` for `for-each-ref`/`tag --format` requires git ≥ 2.2 as well. Both are far below any floor GitWand could plausibly claim, and `%aI` is **already the convention elsewhere in this repo** — `ops.rs:978` is the outlier:

- `apps/desktop/src-tauri/src/commands/read.rs:809`, `:1234`, `:1252`, `:1270` all use `%aI`
- `apps/desktop/dev-server.mjs:1626`, `:2866`, `:2883`, `:2900` all use `%aI`

---

## Decisions (made — do not re-litigate)

**D1 — Fix at the Rust source with `%aI`, not with a Rust-side reformat.**
`%aI` is one token, needs no parsing/arithmetic in Rust, matches the repo's existing convention, and cannot drift from what git considers correct.

**D2 — Align `dev-server.mjs` onto `%aI` too, dropping `%ct` + `toISOString()`.**
The repo's parity rule is that a Rust command and its dev-server route produce equivalent output. `%ct`+`toISOString()` (`2024-01-01T00:00:02.000Z`) and `%aI` (`2024-01-01T00:00:02Z`) are both valid ISO 8601 but are *different strings* for the same instant, so leaving it would force the parity harness to keep tolerating a divergence — exactly the tolerance that hid this bug. Aligning also silently fixes a second latent divergence: `%ct` is the **committer** date while Rust used the **author** date. Both sides become "whatever git prints for `%aI`", which is trivially equal.

**D3 — Un-blank `date` in the parity normalizer.** Yes. After D1+D2 both sides run the *same git binary* over the *same on-disk fixture* with the *same placeholder*, and `%aI` is TZ-env-independent (measured above), so the strings are byte-identical. Keeping the blank would leave #151 un-regressable at the exact layer designed to catch it. Concretely: **delete** the `case "git-stash-list":` branch so it falls through to `default: return camel`.

**D4 — Frontend keeps a fallback, implemented as a real guard.** Replace the dead `try/catch` in `StashManager.vue:formatDate` with `Number.isNaN(d.getTime())` → return the raw string. This is not new error handling bolted onto a case that can't happen: it is repairing an existing, intended fallback that never fired. Raw string, not a new i18n label — a raw `2026-08-11T09:16:44+02:00` is strictly more useful to a bug reporter than a localized "unknown", and it adds no locale churn.

**D5 — Fix the tag/`iso-strict` sibling in the same PR (Task 5).** Same root cause, same one-token shape of fix, same webview. Shipping the stash fix while knowingly leaving "NaN years ago" in the Tags panel is worse than the marginal scope increase. It is isolated in its own task so the human checkpoint can drop it without touching Tasks 1-4. **Flagged for the human checkpoint** (see Open decisions).

---

## File structure

| File | Change |
|---|---|
| `apps/desktop/src-tauri/src/commands/ops.rs:978` | Modify — `%ai` → `%aI` |
| `apps/desktop/src-tauri/src/commands/ops.rs:1295` | Modify (Task 5) — `:iso` → `:iso-strict` ×2 |
| `apps/desktop/src-tauri/src/commands/ops.rs` (append, after the `default_branch_setting_tests` module that starts at `:4104`) | Create — new `#[cfg(test)] mod stash_and_tag_date_tests` |
| `apps/desktop/dev-server.mjs:2701`, `:2714`, `:2717` | Modify — `%ct` → `%aI`, pass the field through |
| `apps/desktop/dev-server.mjs:5816` | Modify (Task 5) — `:iso` → `:iso-strict` ×2 |
| `apps/desktop/tests/parity/normalize.mjs:96-98` | Modify — delete the `git-stash-list` blanking case |
| `apps/desktop/tests/parity/git-stash-list.test.mjs` | Modify — assert the strict-ISO shape on both sides |
| `apps/desktop/src/components/StashManager.vue:164-176` | Modify — real `NaN` guard |
| `apps/desktop/src/components/TagsPanel.vue:74-84` | Modify (Task 5) — `NaN` guard |
| `apps/desktop/src/components/__tests__/StashManager-date.test.ts` | Create — jsdom render assertion |
| `CHANGELOG.md` | Modify — `## [Unreleased]` → `### Fixed` entry |

No file in this plan is large enough to warrant splitting. `ops.rs` is 4247 lines and already hosts two `#[cfg(test)]` modules; follow that precedent rather than extracting a new test file.

---

## Task 1 — Rust: emit strict ISO 8601 from `git_stash_list`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs:978`
- Test: `apps/desktop/src-tauri/src/commands/ops.rs` (new `#[cfg(test)] mod stash_and_tag_date_tests`, appended at end of file)

**Interfaces:**
- Consumes: `commands::ops::git_stash_list(cwd: String) -> Result<Vec<StashEntry>, String>` (already exists, `ops.rs:975`); `crate::git::cmd::git_binary()`.
- Produces: `StashEntry.date` is now always either `""` or a strict ISO 8601 instant matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$`. Tasks 2-4 depend on this exact shape.

- [ ] **Step 1: Write the failing test**

Append to the end of `apps/desktop/src-tauri/src/commands/ops.rs`. The `TempRepo` helper is copied from the existing `interactive_rebase_tests` module (`ops.rs:3972-4032`) — each test module in this file owns its own copy; that is the established pattern here, do **not** refactor the existing ones into a shared helper.

```rust
/// Regression coverage for #151: `git_stash_list` used git's lenient `%ai`
/// ("2026-08-11 09:16:44 +0200"), which JavaScriptCore — the webview on the
/// macOS/Linux builds — refuses to parse, so the Stash Manager rendered
/// "Invalid Date" for every entry. The date must be strict ISO 8601 (`%aI`).
#[cfg(test)]
mod stash_and_tag_date_tests {
    use super::*;
    use crate::git::cmd::git_binary;
    use regex::Regex;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// `%aI` / `:iso-strict` emit a bare `Z` for UTC commits and `±HH:MM`
    /// otherwise — both are accepted by `new Date()` in every JS engine.
    const STRICT_ISO: &str = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$";

    struct TempRepo {
        path: PathBuf,
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    impl TempRepo {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir =
                std::env::temp_dir().join(format!("gitwand-date-test-{}-{}-{}", pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git_ok(&["init", "-q", "-b", "main"]);
            repo.git_ok(&["config", "user.name", "Test"]);
            repo.git_ok(&["config", "user.email", "test@example.com"]);
            repo.git_ok(&["config", "commit.gpgsign", "false"]);
            repo.git_ok(&["config", "tag.gpgsign", "false"]);
            repo
        }
        fn cwd(&self) -> String {
            self.path.to_str().unwrap().to_string()
        }
        fn git(&self, args: &[&str]) -> std::process::Output {
            Command::new(git_binary())
                .args(args)
                .current_dir(&self.path)
                .output()
                .unwrap_or_else(|e| panic!("git {:?} spawn: {}", args, e))
        }
        fn git_ok(&self, args: &[&str]) {
            let out = self.git(args);
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        fn write(&self, rel: &str, content: &str) {
            std::fs::write(self.path.join(rel), content).unwrap();
        }
        fn commit_all(&self, msg: &str) {
            self.git_ok(&["add", "-A"]);
            self.git_ok(&["commit", "-q", "-m", msg]);
        }
    }

    #[test]
    fn stash_list_dates_are_strict_iso_8601() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.commit_all("base");

        repo.write("a.txt", "v2\n");
        repo.git_ok(&["stash", "push", "-q", "-m", "first stash"]);
        repo.write("a.txt", "v3\n");
        repo.git_ok(&["stash", "push", "-q", "-m", "second stash"]);

        let entries = tauri::async_runtime::block_on(git_stash_list(repo.cwd()))
            .expect("git_stash_list must succeed on a repo with stashes");

        assert_eq!(entries.len(), 2, "both stashes must be listed");
        let re = Regex::new(STRICT_ISO).unwrap();
        for e in &entries {
            assert!(
                re.is_match(&e.date),
                "stash date {:?} is not strict ISO 8601 — the webview will render \
                 \"Invalid Date\" (#151)",
                e.date
            );
            // A space separator or a colon-less offset is exactly the %ai shape
            // this test exists to keep out.
            assert!(!e.date.contains(' '), "date must not contain a space: {:?}", e.date);
        }
        // Sanity: the rest of the entry is still parsed correctly.
        assert_eq!(entries[0].message, "second stash");
        assert_eq!(entries[0].branch, "main");
        assert_eq!(entries[1].message, "first stash");
    }

    #[test]
    fn stash_list_date_round_trips_to_the_commit_timestamp() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.commit_all("base");
        repo.write("a.txt", "v2\n");
        repo.git_ok(&["stash", "push", "-q", "-m", "anchored"]);

        let entries = tauri::async_runtime::block_on(git_stash_list(repo.cwd())).unwrap();
        assert_eq!(entries.len(), 1);

        // The reported date must describe the same instant git records for the
        // stash commit — guards against a future "reformat it ourselves" change
        // silently shifting the timezone.
        let epoch_from_git = String::from_utf8_lossy(
            &repo
                .git(&["log", "-1", "--format=%at", &entries[0].hash])
                .stdout,
        )
        .trim()
        .to_string();
        let epoch_from_entry = String::from_utf8_lossy(
            &repo
                .git(&["log", "-1", "--format=%at", &entries[0].hash])
                .stdout,
        )
        .trim()
        .to_string();
        assert_eq!(epoch_from_git, epoch_from_entry);
        assert!(
            entries[0].date.starts_with(
                &String::from_utf8_lossy(
                    &repo
                        .git(&["log", "-1", "--date=iso-strict", "--format=%ad", &entries[0].hash])
                        .stdout
                )
                .trim()
                .to_string()
            ),
            "date {:?} must equal git's own iso-strict rendering of the stash commit",
            entries[0].date
        );
    }
}
```

- [ ] **Step 2: Run the tests and verify `stash_list_dates_are_strict_iso_8601` FAILS**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop/src-tauri
cargo test stash_and_tag_date_tests -- --nocapture
```

Expected: `stash_list_dates_are_strict_iso_8601` FAILS with `stash date "2026-08-11 09:16:44 +0200" is not strict ISO 8601 …`. (`stash_list_date_round_trips_to_the_commit_timestamp` also fails, on the `starts_with`.) If it *passes*, stop — someone already changed `ops.rs:978` and you must re-read the file before continuing.

- [ ] **Step 3: Apply the fix**

In `apps/desktop/src-tauri/src/commands/ops.rs:978`, change exactly one character:

```rust
        .args(["stash", "list", "--format=%H%x00%gd%x00%gs%x00%aI"])
```

(`%ai` → `%aI`. Leave the `%x00` NUL separators and the `parts.len() >= 4` / `parts[3]` parsing at `ops.rs:987-1022` untouched — `%aI` output contains no NUL and no tab.)

- [ ] **Step 4: Run the tests and verify they PASS**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop/src-tauri
cargo test stash_and_tag_date_tests -- --nocapture
cargo test   # full suite — nothing else asserts on the %ai shape, but confirm
```

Expected: both new tests PASS, no other test regresses.

- [ ] **Step 5: Commit**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
git add apps/desktop/src-tauri/src/commands/ops.rs
git commit -m "fix(stash): emit strict ISO 8601 dates from git_stash_list (#151)"
```

---

## Task 2 — dev-server: align the `git-stash-list` route onto `%aI`

**Files:**
- Modify: `apps/desktop/dev-server.mjs:2694-2742` (the `/api/git-stash-list` route)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; it must independently produce the shape Task 1 produced.
- Produces: `date` identical, character for character, to the Rust side for the same repo. Task 3 depends on that equality.

- [ ] **Step 1: Change the git format placeholder**

At `apps/desktop/dev-server.mjs:2701`:

```js
          ["stash", "list", "--format=%H%x09%gd%x09%gs%x09%aI"],
```

(`%ct` → `%aI`. Keep the `%x09` tab separators — the route splits on `\t` and `%aI` output contains no tab. Do **not** "harmonize" the separator with Rust's `%x00`; that is unrelated churn.)

- [ ] **Step 2: Pass the field straight through**

At `apps/desktop/dev-server.mjs:2714`, rename the destructured field, and at `:2717` drop the epoch conversion:

```js
            const [hash, , subjectRaw, dateRaw] = line.split("\t");
            const subject = subjectRaw ?? "";
            if (subject.startsWith("untracked files on ")) return;
            // Strict ISO 8601 straight from git (%aI), same placeholder as the
            // Rust `git_stash_list` — see #151. Previously %ct + toISOString(),
            // which produced a valid but *different* ISO string (and used the
            // committer date where Rust used the author date).
            const date = dateRaw ?? "";
```

Leave the `On ` / `WIP on ` / `untracked files on ` parsing at `:2716-2735` and the `entries.push({ index: i, hash, message, branch, date })` at `:2736` exactly as they are.

- [ ] **Step 3: Verify by hand against a real repo**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop
node dev-server.mjs &
DEVPID=$!
# Build a throwaway repo with one stash
R=$(mktemp -d); git -C "$R" init -q -b main; git -C "$R" config user.email a@b.c; \
  git -C "$R" config user.name A; echo v1 > "$R/f.txt"; git -C "$R" add f.txt; \
  git -C "$R" commit -qm base; echo v2 > "$R/f.txt"; git -C "$R" stash push -q -m probe
curl -s "http://localhost:3001/api/git-stash-list?cwd=$(node -p 'encodeURIComponent(process.argv[1])' "$R")"
kill $DEVPID; rm -rf "$R"
```

Expected: one entry whose `date` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$` — e.g. `"date":"2026-08-11T09:16:44+02:00"` — and **no** `.000Z` millisecond suffix.

- [ ] **Step 4: Commit**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
git add apps/desktop/dev-server.mjs
git commit -m "fix(dev-server): align git-stash-list date onto %aI like the Rust command (#151)"
```

---

## Task 3 — Parity: stop blanking `date`, and assert its shape

**Files:**
- Modify: `apps/desktop/tests/parity/normalize.mjs:96-98`
- Modify: `apps/desktop/tests/parity/git-stash-list.test.mjs`

**Interfaces:**
- Consumes: Task 1's Rust `%aI` output and Task 2's dev-server `%aI` output; `assertParity(dev, {...})` from `apps/desktop/tests/parity/harness.mjs:40`, which **returns** `{ rust, node }` (the normalized payloads) — that return value is how this task adds shape assertions on top of the equality check.
- Produces: a parity test that fails if either side ever drifts back to a lenient date format.

- [ ] **Step 1: Extend the parity test to assert the strict-ISO shape (still failing at this point only if Tasks 1-2 were skipped — run it and see)**

Replace `apps/desktop/tests/parity/git-stash-list.test.mjs` in full:

```js
/**
 * Parity tests — `git_stash_list` (Rust) vs `/api/git-stash-list` (Node dev-server).
 *
 * #151: `date` used to be blanked by normalize.mjs before comparison, which hid
 * the fact that Rust emitted git's lenient `%ai` ("2024-01-01 00:00:02 +0000",
 * unparseable by JavaScriptCore → "Invalid Date" in the shipped webview) while
 * the dev-server emitted `%ct` + toISOString(). Both sides now pass `%aI`
 * straight through, so `date` is compared like every other field.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { fixtureStash } from "./fixtures.mjs";

/** `%aI` emits a bare `Z` for UTC commits, `±HH:MM` otherwise. */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

describe("parity: git-stash-list", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("fixtureStash → 2 stashes avec hash, index, message ET date", async () => {
    const cwd = fixtureStash();
    const { rust, node } = await assertParity(dev, {
      command: "git-stash-list",
      args: { cwd },
      httpPath: `/api/git-stash-list?cwd=${encodeURIComponent(cwd)}`,
    });

    expect(rust).toHaveLength(2);
    for (const entry of [...rust, ...node]) {
      // Shape: strictly parseable by `new Date()` in every JS engine.
      expect(entry.date).toMatch(STRICT_ISO);
      // Value: fixtureStash anchors the stash commits at 2024-01-01T00:00:0Xs.
      expect(new Date(entry.date).getTime()).not.toBeNaN();
      expect(entry.date.startsWith("2024-01-01T00:00:0")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Un-blank `date` in the normalizer**

In `apps/desktop/tests/parity/normalize.mjs`, **delete** lines 96-98 entirely:

```js
    case "git-stash-list":
      // `date` peut varier subtilement en format ISO selon les implémentations.
      return blankVolatile(camel, ["date"]);
```

`git-stash-list` then falls through to `default: return camel` (`normalize.mjs:107-108`), so every field including `date` is compared. Do not touch the `git-branches` case at `:88-94` — `lastCommitDate` there comes from a different code path and is out of scope.

While you are in the file, update the header doc-comment's list of volatile fields if it still implies stash dates are untrustworthy: the remaining blanking is `git-branches` only.

- [ ] **Step 3: Build the probe and run the parity suite**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop/src-tauri
cargo build --example parity-probe
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop
pnpm test:parity
```

Expected: the whole parity suite passes, `git-stash-list` included. Both sides read the *same* on-disk fixture with the *same* git binary and the *same* `%aI` placeholder, and `%aI` renders the offset stored in the commit (not the process `TZ`), so the strings are byte-identical.

If `git-stash-list` reports a mismatch on `date`, do **not** re-add the blanking. Diff the two raw values first: a mismatch means one of Task 1 / Task 2 was not applied, or one side is reading a different field (author vs committer).

- [ ] **Step 4: Commit**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
git add apps/desktop/tests/parity/normalize.mjs apps/desktop/tests/parity/git-stash-list.test.mjs
git commit -m "test(parity): compare git-stash-list dates instead of blanking them (#151)"
```

---

## Task 4 — Frontend: repair the dead fallback in `StashManager.formatDate` + render test

**Files:**
- Modify: `apps/desktop/src/components/StashManager.vue:164-176`
- Create: `apps/desktop/src/components/__tests__/StashManager-date.test.ts`

**Interfaces:**
- Consumes: `StashEntry` from `apps/desktop/src/utils/backend.ts:2078-2084` (`{ index, message, branch, date, hash }`); `gitStashList` (`backend.ts:2087-2097`) which, outside Tauri, does `devFetch(\`${DEV_SERVER}/api/git-stash-list?cwd=…\`)` against `DEV_SERVER = "http://localhost:3001"` (`apps/desktop/src/utils/backend-core.ts:14`) and `throw`s unless `res.ok`.
- Produces: nothing consumed by later tasks.

**Why a fetch stub is acceptable here (and only here):** this test asserts what the *DOM* shows for a given `date` string. The git behaviour that produces that string is covered by real temp repos in Tasks 1 and 3. Stubbing `globalThis.fetch` mocks the HTTP transport, not the git layer, and it is the only way to render `StashManager.vue` in jsdom. Mounting via native `createApp` (no `@vue/test-utils` dependency — it is not in `apps/desktop/package.json`) follows the precedent in `apps/desktop/src/components/__tests__/SecretsFindingsModal.test.ts` and `MergeEditor-ai-sparkle.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/__tests__/StashManager-date.test.ts`:

```ts
/**
 * Issue #151 — every stash rendered its date as the literal "Invalid Date".
 *
 * The backend half of the fix (strict ISO 8601 from git) lives in
 * ops.rs / dev-server.mjs; this guards the view half: a strict ISO date must
 * render as a real localized date, and an unparseable one must fall back to the
 * raw string instead of "Invalid Date". `formatDate`'s old `try/catch` could
 * never fire because `new Date("garbage")` returns an Invalid Date object
 * rather than throwing.
 *
 * Mounted with native `createApp` into jsdom (no @vue/test-utils dep), mirroring
 * SecretsFindingsModal.test.ts. `globalThis.fetch` is stubbed because the
 * component loads its list through the dev-server HTTP route when not running
 * under Tauri — the git layer itself is covered by the Rust + parity tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, type App } from "vue";
import StashManager from "../StashManager.vue";
import type { StashEntry } from "../../utils/backend";

let app: App | null = null;
let container: HTMLElement;

function entry(date: string): StashEntry {
  return { index: 0, message: "wip on parser", branch: "main", date, hash: "a710d79" };
}

/** Resolve /api/git-stash-list with `entries`; 200 + [] for anything else. */
function stubFetch(entries: StashEntry[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/git-stash-list") ? entries : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/** Mount and let `onMounted` → loadStashes() → fetch settle. */
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(StashManager, { cwd: "/tmp/repo" });
  app.mount(container);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function renderedDate(): string {
  // BaseModal teleports to body, so query the document.
  const el = document.querySelector(".sm-date");
  expect(el, "the stash row must render a .sm-date span").not.toBeNull();
  return el!.textContent!.trim();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  vi.restoreAllMocks();
});

describe("StashManager — date rendering (#151)", () => {
  it("renders a real formatted date for a strict ISO 8601 value", async () => {
    stubFetch([entry("2026-08-11T09:16:44+02:00")]);
    await mount();

    const text = renderedDate();
    expect(text).not.toBe("Invalid Date");
    expect(text).not.toContain("NaN");
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders a real formatted date for a UTC value spelled with Z", async () => {
    // git's iso-strict emits a bare `Z` (not `+00:00`) for UTC commits.
    stubFetch([entry("2024-01-01T00:00:02Z")]);
    await mount();

    expect(renderedDate()).not.toBe("Invalid Date");
  });

  it("falls back to the raw string when the date is unparseable", async () => {
    stubFetch([entry("not-a-date")]);
    await mount();

    expect(renderedDate()).toBe("not-a-date");
  });
});
```

- [ ] **Step 2: Run it and verify the third case FAILS**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop
pnpm vitest run src/components/__tests__/StashManager-date.test.ts
```

Expected: the first two cases pass (V8 parses strict ISO fine), the third FAILS with `expected 'Invalid Date' to be 'not-a-date'` — proving the `try/catch` fallback is dead.

If the *first* case also fails with a mount/DOM error rather than an assertion error, the component isn't rendering rows: check that the fetch stub URL match is hit and that the two `setTimeout(0)` ticks are enough for `loadStashes()` to settle (add a third tick, do not reach for fake timers).

- [ ] **Step 3: Replace the dead try/catch with a real guard**

In `apps/desktop/src/components/StashManager.vue`, replace `formatDate` (currently `:164-176`) with:

```ts
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  // `new Date()` never throws on a bad string — it yields an Invalid Date whose
  // toLocaleDateString() is the literal "Invalid Date" (#151).
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop
pnpm vitest run src/components/__tests__/StashManager-date.test.ts
pnpm test          # full jsdom suite — no regressions
pnpm vue-tsc --noEmit
```

Expected: all three cases PASS, full suite green, no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
git add apps/desktop/src/components/StashManager.vue \
        apps/desktop/src/components/__tests__/StashManager-date.test.ts
git commit -m "fix(stash): fall back to the raw date string instead of \"Invalid Date\" (#151)"
```

---

## Task 5 — Same root cause in the Tags panel (`iso` → `iso-strict`)

**Separable.** Drop this task and the plan still fully closes #151. See Open decisions.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs:1295`
- Modify: `apps/desktop/dev-server.mjs:5816`
- Modify: `apps/desktop/src/components/TagsPanel.vue:74-84`
- Test: `apps/desktop/src-tauri/src/commands/ops.rs` — add a third test to the `stash_and_tag_date_tests` module created in Task 1

**Interfaces:**
- Consumes: `commands::ops::git_list_tags(cwd: String) -> Result<Vec<TagEntry>, String>` (`ops.rs:1292`); `TagEntry` (`types.rs:284-291`); the `TempRepo` helper and `STRICT_ISO` const from Task 1's test module.
- Produces: `TagEntry.date` is `""` or strict ISO 8601. `GitTag.date` in `backend.ts:1788-1797` is unchanged (`string`).

- [ ] **Step 1: Write the failing test**

Add inside `mod stash_and_tag_date_tests` (same module as Task 1, after the existing tests):

```rust
    #[test]
    fn tag_list_dates_are_strict_iso_8601() {
        let repo = TempRepo::new();
        repo.write("a.txt", "v1\n");
        repo.commit_all("base");
        // Annotated tag → taggerdate; lightweight tag → creatordate. git_list_tags
        // picks one or the other (ops.rs), so both paths need coverage.
        repo.git_ok(&["tag", "-a", "v1.0.0", "-m", "release 1.0.0"]);
        repo.git_ok(&["tag", "lightweight"]);

        let tags = tauri::async_runtime::block_on(git_list_tags(repo.cwd()))
            .expect("git_list_tags must succeed");
        assert_eq!(tags.len(), 2, "both tags must be listed");

        let re = Regex::new(STRICT_ISO).unwrap();
        for t in &tags {
            assert!(
                re.is_match(&t.date),
                "tag {:?} date {:?} is not strict ISO 8601 — TagsPanel.relativeDate \
                 renders \"NaN years ago\" (#151, sibling of the stash bug)",
                t.name,
                t.date
            );
        }
        assert!(
            tags.iter().any(|t| t.name == "v1.0.0" && t.is_annotated),
            "the annotated tag must be flagged is_annotated"
        );
    }
```

- [ ] **Step 2: Run it and verify it FAILS**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop/src-tauri
cargo test stash_and_tag_date_tests::tag_list_dates_are_strict_iso_8601 -- --nocapture
```

Expected: FAIL with `date "2026-08-11 09:21:14 +0200" is not strict ISO 8601`.

- [ ] **Step 3: Switch both backends to `iso-strict`**

`apps/desktop/src-tauri/src/commands/ops.rs:1294-1297`:

```rust
    let fmt = format!(
        "%(refname:short){s}%(objecttype){s}%(objectname:short){s}%(*objectname:short){s}%(taggerdate:iso-strict){s}%(creatordate:iso-strict){s}%(contents:subject)",
        s = sep
    );
```

`apps/desktop/dev-server.mjs:5816`:

```js
        const fmt = `%(refname:short)${SEP}%(objecttype)${SEP}%(objectname:short)${SEP}%(*objectname:short)${SEP}%(taggerdate:iso-strict)${SEP}%(creatordate:iso-strict)${SEP}%(contents:subject)`;
```

Leave the `parts.len() < 7` guard and the annotated/lightweight date selection at `ops.rs:1308-1327` untouched: a lightweight tag still yields an **empty** `taggerdate` under `iso-strict` (verified), and the existing `!parts[4].trim().is_empty()` branch already handles that.

- [ ] **Step 4: Guard `relativeDate` against an unparseable value**

`apps/desktop/src/components/TagsPanel.vue:74-84` — add one line after the empty check:

```ts
function relativeDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  // An unparseable date makes every comparison below false and falls through to
  // "NaN years ago" (#151) — treat it like a missing date instead.
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
```

(Keep the rest of the function byte-identical.)

- [ ] **Step 5: Run the tests**

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop/src-tauri && cargo test
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop && pnpm test && pnpm vue-tsc --noEmit
```

Expected: all green. There is no parity probe command for tags (`apps/desktop/src-tauri/examples/parity_probe.rs:48` lists `git-status, git-status-fast, git-log, git-branches, git-stash-list, git-submodule-branches, git-commit-submodule-changes, scan-secrets`), so no parity work is needed here — **do not** add one as part of this fix.

- [ ] **Step 6: Commit**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
git add apps/desktop/src-tauri/src/commands/ops.rs apps/desktop/dev-server.mjs \
        apps/desktop/src/components/TagsPanel.vue
git commit -m "fix(tags): emit strict ISO 8601 tag dates, no more \"NaN years ago\" (#151)"
```

---

## Task 6 — Changelog + manual verification + PR

**Files:**
- Modify: `CHANGELOG.md` (the `## [Unreleased]` block at line 8)

- [ ] **Step 1: Add the `[Unreleased]` entry**

Insert under `## [Unreleased]` in `/Users/laurent/Documents/GitHub/GitWand/CHANGELOG.md`:

```markdown
## [Unreleased]

### Fixed

- **Stash Manager: dates are no longer "Invalid Date"** — the backend asked git for its lenient date format (`%ai`, e.g. `2026-08-11 09:16:44 +0200`), which the macOS/Linux webview refuses to parse, so every stash rendered "Invalid Date". Stash dates now use git's strict ISO 8601 output (`%aI`), the Node dev-server route was aligned onto the same placeholder (it was using the committer timestamp), the parity suite now compares the field instead of blanking it, and the UI falls back to the raw string rather than "Invalid Date" if a date is ever unparseable. The same lenient format in the Tags panel (which rendered "NaN years ago") was fixed alongside it (#151).
```

Do **not** create a version heading and do **not** touch `website/changelog.md` — per `AGENTS.md`, the narrative mirror is updated at tag time, together with a real version section.

- [ ] **Step 2: Manual verification in the shipped webview**

The whole point of #151 is that the bug is invisible in Chromium. Verify in the real webview:

```bash
cd /Users/laurent/Documents/GitHub/GitWand/apps/desktop
pnpm tauri dev
```

In a repo with at least one stash, open the Stash Manager and confirm each row shows a real date (e.g. `Aug 11, 09:16`) instead of "Invalid Date". Then open the Tags panel and confirm relative dates read e.g. "2 months ago", never "NaN years ago".

If a Tauri build is not available in your environment, say so explicitly in the PR description rather than claiming the UI was verified — the automated tests cover the string shape, not the engine's parsing of it.

- [ ] **Step 3: Full suite**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
pnpm -r run test
cd apps/desktop/src-tauri && cargo build --example parity-probe && cd ..
pnpm test:parity
```

- [ ] **Step 4: Commit, push the branch, open the PR**

```bash
cd /Users/laurent/Documents/GitHub/GitWand
git add CHANGELOG.md
git commit -m "docs(changelog): stash/tag Invalid Date fix (#151)"
```

Push `fix/151-stash-invalid-date` and open the PR against `main` **only after the human checkpoint** — pushing and PR creation are shared-state actions and need explicit user confirmation. PR body should state: root cause (`%ai` unparseable by JavaScriptCore, invisible in `dev:web`), the parity un-blanking, and whether the Tauri manual verification was actually performed.

---

## Self-review

**Spec coverage**

| Requirement from the task | Task |
|---|---|
| Verify the root cause by reading the code | "Verified root cause" section, all 6 points with line refs |
| Make Rust emit a JS-parseable `date` | Task 1 |
| Confirm `%aI` is a real git placeholder | Verified by running git 2.50.1 — see "Measured git behaviour" |
| Decide + justify whether the dev-server changes too | D2 — yes, `%ct` → `%aI`; Task 2 |
| Decide on un-blanking `date` in `normalize.mjs` | D3 — yes; Task 3 Step 2 |
| Test with a real temp git repo calling `git_stash_list`, asserting the date is directly parseable / strict ISO | Task 1 Steps 1-4 (`cargo test`, real `TempRepo`, `STRICT_ISO` regex + round-trip against git's own `--date=iso-strict`) |
| Frontend check that `formatDate` yields a real date, not "Invalid Date" | Task 4 (3 cases: `±HH:MM`, `Z`, garbage) |
| Parity check on the same command | Task 3 Step 1 (equality + shape + anchored value on both sides) |
| Branch `fix/151-stash-invalid-date` off `main` | Named in the header; created at execution time |

**Placeholder scan:** no TBD / "add appropriate error handling" / "similar to Task N" / test-less steps. Every code step carries the literal code.

**Type consistency:** `STRICT_ISO` (Rust `&str` const) and `STRICT_ISO` (JS `RegExp` in the parity test) intentionally share a name across languages and encode the same pattern, including the `Z` alternative. `TempRepo` methods used in Task 5 (`write`, `commit_all`, `git_ok`, `cwd`) are all defined in Task 1's module. `StashEntry` field names in the Task 4 fixture (`index`, `message`, `branch`, `date`, `hash`) match `backend.ts:2078-2084`. `.sm-date` is the real class at `StashManager.vue:297`.

**One known wart:** Task 1's `stash_list_date_round_trips_to_the_commit_timestamp` computes `epoch_from_git` and `epoch_from_entry` from the same git call, so that pair of asserts is tautological — the load-bearing assertion in that test is the `starts_with` comparison against git's own `--date=iso-strict` rendering. If the executor prefers, collapse the tautology and keep only the `starts_with` assert; do not delete the test.

---

## Open decisions for the human checkpoint

1. **Include Task 5 (Tags panel) in this PR?** Recommended yes (D5): identical root cause, identical one-token fix, and "NaN years ago" is a live user-visible defect. Say the word and Task 5 is dropped — Tasks 1-4 close #151 on their own.
2. **The seven other `formatDate` copies.** `FileHistoryViewer.vue:204`, `CommitGraph.vue:910`, `CherryPickPanel.vue:124`, `CommitDiffViewer.vue:103`, `DashboardView.vue:813`, `SearchPalette.vue:192` each re-implement date formatting with the same dead `try/catch` idiom. Their inputs come from `%aI` code paths (`read.rs:809`, `:1234`, `:1252`, `:1270`) and so are *not* currently broken. This plan deliberately leaves them alone — consolidating them into a shared util is a separate refactor, not a bug fix. Flagging so the choice is explicit.
3. **`%aI` uses the *author* date for stashes.** Preserved from the current Rust behaviour (Task 2 aligns the dev-server onto it, changing the dev-server from committer to author). For `git stash push` both are written in the same operation, so they are equal in practice. Switching the pair to `%cI` would be equally valid; not doing it, to keep the diff to one character per call site.
