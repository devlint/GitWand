# PR Dock Badge Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app dock's "prs" badge shows the true total open-PR count for the active repo (via a single cheap `getPRCount()` call at repo-open), instead of however many PRs happen to be loaded into the branch-badge list — which today reads `0` until the user has opened the branch-selector popover or graph mode.

**Architecture:** A new `dockPrCount` ref + `refreshDockPrCount()` function in `usePrPanel.ts`, populated via the already-existing, forge-abstracted `getPRCount()` (works across GitHub/GitLab/Bitbucket/Azure), triggered on repo open/switch and on the PR list view's manual refresh button. `App.vue`'s existing `:pr-count` binding is redirected from `prPanel.prs.value.length` to this new ref.

**Tech Stack:** Vue 3 Composition API, Vitest/jsdom.

## Global Constraints

- No new Rust or IPC surface — `getPRCount()`/`ghPrCount()`/`gh_pr_count` already exist end-to-end across all 4 forge providers; this plan only adds frontend wiring.
- No new `setInterval`/polling — the count refreshes only on repo-open/switch and on the PR list's manual refresh button (`apps/desktop/CLAUDE.md` perf invariants: no unconditional polling).
- No changes to `PrListSidebar.vue`'s list rendering, pagination, or its own `totalCount` header pill — those stay exactly as they are today.
- The dock count always reflects `state: "open"` — it does not follow the PR list view's active filter.
- Composables vs components separation: the new IPC-calling logic (`refreshDockPrCount`) lives in `usePrPanel.ts` (a composable), not in `App.vue` or `PrListSidebar.vue` (components) — per `apps/desktop/src/CLAUDE.md`'s architecture rule.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/composables/usePrPanel.ts` (modify) | New `dockPrCount` ref + `refreshDockPrCount()` function; wired into the existing `watch(cwd, ...)` handler; exposed in the returned object. |
| `apps/desktop/src/composables/__tests__/usePrPanel.test.ts` (modify) | New tests for `refreshDockPrCount()`'s success/failure behavior and its trigger on repo switch. |
| `apps/desktop/src/App.vue` (modify) | Redirect the existing `:pr-count` binding from `prPanel.prs.value.length` to `prPanel.dockPrCount.value ?? undefined`. |
| `apps/desktop/src/components/PrListSidebar.vue` (modify) | New `refreshList()` handler that calls both `panel.loadPrs()` and `panel.refreshDockPrCount()`; the refresh button's `@click` is redirected to it. |

Task order: Task 1 (composable logic, independently testable) lands first; Task 2 (UI wiring, no automated test surface) depends on Task 1's `dockPrCount`/`refreshDockPrCount` existing.

---

### Task 1: `dockPrCount` state + `refreshDockPrCount()` in `usePrPanel.ts`

**Files:**
- Modify: `apps/desktop/src/composables/usePrPanel.ts:88` (add `dockPrCount` ref near `prs`), `:447` (add `refreshDockPrCount` near `loadPrs`), `:786-795` (wire into the `watch(cwd, ...)` handler), `:1197-1227` (add to the returned object)
- Test: `apps/desktop/src/composables/__tests__/usePrPanel.test.ts` (extend the existing file from the PR-badge-prefetch plan)

**Interfaces:**
- Consumes: `forge` (existing computed, `usePrPanel.ts:81`, resolves to the active `ForgeProvider`), `cwd` (existing `Ref<string>` param).
- Produces: `dockPrCount: Ref<number | null>` and `refreshDockPrCount(): Promise<void>` on the composable's returned object — consumed by Task 2's `App.vue`/`PrListSidebar.vue` changes.

- [ ] **Step 1: Write the failing tests**

The test file already has this mock setup from the PR-badge-prefetch plan (`docs/superpowers/plans/2026-07-09-pr-badge-prefetch.md`, Tasks 2/7):

```ts
const listPRs = vi.fn();
const createPR = vi.fn();
const mergePR = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs, createPR, mergePR })),
  githubProvider: { name: "github", listPRs, createPR, mergePR },
}));
```

Add a `getPRCount` mock alongside the existing ones — change this block to:

```ts
const listPRs = vi.fn();
const createPR = vi.fn();
const mergePR = vi.fn();
const getPRCount = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => ({ name: "github", listPRs, createPR, mergePR, getPRCount })),
  githubProvider: { name: "github", listPRs, createPR, mergePR, getPRCount },
}));
```

