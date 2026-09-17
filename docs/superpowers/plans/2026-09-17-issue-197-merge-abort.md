# Abort merge truthfulness (issue #197) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitWand's "Abort merge" and "Abort cherry-pick" report what git actually did, confirm before discarding resolution work, and leave no stale state behind when they succeed.

**Architecture:** The two abort functions in `useGitRepo` stop discarding their result and return `Promise<boolean>`. `App.vue` reads that boolean to decide whether to clear `useGitWand`'s resolution state and leave the changes view. One backend wrapper (`gitCherryPickAbort`) gets its web branch aligned with its Tauri branch so both fail the same way. No Rust change.

**Tech Stack:** Vue 3 `<script setup>` + Composition API, TypeScript, Vitest (node environment), real temporary git repos for contract tests.

**Spec:** `docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md`

## Global Constraints

- **Package manager is pnpm only.** Never `npm`, never `yarn`.
- **Never call `invoke()` outside `src/utils/backend.ts`.** All IPC goes through that module (AGENTS.md § IPC).
- **Every user-visible string needs a key in all 5 locales:** `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`. `en` is the default. No hardcoded text in templates.
- **Never mock the git layer in tests.** Tests that need git spin up a real temporary repo and clean it up (AGENTS.md § Testing). Mocking `src/utils/backend` — the IPC wrapper module — is not mocking git and is allowed.
- **Vitest environment is `node` by default.** A file that genuinely touches `document`/`window` adds `// @vitest-environment jsdom` at the top. None of the files in this plan need it.
- **Do not edit version fields by hand** (`package.json`, `Cargo.toml`, `tauri.conf.json`). Nothing in this plan touches them.
- **New Vue components use `<script setup>`.** This plan adds none.
- **Run the desktop test suite with:** `pnpm --filter @gitwand/desktop test` (the package name is `@gitwand/desktop`, not `gitwand-desktop`). A single file: `pnpm --filter @gitwand/desktop exec vitest run <path> -t "<name>"`.

## Prerequisite

The workspace must have a complete `pnpm install` (`apps/desktop/node_modules/.bin/vitest` exists). If it does not, run `pnpm install` at the repo root before Task 1 — the test commands in every task depend on it.

If that install dies with `ERR_PNPM_EPERM ... mkdir '.../iconv-lite_tmp_*/.idea/codeStyles'`, it is the agent sandbox refusing to create a `.idea` directory, not a broken lockfile: one of the tarballs ships one. Re-run the install outside the sandbox.

---

### Task 1: Lock the git behaviours the design relies on

This task adds no product code. It writes down, against real git, the four facts the rest of the plan assumes — that a failing abort is distinguishable from a succeeding one, and that the "entry not uptodate" refusal is real. If a future git changes one of them, this file fails loudly instead of the app silently mis-reporting.

