# PR Badge Background Prefetch & Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Branch badges (`#<number>` on branches with an open PR) reflect open PRs beyond the current hard cap of 10, via a git-log-style (PR #113) background prefetch + in-memory cache, without multiplying the cost of the Rust layer's naive `offset+limit` pagination.

**Architecture:** `usePrPanel.ts`'s `ensurePrsLoaded()` gets a background drain loop (`prefetchOpenPrs()`, idle-scheduled, bigger page jumps) that continues past the first page, plus a per-session in-memory `PR_LIST_CACHE` keyed by repo. A new lightweight Rust command (`gh_pr_freshness_signal`) lets the cache be validated cheaply (one small GitHub call) instead of redrained on every repo visit. Non-GitHub forges get the drain (the actual breadth fix) but not the instant-cache-restore shortcut.

**Tech Stack:** Vue 3 Composition API (`<script setup>` not applicable — plain composables), Vitest/jsdom, Rust (Tauri 2 commands), Node `dev-server.mjs` (browser dev-mode backend mock).

## Global Constraints

- Package manager: pnpm only (never npm/yarn) — `apps/desktop/package.json`'s `test` script is `vitest run`.
- No shell string interpolation for any spawned process — always `.arg()`/`.args([...])` per argument (`AGENTS.md`).
- Every new `#[tauri::command]` needs its typed TypeScript wrapper (in `backend-pr.ts`, following this PR-domain's existing convention) **and** a `dev-server.mjs` route in the same change (`AGENTS.md`, `apps/desktop/CLAUDE.md`).
- No unconditional polling — this feature adds no new `setInterval`; the prefetch loop is a bounded, self-terminating drain, not a poll (`apps/desktop/CLAUDE.md` perf invariants).
- No hardcoded user-facing strings — N/A for this plan: no new UI copy is introduced (pure data-fetching change).
- `packages/core` must stay Node-free — N/A, this plan never touches `packages/core`.
- Never edit version files by hand — N/A, this plan doesn't touch versioning.
- Diff-parsing space-prefix gotcha — N/A, no diff parsing in this plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/utils/idleSchedule.ts` (new) | Shared `whenIdle()` helper — idle-scheduled resume so background work never blocks input. Extracted out of `useGitRepo.ts` so `usePrPanel.ts` can reuse the exact same scheduling primitive instead of duplicating it. |
| `apps/desktop/src/utils/__tests__/idleSchedule.test.ts` (new) | Unit tests for `whenIdle()`. |
| `apps/desktop/src/composables/useGitRepo.ts` (modify) | Remove the inline `whenIdle()` definition, import the shared one instead. No behavior change. |
| `apps/desktop/src/composables/usePrPanel.ts` (modify) | Core of this feature: generalized `loadMorePrs(pageSize)`, new `prefetchOpenPrs()` background drain, new in-memory `PR_LIST_CACHE`, rewritten `ensurePrsLoaded()` fast path, cache invalidation in `createPr()`/`mergePr()`. |
| `apps/desktop/src/composables/__tests__/usePrPanel.test.ts` (new) | Unit tests for the drain loop, cache restore, invalidation, and cancellation. |
| `apps/desktop/src-tauri/src/types.rs` (modify) | New `PrFreshnessSignal` struct. |
| `apps/desktop/src-tauri/src/commands/github_api.rs` (modify) | New `rest_pr_freshness_signal()` (REST/token path) + pure, unit-tested `top_pr_from_rest_json()` helper. |
| `apps/desktop/src-tauri/src/commands/gh.rs` (modify) | New `gh_pr_freshness_signal` Tauri command (branches token vs `gh` CLI) + pure, unit-tested `top_pr_from_cli_json()` helper. |
| `apps/desktop/src-tauri/src/lib.rs` (modify) | Register the new command in `invoke_handler!`. |
| `apps/desktop/src/utils/backend-pr.ts` (modify) | New `ghPrFreshnessSignal()` typed wrapper + `PrFreshnessSignal` TS interface. |
| `apps/desktop/src/utils/__tests__/backend-pr.test.ts` (modify) | New tests for `ghPrFreshnessSignal()`, appended to the existing file (same mocking convention already used there for `ghCurrentUser`). |
| `apps/desktop/dev-server.mjs` (modify) | New `GET /api/gh-pr-freshness` route mirroring the Rust command, for browser dev-mode (`pnpm dev:web`). |

Task order: the shared idle util (Task 1) and the core drain loop (Task 2) land first since they fix the actual user-reported bug (breadth) and need no Rust changes. The Rust command + wrapper + route (Tasks 3–6) come next. The in-memory cache + freshness fast path + invalidation (Task 7) lands last since it depends on both the drain loop and the TS wrapper.

---

### Task 1: Shared idle-scheduling helper

**Files:**
- Create: `apps/desktop/src/utils/idleSchedule.ts`
- Modify: `apps/desktop/src/composables/useGitRepo.ts:1` (add import), `apps/desktop/src/composables/useGitRepo.ts:626-633` (delete the inline `whenIdle` definition)
- Test: `apps/desktop/src/utils/__tests__/idleSchedule.test.ts`

**Interfaces:**
- Produces: `whenIdle(): Promise<void>` — resolves on `requestIdleCallback` (timeout 300ms) if available, else `setTimeout(resolve, 32)`. Used by Task 2's `prefetchOpenPrs()`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/utils/__tests__/idleSchedule.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { whenIdle } from "../idleSchedule";

describe("whenIdle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves via requestIdleCallback when available", async () => {
    const ric = vi.fn((cb: () => void) => cb());
    vi.stubGlobal("requestIdleCallback", ric);
    await whenIdle();
    expect(ric).toHaveBeenCalledTimes(1);
  });

  it("falls back to setTimeout when requestIdleCallback is unavailable", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    await expect(whenIdle()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm test -- src/utils/__tests__/idleSchedule.test.ts`
Expected: FAIL — `Cannot find module '../idleSchedule'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/utils/idleSchedule.ts`:

```ts
/**
 * Resolve on the next idle slice so background paging never blocks input.
 * Falls back to a short timeout when `requestIdleCallback` isn't available
 * (older browsers, some webview engines).
 */
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void;
    }).requestIdleCallback;
    if (typeof ric === "function") ric(() => resolve(), { timeout: 300 });
    else setTimeout(resolve, 32);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm test -- src/utils/__tests__/idleSchedule.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `useGitRepo.ts` to use the shared helper**

In `apps/desktop/src/composables/useGitRepo.ts`, change line 1 from:

```ts
import { ref, computed, watch } from "vue";
```

to:

```ts
import { ref, computed, watch } from "vue";
import { whenIdle } from "../utils/idleSchedule";
```

Then delete the inline definition at lines 626-633:

```ts
  /** Resolve on the next idle slice so background paging never blocks input. */
  function whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (typeof ric === "function") ric(() => resolve(), { timeout: 300 });
      else setTimeout(resolve, 32);
    });
  }

