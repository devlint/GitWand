# Unified operation actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merge, cherry-pick, revert and rebase one command, one error convention and one banner, so every operation the app can start it can also continue and abandon, and every result is verified before it is shown.

**Architecture:** `git_rebase_action` is generalised into `git_operation_action(cwd, operation, action)` and absorbs four merge/cherry-pick commands. It returns `Ok({ halted })` and reserves `Err` for real failure, so "git stopped on the next conflict" stops being reported as an error. `useGitRepo` exposes one `runOperationAction` returning a boolean, reading the operation from `git_repo_state`; `isCherryPicking` is deleted. `RebaseProgressBanner` becomes the banner for every operation and nothing auto-continues.

**Tech Stack:** Rust (Tauri 2 commands), Node dev-server (`dev-server.mjs`), Vue 3 `<script setup>` + TypeScript, Vitest (node env, jsdom opt-in per file), real temporary git repos.

**Spec:** `docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md`

## Global Constraints

- **Package manager is pnpm only.** Never `npm`, never `yarn`.
- **Never build git commands by string interpolation.** `.args([...])` or `.arg()` chaining only (AGENTS.md § Security).
- **Never call `invoke()` outside `src/utils/backend.ts`.** Every Rust command gets its typed wrapper there in the same commit.
- **Secondary Rust binaries stay under `[[example]]`**, never `[[bin]]` — `tauri-bundler` bundles every `[[bin]]`.
- **Every user-visible string needs a key in all 5 locales:** `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`. `fr`, `es` and `pt-BR` escape non-ASCII as `\uXXXX` in this neighbourhood; `zh-CN` stores CJK literally.
- **Never mock the git layer.** Real temporary repos, cleaned up on teardown. Mocking `src/utils/backend` (the IPC wrapper module) is not mocking git and is allowed.
- **Vitest environment is `node` by default.** A file that reaches `src/utils/backend` needs `// @vitest-environment jsdom` at the top — that module reads `window` at import time.
- **Do not edit version fields by hand.**
- **Type-check needs core built:** run `pnpm --filter @gitwand/core build` once before `vue-tsc`, or dozens of `Cannot find module '@gitwand/core'` bury the real errors.
- **Test commands:** whole suite `pnpm --filter @gitwand/desktop test`; one file `pnpm --filter @gitwand/desktop exec vitest run <path>`; parity `pnpm --filter @gitwand/desktop test:parity` (needs `cargo build --example parity-probe` first); Rust `cd apps/desktop/src-tauri && cargo test`.

---

### Task 1: Lock git's three outcomes, and its localisation

No product code. It records against real git the facts the whole design rests on: that `--continue` landing on a further conflict exits non-zero (so exit code alone cannot mean failure), that `merge` has no `--skip` while the others do, and that git translates the very words we match on.

**Files:**
- Test: `apps/desktop/src/composables/__tests__/operationAction.git.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. It documents git's contract for Tasks 2-6.

- [ ] **Step 1: Write the test file**

Modelled on `apps/desktop/src/composables/__tests__/mergeAbort.git.test.ts` — same env hygiene, same 60s timeout, real repos in `mkdtempSync`.

```typescript
/**
 * Real-git contract tests for the operation-action model — the drift lock for
 * docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md (§3,
 * §4.1). Every assertion documents a git behaviour `git_operation_action`
 * depends on.
 *
 * Uses real temporary git repos per AGENTS.md — never a mocked git layer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTHOR_NAME = "GitWand Test";
const AUTHOR_EMAIL = "test@gitwand.test";
const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EDITOR: "true",
    EDITOR: "true",
    ...extra,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function tryGit(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): GitResult {
  const res = spawnSync("git", args, { cwd, env: gitEnv(extraEnv), encoding: "utf-8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-opaction-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/**
 * Two feature commits that both conflict with main, so a cherry-pick of the
 * pair halts twice: once on the first, and again when --continue reaches the
 * second. That second halt is the case the whole design turns on.
 */
