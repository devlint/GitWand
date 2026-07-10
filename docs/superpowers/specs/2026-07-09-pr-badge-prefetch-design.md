# PR badges — background prefetch & cache (git-log style)

## Problem

The branch-badge path (`#<number>` shown on branches with an open PR, in `BranchSelector.vue`) only ever loads the first page of open PRs. `usePrPanel.ts::ensurePrsLoaded()` is a one-shot guard: it calls `loadPrs()` exactly once per repo, which fetches `PAGE_SIZE = 10` open PRs at offset 0, and never calls the existing `loadMorePrs()` pagination. Any repo with more than 10 open PRs — or where the relevant PR isn't within `gh`'s first 10 by creation order — silently gets no badge. There is no cache-based instant restore either: every repo (re)open starts the one page-of-10 fetch again from a cold state (aside from the 24h localStorage SWR cache in `usePrCache.ts`, which caches only whatever was fetched, i.e. still just 10 PRs).

This mirrors the git-log pagination bug fixed in PR #113 ("Cache the Git log and prefetch pages", `apps/desktop/src/composables/useGitRepo.ts`), and should get the same treatment: a background prefetch loop that drains further pages after the first paint, plus an in-memory cache keyed by repo so a repeat visit restores instantly when nothing changed upstream.

## Goals

