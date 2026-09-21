# Failure parity for the write commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the Rust backend and the dev-server refuse the same way — and leave the repository in the same state — for the ten commands whose divergence would corrupt a user's working tree.

**Architecture:** One generic `command-parity` probe arm dispatches by command name, replacing what would otherwise be thirty wrapper-plus-arm pairs. The tests then drive both backends against two independently built repositories and compare the refusal *and* the state left behind.

**Tech Stack:** Rust (the `parity-probe` example binary), Node (`dev-server.mjs` already serves these routes), Vitest via `vitest.config.parity.ts`, real temporary git repositories.

**Spec:** `docs/superpowers/specs/2026-09-18-command-route-registry-design.md` (§5, as corrected)

## Global Constraints

- **Package manager is pnpm only.**
- **Secondary Rust binaries stay under `[[example]]`**, never `[[bin]]` — `tauri-bundler` bundles every `[[bin]]` and that breaks the release build.
- **Never build git commands by string interpolation** — `.args([...])` only (AGENTS.md § Security).
- **Never mock the git layer.** Real temporary repositories, cleaned up on teardown.
- **The probe reads its input as JSON on stdin**, not as CLI flags. `runProbe(command, argsObject)` in `tests/parity/probe.mjs` sends it and returns `{ ok, value, error }`.
- **A freshly built probe blocks on the macOS keychain.** After `cargo build --example parity-probe`, the first run that reaches `settings_github_token()` waits minutes on an OS authorization decision while the harness kills it at 10s. This is documented in `auto-merge-refusal.test.mjs` and its remedy is to run the probe once directly, with no timeout, and let it finish. Two separate investigations in this repo have mistaken it for a flaky test — do not be the third.
- **Test commands:** parity `pnpm --filter @gitwand/desktop test:parity` (needs `cargo build --example parity-probe` first); Rust `cd apps/desktop/src-tauri && cargo test`; `cargo fmt` before pushing, because `Rust check` runs `cargo fmt --check`.
- **Measured baseline:** the parity suite is 81 tests over 24 files and runs in ~25s.

---

### Task 1: One generic probe arm

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add one wrapper next to `git_operation_action_parity`)
- Modify: `apps/desktop/src-tauri/examples/parity_probe.rs` (add one arm; the dispatch `match` starts at :102, `must_str` at :79)

**Interfaces:**
- Consumes: the `#[tauri::command]` functions in `commands::ops`.
- Produces: probe command `command-parity`, taking `{ "command": "<name>", "args": { … } }` on stdin. Tasks 2 and 3 call it through `runProbe("command-parity", { command, args })`.

**Context.** Thirty commands need to be reachable. Thirty `*_parity` wrappers plus thirty probe arms is thirty times the same ceremony; one arm with a `match` is the same coverage with a tenth of the surface. The wrapper lives in `lib.rs` because that is where every other `*_parity` entry point lives and where the probe imports from.

- [ ] **Step 1: Write the failing Rust test**

Add to the end of `apps/desktop/src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod command_parity_tests {
    use super::command_parity;

    #[test]
    fn refuses_a_command_it_does_not_know() {
        let err = command_parity(
            "git_not_a_command".to_string(),
            serde_json::json!({ "cwd": "/tmp" }),
        )
        .unwrap_err();
        assert!(err.contains("git_not_a_command"), "error names the command: {err}");
    }

    #[test]
    fn refuses_a_call_missing_a_required_argument() {
        // `git_merge` needs a branch; the dispatcher must say so rather than
        // passing an empty string to git.
        let err = command_parity("git_merge".to_string(), serde_json::json!({ "cwd": "/tmp" }))
            .unwrap_err();
        assert!(err.contains("branch"), "error names the missing arg: {err}");
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/desktop/src-tauri && cargo test command_parity
```

Expected: FAIL to compile — `command_parity` does not exist.

- [ ] **Step 3: Write the dispatcher**

In `apps/desktop/src-tauri/src/lib.rs`, next to `git_operation_action_parity`:

```rust
/// Parity entry point for commands that would otherwise each need their own
/// wrapper and probe arm.
///
/// The probe already takes JSON on stdin, so one dispatcher keyed on the
/// command name covers thirty commands with thirty short arms instead of
/// thirty wrapper-plus-arm pairs. Only commands the parity suite actually
/// drives are listed; an unknown name is an error, never a silent no-op,
/// because a test that quietly exercises nothing is worse than a missing test.
pub fn command_parity(
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let s = |key: &str| -> Result<String, String> {
        args.get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .ok_or_else(|| format!("missing required arg '{}' for {}", key, command))
    };
    // Several of these return Option<SnapshotMeta>; the tests assert on the
    // repository, not on the payload, so success collapses to a marker.
    let ok = |_| serde_json::json!({ "ok": true });

    // Signatures verified against commands/ops.rs. `snapshots_enabled` is
    // forced to Some(false) everywhere it exists: a snapshot writes into the
    // repository, and two independently built repositories would then differ
    // for a reason that has nothing to do with the refusal under test.
    match command.as_str() {
        "git_merge" => tauri::async_runtime::block_on(commands::ops::git_merge(
            s("cwd")?,
            s("branch")?,
            Some(false),
        ))
        .map(|r| serde_json::json!({ "success": r.success, "message": r.message })),
        "git_cherry_pick" => tauri::async_runtime::block_on(commands::ops::git_cherry_pick(
            s("cwd")?,
            vec![s("hash")?],
        ))
        .map(|r| serde_json::json!({ "success": r.success, "message": r.message })),
        "git_revert_commit" => tauri::async_runtime::block_on(
            commands::ops::git_revert_commit(s("cwd")?, s("hash")?, None),
        )
        .map(|r| serde_json::json!({ "success": r.success, "message": r.message })),
        "git_reset_to_commit" => tauri::async_runtime::block_on(
            commands::ops::git_reset_to_commit(s("cwd")?, s("hash")?, s("mode")?, Some(false)),
        )
        .map(ok),
        "git_discard" => tauri::async_runtime::block_on(commands::ops::git_discard(
            s("cwd")?,
            vec![s("path")?],
            false,
            Some(false),
        ))
        .map(ok),
        "git_stash" => {
            tauri::async_runtime::block_on(commands::ops::git_stash(s("cwd")?, None)).map(ok)
        }
        // Takes no index, unlike git_stash_apply.
        "git_stash_pop" => {
            tauri::async_runtime::block_on(commands::ops::git_stash_pop(s("cwd")?)).map(ok)
        }
        "git_stash_apply" => tauri::async_runtime::block_on(commands::ops::git_stash_apply(
            s("cwd")?,
            args.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        ))
        .map(ok),
        "git_checkout_commit" => tauri::async_runtime::block_on(
            commands::ops::git_checkout_commit(s("cwd")?, s("hash")?, Some(false)),
        )
        .map(ok),
        "git_switch_branch" => tauri::async_runtime::block_on(
            commands::ops::git_switch_branch(s("cwd")?, s("branch")?, Some(false)),
        )
        .map(ok),
        other => Err(format!("command-parity does not know '{}'", other)),
    }
}
```

**If `cargo check` still rejects an arm**, a signature moved since this plan was
written: fix the arm against the real one. Do not delete an arm to make it
compile — a missing arm silently removes a test's subject.

- [ ] **Step 4: Run the Rust test**

```bash
cd apps/desktop/src-tauri && cargo test command_parity && cargo check --examples
```

Expected: 2 tests pass, `cargo check` clean.

- [ ] **Step 5: Add the probe arm**

In `apps/desktop/src-tauri/examples/parity_probe.rs`, add to the `use gitwand_desktop_lib::{…}` list: `command_parity`. Then add to the dispatch `match`, before the `"preview-merge"` arm:

```rust
        "command-parity" => {
            let name = match must_str("command") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let args = input.get("args").cloned().unwrap_or_else(|| json!({}));
            to_json(command_parity(name, args))
        }
```

Also add `command-parity` to the usage string printed at `parity_probe.rs:52`.

- [ ] **Step 6: Build the probe and prove the arm answers**

```bash
cd apps/desktop/src-tauri && cargo build --example parity-probe
echo '{"command":"git_not_a_command","args":{}}' | ./target/debug/examples/parity-probe command-parity
```

Expected: JSON on stdout containing `"error"` and the command name, exit code 1.

If this hangs for more than a few seconds, it is the macOS keychain (see Global Constraints) — let it finish once, then continue.

- [ ] **Step 7: Format and commit**

```bash
cd apps/desktop/src-tauri && cargo fmt
cd /Users/laurent/Projects/GitWand
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/examples/parity_probe.rs
git commit -m "test(desktop): one generic probe arm for write-command parity"
```

---

### Task 2: The shared failure harness, and the first three commands

**Files:**
- Create: `apps/desktop/tests/parity/write-failure.test.mjs`

**Interfaces:**
- Consumes: `command-parity` (Task 1); `startDevServer` and `runProbe` from the existing harness.
- Produces: the `expectSameRefusal` helper and the fixture builders used by Task 3, in the same file.