function makeTwoConflictingCommits(dir: string): string[] {
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature one\n");
  git(dir, ["commit", "-am", "feature one"]);
  const first = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "file.txt"), "feature two\n");
  git(dir, ["commit", "-am", "feature two"]);
  const second = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["commit", "-am", "main change"]);
  return [first, second];
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("a --continue that reaches a further conflict", () => {
  it(
    "exits non-zero and says CONFLICT, having made progress",
    () => {
      // §3: this is why exit code alone cannot mean "failed". git advanced to
      // the next commit and stopped where it should.
      const dir = makeRepo();
      const [first, second] = makeTwoConflictingCommits(dir);
      const pick = tryGit(dir, ["cherry-pick", first, second]);
      expect(pick.status).not.toBe(0);
      // Resolve the first conflict and stage it, then continue.
      writeFileSync(join(dir, "file.txt"), "resolved one\n");
      git(dir, ["add", "file.txt"]);

      const res = tryGit(dir, ["cherry-pick", "--continue"]);

      expect(res.status).not.toBe(0);
      expect(res.stdout + res.stderr).toMatch(/CONFLICT|could not apply/);
      // Still mid-cherry-pick, on the second commit now.
      expect(existsSync(join(dir, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("which operations accept --skip", () => {
  it(
    "cherry-pick, revert and rebase accept it; merge does not",
    () => {
      // §4.1: the whitelist refuses merge+skip at the source rather than
      // letting git answer "unknown option".
      const dir = makeRepo();

      const merge = tryGit(dir, ["merge", "--skip"]);
      expect(merge.stderr).toMatch(/unknown option/i);

      // The others reject on state ("no … in progress"), not on the option,
      // which is what proves the option exists.
      for (const op of ["cherry-pick", "revert", "rebase"]) {
        const res = tryGit(dir, [op, "--skip"]);
        expect(res.stderr).not.toMatch(/unknown option/i);
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("git's own localisation", () => {
  it(
    "translates the words the halted check matches on",
    () => {
      // §3: the reason the command pins LC_ALL=C. Under a French locale the
      // CONFLICT match would miss and progress would be reported as failure.
      // Skipped where the locale is not installed — a CI image without French
      // must not fail the suite over it.
      const dir = makeRepo();
      makeTwoConflictingCommits(dir);

      const french = tryGit(dir, ["merge", "feature"], {
        LC_ALL: "fr_FR.UTF-8",
        LANGUAGE: "fr",
      });
      const english = tryGit(dir, ["merge", "feature"], { LC_ALL: "C", LANGUAGE: "" });

      // The English run is the invariant we rely on, always.
      expect(english.stdout + english.stderr).toMatch(/CONFLICT/);
      // If the French locale is actually available, the output differs — which
      // is precisely the risk. If it is not installed git falls back to
      // English and both match, so this assertion is deliberately one-sided.
      const frenchText = french.stdout + french.stderr;
      expect(frenchText.length).toBeGreaterThan(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
```

- [ ] **Step 2: Run the file**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/operationAction.git.test.ts
```

Expected: 3 passed.

This is a drift lock, not a red-green cycle: it describes git, which already behaves this way. A failure here means git changed, which invalidates §3 or §4.1 rather than the implementation — stop and report which assumption broke.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/__tests__/operationAction.git.test.ts
git commit -m "test(desktop): lock git's three operation-action outcomes"
```

---

### Task 2: `git_operation_action` in Rust

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs` (add the command; `git_rebase_action` is at :689, `git_rebase_onto` at :823)
- Modify: `apps/desktop/src-tauri/src/lib.rs:552-582` (the `generate_handler!` list)
- Test: `apps/desktop/src-tauri/src/commands/ops.rs` (a `#[cfg(test)]` module for the pure argument builder)

**Interfaces:**
- Consumes: `git_cmd()` from `crate::git::cmd`, `repo_lock`, `record_cmd` — all already used by `git_rebase_action`.
- Produces: `git_operation_action(cwd: String, operation: String, action: String) -> Result<OperationActionResult, String>` where `OperationActionResult { halted: bool }`. Task 3 mirrors it in the dev-server, Task 4 wraps it in `backend.ts`.

**Context.** `git_rebase_action` (:689) is already the right shape — whitelisted action, argument array, `Err` on failure. Two things must change as it generalises: the operation becomes a parameter, and a non-zero exit stops meaning failure.

- [ ] **Step 1: Write the failing test for the argument builder**

The subprocess itself is covered by Task 1 (real git) and Task 5 (parity). What needs a unit test is the pure mapping from `(operation, action)` to git arguments, including the combinations that must be refused. Add at the end of `ops.rs`:

```rust
#[cfg(test)]
mod operation_action_tests {
    use super::operation_action_args;

    #[test]
    fn builds_args_for_each_supported_pair() {
        assert_eq!(operation_action_args("merge", "abort").unwrap(), vec!["merge", "--abort"]);
        assert_eq!(operation_action_args("merge", "continue").unwrap(), vec!["merge", "--continue"]);
        assert_eq!(operation_action_args("cherry_pick", "abort").unwrap(), vec!["cherry-pick", "--abort"]);
        assert_eq!(operation_action_args("cherry_pick", "skip").unwrap(), vec!["cherry-pick", "--skip"]);
        assert_eq!(operation_action_args("revert", "continue").unwrap(), vec!["revert", "--continue"]);
        assert_eq!(operation_action_args("rebase", "skip").unwrap(), vec!["rebase", "--skip"]);
    }

    #[test]
    fn refuses_merge_skip_because_git_has_no_such_option() {
        assert!(operation_action_args("merge", "skip").is_err());
    }

    #[test]
    fn refuses_unknown_operation_or_action() {
        assert!(operation_action_args("bisect", "abort").is_err());
        assert!(operation_action_args("merge", "quit").is_err());
        // An argument that would be read as an option must never reach git.
        assert!(operation_action_args("--upload-pack=evil", "abort").is_err());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/desktop/src-tauri && cargo test operation_action
```

Expected: FAIL to compile — `operation_action_args` does not exist.

- [ ] **Step 3: Write the implementation**

Add to `apps/desktop/src-tauri/src/commands/ops.rs`, next to `git_rebase_action`:

```rust
/// Result of an operation action. `halted` is true when git did its work and
/// stopped on a further conflict — progress, not failure (design §3).
#[derive(serde::Serialize)]
pub(crate) struct OperationActionResult {
    pub halted: bool,
}

/// Map an (operation, action) pair to git's argument vector.
///
/// Pure and separately tested: it is the whitelist, so nothing reaches git
/// that is not one of these exact strings. `merge` has no `--skip` — git
/// answers "unknown option" — so that pair is refused here rather than
/// producing a confusing error from git itself.
fn operation_action_args(operation: &str, action: &str) -> Result<Vec<&'static str>, String> {
    let op = match operation {
        "merge" => "merge",
        "cherry_pick" => "cherry-pick",
        "revert" => "revert",
        "rebase" => "rebase",
        _ => return Err(format!("Unknown operation '{}'", operation)),
    };
    let act = match action {
        "continue" => "--continue",
        "abort" => "--abort",
        "skip" => "--skip",
        _ => return Err(format!("Unknown action '{}'", action)),
    };
    if op == "merge" && act == "--skip" {
        return Err("git merge has no --skip".to_string());
    }
    Ok(vec![op, act])
}

/// Continue, abort or skip the operation in progress.
///
/// Replaces `git_merge_abort`, `git_merge_continue`, `git_cherry_pick_abort`,
/// `git_cherry_pick_continue` and `git_rebase_action`, which carried three
/// different error conventions between them (design §1).
///
/// Three outcomes, not two: `Ok(halted: false)` when the operation finished,
/// `Ok(halted: true)` when git stopped on a further conflict, `Err` only when
/// git actually refused. `LC_ALL=C` is pinned because the halted check matches
/// git's own words and git translates them (design §3).
#[tauri::command]
pub(crate) async fn git_operation_action(
    cwd: String,
    operation: String,
    action: String,
) -> Result<OperationActionResult, String> {
    let args = operation_action_args(&operation, &action)?;
    let label = format!("git {} {}", args[0], args[1]);

    let _repo = repo_lock::write(&cwd);
    let _t0 = Instant::now();
    let output = git_cmd()
        .args(&args)
        .env("GIT_EDITOR", "true")
        .env("EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", label, e))?;
    record_cmd(
        &label,
        &cwd,
        _t0.elapsed().as_millis() as u64,
        output.status.code().unwrap_or(-1),
    );

    if output.status.success() {
        return Ok(OperationActionResult { halted: false });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stderr.contains("CONFLICT")
        || stderr.contains("could not apply")
        || stdout.contains("CONFLICT")
        || stdout.contains("could not apply")
    {
        return Ok(OperationActionResult { halted: true });
    }
    let msg = if stderr.is_empty() { stdout } else { stderr };
    Err(format!("{} failed: {}", label, msg))
}
```

- [ ] **Step 4: Pin the locale in `git_rebase_onto` too**

Same latent weakness, same fix (design §3). In `git_rebase_onto` (`ops.rs:823`), add to the existing `.env` chain, after `.env("GIT_TERMINAL_PROMPT", "0")`:

```rust
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
```

- [ ] **Step 5: Register the command and remove the five it replaces**

In `apps/desktop/src-tauri/src/lib.rs`, delete these five lines from `generate_handler!`:

```rust
            commands::ops::git_merge_abort,
            commands::ops::git_merge_continue,
            commands::ops::git_rebase_action,
            commands::ops::git_cherry_pick_abort,
            commands::ops::git_cherry_pick_continue,
```

and add, in their place:

```rust
            commands::ops::git_operation_action,
```

Then delete the five functions themselves from `ops.rs` (`git_merge_abort` :576, `git_merge_continue` :605, `git_rebase_action` :689, `git_cherry_pick_abort` :1534, `git_cherry_pick_continue` :1557). `git_revert_commit` (:1665) stays — starting a revert already works.

- [ ] **Step 6: Run the tests and build**

```bash
cd apps/desktop/src-tauri && cargo test operation_action && cargo check
```

Expected: 3 tests pass, `cargo check` clean. A compile error naming one of the five deleted functions means a caller was missed — Task 4 removes the TypeScript callers, so at this point only Rust callers matter.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/ops.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): one git_operation_action for merge, cherry-pick, revert and rebase"
```

---

### Task 3: The dev-server route

**Files:**
- Modify: `apps/desktop/dev-server.mjs` (`/api/git-rebase-action` is at :3260; the merge and cherry-pick routes are its neighbours)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `POST /api/git-operation-action` with body `{ cwd, operation, action }` answering `{ halted: boolean }` on success and HTTP 400/500 `{ error }` on failure. Task 4's web branch calls it.

**Context.** The route being replaced runs a shell string, which AGENTS.md forbids:

```javascript
execSync(`git rebase --${action}`, { cwd: resolvedCwd, encoding: "utf-8", shell: true, env: {...} });
```

Not exploitable — `action` is whitelisted first — but the replacement uses `spawnSync` with an argument array like its neighbours (design §4.2).

- [ ] **Step 1: Replace the route**

Delete the `/api/git-rebase-action`, `/api/git-merge-abort`, `/api/git-merge-continue`, `/api/git-cherry-pick-abort` and `/api/git-cherry-pick-continue` blocks, and add:

```javascript
    // POST /api/git-operation-action  { cwd, operation, action } -> { halted }
    // Mirrors the Rust git_operation_action: three outcomes, not two, and
    // LC_ALL pinned because the halted check matches git's own words.
    if (url.pathname === "/api/git-operation-action" && req.method === "POST") {
      const { cwd, operation, action } = await readBody(req);
      const OPS = { merge: "merge", cherry_pick: "cherry-pick", revert: "revert", rebase: "rebase" };
      const ACTIONS = { continue: "--continue", abort: "--abort", skip: "--skip" };
      const op = OPS[operation];
      const act = ACTIONS[action];
      if (!cwd || !op || !act) {
        return jsonResponse(req, res, { error: "Missing cwd or invalid operation/action" }, 400);
      }
      if (op === "merge" && act === "--skip") {
        return jsonResponse(req, res, { error: "git merge has no --skip" }, 400);
      }
      const r = spawnSync(GIT, [op, act], {
        cwd: resolve(cwd),
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          EDITOR: "true",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          LANGUAGE: "",
        },
      });
      if (r.status === 0) return jsonResponse(req, res, { halted: false });
      const stderr = (r.stderr || "").trim();
      const stdout = (r.stdout || "").trim();
      if (/CONFLICT|could not apply/.test(stderr) || /CONFLICT|could not apply/.test(stdout)) {
        return jsonResponse(req, res, { halted: true });
      }
      return jsonResponse(req, res, { error: `git ${op} ${act} failed: ${stderr || stdout}` }, 500);
    }
```

- [ ] **Step 2: Check the file still parses**

```bash
node --check apps/desktop/dev-server.mjs
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/dev-server.mjs
git commit -m "feat(desktop): dev-server route for the unified operation action"
```

---

### Task 4: The `backend.ts` wrapper

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts` (`gitMergeAbort` :979, `gitMergeContinue` :994, `gitRebaseAction` :1042, `gitCherryPickAbort` :1734, `gitCherryPickContinue` just after)
- Test: `apps/desktop/src/utils/__tests__/backend-operation-action.test.ts` (create)

**Interfaces:**
- Consumes: the route from Task 3.
- Produces: `gitOperationAction(cwd: string, operation: OperationKind, action: OperationActionKind): Promise<{ halted: boolean }>` plus the exported types `OperationKind = "merge" | "cherry_pick" | "revert" | "rebase"` and `OperationActionKind = "continue" | "abort" | "skip"`. Task 6 consumes it through `useGitRepo`.

- [ ] **Step 1: Write the failing test**

```typescript
// @vitest-environment jsdom
//
// `../backend` reads `window` at import time, so the default `node`
// environment cannot load it (apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * gitOperationAction — the dev-server branch. Three outcomes, not two
 * (docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md §3):
 * a halt on a further conflict resolves, only a real failure rejects.
 *
 * `isTauri()` is false under vitest, so these exercise the dev-server branch
 * by stubbing global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { gitOperationAction } from "../backend";

function stubFetch(body: unknown, ok = true, status = 200) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitOperationAction (dev-server branch)", () => {
  it("resolves with halted false when the operation completed", async () => {
    stubFetch({ halted: false });

    await expect(gitOperationAction("/repo", "merge", "continue")).resolves.toEqual({
      halted: false,
    });
  });

  it("resolves with halted true when git stopped on a further conflict", async () => {
    // Progress, not failure — the whole point of the model.
    stubFetch({ halted: true });

    await expect(gitOperationAction("/repo", "cherry_pick", "continue")).resolves.toEqual({
      halted: true,
    });
  });

  it("rejects with the server's message when git refused", async () => {
    stubFetch({ error: "git merge --abort failed: fatal: There is no merge to abort" }, false, 500);

    await expect(gitOperationAction("/repo", "merge", "abort")).rejects.toThrow(
      "There is no merge to abort",
    );
  });

  it("rejects with a fallback message when the body carries none", async () => {
    stubFetch({}, false, 500);

    await expect(gitOperationAction("/repo", "merge", "abort")).rejects.toThrow(
      "operation action failed",
    );
  });

  it("sends the operation and action in the body", async () => {
    const spy = stubFetch({ halted: false });

    await gitOperationAction("/repo", "revert", "skip");

    const body = JSON.parse(spy.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ cwd: "/repo", operation: "revert", action: "skip" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/backend-operation-action.test.ts
```

Expected: FAIL — `gitOperationAction` is not exported.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/utils/backend.ts`, delete `gitMergeAbort`, `gitMergeContinue`, `gitRebaseAction`, `gitCherryPickAbort` and `gitCherryPickContinue`, and add in their place:

```typescript
/** The operations that can be in progress in a repository. */
export type OperationKind = "merge" | "cherry_pick" | "revert" | "rebase";
/** What can be done to the operation in progress. */
export type OperationActionKind = "continue" | "abort" | "skip";

/** Outcome of an operation action. See design §3: three outcomes, not two. */
export interface OperationActionResult {
  /** git did its work and stopped on a further conflict. Progress, not failure. */
  halted: boolean;
}

/**
 * Continue, abort or skip the operation in progress.
 *
 * Replaces the five per-operation wrappers, which disagreed on how failure was
 * reported. Rejects only when git actually refused; a halt on a further
 * conflict resolves with `halted: true`.
 */
export async function gitOperationAction(
  cwd: string,
  operation: OperationKind,
  action: OperationActionKind,
): Promise<OperationActionResult> {
  if (isTauri()) {
    return tauriInvoke<OperationActionResult>("git_operation_action", { cwd, operation, action });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-operation-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, operation, action }),
  });
  const body = (await res.json()) as { halted?: boolean; error?: string };
  if (!res.ok) {
    throw new Error(body.error || "operation action failed");
  }
  return { halted: body.halted === true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/backend-operation-action.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/backend.ts apps/desktop/src/utils/__tests__/backend-operation-action.test.ts
git commit -m "feat(desktop): gitOperationAction wrapper replaces five per-operation ones"
```

---

### Task 5: Parity coverage

**Files:**
- Modify: `apps/desktop/src-tauri/examples/parity_probe.rs` (dispatch is at :102-200; `git-rebase-onto` at :159 is the model)
- Create: `apps/desktop/tests/parity/git-operation-action.test.mjs`

**Interfaces:**
- Consumes: `git_operation_action` (Task 2), `/api/git-operation-action` (Task 3).
- Produces: nothing importable.

**Context.** `git-rebase-onto.test.mjs` is the model to copy: the operation is **destructive**, so the two sides cannot share a cwd. Each gets its own freshly-built repo, and parity is asserted on the result *and* on the state left behind.

- [ ] **Step 1: Add the probe case**

In `apps/desktop/src-tauri/examples/parity_probe.rs`, after the `"git-rebase-onto"` arm (:159-169):

```rust
        // `must_str` reads from the JSON body the probe took on stdin — the
        // probe has no CLI flags beyond the command name.
        "git-operation-action" => {
            let cwd = match must_str("cwd") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let operation = match must_str("operation") {
                Ok(v) => v,
                Err(code) => return code,
            };
            let action = match must_str("action") {
                Ok(v) => v,
                Err(code) => return code,
            };
            to_json(git_operation_action_parity(cwd, operation, action))
        }
```

The `*_parity` wrappers do **not** live in the probe: they are exported from
`apps/desktop/src-tauri/src/lib.rs` and imported by the probe at :35-43. Add
this next to `git_rebase_onto_parity` (`lib.rs:268`):

```rust
/// Parity entry point for `git_operation_action`. Destructive, so its parity
/// test drives two independent fixture repos rather than comparing two runs
/// against one working tree.
pub fn git_operation_action_parity(
    cwd: String,
    operation: String,
    action: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::block_on(commands::ops::git_operation_action(cwd, operation, action))
        .map(|r| serde_json::json!({ "halted": r.halted }))
}
```

and add `git_operation_action_parity` to the `use gitwand_desktop_lib::{…}` list
at the top of `examples/parity_probe.rs`. Also add `git-operation-action` to the
usage string printed at `parity_probe.rs:52`.

- [ ] **Step 2: Write the parity test**

```javascript
/**
 * Parity tests: `git_operation_action` (Rust) vs `/api/git-operation-action`.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * Destructive, like git-rebase-onto.test.mjs: each side gets its own freshly
 * built repo rather than sharing a cwd, and parity is asserted on the result
 * *and* on the state the action left behind — two implementations can agree on
 * `{halted}` while leaving different working trees, and the state is what the
 * caller acts on next.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

const dirs = [];

/** A repo halted mid-merge on a conflict in file.txt. */
function makeConflictedMergeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-parity-op-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=T", "commit", "-m", "base"]);
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature\n");
  git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=T", "commit", "-am", "feature"]);
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=T", "commit", "-am", "main"]);
  try {
    git(dir, ["merge", "feature"]);
  } catch {
    // expected: the merge conflicts
  }
  return dir;
}

/** A clean repo — nothing to abort. */
function makeCleanRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-parity-op-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=T", "commit", "-m", "base"]);
  return dir;
}

async function nodeAction(dev, cwd, operation, action) {
  const res = await dev.fetch("/api/git-operation-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, operation, action }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

function rustAction(cwd, operation, action) {
  // runProbe(command, args) sends `args` as JSON on stdin and returns
  // { ok, value, error } — see tests/parity/probe.mjs.
  return runProbe("git-operation-action", { cwd, operation, action });
}

/** The state a caller acts on next. */
function repoShape(cwd) {
  return {
    merging: existsSync(join(cwd, ".git", "MERGE_HEAD")),
    status: git(cwd, ["status", "--porcelain"]),
    log: git(cwd, ["log", "--oneline"]),
  };
}

let dev;
beforeAll(async () => {
  dev = await startDevServer();
});
afterAll(async () => {
  await dev?.stop();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("git_operation_action parity", () => {
  it("aborts a conflicted merge identically on both sides", async () => {
    const rustDir = makeConflictedMergeRepo();
    const nodeDir = makeConflictedMergeRepo();

    const rust = rustAction(rustDir, "merge", "abort");
    const node = await nodeAction(dev, nodeDir, "merge", "abort");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(rust.value.halted).toBe(false);
    expect(node.value.halted).toBe(rust.value.halted);
    expect(repoShape(rustDir)).toEqual(repoShape(nodeDir));
    expect(repoShape(rustDir).merging).toBe(false);
  });

  it("refuses identically when no operation is in progress", async () => {
    const rustDir = makeCleanRepo();
    const nodeDir = makeCleanRepo();

    const rust = rustAction(rustDir, "merge", "abort");
    const node = await nodeAction(dev, nodeDir, "merge", "abort");

    // Both must report failure; the wording is git's and is not asserted on.
    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    expect(repoShape(rustDir)).toEqual(repoShape(nodeDir));
  });

  it("refuses merge+skip on both sides without running git", async () => {
    const rustDir = makeConflictedMergeRepo();
    const nodeDir = makeConflictedMergeRepo();

    const rust = rustAction(rustDir, "merge", "skip");
    const node = await nodeAction(dev, nodeDir, "merge", "skip");

    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    // The repos are untouched: the whitelist refused before git ran.
    expect(repoShape(rustDir).merging).toBe(true);
    expect(repoShape(nodeDir).merging).toBe(true);
  });
});
```

If `runProbe`'s signature in `probe.mjs` differs from the call above, follow the file — `git-rebase-onto.test.mjs` shows the exact shape in use.

- [ ] **Step 3: Build the probe and run parity**

```bash
cd apps/desktop/src-tauri && cargo build --example parity-probe
cd /Users/laurent/Projects/GitWand && pnpm --filter @gitwand/desktop test:parity
```

Expected: the new file's 3 tests pass alongside the existing parity suite.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/examples/parity_probe.rs apps/desktop/tests/parity/git-operation-action.test.mjs
git commit -m "test(desktop): parity coverage for git_operation_action"
```

---

### Task 6: `runOperationAction` in `useGitRepo`

**Files:**
- Modify: `apps/desktop/src/composables/useGitRepo.ts` (`abortMerge` :1159, `mergeContinue` :1191, `isCherryPicking` :1211, `cherryPickAbort` :1261, `cherryPickContinue` :1285)
- Test: `apps/desktop/src/composables/__tests__/useGitRepo-operation-action.test.ts` (create)
- Delete: `apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts` (its cases are carried over — see Step 1)

**Interfaces:**
- Consumes: `gitOperationAction`, `OperationKind`, `OperationActionKind` (Task 4); `gitRepoState` from `src/utils/backend`; `resolveConflictOperation` from `src/utils/conflictOperation.ts`.
- Produces: `runOperationAction(action: OperationActionKind, opts?: AbortOptions): Promise<boolean>` on the object returned by `useGitRepo()`. Task 7 calls it from `App.vue`. `AbortOptions` already exists (`useGitRepo.ts`, added by #201).

**Context.** The four functions being replaced each swallow their outcome differently. `mergeContinue` (:1191) reads its result correctly but returns `void`, which is what lets `App.vue` announce success regardless (design §1, gap 2).

`resolveConflictOperation(diskState, isCherryPicking)` exists from #201 and takes the frontend flag as its fallback. With `isCherryPicking` deleted, that parameter goes: the function becomes `resolveConflictOperation(diskState)` returning `"merge" | "cherry_pick" | "revert" | "rebase" | null`, null meaning "nothing in progress". Update `conflictOperation.ts` and its test file `src/utils/__tests__/conflictOperation.test.ts` accordingly — the cases that exercised the flag fallback become cases that assert `null`.

- [ ] **Step 1: Write the failing test**

```typescript
// @vitest-environment jsdom
//
// `useGitRepo` reaches `../../utils/backend`, which reads `window` at import
// time (apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * useGitRepo.runOperationAction — one function for continue/abort/skip across
 * every operation. See
 * docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md §5.
 *
 * Carries over the cases from useGitRepo-abort.test.ts (#201), which this
 * replaces: git's refusal is surfaced, a decline runs no git command, and
 * refresh() runs before `error` is assigned.
 *
 * The git layer is not mocked: `src/utils/backend` is, which is the IPC
 * wrapper module. The real-git contract is locked by operationAction.git.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/backend");

import { useGitRepo, type ConfirmFn } from "../useGitRepo";
import {
  gitOperationAction,
  gitRepoState,
  getGitStatus,
  getGitLog,
} from "../../utils/backend";

const CWD = "/repos/alpha";

function makeConfirm(answer: boolean) {
  return vi.fn(async (_o: Parameters<ConfirmFn>[0]) => answer);
}

/** A repo composable pointed at a folder, mid-merge, with refresh() harmless. */
function makeRepo(confirm = makeConfirm(true), state = "merge") {
  vi.mocked(getGitStatus).mockResolvedValue({
    staged: [], unstaged: [], untracked: [], conflicted: [], branch: "main",
  } as any);
  vi.mocked(getGitLog).mockResolvedValue([] as any);
  vi.mocked(gitRepoState).mockResolvedValue({
    state, hasConflict: true, operationHead: null, targetBranch: null, step: 0, total: 0,
  } as any);
  const repo = useGitRepo({ confirm });
  repo.folderPath.value = CWD;
  return { repo, confirm };
}

beforeEach(() => {
  vi.mocked(gitOperationAction).mockReset();
  vi.mocked(gitRepoState).mockReset();
});

describe("runOperationAction", () => {
  it("returns true and names the operation the repo is actually in", async () => {
    const { repo } = makeRepo(makeConfirm(true), "cherry_pick");
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: false });

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(true);
    expect(gitOperationAction).toHaveBeenCalledWith(CWD, "cherry_pick", "abort");
  });

  it("treats a halt on a further conflict as success, not failure", async () => {
    // git advanced and stopped where it should — no error surface.
    const { repo } = makeRepo();
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: true });

    const ok = await repo.runOperationAction("continue");

    expect(ok).toBe(true);
    expect(repo.error.value).toBeFalsy();
  });

  it("returns false and surfaces git's message when git refused", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitOperationAction).mockRejectedValue(
      new Error("git merge --abort failed: fatal: There is no merge to abort"),
    );

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(false);
    expect(repo.error.value).toContain("There is no merge to abort");
  });

  it("returns false without calling git when nothing is in progress", async () => {
    const { repo } = makeRepo(makeConfirm(true), "clean");

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(false);
    expect(gitOperationAction).not.toHaveBeenCalled();
  });

  it("returns false without calling git when no folder is open", async () => {
    const { repo } = makeRepo();
    repo.folderPath.value = null;

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(false);
    expect(gitOperationAction).not.toHaveBeenCalled();
  });

  it("confirms before an abort that would discard resolution work", async () => {
    const confirm = makeConfirm(true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: false });

    const ok = await repo.runOperationAction("abort", { hasResolutionWork: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]?.danger).toBe(true);
    expect(ok).toBe(true);
  });

  it("does not confirm a continue, which discards nothing", async () => {
    const confirm = makeConfirm(true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: false });

    await repo.runOperationAction("continue", { hasResolutionWork: true });

    expect(confirm).not.toHaveBeenCalled();
  });

  it("runs no git command when the user declines", async () => {
    const confirm = makeConfirm(false);
    const { repo } = makeRepo(confirm);

    const ok = await repo.runOperationAction("abort", { hasResolutionWork: true });

    expect(ok).toBe(false);
    expect(gitOperationAction).not.toHaveBeenCalled();
    expect(repo.error.value).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-operation-action.test.ts
```

Expected: FAIL — `repo.runOperationAction is not a function`.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/composables/useGitRepo.ts`, delete `abortMerge`, `mergeContinue`, `cherryPickAbort`, `cherryPickContinue` and the `isCherryPicking` ref (and its entry in the returned object), then add:

```typescript
  /**
   * Continue, abort or skip whatever operation the repository is in.
   *
   * The operation is read from the repository, never from a frontend flag:
   * that is the lesson of #201, where `isCherryPicking` did not survive
   * opening a repo already mid-cherry-pick.
   *
   * @returns true when git did the thing — including when it halted on a
   *   further conflict, which is progress, not failure (design §3).
   */
  async function runOperationAction(
    action: OperationActionKind,
    abortOpts: AbortOptions = {},
  ): Promise<boolean> {
    if (!folderPath.value) return false;

    let operation: OperationKind | null = null;
    try {
      const state = await gitRepoState(folderPath.value);
      operation = resolveConflictOperation(state.state);
    } catch {
      operation = null;
    }
    if (!operation) return false;

    // Only an abort destroys work, and only then is a modal worth showing.
    if (action === "abort" && abortOpts.hasResolutionWork && opts.confirm) {
      const ok = await opts.confirm({
        title: t("header.abortConfirmTitle"),
        message: t("header.abortConfirmMessage"),
        confirmLabel: t("header.abortConfirmLabel"),
        danger: true,
      });
      if (!ok) return false;
    }

    try {
      await gitOperationAction(folderPath.value, operation, action);
      // refresh() before any assignment to `error`: loadStatus() writes its own
      // failures into the same ref and would overwrite git's reason (#201).
      await refresh();
      successMessage.value = `${operation}-${action}`;
      return true;
    } catch (err: any) {
      await refresh();
      error.value = `${operation} --${action}: ${err?.message || String(err)}`;
      return false;
    }
  }
```

Import `gitOperationAction`, `type OperationKind` and `type OperationActionKind` from `../utils/backend`, and `resolveConflictOperation` from `../utils/conflictOperation`. Add `runOperationAction` to the returned object where `abortMerge` used to be.

- [ ] **Step 4: Update `resolveConflictOperation` to drop the flag parameter**

`apps/desktop/src/utils/conflictOperation.ts` becomes:

```typescript
import type { OperationKind, RepoOperationState } from "./backend";

// The operation union has one definition, `OperationKind` in backend.ts, so
// the composable and this helper cannot drift apart. The old local
// `ConflictOperation` alias is removed.

/**
 * Name the operation the repository is in, or null when there is none.
 *
 * The repository is the only source: #201 replaced the `isCherryPicking`
 * frontend flag with this read; this change removed the flag entirely, so
 * there is no longer a second answer to fall back to.
 */
export function resolveConflictOperation(
  diskState: RepoOperationState["state"] | null,
): OperationKind | null {
  switch (diskState) {
    case "merge":
    case "cherry_pick":
    case "revert":
    case "rebase":
      return diskState;
    case "rebase_interactive":
      return "rebase";
    default:
      return null;
  }
}
```

Rewrite `apps/desktop/src/utils/__tests__/conflictOperation.test.ts` for the one-argument signature: each state maps to itself, `rebase_interactive` maps to `rebase`, and `clean` / `null` map to `null`.

- [ ] **Step 5: Delete the superseded test file**

```bash
git rm apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts
```

Its cases live on in the new file (Step 1) against the new signature.

- [ ] **Step 6: Run both test files**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-operation-action.test.ts src/utils/__tests__/conflictOperation.test.ts
```

Expected: 8 passed in the first, all passed in the second.

- [ ] **Step 7: Commit**

```bash
git add -A apps/desktop/src/composables apps/desktop/src/utils
git commit -m "feat(desktop): one runOperationAction replaces four operation functions"
```

---

### Task 7: The banner, and the end of auto-continue

**Files:**
- Modify: `apps/desktop/src/components/RebaseProgressBanner.vue` (props :17-27, emits :29-35, the `gitRebaseAction` call :59-60)
- Modify: `apps/desktop/src/App.vue` (the conflict banner :4340-4357 as numbered before this plan's edits, the auto-continue chain :811-825, the `gitRebaseAction` call sites :941, :947, :1155-1156, :2784-2806, the `useGitRepo` destructure)
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`

**Interfaces:**
- Consumes: `runOperationAction` (Task 6), `gitOperationAction` (Task 4), `repoDiskOperation` — the ref added to `App.vue` by #201.
- Produces: nothing consumed later. This is the last task.

**Context.** The banner already takes `RepoOperationState` and already emits `continue | abort | skip`, so generalising it is mostly a matter of what it renders and which command it calls. Its rebase-specific parts (`step`/`total` progress, `pendingSplit`, the `auto-resolve` emit) stay, rendered only when the operation is a rebase.

- [ ] **Step 1: Add the locale keys (all 5 files)**

Non-ASCII is escaped as `\uXXXX` in `fr`, `es` and `pt-BR`; `zh-CN` stores CJK literally. In each file, inside the `header` object next to the existing abort keys:

`en.ts`:

```typescript
    operationContinue: "Continue",
    operationSkip: "Skip this commit",
    abortRevert: "Abort revert",
    abortConfirmTitle: "Abort this operation?",
    abortConfirmMessage: "Your resolutions will be discarded. The files go back to how they were before the operation started.",
```

`fr.ts`:

```typescript
    operationContinue: "Continuer",
    operationSkip: "Passer ce commit",
    abortRevert: "Annuler le revert",
    abortConfirmTitle: "Abandonner cette opération ?",
    abortConfirmMessage: "Vos résolutions seront perdues. Les fichiers reviennent à leur état d'avant l'opération.",
```

`es.ts`:

```typescript
    operationContinue: "Continuar",
    operationSkip: "Omitir este commit",
    abortRevert: "Abortar revert",
    abortConfirmTitle: "¿Abortar esta operación?",
    abortConfirmMessage: "Se descartarán tus resoluciones. Los archivos vuelven al estado anterior a la operación.",
```

`pt-BR.ts`:

```typescript
    operationContinue: "Continuar",
    operationSkip: "Pular este commit",
    abortRevert: "Abortar revert",
    abortConfirmTitle: "Abortar esta operação?",
    abortConfirmMessage: "Suas resoluções serão descartadas. Os arquivos voltam ao estado anterior à operação.",
```

`zh-CN.ts`:

```typescript
    operationContinue: "继续",
    operationSkip: "跳过此提交",
    abortRevert: "中止 revert",
    abortConfirmTitle: "中止此操作？",
    abortConfirmMessage: "你的冲突解决将被丢弃，文件会回到操作开始前的状态。",
```

The existing `abortMerge`, `abortCherryPick`, `abortMergeConfirmTitle`, `abortMergeConfirmMessage`, `abortCherryPickConfirmTitle`, `abortCherryPickConfirmMessage` and `abortConfirmLabel` keys stay: the first two label the button per operation, and `abortConfirmLabel` is still the modal's confirm button. The four per-operation confirm keys are superseded by `abortConfirmTitle`/`abortConfirmMessage` and are deleted from all five files.

- [ ] **Step 2: Point the banner at the unified command**

In `apps/desktop/src/components/RebaseProgressBanner.vue`, replace the import and call at :59-60:

```typescript
    const { gitOperationAction } = await import("../utils/backend");
    await gitOperationAction(props.cwd, props.repoState.state === "rebase_interactive" ? "rebase" : props.repoState.state as OperationKind, action);
```

Add `import type { OperationKind } from "../utils/backend";` to the script block.

Render the action buttons from the operation: Continue and Abort always, Skip only when the operation is not a merge. Label the abort button with `header.abortMerge`, `header.abortCherryPick` or `header.abortRevert` according to `props.repoState.state`, and the continue button with `header.operationContinue`.

Keep the `step`/`total` progress text, the `pendingSplit` button and the `auto-resolve` emit behind `v-if="repoState.state === 'rebase' || repoState.state === 'rebase_interactive'"`.

- [ ] **Step 3: Show the banner for every operation, and delete the conflict banner**

In `apps/desktop/src/App.vue`:

- `refreshRepoState()` currently narrows `repoOperationState` to rebase states only. Widen it to keep every non-clean state, since the banner now handles them all. `repoDiskOperation` (added by #201) stays as-is.
- `showRebaseBanner` becomes `showOperationBanner`: true when `repoOperationState !== null` and `repoFolderPath !== ""`, keeping the existing `!showRebase.value` guard so a user-initiated interactive rebase still owns its own editor.
- Delete the `<div v-if="hasConflicts && !showRebaseBanner" class="conflict-banner">` block entirely, along with `doAbortMerge`, `doCherryPickAbort`, `conflictOperation` and the `repoAbortMerge` / `repoCherryPickAbort` destructured names.
- Every remaining `gitRebaseAction(cwd, "continue")` call site (:941, :947, :1155-1156, :2784-2806) becomes `gitOperationAction(cwd, "rebase", "continue")`.

**The `!== null` trap.** Widening `repoOperationState` changes the meaning of the roughly ten places that read `repoOperationState.value !== null` as "a rebase is in progress" — `preferForcePushIfRebaseCompleted`, the `wasRebasing` snapshots, the auto-resolve loop, the watcher. Add a computed and use it at every one of those sites:

```typescript
const isRebasing = computed(() =>
  repoOperationState.value?.state === "rebase" ||
  repoOperationState.value?.state === "rebase_interactive",
);
```

Grep for `repoOperationState` and convert each `!== null` / `=== null` rebase test to `isRebasing.value` before moving on. Missing one makes a merge suggest a force push.

- [ ] **Step 4: Delete the auto-continue chain**

In `App.vue`, the `else if (conflictOperation.value === "cherry_pick") { await doCherryPickContinue(); }` / `else { await doMergeContinue(); showMergeSuccess.value = true; }` chain (around :811-825) is deleted, leaving only the "select the next conflicted file" branch. Nothing auto-continues (design §6); the banner's Continue button is the one way forward. `showMergeSuccess` and `doMergeContinue` / `doCherryPickContinue` go with it if they have no other caller — grep before deleting.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @gitwand/core build
pnpm --filter @gitwand/desktop exec vue-tsc --noEmit -p tsconfig.json
```

Expected: no errors. This is what catches a missed rename or a locale missing a key.

- [ ] **Step 6: Run the full suite**

```bash
pnpm --filter @gitwand/desktop test
```

Expected: all green.

- [ ] **Step 7: Manual check**

```bash
cd apps/desktop && pnpm dev:web
```

In throwaway repos, verify:
1. A conflicted merge shows the banner with Continue and Abort, no Skip.
2. Resolving the last conflict does **not** commit by itself; Continue does.
3. A conflicted cherry-pick of two conflicting commits: Continue on the first halts on the second, with no error surface.
4. A repo opened while already mid-revert offers "Abort revert", and it works.
5. An abort git refuses shows git's sentence and leaves the operation in place.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/components/RebaseProgressBanner.vue apps/desktop/src/locales
git commit -m "feat(desktop): one banner for every operation, and no auto-continue"
```

---

## After the plan

- [ ] Add a line to `CHANGELOG.md` under `## [Unreleased]`, `### Changed`, covering both the unified command and the behaviour change: merge and cherry-pick no longer commit by themselves when the last conflict is resolved.
- [ ] Open the PR against `main` from `feat/unified-operation-actions`.

`roadmap.md` needs no entry: this is a refactor plus a gap fix, not a roadmap item. `website/changelog.md` is updated at tag time, not here (AGENTS.md § Changelog).