- Branch badges reflect open PRs beyond the first 10, up to a bounded ceiling, without blocking the UI.
- Repeat visits to a repo (branch popover reopened, tab switch back) restore the previously-drained PR list instantly from an in-memory cache when nothing has changed on GitHub, instead of re-fetching.
- Cache invalidation is signal-based (like git log's head-hash), not purely time-based: detect that something changed upstream, then redrain.
- Do not blow up API/subprocess cost — both Rust list-fetch paths (`gh` CLi and REST) paginate naively (`offset+limit` then slice, re-walking from the start on every call), so a naive one-page-at-a-time background drain would multiply cost roughly quadratically as more pages are pulled.

## Non-goals

- Closed/merged PRs — badges stay scoped to `state: "open"`, matching current behavior.
- Cursor-based GraphQL pagination in the Rust layer (`gh_list_prs_inner` / `rest_list_prs`) — that's a separate, already-tracked TODO (Phase 2 / v2.9 comments in `gh.rs` and `github_api.rs`). This feature works within the existing naive pagination, just calls it less often and in bigger jumps.
- Non-GitHub forges (GitLab, Bitbucket, Azure) get the background-drain fix (the actual breadth bug) but not the instant-paint freshness shortcut — see "Forge scope" below.
- Any change to the PR *detail* view, PR panel's own manual pagination/scroll UX, or `usePrCache.ts`'s existing localStorage SWR layer (kept as-is, unchanged).

## Existing pieces (no changes except noted)

- `apps/desktop/src/composables/usePrPanel.ts` — singleton PR-panel state. Relevant existing bits:
  - `PAGE_SIZE = 10`, `hasMore`, `loadingMore`, `loadPrs()`, `loadMorePrs()` — foreground pagination.
  - `_prsEnsured` flag + `ensurePrsLoaded()` — the one-shot badge-population entry point, called from `BranchSelector.vue`'s popover open and from `App.vue`'s graph-mode entry.
  - `cache.invalidateLists(cwd)` already called from `createPr()` and `mergePr()` (localStorage SWR invalidation on mutation).
- `apps/desktop/src/composables/usePrCache.ts` — localStorage SWR cache, 24h TTL, `listKey(cwd, filterState)`. Untouched by this feature; the new in-memory cache sits alongside it, the same way `useGitRepo.ts`'s `LOG_CACHE` module-level `Map` sits alongside no other cache.
- `apps/desktop/src-tauri/src/commands/gh.rs::gh_list_prs_inner` and `apps/desktop/src-tauri/src/commands/github_api.rs::rest_list_prs` — both take `(cwd, state, limit, offset)` and implement naive pagination: fetch `offset + limit` items from the start, then slice off the first `offset`. `rest_list_prs` already requests `sort=updated&direction=desc` from the GitHub REST API; `gh_list_prs_inner` (the `gh` CLI path, used when no token is configured in Settings) passes no sort flag, so `gh pr list`'s default order applies (creation descending).
- `apps/desktop/src-tauri/src/commands/github_api.rs::rest_pr_count` and `gh.rs::gh_pr_count_inner` — existing cheap "how many PRs match this state" functions (REST: `/search/issues?...&per_page=1`, reads `total_count`; CLI: separate GraphQL count query). Both already exist and are reused as-is by the freshness signal below.

## Architecture

### In-memory cache (new)

A module-level `Map` in `usePrPanel.ts`, analogous to `useGitRepo.ts`'s `LOG_CACHE`:

```ts
const PR_LIST_CACHE = new Map<string, {
  prs: PullRequest[];
  hasMore: boolean;
  topSignal: { number: number; updatedAt: string; openCount: number } | null;
}>();
```

Keyed by `cwd` only (not by filter state — this cache is scoped to the badge path, which is always `state: "open"`).

### Background prefetch (new)

`prefetchOpenPrs()`, called from `ensurePrsLoaded()` right after the first page loads successfully:

```ts
const BG_PAGE = 100;           // bigger than PAGE_SIZE=10 — see cost note below
const PREFETCH_CEILING = 300;  // matches the existing dev-server REST cap (3×100 pages)

async function prefetchOpenPrs() {
  const token = ++_prPrefetchToken;
  const repo = cwd.value;
  const live = () =>
    _prPrefetchToken === token && cwd.value === repo && filterState.value === "open";
  while (live() && hasMore.value && prs.value.length < PREFETCH_CEILING) {
    await whenIdle();
    if (!live()) return;
    await loadMoreThroughBg(BG_PAGE); // loadMorePrs, parametrized with BG_PAGE instead of PAGE_SIZE
  }
  if (live() && !hasMore.value) {
    PR_LIST_CACHE.set(repo, {
      prs: prs.value.slice(),
      hasMore: false,
      topSignal: await fetchFreshnessSignal(repo),
    });
  }
}
```

- `whenIdle()` — extracted from `useGitRepo.ts` into a new shared `apps/desktop/src/composables/useIdleSchedule.ts` (or `utils/idle.ts`) so both composables use the same `requestIdleCallback` (timeout 300ms) + `setTimeout(32ms)` fallback, instead of duplicating it.
- `loadMoreThroughBg(pageSize)` is `loadMorePrs()` generalized to take a page size parameter (default `PAGE_SIZE` for the existing scroll-driven foreground calls, `BG_PAGE` for background prefetch), otherwise identical: same `loadingMore`/`hasMore`/`refreshing` guards, same dedup-by-`number` logic.
- A capped drain (`PREFETCH_CEILING` reached while `hasMore` is still true) is **not** written to `PR_LIST_CACHE` as "complete" — mirrors git log's ceiling behavior, so the badge path simply has partial coverage on pathologically large PR counts rather than falsely claiming completeness.
- Cancellation: `_prPrefetchToken` + `live()` bail out a stale prefetch if the repo changes, or a manual action (`createPr`/`mergePr`) invalidates mid-drain.

**Cost note:** because `loadMorePrs`'s underlying Rust call re-fetches `offset+limit` items from scratch every time, a naive 10-at-a-time background drain to a 300-PR ceiling would issue calls at offsets 10, 20, …, 290 with limits 20, 30, …, 300 — summing to ~4,650 PR items fetched from GitHub to populate 300 badges (~15× overhead). Using `BG_PAGE = 100` instead means 3 background calls (offsets 10, 110, 210; limits 110, 210, 310) summing to ~630 items (~2× overhead) — bounded and acceptable.

### Cache read / fast path (new)

`ensurePrsLoaded()` changes from "one-shot forever" to "cheap-checked on every call, throttled":

1. If `PR_LIST_CACHE` has an entry for `cwd.value` **and** it's been at least 30s since the last check (new `_lastFreshnessCheck` timestamp, throttling repeated popover toggles the way `_lastPoll` already throttles the visibility-change catch-up in this same file): call `fetchFreshnessSignal(cwd.value)` (new, see below).
   - Signal matches cached `topSignal` → restore instantly: `prs.value = cached.prs; hasMore.value = false`. No page-1 fetch, no prefetch loop.
   - Signal differs, or the probe itself errors → treat cache as stale: delete the entry, fall through to the normal `loadPrs()` first-page fetch + `prefetchOpenPrs()`.
2. No cache entry → normal `loadPrs()` first-page fetch, then kick off `prefetchOpenPrs()` in the background (same as today's flow, just no longer stopping after page 1).

This replaces the current `if (!cwd.value || _prsEnsured || prs.value.length > 0) return;` one-shot guard.

### Invalidation signal — `fetchFreshnessSignal(cwd)`

A single lightweight probe combining two cheap existing/near-existing calls:

- **Most-recently-updated open PR** — `{ number, updatedAt }`. On the REST/token path, `rest_list_prs(cwd, "open", 1, 0, token)` already sorts `updated desc`, so this is a free `per_page=1` call, no Rust change needed. On the `gh` CLI path, `gh_list_prs_inner` has no sort flag (`gh pr list`'s default is creation-descending) — the new dedicated command adds `-S "sort:updated-desc"` **only** for this probe, without touching the main list fetch's ordering.
- **Open PR count** — reuses the existing `rest_pr_count` / `gh_pr_count_inner` as-is. Needed because a PR transitioning from open → closed drops out of the "state=open" results entirely, so "the top-updated PR is unchanged" alone wouldn't catch that case.

New Rust command bundling both, mirroring the existing token/CLI branch in `gh_list_prs_inner`:

```rust
#[tauri::command]
pub(crate) async fn gh_pr_freshness_signal(cwd: String) -> Result<Option<PrFreshnessSignal>, String>
```

```rust
pub(crate) struct PrFreshnessSignal {
    number: i64,
    updated_at: String,
    open_count: i64,
}
```

- Token path: `rest_list_prs(&cwd, "open", 1, 0, &token)` for the top PR + `rest_pr_count(&cwd, "open", &token)` for the count.
- `gh` CLI path: `gh pr list --state open --json number,updatedAt --limit 1 -S "sort:updated-desc"` for the top PR + existing `gh_pr_count_inner(cwd, "open")` for the count. Reuses `gh_fork_upstream` for `--repo` resolution, same as `gh_list_prs_inner`.
- Returns `None` if there are zero open PRs (rather than erroring) so the frontend can treat "empty repo" as a valid, cacheable state.

Frontend wiring, following the existing convention that PR-specific commands are wrapped in `apps/desktop/src/utils/backend-pr.ts` (not the general `backend.ts`, despite `AGENTS.md`'s general rule — this repo's PR domain already deviates that way, e.g. `ghListPrs`, and this stays consistent with its neighbors rather than fixing that inconsistency as a drive-by):

```ts
export async function ghPrFreshnessSignal(cwd: string): Promise<PrFreshnessSignal | null>
```

Plus the matching `dev-server.mjs` route (`GET /api/gh-pr-freshness`), per the project's dev-server-parity convention for every new `#[tauri::command]`.

### Invalidation call sites

`PR_LIST_CACHE.delete(cwd.value)` added at the same two places `cache.invalidateLists(cwd.value)` already fires: `createPr()` and `mergePr()`. No new call sites invented — this stays consistent with what already counts as "the PR list changed" in this file today. (`convertDraftToReady`, comment/review actions don't touch list membership and don't invalidate today either.)

## Forge scope

`usePrPanel.ts` is forge-agnostic (`forge.value.listPRs(...)`), so the background-drain fix (the actual breadth bug) applies to every forge (GitHub, GitLab, Bitbucket, Azure) via the existing `loadMorePrs()` abstraction — no forge-specific code needed there.

The freshness-signal fast path is GitHub-only for this iteration (`gh_pr_freshness_signal` has no GitLab/Bitbucket/Azure equivalent). For those forges, `fetchFreshnessSignal()` returns `null` (no signal available), so `ensurePrsLoaded()` always falls through to the normal fetch-and-prefetch path — same behavior as before this feature, just now with a full drain instead of stopping at 10. This is not a new gap; those forges never had an instant-restore path before either.

## Edge cases

- **Freshness probe fails (network error, `gh` missing, etc.):** treated as "cache stale" — fall through to the normal path rather than trusting possibly-outdated cached data indefinitely.
- **Prefetch in flight when the user switches repos:** `live()` check bails out; no stale writes into `PR_LIST_CACHE` or `prs.value` for the wrong repo.
- **Prefetch in flight when `createPr`/`mergePr` invalidates:** same `live()` guard (token bump) stops the in-flight drain from re-populating the cache with data that's about to be stale anyway; the subsequent `loadPrs()` call from those actions' own refresh starts a fresh drain.
- **Repo with zero open PRs:** `gh_pr_freshness_signal` returns `None`; cached as `topSignal: null`, `prs: []`, `hasMore: false` — a valid, stable, cacheable state (repeat visits don't re-probe more than the 30s throttle).
- **Ceiling hit (>300 open open PRs):** not cached as complete; every `ensurePrsLoaded()` call redoes the fetch-and-prefetch path (no instant restore) for that repo, same as before this feature for such repos, but at least drains to 300 instead of 10.

## Testing

- `usePrPanel.test.ts` (existing or new, mocking the injected forge provider, consistent with how forge/API calls — as opposed to the git layer — are already mocked in this codebase's PR tests, e.g. `2026-07-01-branch-selector-pr-search-design.md`'s testing section):
  - First `ensurePrsLoaded()` on a repo with >10 open PRs drains to completion (mocked `listPRs` returning multiple pages) and populates `PR_LIST_CACHE`.
  - Second `ensurePrsLoaded()` call within the 30s throttle window, freshness signal unchanged → restores from cache with zero `listPRs` calls.
  - Freshness signal count mismatch (simulating a PR closing) → cache invalidated, full redrain.
  - Prefetch cancels cleanly on repo switch mid-drain (no writes to the new repo's slot from the stale token).
  - `createPr()` / `mergePr()` clear `PR_LIST_CACHE` for the repo.
  - Ceiling behavior: drain stops at `PREFETCH_CEILING`, not cached as complete.
- Rust: unit test for `gh_pr_freshness_signal` covering both the token/REST branch and the `gh` CLI branch (mocked subprocess/HTTP as existing Rust PR command tests already do), plus the zero-open-PRs `None` case.
- `pnpm test:parity` — no new parity coverage needed; `gh_pr_freshness_signal` isn't a deterministic git command, it's a GitHub API passthrough, same category as the existing `gh_list_prs` (not currently in the parity suite either, per the earlier investigation).