In the existing `beforeEach` inside `describe("usePrPanel — background prefetch drain", ...)`, add a reset for the new mock — change:

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

to:

```ts
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    listPRs.mockReset();
    createPR.mockReset();
    mergePR.mockReset();
    getPRCount.mockReset();
    ghPrFreshnessSignal.mockReset();
    vi.useFakeTimers();
  });
```

Then append these two new tests at the end of the `describe("usePrPanel — background prefetch drain", ...)` block, right before its closing `});`:

```ts

  it("refreshDockPrCount() populates dockPrCount from the forge's getPRCount", async () => {
    getPRCount.mockResolvedValue(7);
    const panel = usePrPanel(ref("/repo"));
    expect(panel.dockPrCount.value).toBeNull();
    await panel.refreshDockPrCount();
    expect(panel.dockPrCount.value).toBe(7);
    expect(getPRCount).toHaveBeenCalledWith("/repo", "open");
  });

  it("refreshDockPrCount() resolves to 0 instead of throwing when getPRCount rejects", async () => {
    getPRCount.mockRejectedValue(new Error("network down"));
    const panel = usePrPanel(ref("/repo"));
    await panel.refreshDockPrCount();
    expect(panel.dockPrCount.value).toBe(0);
  });

  it("switching repos resets dockPrCount and triggers a fresh refresh for the new repo", async () => {
    getPRCount.mockResolvedValue(3);
    const cwd = ref("/repo-a");
    const panel = usePrPanel(cwd);
    await panel.refreshDockPrCount();
    expect(panel.dockPrCount.value).toBe(3);

    getPRCount.mockResolvedValue(9);
    cwd.value = "/repo-b";
    await nextTick(); // flush the cwd watcher
    await nextTick(); // flush the watcher's own fire-and-forget refreshDockPrCount() call

    expect(getPRCount).toHaveBeenCalledWith("/repo-b", "open");
    expect(panel.dockPrCount.value).toBe(9);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && pnpm test -- src/composables/__tests__/usePrPanel.test.ts`