```

(Delete the whole block including the doc comment and the trailing blank line — `prefetchAllPages()` right below it, which calls `whenIdle()`, is otherwise unchanged.)

- [ ] **Step 6: Verify nothing broke**

Run: `cd apps/desktop && pnpm test`
Expected: PASS — same pass count as before this change (no test exercises `useGitRepo.ts`'s prefetch directly today, so this is primarily a compile/typecheck check). Also run:

Run: `cd apps/desktop && pnpm build`
Expected: PASS — `vue-tsc` typecheck succeeds (confirms the import resolves and no unused-import lint fires on the removed inline function).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/utils/idleSchedule.ts apps/desktop/src/utils/__tests__/idleSchedule.test.ts apps/desktop/src/composables/useGitRepo.ts
git commit -m "refactor: extract whenIdle() into a shared idleSchedule util"
```

---

### Task 2: Background prefetch drain loop for PR badges

**Files:**
- Modify: `apps/desktop/src/composables/usePrPanel.ts` (imports, constants near line 180, `loadMorePrs` at lines 484-516, new `prefetchOpenPrs`, `ensurePrsLoaded` at lines 1060-1077)
- Test: Create `apps/desktop/src/composables/__tests__/usePrPanel.test.ts`

**Interfaces:**
- Consumes: `whenIdle()` from Task 1 (`../utils/idleSchedule`).
- Produces: `prefetchOpenPrs(): Promise<void>` (module-internal, not part of the composable's returned object) — later consumed by Task 7's cache-write logic. `loadMorePrs(pageSize: number = PAGE_SIZE): Promise<void>` — same exported name/behavior as today when called with no argument (existing scroll-driven callers are unaffected).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/usePrPanel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";

vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(async () => null),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
}));

const listPRs = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs })),
  githubProvider: { name: "github", listPRs },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";

function makePr(n: number) {
  return {
    number: n, title: `PR ${n}`, state: "open", author: "me", branch: `feat-${n}`,
    base: "main", draft: false, createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", url: `https://x/${n}`, additions: 0,
    deletions: 0, labels: [], assignees: [], reviewRequested: [], reviewDecision: "",
    mergeStateStatus: "", checksRollup: "", commentCount: 0,
  };
}

/** Simulates the Rust layer's naive `offset+limit` pagination over `total` PRs. */
function pagedListPRs(total: number) {
  return vi.fn(async (_cwd: string, opts: { limit: number; offset: number }) => {
    const { limit, offset } = opts;
    if (offset >= total) return [];
    const count = Math.min(limit, total - offset);
    return Array.from({ length: count }, (_, i) => makePr(offset + i + 1));
  });
}

