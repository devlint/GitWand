# Branch selector — search by PR number

## Problem

The branch-picker popover (`BranchSelector.vue`) filters branches by name substring only. GitHub Desktop lets you type a PR reference like `#9335` into the same search box and jumps straight to the branch behind that PR. GitWand should do the same.

## Goals

- Typing `#<number>` in the existing branch filter input resolves to the branch that is the head of that PR, and narrows the branch list to just that branch.
- Works even for PRs that aren't in the currently-loaded page of the PR sidebar's cache (paginated, 10 at a time, only loaded once the PR panel has been opened).
- Surface which branches have an open/cached PR via a small badge, so the feature is discoverable and self-explanatory without requiring a search.

## Non-goals

- Fuzzy/partial PR-number matching (e.g. `#93` matching `#9335`) — exact number only, matching the decision below.
- Fetching/caching PRs for branches that have no local/remote `GitBranch` entry (e.g. already deleted after merge) — if there's no branch to show, there's nothing to filter to.
- Changes to `usePrPanel.ts`'s pagination model or cache shape.

## Data model (existing, no changes)

- `PullRequest` (`apps/desktop/src/utils/backend-pr.ts:69`) has `number: number` and `branch: string` (head branch, short name, no remote prefix — confirmed identical across GitHub/GitLab/Bitbucket/Azure providers).
- `usePrPanel(cwd, opts)` (`apps/desktop/src/composables/usePrPanel.ts`) is a singleton, provided once in `App.vue` via `provide(PR_PANEL_KEY, prPanel)`, and injected elsewhere with `inject<PrPanelState>(PR_PANEL_KEY)!` (see `PrListSidebar.vue`, `PrDetailView.vue`, `PrCreateView.vue`). It exposes:
  - `prs: Ref<PullRequest[]>` — current cached/loaded page(s), not exhaustive.
  - `forge: <computed ref to the active ForgeProvider | null>` — has `getPR(cwd, number): Promise<PullRequestDetail>`, which fetches a single PR by exact number regardless of pagination.

`BranchSelector.vue` will inject `PR_PANEL_KEY` the same way the PR views do. No new provide/inject key, no changes to `usePrPanel.ts`.

## Matching & filtering logic

New computed in `BranchSelector.vue`:

```ts
const prNumberQuery = computed(() => {
  const m = /^#(\d+)$/.exec(branchFilter.value.trim());
  return m ? Number(m[1]) : null;
});
```

When `prNumberQuery.value !== null`, the filter predicates used by `pinnedBranches`, `localBranches`, and `remoteBranches` (currently `b.name.toLowerCase().includes(branchFilter.value.toLowerCase())`) switch to matching against a resolved branch name instead of the raw text:

1. **Cache-first:** look up the number in `prPanel.prs.value` (`.find(p => p.number === n)`). If found, its `.branch` is the resolved name — no network call.
2. **Fallback fetch:** if not found in the cache, debounce ~350ms (guards against firing a request per keystroke while a multi-digit number is typed), then call `prPanel.forge.value?.getPR(cwd, n)`. On success, its `.branch` is the resolved name. Result is held in a local `ref` scoped to `BranchSelector.vue` (not written back into `prPanel.prs`, since that array is the PR panel's own paginated view and mixing in an out-of-band single fetch would corrupt its pagination invariants).
3. **Not found / no forge:** if the fetch 404s, or `prPanel.forge.value` is null (repo has no connected/configured remote provider), there is no resolved branch name — the branch lists render empty and a dedicated message is shown (see below) instead of the generic "no branches found" empty state.

Resolved name comparison strips the `origin/` prefix for remote branches, mirroring the existing switch-branch behavior (`branch.name.replace(/^origin\//, '')`) — same convention, not a new one.

State needed:

```ts
const resolvedPrBranch = ref<string | null>(null); // from cache or fallback fetch
const prLookupLoading = ref(false);
const prLookupNotFound = ref(false);
```

A `watch(prNumberQuery, ...)` drives steps 1–3 above, resetting `resolvedPrBranch` / `prLookupNotFound` whenever the query changes or is cleared.

## UI feedback states

Inside the popover's `bp-lists` area, when `prNumberQuery.value !== null`:

- **Resolving** (`prLookupLoading`): a muted row reusing the existing `.bp-spinner` pattern, text: "Looking up PR #9335…".
- **Not found** (`prLookupNotFound`): text "No branch found for PR #9335", styled like the existing `.bp-empty` block.
- **Found**: normal rendering — the Pinned/Local/Remote sections render as today, just narrowed to the one matching branch by the filter predicate change above.

When `prNumberQuery.value === null`, behavior is entirely unchanged (today's substring filtering).

## PR badges

Branches that already have a PR in `prPanel.prs.value` (no extra fetch — badge display never triggers the fallback lookup) show a small "#1234" badge:

```ts
const prNumberByBranch = computed(() => {
  const map = new Map<string, number>();
  for (const pr of prPanel.prs.value) map.set(pr.branch, pr.number);
  return map;
});
```

Rendered next to the existing ahead/behind indicator (`.bp-item-meta`) in the Pinned, Local, and Remote section templates. Archived branches are skipped (low relevance, already a secondary/collapsed section). Clicking the badge does nothing special in this iteration (no navigation to the PR view) — it's informational only, keeping scope tight.

## Input placeholder

Update the filter input's placeholder (`branches.filter` locale key, currently "Filter…") to hint at the new capability, e.g. "Filter branches or #PR…". Same key updated across all 5 locales (`en`, `fr`, `es`, `pt-BR`, `zh-CN`) per `AGENTS.md` i18n rules.

## New locale keys

Added to `branches.*` in all 5 locale files:
- `branches.prLookupLoading` — "Looking up PR #{0}…"
- `branches.prLookupNotFound` — "No branch found for PR #{0}"
- `branches.prBadgeTitle` — tooltip for the badge, e.g. "PR #{0}: {1}" (number, title)

## Edge cases

- **No remote/forge configured:** `prPanel.forge.value` is `null` → treat as "not found" immediately, no fetch attempted, no crash on `?.getPR`.
- **PR exists but its branch was deleted locally and remotely:** resolves to a branch name that matches nothing in `props.branches` → same as "not found" from the UI's perspective (empty list under a resolved-but-absent name reads identically to unresolved; acceptable — there's nothing actionable to show either way).
- **Rapid typing of a multi-digit number:** debounce prevents a fetch per keystroke; only the settled value triggers `getPR`.
- **Switching cwd/repo while a lookup is in-flight:** the existing `branchFilter` is cleared when the popover closes/reopens (`togglePopover`) already, and `prNumberQuery` recomputation naturally invalidates stale lookups since the watch re-keys on the new query value. No repo-mismatch guard needed beyond what's already there for the popover’s own lifecycle.

## Testing

- Unit tests in `apps/desktop/src/components/header/__tests__/` (new file) or co-located composable-style tests, covering:
  - Cache-hit resolution (PR already in `prs.value`).
  - Cache-miss → fallback fetch called with debounce, resolves branch.
  - Fallback fetch 404 → "not found" state.
  - `forge` null → "not found" state, no fetch attempted.
  - Remote branch `origin/` prefix stripped correctly when matching.
- Mock the injected `PrPanelState` object directly (it's a plain object of refs/functions) rather than mocking Tauri/git — consistent with `AGENTS.md`'s "use real git repos in tests" rule, which applies to the git layer, not the forge-provider layer (already mocked elsewhere in existing PR-related tests).