Expected: FAIL — `panel.dockPrCount` and `panel.refreshDockPrCount` are `undefined` (property doesn't exist on the returned object yet).

- [ ] **Step 3: Add `dockPrCount` and `refreshDockPrCount`**

In `apps/desktop/src/composables/usePrPanel.ts`, right after line 88 (`const prs = ref<PullRequest[]>([]);`), add:

```ts
  // ─── Dock badge count (cheap, independent of the badge-path list) ──────
  // Reflects the true total open-PR count via a single cheap forge call,
  // not `prs.value.length` (which only reflects however much of the
  // branch-badge list has been loaded — see usePrCache's SWR list and
  // the background prefetch in this same file). `null` = not yet fetched.
  const dockPrCount = ref<number | null>(null);
```

Then, right after the `loadPrs` function's closing brace (the function currently ends at line ~468, right before the `loadMorePrs` doc comment), add:

```ts

  /**
   * Refresh the dock's PR badge count via a single cheap forge call
   * (`getPRCount`, backed by a `/search/issues?...&per_page=1`-style REST
   * call or GraphQL `totalCount` query per forge — no per-PR enrichment).
   * Independent of `loadPrs`/`ensurePrsLoaded`: this can run even if the
   * user has never opened the branch popover, graph mode, or the PR view.
   */
  async function refreshDockPrCount() {
    if (!cwd.value) return;
    try {
      dockPrCount.value = await forge.value.getPRCount(cwd.value, "open");
    } catch {
      // Defense-in-depth: ghPrCount's own implementations already swallow
      // failures to 0, but don't assume every forge does.
      dockPrCount.value = 0;
    }
  }
```

- [ ] **Step 4: Wire into the `cwd` watcher**

In `apps/desktop/src/composables/usePrPanel.ts`, change the `watch(cwd, ...)` handler (currently lines 786-795) from:

```ts
  watch(cwd, (newCwd) => {
    selectedPr.value = null;
    prs.value = [];
    remote.value = null;
    _prsEnsured = false;
    _lastFreshnessCheck = 0;
    ++_prPrefetchToken; // invalidate any in-flight background prefetch for the old repo
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
    ++_prPrefetchToken; // invalidate any in-flight background prefetch for the old repo
    dockPrCount.value = null;
    resetDetail();
    if (newCwd) void refreshDockPrCount();
    if (newCwd && panelMounted.value) init();
  });
```

(`refreshDockPrCount()` is called unconditionally on any real repo — NOT gated by `panelMounted.value` the way `init()` is. `panelMounted` gating exists specifically to avoid the heavy, per-PR-enriched `gh_list_prs` firing on every repo open; `getPRCount` is a single, unenriched call with a fundamentally different, much cheaper cost profile, so it doesn't need that gate.)

- [ ] **Step 5: Expose in the returned object**

In `apps/desktop/src/composables/usePrPanel.ts`, in the `return { ... }` block (currently lines 1197-1226), change:

```ts
    // Pagination (v2.8.5)
    hasMore, loadingMore,
```

to:

```ts
    // Pagination (v2.8.5)
    hasMore, loadingMore,
    // Dock badge count
    dockPrCount, refreshDockPrCount,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm test -- src/composables/__tests__/usePrPanel.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd apps/desktop && pnpm test`
Expected: PASS — no regressions elsewhere.

Run: `cd apps/desktop && pnpm build`
Expected: PASS — `vue-tsc` typecheck succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/composables/usePrPanel.ts apps/desktop/src/composables/__tests__/usePrPanel.test.ts
git commit -m "feat: add cheap dockPrCount refresh independent of the branch-badge list"
```

---

### Task 2: Wire the dock badge and the PR view's refresh button

**Files:**
- Modify: `apps/desktop/src/App.vue:3347`
- Modify: `apps/desktop/src/components/PrListSidebar.vue:21` (add handler), `:148` (redirect the refresh button's `@click`)

**Interfaces:**
- Consumes: `dockPrCount: Ref<number | null>` and `refreshDockPrCount(): Promise<void>` from Task 1, both already present on `PrPanelState` (the type returned by `usePrPanel`, used as `inject<PrPanelState>(PR_PANEL_KEY)!` in `PrListSidebar.vue` and referenced as `prPanel` in `App.vue`).

- [ ] **Step 1: Redirect the dock badge's data source**

In `apps/desktop/src/App.vue`, change line 3347 from:

```vue
        :pr-count="prPanel.prs.value.length" :terminal-active="showTerminal" :files-active="showFiles"
```

to:

```vue
        :pr-count="prPanel.dockPrCount.value ?? undefined" :terminal-active="showTerminal" :files-active="showFiles"
```

- [ ] **Step 2: Add the combined refresh handler in `PrListSidebar.vue`**

In `apps/desktop/src/components/PrListSidebar.vue`, right after line 21 (`const openSettings = inject(OPEN_SETTINGS_KEY, undefined);`), add:

```ts

/** Manual refresh: reload both the PR list and the dock's total-count badge together. */
function refreshList() {
  panel.loadPrs();
  panel.refreshDockPrCount();
}
```

- [ ] **Step 3: Redirect the refresh button**

In `apps/desktop/src/components/PrListSidebar.vue`, change line 148 from:

```vue
          @click="panel.loadPrs"
```

to:

```vue
          @click="refreshList"
```

- [ ] **Step 4: Verify the build**

Run: `cd apps/desktop && pnpm test`
Expected: PASS — no test exercises this template wiring directly (no automated test surface for this step; see Step 5 for manual verification), so this run just confirms no regression elsewhere.

Run: `cd apps/desktop && pnpm build`
Expected: PASS — `vue-tsc` typecheck succeeds (confirms `refreshList`/`prPanel.dockPrCount` resolve correctly in both templates).

- [ ] **Step 5: Manual verification**

Run: `cd apps/desktop && pnpm dev:web`
Expected: dev server starts. Open the app in a browser, open a repo that has open PRs on GitHub (or another connected forge), and confirm:
- The dock's "prs" item shows a numeric badge WITHOUT ever opening the branch-selector popover, entering graph mode, or opening the PR list view.
- Switching to a different repo tab updates the badge to that repo's own open-PR count.
- Opening the PR list view and clicking its refresh button updates both the list and the dock badge.

Stop the dev server after verifying (Ctrl+C) — don't leave it running.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/components/PrListSidebar.vue
git commit -m "feat: show the true open-PR count on the dock badge, independent of the loaded branch-badge list"
```

---

## Post-implementation checklist

- [ ] `cd apps/desktop && pnpm test` — full Vitest suite green.
- [ ] `cd apps/desktop && pnpm build` — typecheck + Vite build green.
- [ ] Manual check via `pnpm dev:web` per Task 2 Step 5, on a repo with open PRs on each of at least GitHub (required) — GitLab/Bitbucket/Azure if convenient, since `getPRCount` is forge-abstracted and this plan doesn't add forge-specific code.