describe("usePrPanel — background prefetch drain", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains beyond the first PAGE_SIZE=10 page in the background", async () => {
    listPRs.mockImplementation(pagedListPRs(45));
    const panel = usePrPanel(ref("/repo"));
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(panel.hasMore.value).toBe(true);

    await vi.advanceTimersByTimeAsync(40); // one whenIdle() tick → a BG_PAGE=100 hop

    expect(panel.prs.value).toHaveLength(45);
    expect(panel.hasMore.value).toBe(false);
  });

  it("stops the drain when the repo changes mid-prefetch", async () => {
    listPRs.mockImplementation(pagedListPRs(500));
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    await panel.ensurePrsLoaded();
    expect(panel.prs.value).toHaveLength(10);
    expect(listPRs).toHaveBeenCalledTimes(1);

    cwd.value = "/repo-b";
    await nextTick(); // let the cwd watcher reset state before the drain resumes
    await vi.advanceTimersByTimeAsync(40);

    // The stale prefetch for /repo-a must not issue a second call.
    expect(listPRs).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm test -- src/composables/__tests__/usePrPanel.test.ts`
Expected: FAIL on the first test — `panel.prs.value` has length 10 but never grows to 45 (no background drain exists yet), timeout or assertion failure.

- [ ] **Step 3: Generalize `loadMorePrs` to accept a page size**

In `apps/desktop/src/composables/usePrPanel.ts`, replace the `loadMorePrs` function (currently lines 484-516):

```ts
  async function loadMorePrs() {
    if (!cwd.value || loadingMore.value || !hasMore.value || loading.value || refreshing.value) return;
    if (!(await requireOnline("gh pr list (more)"))) {
      hasMore.value = false;
      return;
    }
    loadingMore.value = true;
    try {
      const page = await forge.value.listPRs(cwd.value, { state: filterState.value, limit: PAGE_SIZE, offset: prs.value.length });
      if (page.length === 0) {
        hasMore.value = false;
      } else {
        const seen = new Set(prs.value.map((p) => p.number));
        for (const pr of page) {
          if (!seen.has(pr.number)) prs.value.push(pr);
        }
        hasMore.value = page.length >= PAGE_SIZE;
      }
    } catch (e) {
      console.warn("[usePrPanel] loadMorePrs failed:", e);
      hasMore.value = false;
    } finally {
      loadingMore.value = false;
    }
  }
```

with:

```ts
  async function loadMorePrs(pageSize: number = PAGE_SIZE) {
    if (!cwd.value || loadingMore.value || !hasMore.value || loading.value || refreshing.value) return;
    if (!(await requireOnline("gh pr list (more)"))) {
      hasMore.value = false;
      return;
    }
    loadingMore.value = true;
    try {
      const page = await forge.value.listPRs(cwd.value, { state: filterState.value, limit: pageSize, offset: prs.value.length });
      if (page.length === 0) {
        hasMore.value = false;
      } else {
        const seen = new Set(prs.value.map((p) => p.number));
        for (const pr of page) {
          if (!seen.has(pr.number)) prs.value.push(pr);
        }
        hasMore.value = page.length >= pageSize;
      }
    } catch (e) {
      console.warn("[usePrPanel] loadMorePrs failed:", e);
      hasMore.value = false;
    } finally {
      loadingMore.value = false;
    }
  }
```

(Only `PAGE_SIZE` → `pageSize` param, in the signature and the two usages inside the body. Every existing call site calls `loadMorePrs()` with no argument, so behavior is unchanged for them.)

- [ ] **Step 4: Add prefetch constants and `prefetchOpenPrs()`**

In `apps/desktop/src/composables/usePrPanel.ts`, add the import at the top (near the other relative imports, e.g. right after the `usePrCache` import):

```ts
import { usePrCache, listKey, detailKey } from "./usePrCache";
import { whenIdle } from "../utils/idleSchedule";
```

Then, right after the existing pagination block (currently lines 171-182):

```ts
  const PAGE_SIZE = 10;
  const hasMore = ref(true);
  const loadingMore = ref(false);
```

add:

```ts

  // ─── Background prefetch (badge path) ───────────────────────────────────
  // Bigger than PAGE_SIZE so the naive offset+limit Rust pagination
  // (gh_list_prs_inner / rest_list_prs re-fetch offset+limit items from
  // scratch on every call) issues only a handful of background round trips
  // instead of one per 10 PRs.
  const BG_PAGE = 100;
  // Ceiling on the automatic background drain — matches the dev-server REST
  // route's existing 3x100-page cap. Beyond this the badge path just has
  // partial coverage for that repo; ensurePrsLoaded() keeps retrying on
  // future calls rather than falsely treating an incomplete list as done.
  const PREFETCH_CEILING = 300;
  let _prPrefetchToken = 0;
```

Then add the new function right after `loadMorePrs`:

```ts

  /**
   * Lazily drain the rest of the open-PR list in the background after the
   * first page paints, so branch badges cover more than PAGE_SIZE PRs.
   * Idle-scheduled (never blocks input) and cancellable if the repo changes
   * or the filter leaves "open" mid-drain.
   */
  async function prefetchOpenPrs() {
    if (filterState.value !== "open") return;
    const token = ++_prPrefetchToken;
    const repo = cwd.value;
    if (!repo) return;
    const live = () =>
      cwd.value === repo && token === _prPrefetchToken && filterState.value === "open";
    while (live() && hasMore.value && prs.value.length < PREFETCH_CEILING) {
      await whenIdle();
      if (!live()) return;
      await loadMorePrs(BG_PAGE);
    }
  }
```

- [ ] **Step 5: Wire the drain into `ensurePrsLoaded()`**

In `apps/desktop/src/composables/usePrPanel.ts`, change the `ensurePrsLoaded` function (currently lines 1066-1077) from:

```ts
  async function ensurePrsLoaded() {
    if (!cwd.value || _prsEnsured || prs.value.length > 0) return;
    _prsEnsured = true;
    const cachedRemote = cache.getRemote(cwd.value);
    if (cachedRemote) {
      remote.value = cachedRemote.remote;
      loadRemote();
    } else {
      await loadRemote();
    }
    await loadPrs();
  }
```

to:

```ts
  async function ensurePrsLoaded() {
    if (!cwd.value || _prsEnsured || prs.value.length > 0) return;
    _prsEnsured = true;
    const cachedRemote = cache.getRemote(cwd.value);
    if (cachedRemote) {
      remote.value = cachedRemote.remote;
      loadRemote();
    } else {
      await loadRemote();
    }
    await loadPrs();
    void prefetchOpenPrs();
  }
```

(Task 7 will rewrite this function further to add the in-memory cache fast path — this step only adds the drain.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/desktop && pnpm test -- src/composables/__tests__/usePrPanel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/composables/usePrPanel.ts apps/desktop/src/composables/__tests__/usePrPanel.test.ts
git commit -m "fix: drain open-PR pages in the background so branch badges aren't capped at 10"
```

---

### Task 3: Rust — `PrFreshnessSignal` struct + REST freshness helper

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs` (insert after line 359, the end of the `PullRequest` struct)
- Modify: `apps/desktop/src-tauri/src/commands/github_api.rs` (new functions after `rest_list_prs`, currently ending at line 504; new tests in the existing `#[cfg(test)] mod tests` block, currently starting at line 1527)

**Interfaces:**
- Produces: `pub struct PrFreshnessSignal { number: i64, updated_at: String, open_count: i64 }` (types.rs). `pub(crate) fn rest_pr_freshness_signal(cwd: &str, token: &str) -> Result<Option<PrFreshnessSignal>, String>` (github_api.rs) — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src-tauri/src/commands/github_api.rs`, inside the existing `#[cfg(test)] mod tests { use super::*; use serde_json::json;` block (starts at line 1527), add these two tests right after the `bearer_config_keeps_token_in_header_directive` test (the last one in the file):

```rust
    #[test]
    fn top_pr_from_rest_json_reads_first_sorted_entry() {
        let raw = vec![
            json!({"number": 88, "updated_at": "2026-07-09T10:00:00Z"}),
            json!({"number": 3, "updated_at": "2026-01-01T00:00:00Z"}),
        ];
        assert_eq!(
            top_pr_from_rest_json(&raw),
            Some((88, "2026-07-09T10:00:00Z".to_string()))
        );
    }

    #[test]
    fn top_pr_from_rest_json_empty_list_is_none() {
        assert_eq!(top_pr_from_rest_json(&[]), None);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test top_pr_from_rest_json`
Expected: FAIL — compile error, `cannot find function 'top_pr_from_rest_json' in this scope`.

- [ ] **Step 3: Implement the struct and the REST helper**

In `apps/desktop/src-tauri/src/types.rs`, insert this right after the `PullRequest` struct's closing brace (after line 359, before the `GhPrAuthor` struct):

```rust

/// Cheap signal used to detect whether a repo's open-PR list has changed
/// since it was last fully drained and cached (`usePrPanel.ts`'s
/// `PR_LIST_CACHE`), without re-fetching the whole list. Two facts, since
/// neither alone catches every kind of change: the most-recently-updated
/// open PR (catches edits/comments/new PRs) and the open PR count (catches
/// a PR closing, which drops it out of the "state=open" results entirely
/// without changing who's "most recently updated").
#[derive(Serialize)]
pub struct PrFreshnessSignal {
    pub number: i64,
    pub updated_at: String,
    pub open_count: i64,
}
```

In `apps/desktop/src-tauri/src/commands/github_api.rs`, insert this right after `rest_list_prs`'s closing brace (after line 504, before the `rest_rollup_for_sha` doc comment):

```rust

/// Pure extraction of `(number, updated_at)` from a REST `GET .../pulls` JSON
/// array already sorted `updated desc` — the first element is the signal.
/// Split out from `rest_pr_freshness_signal` so it's unit-testable without an
/// HTTP call (mirrors `json_to_pr`'s separation of parsing from I/O).
fn top_pr_from_rest_json(raw: &[serde_json::Value]) -> Option<(i64, String)> {
    let top = raw.first()?;
    let updated_at = js(top, "updated_at");
    if updated_at.is_empty() {
        return None;
    }
    Some((ji(top, "number"), updated_at))
}

/// Cheap "has the open-PR list changed?" probe: the single most-recently
/// updated open PR (`per_page=1&sort=updated&direction=desc`, no per-PR
/// enrichment — unlike `rest_list_prs` this never calls the detail/check-runs
/// endpoints) plus the open PR count (`rest_pr_count`, already a single
/// `/search/issues` call). `Ok(None)` means the repo currently has zero open
/// PRs.
pub(crate) fn rest_pr_freshness_signal(cwd: &str, token: &str) -> Result<Option<PrFreshnessSignal>, String> {
    let base = base_owner_repo(cwd, token).unwrap_or_else(|_| {
        let (o, r) = owner_repo(cwd).unwrap_or_default();
        format!("{}/{}", o, r)
    });
    let raw: Vec<serde_json::Value> = api_json_cached(
        &format!(
            "{}/repos/{}/pulls?state=open&per_page=1&page=1&sort=updated&direction=desc",
            API_BASE, base
        ),
        token,
    )?
    .as_array()
    .cloned()
    .unwrap_or_default();
    let (number, updated_at) = match top_pr_from_rest_json(&raw) {
        Some(pair) => pair,
        None => return Ok(None),
    };
    let open_count = rest_pr_count(cwd, "open", token)?;
    Ok(Some(PrFreshnessSignal { number, updated_at, open_count }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test top_pr_from_rest_json`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify the crate still builds**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: PASS — no warnings about `rest_pr_freshness_signal` being unused yet is expected (Rust warns on unused `pub(crate)` items only if truly unreferenced anywhere; Task 4 references it in the same build before this is committed, so build the two tasks' code together if warnings appear here).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/types.rs apps/desktop/src-tauri/src/commands/github_api.rs
git commit -m "feat(rust): add PrFreshnessSignal + REST freshness probe for PR badge cache"
```

---

### Task 4: Rust — `gh` CLI freshness helper, Tauri command, registration

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/gh.rs` (new functions after `gh_pr_count`, currently ending at line 250; new test module at end of file, after line 1401)
- Modify: `apps/desktop/src-tauri/src/lib.rs:400` (register the command)

**Interfaces:**
- Consumes: `github_api::rest_pr_freshness_signal` (Task 3), `github_api::settings_github_token()`, `gh_fork_upstream()`, `gh_pr_count_inner()`, `hidden_cmd()` (all pre-existing in this file).
- Produces: `#[tauri::command] pub(crate) async fn gh_pr_freshness_signal(cwd: String) -> Result<Option<PrFreshnessSignal>, String>` — consumed by Task 5's TS wrapper via IPC name `"gh_pr_freshness_signal"`.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src-tauri/src/commands/gh.rs`, append this new test module at the end of the file (after the closing brace of the existing `gh_list_issues_tests` module, i.e. at the very end of the file, past line 1401):

```rust

#[cfg(test)]
mod gh_pr_freshness_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn top_pr_from_cli_json_reads_first_entry() {
        let raw = vec![json!({"number": 12, "updatedAt": "2026-07-09T09:00:00Z"})];
        assert_eq!(
            top_pr_from_cli_json(&raw),
            Some((12, "2026-07-09T09:00:00Z".to_string()))
        );
    }

    #[test]
    fn top_pr_from_cli_json_empty_list_is_none() {
        assert_eq!(top_pr_from_cli_json(&[]), None);
    }

    #[test]
    fn top_pr_from_cli_json_missing_updated_at_is_none() {
        let raw = vec![json!({"number": 12})];
        assert_eq!(top_pr_from_cli_json(&raw), None);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test top_pr_from_cli_json`
Expected: FAIL — compile error, `cannot find function 'top_pr_from_cli_json' in this scope`.

- [ ] **Step 3: Implement the CLI helper and the command**

In `apps/desktop/src-tauri/src/commands/gh.rs`, insert this right after `gh_pr_count`'s closing brace (after line 250, before `gh_create_pr_inner`):

```rust

/// Pure extraction of `(number, updated_at)` from `gh pr list --json
/// number,updatedAt` output (already `--limit 1 -S "sort:updated-desc"`
/// sorted) — the gh CLI's JSON keys are camelCase, unlike the REST API's
/// snake_case, so this can't share `top_pr_from_rest_json` in github_api.rs.
fn top_pr_from_cli_json(raw: &[serde_json::Value]) -> Option<(i64, String)> {
    let top = raw.first()?;
    let updated_at = top.get("updatedAt").and_then(|v| v.as_str())?.to_string();
    let number = top.get("number").and_then(|v| v.as_i64())?;
    Some((number, updated_at))
}

fn gh_pr_freshness_signal_inner(cwd: String) -> Result<Option<PrFreshnessSignal>, String> {
    if let Some(tok) = github_api::settings_github_token() {
        return github_api::rest_pr_freshness_signal(&cwd, &tok);
    }
    // No sort flag is used by the main gh_list_prs_inner list fetch (its
    // order doesn't matter there) — this probe needs updated-desc
    // specifically, via a `-S` search-query sort, requested only here.
    let target_repo = gh_fork_upstream(&cwd);
    let mut cmd = hidden_cmd("gh");
    cmd.args([
        "pr", "list",
        "--state", "open",
        "--json", "number,updatedAt",
        "--limit", "1",
        "-S", "sort:updated-desc",
    ]);
    if let Some(ref nwo) = target_repo {
        cmd.args(["--repo", nwo]);
    }
    let output = cmd
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run gh pr list (freshness signal): {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr list (freshness signal) failed: {}", stderr));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: Vec<serde_json::Value> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse freshness signal output: {}", e))?;
    let (number, updated_at) = match top_pr_from_cli_json(&raw) {
        Some(pair) => pair,
        None => return Ok(None),
    };
    let open_count = gh_pr_count_inner(cwd, "open".to_string())?;
    Ok(Some(PrFreshnessSignal { number, updated_at, open_count }))
}

/// Cheap "has the open-PR list changed?" probe for the branch-badge
/// background-drain cache (`usePrPanel.ts`'s `PR_LIST_CACHE`). See
/// `PrFreshnessSignal`'s doc comment for why two facts are needed.
#[tauri::command]
pub(crate) async fn gh_pr_freshness_signal(cwd: String) -> Result<Option<PrFreshnessSignal>, String> {
    tauri::async_runtime::spawn_blocking(move || gh_pr_freshness_signal_inner(cwd))
        .await
        .map_err(|e| e.to_string())?
}
```

- [ ] **Step 4: Register the command in `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, change line 400 from:

```rust
            commands::gh::gh_pr_count,
```

to:

```rust
            commands::gh::gh_pr_count,
            commands::gh::gh_pr_freshness_signal,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test top_pr_from_cli_json`
Expected: PASS (3 tests).

- [ ] **Step 6: Verify the whole crate builds**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: PASS, no errors.

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS — full existing Rust test suite plus the 5 new tests from Tasks 3-4 all green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/gh.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(rust): add gh_pr_freshness_signal Tauri command (gh CLI path)"
```

---

### Task 5: TypeScript wrapper — `ghPrFreshnessSignal`

**Files:**
- Modify: `apps/desktop/src/utils/backend-pr.ts` (insert after `ghPrCount`, currently ending at line 235)
- Modify: `apps/desktop/src/utils/__tests__/backend-pr.test.ts` (append new `describe` block after the existing one, currently ending at line 62)

**Interfaces:**
- Consumes: `gh_pr_freshness_signal` Tauri command (Task 4) via `tauriInvoke`; `GET /api/gh-pr-freshness` dev-server route (Task 6) via `devFetch`.
- Produces: `export interface PrFreshnessSignal { number: number; updatedAt: string; openCount: number }` and `export async function ghPrFreshnessSignal(cwd: string): Promise<PrFreshnessSignal | null>` — consumed by Task 7's `usePrPanel.ts`.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/utils/__tests__/backend-pr.test.ts`, append this new `describe` block at the end of the file (after the closing `});` of `describe("ghCurrentUser caching", ...)`, currently at line 62):

```ts

describe("ghPrFreshnessSignal", () => {
  beforeEach(() => {
    vi.resetModules();
    devFetch.mockReset();
    tauriInvoke.mockReset();
    tauri = false;
  });

  it("maps the Tauri command's snake_case response to camelCase", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue({ number: 88, updated_at: "2026-07-09T10:00:00Z", open_count: 12 });
    const { ghPrFreshnessSignal } = await import("../backend-pr");
    await expect(ghPrFreshnessSignal("/repo")).resolves.toEqual({
      number: 88, updatedAt: "2026-07-09T10:00:00Z", openCount: 12,
    });
  });

  it("returns null when the Tauri command reports zero open PRs", async () => {
    tauri = true;
    tauriInvoke.mockResolvedValue(null);
    const { ghPrFreshnessSignal } = await import("../backend-pr");
    await expect(ghPrFreshnessSignal("/repo")).resolves.toBeNull();
  });

  it("returns null instead of throwing when the probe fails", async () => {
    tauri = true;
    tauriInvoke.mockRejectedValue(new Error("network down"));
    const { ghPrFreshnessSignal } = await import("../backend-pr");
    await expect(ghPrFreshnessSignal("/repo")).resolves.toBeNull();
  });

  it("dev-server branch maps the JSON response to camelCase", async () => {
    tauri = false;
    devFetch.mockResolvedValue(mockRes({
      ok: true,
      json: { number: 5, updated_at: "2026-01-01T00:00:00Z", open_count: 2 },
    }));
    const { ghPrFreshnessSignal } = await import("../backend-pr");
    await expect(ghPrFreshnessSignal("/repo")).resolves.toEqual({
      number: 5, updatedAt: "2026-01-01T00:00:00Z", openCount: 2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm test -- src/utils/__tests__/backend-pr.test.ts`
Expected: FAIL — `ghPrFreshnessSignal` is not exported from `../backend-pr`.

- [ ] **Step 3: Implement the wrapper**

In `apps/desktop/src/utils/backend-pr.ts`, insert this right after `ghPrCount`'s closing brace (after line 235, before the "Minimal branch shape for the publish guard" comment):

```ts

/** Signal returned by `gh_pr_freshness_signal` — see the Rust doc comment on `PrFreshnessSignal`. */
export interface PrFreshnessSignal {
  number: number;
  updatedAt: string;
  openCount: number;
}

/**
 * Cheap "has the open-PR list changed?" probe for the branch-badge
 * background-drain cache (`usePrPanel.ts`'s `PR_LIST_CACHE`). GitHub-only —
 * other forges have no equivalent yet, so their badge path always falls
 * through to a normal fetch-and-drain instead of an instant cache restore.
 *
 * Returns `null` when the repo currently has zero open PRs, or when the
 * probe itself fails (the caller treats that the same as "cache stale,
 * redrain").
 */
export async function ghPrFreshnessSignal(cwd: string): Promise<PrFreshnessSignal | null> {
  try {
    if (isTauri()) {
      const raw = await tauriInvoke<{ number: number; updated_at: string; open_count: number } | null>(
        "gh_pr_freshness_signal",
        { cwd },
      );
      return raw ? { number: raw.number, updatedAt: raw.updated_at, openCount: raw.open_count } : null;
    }
    const res = await devFetch(`${DEV_SERVER}/api/gh-pr-freshness?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.number !== "number") return null;
    return { number: data.number, updatedAt: data.updated_at, openCount: data.open_count ?? 0 };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm test -- src/utils/__tests__/backend-pr.test.ts`
Expected: PASS (all tests in the file, including the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils/backend-pr.ts apps/desktop/src/utils/__tests__/backend-pr.test.ts
git commit -m "feat: add ghPrFreshnessSignal TS wrapper for the PR badge cache"
```

---

### Task 6: `dev-server.mjs` route

**Files:**
- Modify: `apps/desktop/dev-server.mjs` (new route between the `gh-pr-count` route, ending at line 2967, and the `gh-create-pr` route starting at line 2969; startup route-list log around line 6200)

**Interfaces:**
- Produces: `GET /api/gh-pr-freshness?cwd=<path>` → JSON body `{ number, updated_at, open_count }` or `null`. Consumed by Task 5's `ghPrFreshnessSignal` (already implemented — no code changes needed there, this task just makes the endpoint it calls actually exist for `pnpm dev:web`).

- [ ] **Step 1: Add the route**

In `apps/desktop/dev-server.mjs`, insert this right after the `gh-pr-count` route's closing brace (after line 2967, before the `// POST /api/gh-create-pr` comment at line 2969):

```js

    // GET /api/gh-pr-freshness?cwd=<path>
    // Cheap "has the open-PR list changed?" probe for the branch-badge
    // background-drain cache (mirrors Rust `gh_pr_freshness_signal`): the
    // single most-recently-updated open PR plus the open PR count. Returns
    // null when the repo has zero open PRs or the token/remote can't be
    // resolved — the frontend treats that the same as "cache stale, redrain".
    if (url.pathname === "/api/gh-pr-freshness" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) return jsonResponse(req, res, { error: "Missing cwd" }, 400);
      try {
        const token = getGithubToken();
        if (!token) return jsonResponse(req, res, null);
        const nwo = getRepoNwo(resolve(cwd));
        if (!nwo) return jsonResponse(req, res, null);
        const topResp = await githubFetch(`/repos/${nwo}/pulls?state=open&per_page=1&page=1&sort=updated&direction=desc`, token);
        if (!topResp.ok) return jsonResponse(req, res, null);
        const topData = await topResp.json();
        if (!Array.isArray(topData) || topData.length === 0) return jsonResponse(req, res, null);
        // Count via the same Link-header trick as /api/gh-pr-count.
        const countResp = await githubFetch(`/repos/${nwo}/pulls?state=open&per_page=1`, token);
        let openCount = topData.length;
        if (countResp.ok) {
          const linkHeader = countResp.headers.get("link") || "";
          const m = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
          if (m) openCount = parseInt(m[1], 10);
        }
        return jsonResponse(req, res, {
          number: topData[0].number,
          updated_at: topData[0].updated_at,
          open_count: openCount,
        });
      } catch (err) {
        console.error("[gh-pr-freshness]", err.message);
        return jsonResponse(req, res, null);
      }
    }
```

- [ ] **Step 2: Add the route to the startup log**

In `apps/desktop/dev-server.mjs`, right after the line (around 6200):

```js
    console.log(`    GET  /api/gh-pr-count?cwd=<path>&state=<state>`);
```

add:

```js
    console.log(`    GET  /api/gh-pr-freshness?cwd=<path>`);
```

- [ ] **Step 3: Smoke-test the route manually**

Run: `cd apps/desktop && pnpm dev:server`
Expected: server starts and prints the route list including the new line, no crash on boot (`node dev-server.mjs` syntax-checks the file as part of starting). Stop the server after confirming the log line appears (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/dev-server.mjs
git commit -m "feat: add /api/gh-pr-freshness dev-server route"
```

---

### Task 7: In-memory cache, freshness fast path, and invalidation

**Files:**
- Modify: `apps/desktop/src/composables/usePrPanel.ts` (imports; new cache block near the Task 2 constants; `prefetchOpenPrs` cache-write; new `fetchPrFreshnessSignal`; rewritten `ensurePrsLoaded`; `watch(cwd, ...)` at lines 708-715; `createPr` at lines 718-746; `mergePr` at lines 789-803)
- Modify: `apps/desktop/src/composables/__tests__/usePrPanel.test.ts` (extend the mocks from Task 2, add new tests)

**Interfaces:**
- Consumes: `ghPrFreshnessSignal` (Task 5) from `../utils/backend`; `whenIdle` (Task 1); `prefetchOpenPrs`/`loadMorePrs` (Task 2).
- Produces: no new exports — this task changes `ensurePrsLoaded()`'s internal behavior only. Its returned signature is unchanged.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/composables/__tests__/usePrPanel.test.ts`, change the top-of-file mocks from:

```ts
vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(async () => null),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
}));

const listPRs = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs })),
  githubProvider: { name: "github", listPRs },
}));
```

to:

```ts
const ghPrFreshnessSignal = vi.fn();
vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: vi.fn(async () => null),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
  ghPrFreshnessSignal: (...args: unknown[]) => ghPrFreshnessSignal(...args),
}));

const listPRs = vi.fn();
const createPR = vi.fn();
const mergePR = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs, createPR, mergePR })),
  githubProvider: { name: "github", listPRs, createPR, mergePR },
}));
```

Then add a `beforeEach` reset for the two new mocks inside the existing `describe("usePrPanel — background prefetch drain", ...)` block's `beforeEach`, changing:

```ts
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    vi.useFakeTimers();
  });
```

to:

```ts
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    createPR.mockReset();
    mergePR.mockReset();
    ghPrFreshnessSignal.mockReset();
    vi.useFakeTimers();
  });
```

Then append these new tests at the end of the `describe("usePrPanel — background prefetch drain", ...)` block, right before its closing `});`:

```ts

  it("restores instantly from the in-memory cache when the freshness signal is unchanged", async () => {
    listPRs.mockImplementation(pagedListPRs(15));
    ghPrFreshnessSignal.mockResolvedValue({ number: 15, updatedAt: "t1", openCount: 15 });
    const panel = usePrPanel(ref("/repo"));

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40); // drain completes, cache is written
    expect(panel.prs.value).toHaveLength(15);
    const callsAfterFirstDrain = listPRs.mock.calls.length;

    await panel.ensurePrsLoaded(); // e.g. branch popover reopened
    expect(panel.prs.value).toHaveLength(15);
    expect(listPRs.mock.calls.length).toBe(callsAfterFirstDrain); // no new fetch — restored from cache
    // Called twice total: once when prefetchOpenPrs() wrote the cache after
    // the first drain, once for this second call's freshness recheck.
    expect(ghPrFreshnessSignal).toHaveBeenCalledTimes(2);
  });

  it("redrains when the freshness signal changes (e.g. a PR opened elsewhere)", async () => {
    listPRs.mockImplementation(pagedListPRs(15));
    ghPrFreshnessSignal.mockResolvedValue({ number: 15, updatedAt: "t1", openCount: 15 });
    const panel = usePrPanel(ref("/repo"));

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);
    expect(panel.prs.value).toHaveLength(15);

    listPRs.mockImplementation(pagedListPRs(16));
    ghPrFreshnessSignal.mockResolvedValue({ number: 16, updatedAt: "t2", openCount: 16 });

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);
    expect(panel.prs.value).toHaveLength(16);
  });

  it("createPr() invalidates the cache so the next ensurePrsLoaded() redrains", async () => {
    listPRs.mockImplementation(pagedListPRs(15));
    ghPrFreshnessSignal.mockResolvedValue({ number: 15, updatedAt: "t1", openCount: 15 });
    const panel = usePrPanel(ref("/repo"));

    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);
    expect(panel.prs.value).toHaveLength(15);

    createPR.mockResolvedValue(makePr(16));
    panel.newPrTitle.value = "New PR";
    listPRs.mockImplementation(pagedListPRs(16)); // the repo now has 16 open PRs
    await panel.createPr();
    const callsAfterCreate = listPRs.mock.calls.length;

    ghPrFreshnessSignal.mockResolvedValue({ number: 16, updatedAt: "t2", openCount: 16 });
    await panel.ensurePrsLoaded();
    await vi.advanceTimersByTimeAsync(40);

    // A stale pre-createPr cache entry must NOT be trusted — it must redrain.
    expect(listPRs.mock.calls.length).toBeGreaterThan(callsAfterCreate);
    expect(panel.prs.value).toHaveLength(16);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm test -- src/composables/__tests__/usePrPanel.test.ts`
Expected: FAIL on the 3 new tests — no in-memory cache exists yet, so every `ensurePrsLoaded()` call after the first is a no-op (today's one-shot `_prsEnsured` guard), `ghPrFreshnessSignal` is never called, and `panel.prs.value` never changes on the second call in any of the 3 new tests.

- [ ] **Step 3: Add the import, cache map, and constants**

In `apps/desktop/src/composables/usePrPanel.ts`, add `ghPrFreshnessSignal` and its type to the big import block from `"../utils/backend"` (near `ghForkInfo`, `type ForkInfo`):

```ts
  ghForkInfo,
  type ForkInfo,
  ghPrFreshnessSignal,
  type PrFreshnessSignal,
} from "../utils/backend";
```

Then, right after the `BG_PAGE`/`PREFETCH_CEILING`/`_prPrefetchToken` block added in Task 2, add:

```ts

  // ─── In-memory list cache (badge path) ──────────────────────────────────
  // Mirrors useGitRepo.ts's LOG_CACHE/prefetchAllPages pattern (PR #113).
  // Declared inside usePrPanel() — a singleton instantiated once in App.vue,
  // same as LOG_CACHE — so its lifetime matches the app session, and each
  // fresh usePrPanel() call (e.g. in a test) starts with an empty cache.
  interface PrListCacheEntry {
    prs: PullRequest[];
    hasMore: boolean;
    topSignal: PrFreshnessSignal | null;
  }
  const PR_LIST_CACHE = new Map<string, PrListCacheEntry>();
  // Throttles the freshness re-probe on repeated ensurePrsLoaded() calls
  // (branch popover reopened, graph mode re-entered) so rapid toggling
  // doesn't fire a GitHub request every time.
  const FRESHNESS_RECHECK_MS = 30_000;
  let _lastFreshnessCheck = 0;

  /**
   * GitHub-only cheap freshness probe (see `ghPrFreshnessSignal`'s doc
   * comment). Other forges have no equivalent yet — `null` here just means
   * "no signal available", which `ensurePrsLoaded()` treats as a cache miss.
   */
  async function fetchPrFreshnessSignal(repo: string): Promise<PrFreshnessSignal | null> {
    if (forge.value.name !== "github") return null;
    try {
      return await ghPrFreshnessSignal(repo);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Write the drained list to the cache in `prefetchOpenPrs`**

In `apps/desktop/src/composables/usePrPanel.ts`, change `prefetchOpenPrs` (added in Task 2) from:

```ts
  async function prefetchOpenPrs() {
    if (filterState.value !== "open") return;
    const token = ++_prPrefetchToken;
    const repo = cwd.value;
    if (!repo) return;
    const live = () =>
      cwd.value === repo && token === _prPrefetchToken && filterState.value === "open";
    while (live() && hasMore.value && prs.value.length < PREFETCH_CEILING) {
      await whenIdle();
      if (!live()) return;
      await loadMorePrs(BG_PAGE);
    }
  }
```

to:

```ts
  async function prefetchOpenPrs() {
    if (filterState.value !== "open") return;
    const token = ++_prPrefetchToken;
    const repo = cwd.value;
    if (!repo) return;
    const live = () =>
      cwd.value === repo && token === _prPrefetchToken && filterState.value === "open";
    while (live() && hasMore.value && prs.value.length < PREFETCH_CEILING) {
      await whenIdle();
      if (!live()) return;
      await loadMorePrs(BG_PAGE);
    }
    // Only cache a fully-drained list (reached the true end before the
    // ceiling), and only for GitHub (the only forge with a freshness
    // signal) — a ceiling-capped or signal-less list stays uncached so
    // ensurePrsLoaded() keeps retrying instead of trusting an incomplete or
    // unvalidatable snapshot forever.
    if (live() && !hasMore.value && forge.value.name === "github") {
      const topSignal = await fetchPrFreshnessSignal(repo);
      if (live()) {
        PR_LIST_CACHE.set(repo, { prs: prs.value.slice(), hasMore: false, topSignal });
      }
    }
  }
```

- [ ] **Step 5: Rewrite `ensurePrsLoaded()`**

In `apps/desktop/src/composables/usePrPanel.ts`, change `ensurePrsLoaded` (from Task 2) from:

```ts
  async function ensurePrsLoaded() {
    if (!cwd.value || _prsEnsured || prs.value.length > 0) return;
    _prsEnsured = true;
    const cachedRemote = cache.getRemote(cwd.value);
    if (cachedRemote) {
      remote.value = cachedRemote.remote;
      loadRemote();
    } else {
      await loadRemote();
    }
    await loadPrs();
    void prefetchOpenPrs();
  }
```

to:

```ts
  async function ensurePrsLoaded() {
    if (!cwd.value || filterState.value !== "open") return;
    const repo = cwd.value;
    const cached = PR_LIST_CACHE.get(repo);
    if (cached) {
      const now = Date.now();
      if (now - _lastFreshnessCheck < FRESHNESS_RECHECK_MS) return; // recently confirmed fresh
      _lastFreshnessCheck = now;
      const signal = await fetchPrFreshnessSignal(repo);
      if (cwd.value !== repo) return; // repo changed while the probe was in flight
      const unchanged =
        (signal === null && cached.topSignal === null) ||
        (signal !== null &&
          cached.topSignal !== null &&
          signal.number === cached.topSignal.number &&
          signal.updatedAt === cached.topSignal.updatedAt &&
          signal.openCount === cached.topSignal.openCount);
      if (unchanged) {
        prs.value = cached.prs;
        hasMore.value = false;
        return;
      }
      // Stale (or the probe errored) — drop the cache and fall through to a
      // full redrain below, UNCONDITIONALLY: this branch must not be gated
      // by the `_prsEnsured`/`prs.value.length` check below, or a repo whose
      // cache just went stale would keep showing the stale list forever
      // (`_prsEnsured` stays true and `prs.value` stays non-empty even
      // though nothing is being redrained).
      PR_LIST_CACHE.delete(repo);
    } else if (_prsEnsured && prs.value.length > 0) {
      // No cache yet, but this session already loaded (or is loading/
      // draining) this repo's open PRs — matches the original one-shot
      // guard for the "mid-drain, not yet cached" window.
      return;
    }
    _prsEnsured = true;
    const cachedRemote = cache.getRemote(cwd.value);
    if (cachedRemote) {
      remote.value = cachedRemote.remote;
      loadRemote();
    } else {
      await loadRemote();
    }
    await loadPrs();
    void prefetchOpenPrs();
  }
```

- [ ] **Step 6: Reset the freshness-check throttle on repo switch**

In `apps/desktop/src/composables/usePrPanel.ts`, change the `watch(cwd, ...)` handler (currently lines 708-715) from:

```ts
  watch(cwd, (newCwd) => {
    selectedPr.value = null;
    prs.value = [];
    remote.value = null;
    _prsEnsured = false;
    resetDetail();
    if (newCwd && panelMounted.value) init();
  });
```

to:

```ts
  watch(cwd, (newCwd) => {
    selectedPr.value = null;
    prs.value = [];
    remote.value = null;
    _prsEnsured = false;
    _lastFreshnessCheck = 0;
    resetDetail();
    if (newCwd && panelMounted.value) init();
  });
```

- [ ] **Step 7: Invalidate the cache on `createPr()` and `mergePr()`**

In `apps/desktop/src/composables/usePrPanel.ts`, inside `createPr()`, change:

```ts
      cache.invalidateLists(cwd.value);
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
    finally { isCreating.value = false; }
  }
```

to:

```ts
      cache.invalidateLists(cwd.value);
      PR_LIST_CACHE.delete(cwd.value);
      _prsEnsured = false;
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
    finally { isCreating.value = false; }
  }
```

Inside `mergePr()`, change:

```ts
      cache.invalidateDetail(cwd.value, mergingPr.value.number);
      cache.invalidateLists(cwd.value);
      mergingPr.value = null;
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
  }