**Context.** The model is `git-operation-action.test.mjs`: the operation is destructive, so the two sides cannot share a working tree. Each gets its own freshly built repository, and the comparison covers the state left behind — commit *subjects*, not `--oneline`, because two independently built repositories have different SHAs by construction.

- [ ] **Step 1: Write the file**

```javascript
/**
 * Parity on FAILURE for the commands that mutate the working tree or HEAD.
 *
 * The happy paths are covered elsewhere. What hides best, and what this suite
 * exists for, is a pair of backends that agree while succeeding and disagree
 * while failing: `read_file` rejected non-UTF-8 in Rust and substituted
 * U+FFFD in Node, and nothing noticed until a parity test asked.
 *
 * Both sides must refuse, **and leave the same state behind**. Agreeing on
 * "no" while leaving different working trees is not parity: the state is what
 * the user acts on next.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@gitwand.test",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@gitwand.test",
  GIT_EDITOR: "true",
};

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();

const dirs = [];

/** A repo with one commit on `main`. */
function baseRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gw-parity-writefail-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/** `baseRepo` plus an uncommitted edit, so an operation that needs a clean tree refuses. */
function dirtyRepo() {
  const dir = baseRepo();
  writeFileSync(join(dir, "file.txt"), "uncommitted\n");
  return dir;
}

/**
 * The state a caller acts on next. Subjects rather than `--oneline`: the two
 * repositories are built independently, so their SHAs differ by construction
 * and comparing them would fail for a reason that has nothing to do with parity.
 */
function repoShape(cwd) {
  return {
    status: git(cwd, ["status", "--porcelain"]),
    subjects: git(cwd, ["log", "--format=%s"]),
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    merging: existsSync(join(cwd, ".git", "MERGE_HEAD")),
    file: git(cwd, ["show", ":file.txt"]).slice(0, 40),
  };
}

/**
 * `runProbe`'s `ok` reflects the probe's EXIT CODE, which is not the question
 * asked here: several of these commands return `Ok(GitPushPullResult)` with
 * `success: false` when git refuses — the exact shape that produced #197.
 * Reading only the exit code calls a refusal a success.
 */
function rustRun(cwd, command, args) {
  const r = runProbe("command-parity", { command, args: { cwd, ...args } });
  const refused = !r.ok || r.value?.success === false;
  return { ok: !refused, error: r.error ?? r.value?.message, value: r.value };
}

async function nodeRun(dev, route, body) {
  const res = await dev.fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Several routes answer HTTP 200 with { success: false }; both shapes are a
  // refusal, and the caller cares about the refusal, not about the transport.
  const refused = !res.ok || data.success === false;
  return { ok: !refused, error: data.error ?? data.message };
}

/**
 * Both sides refuse, and the two repositories end up identical.
 *
 * The messages travel into the assertion text deliberately: when this kind of
 * test last failed in this repo, a bare boolean said nothing about what either
 * side printed and recovering it cost a local reproduction.
 */
function expectSameRefusal(rust, node, rustDir, nodeDir) {
  expect(rust.ok, `rust unexpectedly succeeded: ${JSON.stringify(rust.value)}`).toBe(false);
  expect(node.ok, `node unexpectedly succeeded`).toBe(false);
  expect(repoShape(rustDir), `refused on both sides but left different repositories`).toEqual(
    repoShape(nodeDir),
  );
}

let dev;
beforeAll(async () => {
  dev = await startDevServer();
}, 15_000);
afterAll(async () => {
  await dev?.stop();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("parity on failure: working-tree commands", () => {
  it("git_merge refuses an unknown branch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_merge", { branch: "no-such-branch" });
    const node = await nodeRun(dev, "/api/git-merge", {
      cwd: nodeDir,
      branch: "no-such-branch",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_cherry_pick refuses an unknown commit identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_cherry_pick", {
      hash: "0000000000000000000000000000000000000000",
    });
    const node = await nodeRun(dev, "/api/git-cherry-pick", {
      cwd: nodeDir,
      hashes: ["0000000000000000000000000000000000000000"],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_checkout_commit refuses an unknown ref identically", async () => {
    const rustDir = dirtyRepo();
    const nodeDir = dirtyRepo();

    const rust = rustRun(rustDir, "git_checkout_commit", { hash: "deadbeef" });
    const node = await nodeRun(dev, "/api/git-checkout-commit", {
      cwd: nodeDir,
      hash: "deadbeef",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter @gitwand/desktop exec vitest run --config vitest.config.parity.ts tests/parity/write-failure.test.mjs
```

Expected: 3 passed.

