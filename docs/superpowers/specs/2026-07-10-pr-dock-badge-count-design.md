# PR dock badge — cheap count on repo open

## Problem

`AppDock.vue` already has a `prCount?: number` prop (line 24) used to badge the "prs" dock item (line 83: `if (id === "prs") return props.prCount || undefined;`), and `App.vue` already passes it (`App.vue:3347`, `:pr-count="prPanel.prs.value.length"`) — but bound to `prs.value.length`, i.e. however many PRs currently happen to be loaded into `usePrPanel`'s badge-path list. That list is populated lazily (only once the user opens the branch-selector popover or enters graph mode — see `2026-07-09-pr-badge-prefetch-design.md`), so the dock badge reads `0` until one of those interactions happens, and even afterward it reflects "loaded so far" (10, or up to 300 after the background drain), never the true total. Separately, every `ForgeProvider` implements `getPRCount(cwd, state)` (backed by `ghPrCount` → Rust `gh_pr_count` → a single cheap REST `/search/issues?...&per_page=1` call or GraphQL `totalCount` query, per forge), but nothing calls it anywhere in the app today.

Meanwhile, the PR list view's own header count (`PrListSidebar.vue:102`, `totalCount = computed(() => panel.displayedPrs.value.length)`) only ever reflects however many PRs are *currently loaded* into `prs.value` — 10 by default, more after the background drain (see `2026-07-09-pr-badge-prefetch-design.md`), fewer if a user filter is active — never the true total open-PR count.

## Goals

- Wire the existing, unused `AppDock` `prCount` prop to a real open-PR count, refreshed via a single cheap call when a repo becomes active — independent of whether the user has ever opened the branch-selector popover, graph mode, or the PR list view.
- Reuse the existing forge-abstracted `getPRCount()` — works across all 4 forges (GitHub/GitLab/Bitbucket/Azure), not just GitHub.
- Keep the PR list view's own count/list behavior exactly as it is today (10 + scroll pagination, `totalCount` = loaded count) — this spec does not change `PrListSidebar.vue`'s list rendering.
- The PR list view's manual refresh button also refreshes the dock count, so both stay in sync after an explicit user-initiated refresh.

## Non-goals

- No changes to the PR list's own pagination, its `totalCount` pill, or its filter behavior.
- No changes to the branch-badge background-drain/cache work from `2026-07-09-pr-badge-prefetch-design.md` — this is a separate, independent counter.
- The dock count always reflects `state: "open"` — it does not follow the PR list view's active filter (open/closed/all). If the user is viewing "closed" PRs in the list, the dock badge still shows the open count.
- No automatic periodic refresh of the dock count (no new polling) — it updates only on repo-open/switch and on the PR list's manual refresh button.

## Architecture

### New state in `usePrPanel.ts`

```ts
const dockPrCount = ref<number | null>(null);

async function refreshDockPrCount() {
  if (!cwd.value) return;
  try {
    dockPrCount.value = await forge.value.getPRCount(cwd.value, "open");
  } catch {
    // ghPrCount already swallows failures to 0 at the wrapper level; this
    // catch is just defense-in-depth against a forge implementation that
    // doesn't.
    dockPrCount.value = 0;
  }
}
```

Exposed in the composable's returned object alongside the existing `prs`/`hasMore`/etc.

### Trigger — repo open/switch

Called from the existing `watch(cwd, (newCwd) => { ... })` handler (the same one that resets `_prsEnsured`/`_lastFreshnessCheck`/`prs.value` today), unconditionally — NOT gated by `panelMounted` the way `init()` is. This is intentional: `panelMounted` gating exists to avoid the *heavy*, per-PR-enriched list fetch (`gh_list_prs`) firing on every repo open (the v2.8.5 boot-perf fix); `getPRCount` is a single, cheap, unenriched call with a fundamentally different cost profile, so it doesn't need the same gate.

```ts
watch(cwd, (newCwd) => {
  selectedPr.value = null;
  prs.value = [];
  remote.value = null;
  _prsEnsured = false;
  _lastFreshnessCheck = 0;
  dockPrCount.value = null;
  resetDetail();
  if (newCwd) void refreshDockPrCount();
  if (newCwd && panelMounted.value) init();
});
```

### Wiring into `AppDock`

`App.vue:3347` already passes `:pr-count="prPanel.prs.value.length"` to `<AppDock>` — this changes to read from the new cheap-count ref instead of the loaded-list length:

```vue
:pr-count="prPanel.dockPrCount.value ?? undefined"
```

(`?? undefined` because `AppDock`'s prop type is `number | undefined`, and `null` is our "not yet loaded" sentinel.)

### PR list view refresh button

`PrListSidebar.vue:148`, currently `@click="panel.loadPrs"`, becomes a small inline handler that fires both:

```ts
function refreshList() {
  panel.loadPrs();
  panel.refreshDockPrCount();
}
```

```vue
<button ... @click="refreshList" ...>
```

## Edge cases

- **No remote/forge configured:** `forge.value` still resolves to a default provider (as it does today for `loadPrs`); `getPRCount` on that provider is expected to fail gracefully to `0` exactly as `ghPrCount` already documents ("never throw... dashboard renders 0").
- **Repo switch while a count fetch is in flight:** no explicit cancellation token needed — the next `watch(cwd, ...)` firing already resets `dockPrCount.value = null` before the new fetch starts, and a late-resolving stale fetch would overwrite it with a stale number. This is the same class of harmless race the existing `loadRemote()` already has (no token there either) — consistent with existing precedent, not a new gap introduced here. If this proves visible in practice, a future pass can add a cheap repo-snapshot guard (same `repo` capture pattern used elsewhere in this file), but it's not needed for this iteration.
- **Offline:** `getPRCount` implementations don't currently route through `requireOnline()` the way `loadPrs`/`loadMorePrs` do; a failed network call is expected to resolve to `0` via the same graceful-failure path, not hang or throw.

## Testing

- `usePrPanel.test.ts` (extend the existing file from the prefetch-cache work): mock `forge.getPRCount`, assert `refreshDockPrCount()` populates `dockPrCount`, assert the `cwd` watcher calls it on repo switch, assert a `getPRCount` rejection resolves `dockPrCount` to `0` rather than throwing.
- Manual check via `pnpm dev:web`: open a repo with open PRs, confirm the dock's "prs" item shows a numeric badge without ever opening the branch popover or the PR view; click the PR view's refresh button and confirm the dock badge updates alongside the list.