**Files:**
- Test: `apps/desktop/src/composables/__tests__/mergeAbort.git.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. It documents git's contract for Tasks 2–4.

- [ ] **Step 1: Write the test file**

Modelled on `apps/desktop/src/composables/__tests__/pullAutostash.git.test.ts` — same env hygiene, same 60s timeout, real repos in `mkdtempSync`.

```typescript
/**
 * Real-git contract tests for `git merge --abort` and `git cherry-pick --abort`
 * — the drift lock for the design in
 * docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md (§3.1, §3.3,
 * §3.6). Every assertion documents a git behaviour the implementation
 * (`abortMerge` / `cherryPickAbort` in useGitRepo.ts) depends on: chiefly that a
 * refused abort is distinguishable from a successful one by exit code, which is
 * what the frontend reads through `GitPushPullResult.success`.
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
// Real git subprocesses. 60s matches the other git-backed suites: a timeout
// here exists to catch a hang, not to enforce a performance budget.
const GIT_TEST_TIMEOUT_MS = 60_000;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    // Same hygiene as tests/parity/fixtures.mjs — no ambient user config.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_EDITOR: "true",
    EDITOR: "true",
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

/** Runs git and never throws — callers assert on the exit code themselves. */
function tryGit(cwd: string, args: string[]): GitResult {
  const res = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-abort-"));
  dirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

/**
 * Leaves `dir` in a conflicted merge of `feature` into `main`, both branches
 * having changed the same line of file.txt.
 */
function makeConflictedMerge(dir: string): void {
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "feature\n");
  git(dir, ["commit", "-am", "feature change"]);
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "file.txt"), "main\n");
  git(dir, ["commit", "-am", "main change"]);
  const merge = tryGit(dir, ["merge", "feature"]);
  // Sanity: the fixture must actually produce a conflict.
  expect(merge.status).not.toBe(0);
  expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe("git merge --abort", () => {
  it(
    "exits 0 and clears MERGE_HEAD during a conflicted merge",
    () => {
      const dir = makeRepo();
      makeConflictedMerge(dir);

      const res = tryGit(dir, ["merge", "--abort"]);

      expect(res.status).toBe(0);
      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exits non-zero and writes to stderr when no merge is in progress",
    () => {
      const dir = makeRepo();

      const res = tryGit(dir, ["merge", "--abort"]);

      expect(res.status).not.toBe(0);
      expect(res.stderr.trim()).not.toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exits non-zero when an untracked file would be overwritten by the abort",
    () => {
      // §3.3: git refuses an abort it cannot perform without destroying work,
      // and says so on stderr. The assertion is on the exit code and a
      // non-empty stderr, never on git's exact wording, which varies by
      // version.
      const dir = makeRepo();
      git(dir, ["checkout", "-b", "feature"]);
      writeFileSync(join(dir, "file.txt"), "feature\n");
      writeFileSync(join(dir, "extra.txt"), "from feature\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "feature adds extra.txt"]);
      git(dir, ["checkout", "main"]);
      writeFileSync(join(dir, "file.txt"), "main\n");
      git(dir, ["commit", "-am", "main change"]);
      const merge = tryGit(dir, ["merge", "feature"]);
      expect(merge.status).not.toBe(0);
      // extra.txt came in with the merge; make it untracked-and-dirty so the
      // abort cannot cleanly undo the merge.
      git(dir, ["rm", "--cached", "extra.txt"]);
      writeFileSync(join(dir, "extra.txt"), "edited by hand\n");

      const res = tryGit(dir, ["merge", "--abort"]);

      expect(res.status).not.toBe(0);
      expect(res.stderr.trim()).not.toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe("git cherry-pick --abort", () => {
  it(
    "exits non-zero when no sequencer is in progress",
    () => {
      // §3.6: this case is why the web path of gitCherryPickAbort must fail
      // the way the Tauri path does — it is reachable from the UI whenever
      // isCherryPicking has drifted from the repo.
      const dir = makeRepo();

      const res = tryGit(dir, ["cherry-pick", "--abort"]);

      expect(res.status).not.toBe(0);
      expect(res.stderr.trim()).not.toBe("");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "exits 0 and clears the sequencer during a conflicted cherry-pick",
    () => {
      const dir = makeRepo();
      git(dir, ["checkout", "-b", "feature"]);
      writeFileSync(join(dir, "file.txt"), "feature\n");
      git(dir, ["commit", "-am", "feature change"]);
      const featureSha = git(dir, ["rev-parse", "HEAD"]).trim();
      git(dir, ["checkout", "main"]);
      writeFileSync(join(dir, "file.txt"), "main\n");
      git(dir, ["commit", "-am", "main change"]);
      const pick = tryGit(dir, ["cherry-pick", featureSha]);
      expect(pick.status).not.toBe(0);

      const res = tryGit(dir, ["cherry-pick", "--abort"]);

      expect(res.status).toBe(0);
      expect(existsSync(join(dir, ".git", "sequencer"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
```

- [ ] **Step 2: Run the file and confirm every test passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/mergeAbort.git.test.ts
```

Expected: 5 passed.

This is a drift lock, not a red-green cycle: it describes git, which already
behaves this way. If a test fails here, git does **not** behave as the spec
assumes — stop and report which assumption broke, because it invalidates §3.1
or §3.3 rather than the implementation.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/composables/__tests__/mergeAbort.git.test.ts
git commit -m "test(desktop): lock git's abort exit codes for issue #197"
```

---

### Task 2: `gitCherryPickAbort`'s web path fails like its Tauri path

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts:1734-1744`
- Test: `apps/desktop/src/utils/__tests__/backend-cherry-pick-abort.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `gitCherryPickAbort(cwd: string): Promise<void>` — unchanged signature; now rejects with `Error(message)` when the dev-server reports `success: false`. Task 4 relies on this rejection.

**Context.** The function currently is:

```typescript
export async function gitCherryPickAbort(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_cherry_pick_abort", { cwd });
    return;
  }
  await devFetch(`${DEV_SERVER}/api/git-cherry-pick-abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}
```

The dev-server route (`apps/desktop/dev-server.mjs:3119`) answers HTTP 200 with
`{ success: false, message }` on a failing abort. The body is discarded, so in
web mode the failure vanishes. The Tauri command returns `Err`, so
`tauriInvoke` rejects and that branch is already correct.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * gitCherryPickAbort — the dev-server branch must reject on a failed abort,
 * matching the Tauri branch (whose Rust command returns Err). See
 * docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md §3.6.
 *
 * `isTauri()` is false under vitest (no __TAURI_INTERNALS__ on globalThis), so
 * these tests exercise the dev-server branch by stubbing global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { gitCherryPickAbort } from "../backend";

function stubFetch(body: unknown) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitCherryPickAbort (dev-server branch)", () => {
  it("rejects with the server's message when the abort failed", async () => {
    stubFetch({ success: false, message: "error: no cherry-pick in progress" });

    await expect(gitCherryPickAbort("/repo")).rejects.toThrow(
      "error: no cherry-pick in progress",
    );
  });

  it("resolves when the abort succeeded", async () => {
    stubFetch({ success: true, message: "Cherry-pick aborted" });

    await expect(gitCherryPickAbort("/repo")).resolves.toBeUndefined();
  });

  it("rejects with a fallback message when the body carries none", async () => {
    stubFetch({ success: false });

    await expect(gitCherryPickAbort("/repo")).rejects.toThrow(
      "cherry-pick --abort failed",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/backend-cherry-pick-abort.test.ts
```

Expected: the first and third tests FAIL — the promise resolves instead of rejecting. The second passes already.

- [ ] **Step 3: Write the implementation**

Replace the body of `gitCherryPickAbort` in `apps/desktop/src/utils/backend.ts` with:

```typescript
export async function gitCherryPickAbort(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_cherry_pick_abort", { cwd });
    return;
  }
  // The dev-server answers 200 with { success: false, message } on a failing
  // abort, where the Rust command returns Err. Throwing here is what keeps a
  // single failure path for both backends (design §3.6).
  const res = await devFetch(`${DEV_SERVER}/api/git-cherry-pick-abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  const body = (await res.json()) as { success?: boolean; message?: string };
  if (!body.success) {
    throw new Error(body.message || "cherry-pick --abort failed");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/utils/__tests__/backend-cherry-pick-abort.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/backend.ts apps/desktop/src/utils/__tests__/backend-cherry-pick-abort.test.ts
git commit -m "fix(desktop): gitCherryPickAbort rejects on a failed abort in web mode"
```

---

### Task 3: `abortMerge` reports what git did

**Files:**
- Modify: `apps/desktop/src/composables/useGitRepo.ts:1141-1151`
- Test: `apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts` (create)

**Interfaces:**
- Consumes: `gitMergeAbort(cwd): Promise<GitPushPullResult>` from `src/utils/backend.ts`, where `GitPushPullResult` is `{ success: boolean; message: string; conflicts?: boolean }`.
- Produces: `abortMerge(opts?: { hasResolutionWork?: boolean }): Promise<boolean>` on the object returned by `useGitRepo()`. Task 4 extends the same signature to `cherryPickAbort`; Task 6 consumes the boolean in `App.vue`.

**Context.** The function currently is:

```typescript
  /** Abort an in-progress merge. */
  async function abortMerge() {
    if (!folderPath.value) return;
    try {
      await gitMergeAbort(folderPath.value);
      successMessage.value = "merge-aborted";
      await refresh();
    } catch (err: any) {
      error.value = `abort merge: ${err?.message || String(err)}`;
    }
  }
```

`git_merge_abort` (`src-tauri/src/commands/ops.rs:576`) returns `Ok` with
`success: false` on a failing git, so the `catch` never sees a refused abort.

**Ordering trap.** `refresh()` → `loadStatus()` swallows its own failure into
`error.value` (`useGitRepo.ts:421-429`). Setting `error` *before* `refresh()`
lets a status failure overwrite git's abort message. Every failure path in this
task and the next therefore runs `refresh()` **first** and assigns `error`
**after**.

The `confirm` gate is added in Task 5; this task defines the `opts` parameter
and ignores its value, so the signature stops moving after this point.

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * useGitRepo — abort paths for issue #197. One case per decision in
 * docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md §3.
 *
 * The git layer is not mocked here: `src/utils/backend` is, which is the IPC
 * wrapper module, not git. The real-git contract these tests assume (a refused
 * abort exits non-zero, which the backend surfaces as success: false) is locked
 * by mergeAbort.git.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/backend");

import { useGitRepo } from "../useGitRepo";
import {
  gitMergeAbort,
  getGitStatus,
  getGitLog,
} from "../../utils/backend";

const CWD = "/repos/alpha";

/** A repo composable already pointed at a folder, with refresh() harmless. */
function makeRepo(confirm = vi.fn(async () => true)) {
  vi.mocked(getGitStatus).mockResolvedValue({
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    branch: "main",
  } as any);
  vi.mocked(getGitLog).mockResolvedValue([] as any);
  const repo = useGitRepo({ confirm });
  repo.folderPath.value = CWD;
  return { repo, confirm };
}

beforeEach(() => {
  vi.mocked(gitMergeAbort).mockReset();
});

describe("abortMerge", () => {
  it("returns true and sets the toast when git aborted", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: true,
      message: "Merge aborted",
    } as any);

    const ok = await repo.abortMerge();

    expect(ok).toBe(true);
    expect(repo.successMessage.value).toBe("merge-aborted");
    expect(repo.error.value).toBeFalsy();
  });

  it("returns false and surfaces git's message when git refused", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: false,
      message: "error: Entry 'a.txt' not uptodate. Cannot merge.",
    } as any);

    const ok = await repo.abortMerge();

    expect(ok).toBe(false);
    expect(repo.successMessage.value).not.toBe("merge-aborted");
    expect(repo.error.value).toContain("not uptodate");
  });

  it("returns false and surfaces the error when the IPC call rejects", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitMergeAbort).mockRejectedValue(new Error("ipc down"));

    const ok = await repo.abortMerge();

    expect(ok).toBe(false);
    expect(repo.error.value).toContain("ipc down");
  });

  it("returns false without calling git when no folder is open", async () => {
    const { repo } = makeRepo();
    repo.folderPath.value = null;

    const ok = await repo.abortMerge();

    expect(ok).toBe(false);
    expect(gitMergeAbort).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-abort.test.ts
```

Expected: the first three FAIL. `abortMerge` currently returns `undefined`, so `expect(ok).toBe(true)` fails, and the refusal case sets `successMessage` anyway.

The harness itself is known to work: `useGitRepo` had no test before this plan,
so it was verified separately that `vi.mock("../../utils/backend")` (vitest's
automock, which turns all ~45 exports into `vi.fn()`) lets the composable
instantiate, and that `abortMerge` runs through `refresh()` without throwing
when `getGitStatus` and `getGitLog` are stubbed as above. If a *different*
backend function turns out to be needed, add it to `makeRepo`'s stubs. Do not
weaken the assertions.

- [ ] **Step 3: Write the implementation**

Replace `abortMerge` in `apps/desktop/src/composables/useGitRepo.ts`:

```typescript
  /**
   * Abort an in-progress merge.
   *
   * @returns true only when git actually aborted. `git_merge_abort` returns
   *   Ok with `success: false` when git refuses (e.g. "Entry not uptodate"),
   *   so the field has to be read: a rejected promise is not the only failure.
   *   The caller needs the boolean to decide whether to drop resolution state.
   */
  async function abortMerge(_opts: AbortOptions = {}): Promise<boolean> {
    if (!folderPath.value) return false;
    try {
      const result = await gitMergeAbort(folderPath.value);
      // refresh() first on every path: loadStatus() writes its own failure
      // into `error`, so assigning `error` before it would let a status
      // failure overwrite git's reason for refusing.
      await refresh();
      if (!result.success) {
        error.value = `abort merge: ${result.message || "unknown error"}`;
        return false;
      }
      successMessage.value = "merge-aborted";
      return true;
    } catch (err: any) {
      error.value = `abort merge: ${err?.message || String(err)}`;
      return false;
    }
  }
```

And add the options type next to `ConfirmFn` (`useGitRepo.ts:74-80`), after the `ConfirmFn` declaration:

```typescript
/** Options shared by the abort paths (design §3.1). */
export interface AbortOptions {
  /**
   * True when a successful abort would discard resolution work the user has
   * done, which is what makes the confirmation worth showing. App.vue passes
   * `useGitWand`'s `canUndo`.
   */
  hasResolutionWork?: boolean;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-abort.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useGitRepo.ts apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts
git commit -m "fix(desktop): abortMerge reports git's refusal instead of a success toast"
```

---

### Task 4: `cherryPickAbort` reports what git did and stops lying about the mode

**Files:**
- Modify: `apps/desktop/src/composables/useGitRepo.ts:1216-1227`
- Test: `apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts` (append)

**Interfaces:**
- Consumes: `gitCherryPickAbort(cwd): Promise<void>` from Task 2 — it now rejects in both backends. `AbortOptions` from Task 3.
- Produces: `cherryPickAbort(opts?: AbortOptions): Promise<boolean>`.

**Context.** The function currently is:

```typescript
  async function cherryPickAbort() {
    if (!folderPath.value) return;
    try {
      await gitCherryPickAbort(folderPath.value);
      successMessage.value = "cherry-pick-aborted";
      await refresh();
    } catch (err: any) {
      error.value = `cherry-pick abort: ${err?.message ?? err}`;
    } finally {
      isCherryPicking.value = false;
    }
  }
```

The `finally` clears `isCherryPicking` even when the abort failed, so the banner
stops offering "Abort cherry-pick" for a cherry-pick still on disk (design §3.4).

- [ ] **Step 1: Write the failing test**

Append to `useGitRepo-abort.test.ts`. Extend its import list from `../../utils/backend` with `gitCherryPickAbort`, and add to the top-level `beforeEach`: `vi.mocked(gitCherryPickAbort).mockReset();`

```typescript
describe("cherryPickAbort", () => {
  it("returns true, sets the toast and leaves cherry-pick mode on success", async () => {
    const { repo } = makeRepo();
    repo.isCherryPicking.value = true;
    vi.mocked(gitCherryPickAbort).mockResolvedValue(undefined);

    const ok = await repo.cherryPickAbort();

    expect(ok).toBe(true);
    expect(repo.successMessage.value).toBe("cherry-pick-aborted");
    expect(repo.isCherryPicking.value).toBe(false);
  });

  it("stays in cherry-pick mode when the abort failed", async () => {
    const { repo } = makeRepo();
    repo.isCherryPicking.value = true;
    vi.mocked(gitCherryPickAbort).mockRejectedValue(
      new Error("error: no cherry-pick in progress"),
    );

    const ok = await repo.cherryPickAbort();

    expect(ok).toBe(false);
    expect(repo.isCherryPicking.value).toBe(true);
    expect(repo.error.value).toContain("no cherry-pick in progress");
    expect(repo.successMessage.value).not.toBe("cherry-pick-aborted");
  });

  it("returns false without calling git when no folder is open", async () => {
    const { repo } = makeRepo();
    repo.folderPath.value = null;

    const ok = await repo.cherryPickAbort();

    expect(ok).toBe(false);
    expect(gitCherryPickAbort).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-abort.test.ts -t "cherryPickAbort"
```

Expected: the first two FAIL — `undefined` is returned instead of a boolean, and the failing case clears `isCherryPicking`.

- [ ] **Step 3: Write the implementation**

Replace `cherryPickAbort` in `apps/desktop/src/composables/useGitRepo.ts`:

```typescript
  /**
   * Abort an in-progress cherry-pick.
   *
   * @returns true only when git actually aborted. `isCherryPicking` is cleared
   *   on that branch alone — a failed abort leaves the sequencer on disk, and
   *   dropping the flag would make the banner offer "Abort merge" for a
   *   cherry-pick that is still in progress (design §3.4).
   */
  async function cherryPickAbort(_opts: AbortOptions = {}): Promise<boolean> {
    if (!folderPath.value) return false;
    try {
      await gitCherryPickAbort(folderPath.value);
      await refresh();
      successMessage.value = "cherry-pick-aborted";
      isCherryPicking.value = false;
      return true;
    } catch (err: any) {
      await refresh();
      error.value = `cherry-pick abort: ${err?.message ?? err}`;
      return false;
    }
  }
```

- [ ] **Step 4: Run the whole file to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-abort.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useGitRepo.ts apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts
git commit -m "fix(desktop): cherryPickAbort keeps cherry-pick mode when git refuses"
```

---

### Task 5: Confirm before an abort that would discard resolution work

**Files:**
- Modify: `apps/desktop/src/composables/useGitRepo.ts` (both abort functions from Tasks 3 and 4)
- Modify: `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`
- Test: `apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts` (append)

**Interfaces:**
- Consumes: `opts.confirm` — the `ConfirmFn` already injected into `useGitRepo` (`useGitRepo.ts:92`), typed `(opts: { title, message, confirmLabel?, cancelLabel?, danger? }) => Promise<boolean>`. `AbortOptions.hasResolutionWork` from Task 3.
- Produces: no new exports. The `_opts` parameters of Tasks 3 and 4 become `opts` and are read.

**Context.** The pattern to follow is `deleteBranch` (`useGitRepo.ts:1431`), which
already gates a destructive action behind the injected modal:

```typescript
      if (!force && /not fully merged/i.test(msg) && opts.confirm) {
        const ok = await opts.confirm({
          title: t("branchMenu.deleteModalTitle"),
          message: t("branchMenu.forceDeleteConfirm", name),
          confirmLabel: t("branchMenu.deleteModalConfirm"),
          danger: true,
        });
```

Note the name collision: `opts` is already the *composable's* options object
(holding `confirm`). Name the per-call parameter `abortOpts` so both stay
reachable.

- [ ] **Step 1: Add the locale keys (all 5 files)**

The strings below are written with their real characters for readability. Match
the file you are editing: `fr.ts`, `es.ts` and `pt-BR.ts` escape non-ASCII Latin
as `\uXXXX` (e.g. `"Merge annul\u00e9"` at `fr.ts:87`), while `zh-CN.ts` stores
CJK literally.

In `apps/desktop/src/locales/en.ts`, inside the `header` object, right after `abortCherryPick` (line 96):

```typescript
    abortMergeConfirmTitle: "Abort this merge?",
    abortMergeConfirmMessage: "Your resolutions for this merge will be discarded. The files go back to how they were before the merge started.",
    abortCherryPickConfirmTitle: "Abort this cherry-pick?",
    abortCherryPickConfirmMessage: "Your resolutions for this cherry-pick will be discarded. The files go back to how they were before it started.",
    abortConfirmLabel: "Abort",
```

`fr.ts`, after `abortCherryPick` (line 90):

```typescript
    abortMergeConfirmTitle: "Annuler ce merge ?",
    abortMergeConfirmMessage: "Vos résolutions pour ce merge seront perdues. Les fichiers reviennent à leur état d'avant le merge.",
    abortCherryPickConfirmTitle: "Annuler ce cherry-pick ?",
    abortCherryPickConfirmMessage: "Vos résolutions pour ce cherry-pick seront perdues. Les fichiers reviennent à leur état d'avant.",
    abortConfirmLabel: "Abandonner",
```

`abortConfirmLabel` is "Abandonner" and not "Annuler": the modal's own cancel
button already reads "Annuler" (`common.cancel`), and two buttons both saying
"Annuler" — one of which aborts the merge — is the worst possible pair.

`es.ts`, after `abortCherryPick` (line 96):

```typescript
    abortMergeConfirmTitle: "¿Abortar este merge?",
    abortMergeConfirmMessage: "Se descartarán tus resoluciones de este merge. Los archivos vuelven al estado anterior al merge.",
    abortCherryPickConfirmTitle: "¿Abortar este cherry-pick?",
    abortCherryPickConfirmMessage: "Se descartarán tus resoluciones de este cherry-pick. Los archivos vuelven al estado anterior.",
    abortConfirmLabel: "Abortar",
```

`pt-BR.ts`, after `abortCherryPick` (line 97):

```typescript
    abortMergeConfirmTitle: "Abortar este merge?",
    abortMergeConfirmMessage: "Suas resoluções deste merge serão descartadas. Os arquivos voltam ao estado anterior ao merge.",
    abortCherryPickConfirmTitle: "Abortar este cherry-pick?",
    abortCherryPickConfirmMessage: "Suas resoluções deste cherry-pick serão descartadas. Os arquivos voltam ao estado anterior.",
    abortConfirmLabel: "Abortar",
```

`zh-CN.ts`, after `abortCherryPick` (line 101):

```typescript
    abortMergeConfirmTitle: "中止此次合并？",
    abortMergeConfirmMessage: "你对本次合并的冲突解决将被丢弃，文件会回到合并开始前的状态。",
    abortCherryPickConfirmTitle: "中止此次 cherry-pick？",
    abortCherryPickConfirmMessage: "你对本次 cherry-pick 的冲突解决将被丢弃，文件会回到开始前的状态。",
    abortConfirmLabel: "中止",
```

- [ ] **Step 2: Write the failing test**

Append to `useGitRepo-abort.test.ts`:

```typescript
describe("abort confirmation", () => {
  it("asks before a merge abort that would discard resolution work", async () => {
    const confirm = vi.fn(async () => true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: true,
      message: "Merge aborted",
    } as any);

    const ok = await repo.abortMerge({ hasResolutionWork: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].danger).toBe(true);
    expect(ok).toBe(true);
  });

  it("does not ask when there is no resolution work", async () => {
    const confirm = vi.fn(async () => true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: true,
      message: "Merge aborted",
    } as any);

    await repo.abortMerge();
    await repo.abortMerge({ hasResolutionWork: false });

    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns false and runs no git command when the user declines", async () => {
    const confirm = vi.fn(async () => false);
    const { repo } = makeRepo(confirm);

    const ok = await repo.abortMerge({ hasResolutionWork: true });

    expect(ok).toBe(false);
    expect(gitMergeAbort).not.toHaveBeenCalled();
    expect(repo.error.value).toBeFalsy();
  });

  it("asks before a cherry-pick abort that would discard resolution work", async () => {
    const confirm = vi.fn(async () => false);
    const { repo } = makeRepo(confirm);
    repo.isCherryPicking.value = true;

    const ok = await repo.cherryPickAbort({ hasResolutionWork: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
    expect(gitCherryPickAbort).not.toHaveBeenCalled();
    // Declining is not a failed abort — the mode flag must not move.
    expect(repo.isCherryPicking.value).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-abort.test.ts -t "abort confirmation"
```

Expected: the tests that assert `confirm` was called FAIL — nothing calls it yet.

- [ ] **Step 4: Write the implementation**

In `abortMerge`, rename `_opts` to `abortOpts` and insert the gate as the first thing after the folder check:

```typescript
  async function abortMerge(abortOpts: AbortOptions = {}): Promise<boolean> {
    if (!folderPath.value) return false;
    // Only worth a modal when there is something to lose (design §3.2). The
    // signal is useGitWand's `canUndo`, handed down by App.vue.
    if (abortOpts.hasResolutionWork && opts.confirm) {
      const ok = await opts.confirm({
        title: t("header.abortMergeConfirmTitle"),
        message: t("header.abortMergeConfirmMessage"),
        confirmLabel: t("header.abortConfirmLabel"),
        danger: true,
      });
      if (!ok) return false;
    }
    try {
```

The rest of the function is unchanged.

In `cherryPickAbort`, the same, with the cherry-pick keys:

```typescript
  async function cherryPickAbort(abortOpts: AbortOptions = {}): Promise<boolean> {
    if (!folderPath.value) return false;
    if (abortOpts.hasResolutionWork && opts.confirm) {
      const ok = await opts.confirm({
        title: t("header.abortCherryPickConfirmTitle"),
        message: t("header.abortCherryPickConfirmMessage"),
        confirmLabel: t("header.abortConfirmLabel"),
        danger: true,
      });
      if (!ok) return false;
    }
    try {
```

The rest of the function is unchanged. `t` is already imported at
`useGitRepo.ts` from `./useI18n`.

- [ ] **Step 5: Run the whole file to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitRepo-abort.test.ts
```

Expected: 11 passed.

- [ ] **Step 6: Type-check the locales**

```bash
pnpm --filter @gitwand/desktop exec vue-tsc --noEmit -p tsconfig.json
```

Expected: no errors. A key present in `en.ts` but missing from another locale surfaces here.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/useGitRepo.ts apps/desktop/src/composables/__tests__/useGitRepo-abort.test.ts apps/desktop/src/locales
git commit -m "feat(desktop): confirm an abort that would discard resolution work"
```

---

### Task 6: `useGitWand.reset()`

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts` (add `reset`, export it in the returned object at line 1317)
- Test: `apps/desktop/src/composables/__tests__/useGitWand-reset.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `reset(): void` on the object returned by `useGitWand()`. Task 7 calls it from `App.vue`.

**Context.** The state to clear (`useGitWand.ts:372`, `391-392`, and the
`selectedPath` ref that backs the `selectedFile` computed at line 469):

```typescript
  const files = ref<ConflictFile[]>([]);
  const undoStack = ref<Snapshot[]>([]);
  const redoStack = ref<Snapshot[]>([]);
  const selectedFile = computed(() =>
    files.value.find((f) => f.path === selectedPath.value) ?? null,
  );
```

- [ ] **Step 1: Write the failing test**

```typescript
/**
 * useGitWand.reset() — clearing resolution state once the merge it belonged to
 * is gone. See docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md
 * §3.5: without it, `canUndo` stays true after a successful abort and points at
 * resolutions for a merge that no longer exists.
 */
import { describe, it, expect } from "vitest";

import { useGitWand } from "../useGitWand";

const CONFLICTED = [
  "line one",
  "<<<<<<< HEAD",
  "ours",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "line last",
  "",
].join("\n");

/**
 * A composable seeded the way a half-resolved merge leaves it: one conflicted
 * file, one hunk already resolved. `resolveHunkManual` is what pushes the undo
 * snapshot, and it touches no backend — it rewrites `files` in memory — so
 * `canUndo` here is true for the same reason it is true in the app.
 */
async function seededGitWand() {
  const gw = useGitWand();
  (gw.files as any).value = [
    {
      path: "a.txt",
      content: CONFLICTED,
      result: { resolutions: [], mergedContent: CONFLICTED },
    },
  ];
  await gw.resolveHunkManual("a.txt", 0, "ours");
  return gw;
}

describe("useGitWand.reset", () => {
  it("clears files, the selection and both history stacks", async () => {
    const gw = await seededGitWand();
    gw.selectFile("a.txt");
    expect(gw.files.value.length).toBe(1);
    expect(gw.canUndo.value).toBe(true);

    gw.reset();

    expect(gw.files.value).toEqual([]);
    expect(gw.selectedFile.value).toBeNull();
    expect(gw.canUndo.value).toBe(false);
    expect(gw.canRedo.value).toBe(false);
  });

  it("clears the redo stack too", async () => {
    const gw = await seededGitWand();
    gw.undo();
    expect(gw.canRedo.value).toBe(true);

    gw.reset();

    expect(gw.canRedo.value).toBe(false);
  });

  it("is safe to call on an already-empty state", () => {
    const gw = useGitWand();
    gw.reset();
    gw.reset();

    expect(gw.files.value).toEqual([]);
    expect(gw.canUndo.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitWand-reset.test.ts
```

Expected: FAIL with `gw.reset is not a function`.

- [ ] **Step 3: Write the implementation**

In `apps/desktop/src/composables/useGitWand.ts`, next to `undo`/`redo` (after the `redo` function, around line 417):

```typescript
  /**
   * Drop every trace of the current resolution session.
   *
   * Called when the merge or cherry-pick the state described has been aborted
   * (design §3.5). Without it `canUndo` stays true and the undo stack holds
   * snapshots of files whose conflict no longer exists.
   */
  function reset() {
    files.value = [];
    selectedPath.value = null;
    undoStack.value = [];
    redoStack.value = [];
  }
```

If `selectedPath` is typed `Ref<string>` rather than `Ref<string | null>`, set
it to `""` instead and leave the type alone — `selectedFile` resolves to `null`
either way, which is what the test asserts.

Add `reset,` to the returned object (`useGitWand.ts:1317-1343`), next to `undo`
and `redo`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @gitwand/desktop exec vitest run src/composables/__tests__/useGitWand-reset.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts apps/desktop/src/composables/__tests__/useGitWand-reset.test.ts
git commit -m "feat(desktop): useGitWand.reset() drops resolution state"
```

---

### Task 7: Wire App.vue — pass the signal, use the answer, name the toasts

**Files:**
- Modify: `apps/desktop/src/App.vue:285` and `:287` (destructure), `:758-766` (toast map), and add two handlers near `askConfirm` (`:3202`)
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` (two toast keys)

**Interfaces:**
- Consumes: `abortMerge(opts?: AbortOptions): Promise<boolean>` and `cherryPickAbort(opts?: AbortOptions): Promise<boolean>` (Tasks 3–5); `reset(): void` (Task 6); `canUndo` — already destructured from `useGitWand()` at `App.vue:197`; `viewMode`, a `Ref<ViewMode>` from `useGitRepo`, where `ViewMode` includes `"graph"`.
- Produces: nothing consumed by later tasks. This is the last one.

**Context.** The template binds the composable functions directly:

```
              <button v-if="isCherryPicking" class="conflict-abort-btn" @click="doCherryPickAbort">
              <button v-else class="conflict-abort-btn" @click="doAbortMerge">
```

So the destructured names are renamed and `doAbortMerge` / `doCherryPickAbort`
become local wrappers — the template stays untouched, which is what keeps this
from silently skipping the reset on a call site nobody noticed.

- [ ] **Step 1: Rename the destructured functions**

In `apps/desktop/src/App.vue`, in the `useGitRepo` destructure, change line 285 and line 287:

```typescript
  abortMerge: repoAbortMerge,
  cherryPick: doCherryPick,
  cherryPickAbort: repoCherryPickAbort,
```

- [ ] **Step 2: Add the wrapper handlers**

Immediately after `askConfirm` (`App.vue:3219`, the closing brace of that function):

```typescript
/**
 * Abort the merge, then — only if git actually aborted — drop the resolution
 * state it belonged to and leave the changes view, which now has nothing to
 * show. `canUndo` is the "there is work to lose" signal that decides whether
 * the composable asks for confirmation first (design §3.2, §3.5).
 */
async function doAbortMerge() {
  const aborted = await repoAbortMerge({ hasResolutionWork: canUndo.value });
  if (!aborted) return;
  mergeReset();
  viewMode.value = "graph";
}

async function doCherryPickAbort() {
  const aborted = await repoCherryPickAbort({ hasResolutionWork: canUndo.value });
  if (!aborted) return;
  mergeReset();
  viewMode.value = "graph";
}
```

- [ ] **Step 3: Import `reset` from `useGitWand`**

In the `useGitWand()` destructure (`App.vue:191-215`), next to `undo,` and `redo,`, add:

```typescript
  reset: mergeReset,
```

It is aliased because `App.vue` already has several `reset`-ish local names; `mergeReset` says which state it clears.

- [ ] **Step 4: Name the two cherry-pick toasts**

In the `meta` map (`App.vue:758-766`), add two entries after `"merge-aborted"`:

```typescript
    "cherry-pick-done": { key: "header.cherryPickDone" },
    "cherry-pick-aborted": { key: "header.cherryPickAborted" },
```

Without these, the fallback at line 768 (`successToast.value = info ? t(...) : val`) prints the raw slug.

Then add the keys to all five locales, right after `mergeAborted`:

- `en.ts` (after line 93): `cherryPickDone: "Cherry-pick completed",` and `cherryPickAborted: "Cherry-pick aborted",`
- `fr.ts` (after line 87): `cherryPickDone: "Cherry-pick terminé",` and `cherryPickAborted: "Cherry-pick annulé",`
- `es.ts` (after line 93): `cherryPickDone: "Cherry-pick completado",` and `cherryPickAborted: "Cherry-pick abortado",`
- `pt-BR.ts` (after line 94): `cherryPickDone: "Cherry-pick concluído",` and `cherryPickAborted: "Cherry-pick abortado",`
- `zh-CN.ts` (after line 98): `cherryPickDone: "cherry-pick 已完成",` and `cherryPickAborted: "cherry-pick 已中止",`

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @gitwand/desktop exec vue-tsc --noEmit -p tsconfig.json
```

Expected: no errors. This is the check that catches a missed rename — if the
template still referenced the old binding, or a locale is missing a key, it
fails here.

- [ ] **Step 6: Run the full desktop suite**

```bash
pnpm --filter @gitwand/desktop test
```

Expected: all green, including the two new composable files and the git-backed one.

- [ ] **Step 7: Manual check**

```bash
cd apps/desktop && pnpm dev:web
```

In a scratch repo, stage a conflicting merge, resolve one hunk, then click "Abort merge":
1. The confirmation appears (there is resolution work).
2. Confirming clears the conflict banner and lands on the graph view; the toast says "Merge aborted".
3. Repeat without resolving anything: no confirmation.
4. Repeat with an uncommitted edit git refuses to overwrite: no toast, git's own sentence in the error surface, and the conflict banner stays.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/locales
git commit -m "fix(desktop): clear resolution state and leave the merge view on a real abort"
```

---

## After the plan

- [ ] Add a line to `CHANGELOG.md` under `## [Unreleased]`, `### Fixed`: "Abort merge and abort cherry-pick now report git's refusal instead of a success toast, ask before discarding resolution work, and clear the resolution state when they succeed (#197)."
- [ ] Open the PR against `main` from `fix/197-merge-abort-silent-failure`.

`roadmap.md` needs no entry: this is a bug fix, not a roadmap item. The
`website/changelog.md` mirror is updated at tag time, not here (AGENTS.md
§ Changelog).