**A failure here is the point of the exercise, not a broken test.** If one side
succeeds where the other refuses, or the two repositories differ, that is a real
divergence: record it, and fix the dev-server route to match Rust rather than
weakening the assertion. If the two disagree only in *wording*, the assertion
above already tolerates that — it compares refusal and state, never strings.

If a route name in `nodeRun` turns out to be wrong, `commandRegistry.ts` is the
authority: it names the dev-server route for every invoked command.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/tests/parity/write-failure.test.mjs
git commit -m "test(desktop): failure parity for merge, cherry-pick and checkout"
```

---

### Task 3: The remaining seven commands

**Files:**
- Modify: `apps/desktop/tests/parity/write-failure.test.mjs`

**Interfaces:**
- Consumes: `expectSameRefusal`, `baseRepo`, `dirtyRepo`, `rustRun`, `nodeRun` (Task 2).
- Produces: nothing. This completes the tranche.

- [ ] **Step 1: Append the cases**

```javascript
describe("parity on failure: stash and history commands", () => {
  it("git_stash refuses a repo with no initial commit identically", async () => {
    // A clean tree is NOT a refusal: `git stash` exits 0 with "No local
    // changes to save". Before the first commit it genuinely fails, so the
    // fixture is an `unbornRepo()` — init plus a staged file, no commit.
    const rustDir = unbornRepo();
    const nodeDir = unbornRepo();

    const rust = rustRun(rustDir, "git_stash", {});
    const node = await nodeRun(dev, "/api/git-stash", { cwd: nodeDir });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stash_pop refuses an empty stash identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_stash_pop", {});
    const node = await nodeRun(dev, "/api/git-stash-pop", { cwd: nodeDir });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_stash_apply refuses an empty stash identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_stash_apply", { index: 0 });
    const node = await nodeRun(dev, "/api/git-stash-apply", { cwd: nodeDir, index: 0 });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_revert_commit refuses an unknown commit identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_revert_commit", { hash: "deadbeef" });
    const node = await nodeRun(dev, "/api/git-revert-commit", {
      cwd: nodeDir,
      hash: "deadbeef",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_reset_to_commit refuses an unknown commit identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_reset_to_commit", {
      hash: "deadbeef",
      mode: "hard",
    });
    const node = await nodeRun(dev, "/api/git-reset-to-commit", {
      cwd: nodeDir,
      hash: "deadbeef",
      mode: "hard",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_discard refuses a path outside the repository identically", async () => {
    const rustDir = dirtyRepo();
    const nodeDir = dirtyRepo();

    const rust = rustRun(rustDir, "git_discard", { path: "../escape.txt" });
    const node = await nodeRun(dev, "/api/git-discard", {
      cwd: nodeDir,
      paths: ["../escape.txt"],
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });

  it("git_switch_branch refuses an unknown branch identically", async () => {
    const rustDir = baseRepo();
    const nodeDir = baseRepo();

    const rust = rustRun(rustDir, "git_switch_branch", { branch: "no-such-branch" });
    const node = await nodeRun(dev, "/api/git-switch-branch", {
      cwd: nodeDir,
      branch: "no-such-branch",
    });

    expectSameRefusal(rust, node, rustDir, nodeDir);
  });
});
```

`git_discard` with `../escape.txt` is the one case here that is about a guard
rather than about git: `safe_repo_path()` is supposed to refuse it (AGENTS.md
§ Security). If the two sides disagree, that is a security-relevant finding and
belongs in the PR description, not in a follow-up.

- [ ] **Step 2: Run the file**

```bash
pnpm --filter @gitwand/desktop exec vitest run --config vitest.config.parity.ts tests/parity/write-failure.test.mjs
```

Expected: 10 passed.

- [ ] **Step 3: Run the whole parity suite and check the cost**

```bash
time pnpm --filter @gitwand/desktop test:parity
```

Expected: 91 tests over 25 files, green. The baseline was 81 tests in ~25s; if
the suite now takes materially longer than ~35s, say so in the PR — the design
committed to keeping this proportionate, and a measurement that contradicts it
should be reported rather than absorbed.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/parity/write-failure.test.mjs
git commit -m "test(desktop): failure parity for the stash and history commands"
```

---

## After the plan

- [ ] Add a line to `CHANGELOG.md` under `## [Unreleased]`, `### Changed`, naming any divergence the ten tests actually found. If they found none, say that instead — "ten commands verified to refuse identically" is the result, and it is worth recording.
- [ ] Open the PR against `main` from `feat/parity-write-failures`.
- [ ] Update the `ROADMAP.md` v3.11.0 row: the audit lot is complete, with the remaining 25 write commands (index- and ref-only) named as a follow-up rather than left implied.