```

to:

```ts
      cache.invalidateDetail(cwd.value, mergingPr.value.number);
      cache.invalidateLists(cwd.value);
      PR_LIST_CACHE.delete(cwd.value);
      _prsEnsured = false;
      mergingPr.value = null;
      await loadPrs();
    } catch (err: any) { error.value = err.message; }
  }
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/desktop && pnpm test -- src/composables/__tests__/usePrPanel.test.ts`
Expected: PASS (all 5 tests in the file — the 2 from Task 2 plus the 3 new ones).

- [ ] **Step 9: Run the full frontend test suite and typecheck**

Run: `cd apps/desktop && pnpm test`
Expected: PASS — no regressions in other composables (in particular `usePrCache.test.ts`, `useBranchPrSearch.test.ts`, `useLaunchpadPrs.test.ts`, which all touch adjacent PR-panel code paths).

Run: `cd apps/desktop && pnpm build`
Expected: PASS — `vue-tsc` typecheck succeeds (confirms `PrFreshnessSignal`/`ghPrFreshnessSignal` types line up between `backend-pr.ts` and `usePrPanel.ts`).

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/composables/usePrPanel.ts apps/desktop/src/composables/__tests__/usePrPanel.test.ts
git commit -m "feat: cache drained open-PR lists and validate them via a cheap freshness signal"
```

---

## Post-implementation checklist

- [ ] `cd apps/desktop/src-tauri && cargo test` — full Rust suite green.
- [ ] `cd apps/desktop && pnpm test` — full Vitest suite green.
- [ ] `cd apps/desktop && pnpm build` — typecheck + Vite build green.
- [ ] `cd apps/desktop && pnpm dev:web` — manually open a repo with >10 open PRs (or point at a public repo with many open PRs) in the branch selector popover; confirm badges appear for branches beyond the first 10, and that reopening the popover a second time doesn't trigger a visible re-fetch delay.
- [ ] Confirm `docs/superpowers/specs/2026-07-09-pr-badge-prefetch-design.md`'s stated scope was fully implemented: open-PRs only (no closed/merged), GitHub-only freshness fast path, other forges get the breadth fix only.
