# Branch Selector PR-Number Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the branch-picker popover's filter box resolve `#<PR number>` to the branch that PR is on, jump straight to it, and show a small PR badge on branches that already have a known PR — matching GitHub Desktop's branch search.

**Architecture:** A new pure composable, `useBranchPrSearch.ts`, owns all matching/lookup state (debounced cache-first-then-fallback-fetch PR resolution). `BranchSelector.vue` injects the existing `PR_PANEL_KEY` singleton to get the cached PR list + active forge provider, wires them into the composable, and uses its outputs to filter the existing Pinned/Local/Remote branch lists and render badges. No backend/Tauri changes.

**Tech Stack:** Vue 3 Composition API (`<script setup>`), TypeScript, Vitest (jsdom), existing `usePrPanel`/forge-provider layer.

## Global Constraints

- Business logic goes in a composable (`apps/desktop/src/composables/`), not inlined in the component — components stay thin (`apps/desktop/src/CLAUDE.md`).
- Every new user-visible string needs a key in all 5 locale files: `en`, `fr`, `es`, `pt-BR`, `zh-CN` (`AGENTS.md` i18n rules). Never hardcode UI text.
- No new Tauri commands are introduced by this feature, so there is no `dev:web` route/backend.ts wrapper to add.
- Do not mock the git layer in tests — this feature has no git layer involvement (it only touches the forge/PR layer, which existing PR-related code already treats as mockable).
- Match exactly: `#9335` must resolve PR 9335 only, no partial/prefix matching.
- PR badge in the branch list only reflects PRs already in the cached `prPanel.prs` list — badges never trigger a network fetch, only the search itself does (via debounced fallback).

---

## File Structure

- **Create:** `apps/desktop/src/composables/useBranchPrSearch.ts` — the search/matching composable (all new logic; framework-agnostic of the popover's own UI state).
- **Create:** `apps/desktop/src/composables/__tests__/useBranchPrSearch.test.ts` — unit tests for the composable, fake timers, no component mounting.
- **Modify:** `apps/desktop/src/components/header/BranchSelector.vue` — inject `PR_PANEL_KEY`, wire the composable, adjust the three filtered-list computeds, adjust the popover's empty/loading states, add PR badges, update the filter placeholder.
- **Modify:** `apps/desktop/src/locales/en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts` — new `branches.prLookupLoading`, `branches.prLookupNotFound`, `branches.prBadgeTitle` keys, and an updated `branches.filter` placeholder string.

---

### Task 1: `useBranchPrSearch` composable

**Files:**
- Create: `apps/desktop/src/composables/useBranchPrSearch.ts`
- Test: `apps/desktop/src/composables/__tests__/useBranchPrSearch.test.ts`

**Interfaces:**
- Consumes: `PullRequest` type (`{ number: number; branch: string; ... }`) from `../utils/backend`; a `ForgeProvider`-shaped object with `getPR(cwd: string, number: number): Promise<{ branch: string }>` from `./forge/types`.
- Produces (used by Task 2 / `BranchSelector.vue`):
  - `useBranchPrSearch(opts: { cwd: Ref<string>; filterText: Ref<string>; prs: Ref<PullRequest[]>; forge: Ref<ForgeProvider>; debounceMs?: number }): { prNumberQuery: ComputedRef<number | null>; lookupLoading: Ref<boolean>; prFor: (branchName: string, isRemote: boolean) => PullRequest | null; matchesResolvedBranch: (branchName: string, isRemote: boolean) => boolean }`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/desktop/src/composables/__tests__/useBranchPrSearch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick, ref } from "vue";
import { useBranchPrSearch } from "../useBranchPrSearch";
import type { PullRequest } from "../../utils/backend";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "Fix the thing",
    state: "open",
    author: "octocat",
    branch: "feat/the-thing",
    base: "main",
    draft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/acme/repo/pull/42",
    additions: 0,
    deletions: 0,
    labels: [],
    assignees: [],
    reviewRequested: [],
    reviewDecision: "",
    mergeStateStatus: "",
    checksRollup: "",
    commentCount: 0,
    ...overrides,
  };
}

describe("useBranchPrSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prNumberQuery is null for plain text and for partial PR-like text", () => {
    const filterText = ref("feature-x");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR: vi.fn() } as any),
    });
    expect(search.prNumberQuery.value).toBeNull();

    filterText.value = "#93x";
    expect(search.prNumberQuery.value).toBeNull();

    filterText.value = "#93 ";
    expect(search.prNumberQuery.value).toBe(93);
  });

  it("resolves synchronously from the cached PR list on a cache hit (no fetch)", async () => {
    const getPR = vi.fn();
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([makePr({ number: 42, branch: "feat/the-thing" })]),
      forge: ref({ getPR } as any),
    });

    filterText.value = "#42";
    await nextTick();

    expect(search.lookupLoading.value).toBe(false);
    expect(search.matchesResolvedBranch("feat/the-thing", false)).toBe(true);
    expect(search.matchesResolvedBranch("other-branch", false)).toBe(false);
    expect(getPR).not.toHaveBeenCalled();
  });

  it("falls back to forge.getPR after a debounce on a cache miss, and resolves the branch", async () => {
    const getPR = vi.fn(async () => ({ branch: "fix/old-pr" }));
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR } as any),
      debounceMs: 300,
    });

    filterText.value = "#9335";
    await nextTick();
    expect(search.lookupLoading.value).toBe(true);
    expect(getPR).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(getPR).toHaveBeenCalledWith("/repo", 9335);
    expect(search.lookupLoading.value).toBe(false);
    expect(search.matchesResolvedBranch("fix/old-pr", false)).toBe(true);
  });

  it("debounces rapid keystrokes into a single fetch for the final value", async () => {
    const getPR = vi.fn(async () => ({ branch: "fix/old-pr" }));
    const filterText = ref("");
    useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR } as any),
      debounceMs: 300,
    });

    filterText.value = "#9";
    await nextTick();
    filterText.value = "#93";
    await nextTick();
    filterText.value = "#9335";
    await nextTick();

    await vi.advanceTimersByTimeAsync(300);

    expect(getPR).toHaveBeenCalledTimes(1);
    expect(getPR).toHaveBeenCalledWith("/repo", 9335);
  });

  it("leaves the branch unresolved when the fetch rejects (not found)", async () => {
    const getPR = vi.fn(async () => {
      throw new Error("404");
    });
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR } as any),
      debounceMs: 300,
    });

    filterText.value = "#404";
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    expect(search.lookupLoading.value).toBe(false);
    expect(search.matchesResolvedBranch("anything", false)).toBe(false);
  });

  it("prFor strips the origin/ prefix for remote branches but not for local ones", () => {
    const pr = makePr({ number: 7, branch: "feat/y" });
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText: ref(""),
      prs: ref([pr]),
      forge: ref({ getPR: vi.fn() } as any),
    });

    expect(search.prFor("feat/y", false)).toEqual(pr);
    expect(search.prFor("origin/feat/y", true)).toEqual(pr);
    expect(search.prFor("origin/feat/y", false)).toBeNull();
    expect(search.prFor("feat/y", true)).toBeNull();
  });

  it("matchesResolvedBranch strips the origin/ prefix for remote branches", async () => {
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([makePr({ number: 42, branch: "feat/the-thing" })]),
      forge: ref({ getPR: vi.fn() } as any),
    });

    filterText.value = "#42";
    await nextTick();

    expect(search.matchesResolvedBranch("origin/feat/the-thing", true)).toBe(true);
    expect(search.matchesResolvedBranch("feat/the-thing", true)).toBe(false);
  });

  it("clears resolution state when the query is cleared", async () => {
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([makePr({ number: 42, branch: "feat/the-thing" })]),
      forge: ref({ getPR: vi.fn() } as any),
    });

    filterText.value = "#42";
    await nextTick();
    expect(search.matchesResolvedBranch("feat/the-thing", false)).toBe(true);

    filterText.value = "";
    await nextTick();
    expect(search.prNumberQuery.value).toBeNull();
    expect(search.matchesResolvedBranch("feat/the-thing", false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useBranchPrSearch.test.ts`
Expected: FAIL — `Cannot find module '../useBranchPrSearch'` (the module doesn't exist yet).

- [ ] **Step 3: Implement the composable**

```typescript
// apps/desktop/src/composables/useBranchPrSearch.ts
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import type { PullRequest } from "../utils/backend";
import type { ForgeProvider } from "./forge/types";

export interface UseBranchPrSearchOptions {
  /** Current repo path, passed through to `forge.getPR`. */
  cwd: Ref<string>;
  /** The branch popover's filter input value (shared with plain name search). */
  filterText: Ref<string>;
  /** The PR panel's currently-loaded (paginated) PR list. */
  prs: Ref<PullRequest[]>;
  /** The active forge provider (GitHub/GitLab/Bitbucket/Azure). */
  forge: Ref<ForgeProvider>;
  /** Debounce before falling back to a network fetch on a cache miss. */
  debounceMs?: number;
}

export interface UseBranchPrSearchResult {
  /** The typed PR number when `filterText` is exactly `#<digits>`, else null. */
  prNumberQuery: ComputedRef<number | null>;
  /** True while resolving a cache-miss query via `forge.getPR`. */
  lookupLoading: Ref<boolean>;
  /** The cached PR for a given branch name, or null. Strips `origin/` for remote branches. */
  prFor: (branchName: string, isRemote: boolean) => PullRequest | null;
  /** Whether `branchName` is the branch resolved for the current PR-number query. */
  matchesResolvedBranch: (branchName: string, isRemote: boolean) => boolean;
}

function stripRemotePrefix(name: string, isRemote: boolean): string {
  return isRemote ? name.replace(/^origin\//, "") : name;
}

/**
 * Resolves a `#<number>` branch-filter query to the PR's head branch name,
 * cache-first against the PR panel's loaded list, falling back to a single
 * debounced `forge.getPR` call for PRs outside the currently-loaded page.
 */
export function useBranchPrSearch(opts: UseBranchPrSearchOptions): UseBranchPrSearchResult {
  const { cwd, filterText, prs, forge, debounceMs = 350 } = opts;

  const prNumberQuery = computed<number | null>(() => {
    const match = /^#(\d+)$/.exec(filterText.value.trim());
    return match ? Number(match[1]) : null;
  });

  const resolvedBranchName = ref<string | null>(null);
  const lookupLoading = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  watch(prNumberQuery, (n) => {
    if (timer) clearTimeout(timer);
    resolvedBranchName.value = null;
    lookupLoading.value = false;
    if (n === null) return;

    const cached = prs.value.find((pr) => pr.number === n);
    if (cached) {
      resolvedBranchName.value = cached.branch;
      return;
    }

    lookupLoading.value = true;
    timer = setTimeout(async () => {
      try {
        const detail = await forge.value.getPR(cwd.value, n);
        // Stale guard: the user may have kept typing while this was in flight.
        if (prNumberQuery.value !== n) return;
        resolvedBranchName.value = detail.branch;
      } catch {
        // Leave resolvedBranchName null — callers treat that as "not found".
      } finally {
        if (prNumberQuery.value === n) lookupLoading.value = false;
      }
    }, debounceMs);
  });

  const byBranch = computed(() => {
    const map = new Map<string, PullRequest>();
    for (const pr of prs.value) map.set(pr.branch, pr);
    return map;
  });

  function prFor(branchName: string, isRemote: boolean): PullRequest | null {
    return byBranch.value.get(stripRemotePrefix(branchName, isRemote)) ?? null;
  }

  function matchesResolvedBranch(branchName: string, isRemote: boolean): boolean {
    if (!resolvedBranchName.value) return false;
    return stripRemotePrefix(branchName, isRemote) === resolvedBranchName.value;
  }

  return { prNumberQuery, lookupLoading, prFor, matchesResolvedBranch };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useBranchPrSearch.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useBranchPrSearch.ts apps/desktop/src/composables/__tests__/useBranchPrSearch.test.ts
git commit -m "feat(desktop): add useBranchPrSearch composable for #PR branch lookup"
```

---

### Task 2: Locale keys for PR search

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/fr.ts`
- Modify: `apps/desktop/src/locales/es.ts`
- Modify: `apps/desktop/src/locales/pt-BR.ts`
- Modify: `apps/desktop/src/locales/zh-CN.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: locale keys used by Task 3 — `branches.filter`, `branches.prLookupLoading`, `branches.prLookupNotFound`, `branches.prBadgeTitle` (all under the existing `branches: { ... }` block in each file).

- [ ] **Step 1: Update `en.ts`**

In `apps/desktop/src/locales/en.ts`, inside the `branches: { ... }` block, change the `filter` line and add three new keys right after it:

```typescript
    filter: "Filter branches or #PR…",
    prLookupLoading: "Looking up PR #{0}…",
    prLookupNotFound: "No branch found for PR #{0}",
    prBadgeTitle: "PR #{0}: {1}",
```

- [ ] **Step 2: Update `fr.ts`**

In `apps/desktop/src/locales/fr.ts`, inside the `branches: { ... }` block, replace the `filter` line and add the same three keys:

```typescript
    filter: "Filtrer ou #PR…",
    prLookupLoading: "Recherche de la PR #{0}…",
    prLookupNotFound: "Aucune branche trouvée pour la PR #{0}",
    prBadgeTitle: "PR #{0} : {1}",
```

- [ ] **Step 3: Update `es.ts`**

In `apps/desktop/src/locales/es.ts`, inside the `branches: { ... }` block:

```typescript
    filter: "Filtrar o #PR…",
    prLookupLoading: "Buscando la PR #{0}…",
    prLookupNotFound: "No se encontró ninguna rama para la PR #{0}",
    prBadgeTitle: "PR #{0}: {1}",
```

- [ ] **Step 4: Update `pt-BR.ts`**

In `apps/desktop/src/locales/pt-BR.ts`, inside the `branches: { ... }` block:

```typescript
    filter: "Filtrar ou #PR…",
    prLookupLoading: "Procurando o PR #{0}…",
    prLookupNotFound: "Nenhuma branch encontrada para o PR #{0}",
    prBadgeTitle: "PR #{0}: {1}",
```

- [ ] **Step 5: Update `zh-CN.ts`**

In `apps/desktop/src/locales/zh-CN.ts`, inside the `branches: { ... }` block:

```typescript
    filter: "过滤分支或 #PR…",
    prLookupLoading: "正在查找 PR #{0}…",
    prLookupNotFound: "未找到 PR #{0} 对应的分支",
    prBadgeTitle: "PR #{0}：{1}",
```

- [ ] **Step 6: Verify every locale file defines the same new keys**

Run:
```bash
for f in en fr es pt-BR zh-CN; do
  echo "=== $f ==="
  grep -n "prLookupLoading\|prLookupNotFound\|prBadgeTitle" apps/desktop/src/locales/$f.ts
done
```
Expected: each of the 5 files prints all 3 keys (15 lines total).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): add locale keys for branch-selector PR search"
```

---

### Task 3: Wire PR search into `BranchSelector.vue`

**Files:**
- Modify: `apps/desktop/src/components/header/BranchSelector.vue`

**Interfaces:**
- Consumes:
  - `useBranchPrSearch` from Task 1 — signature as documented there.
  - `PR_PANEL_KEY`, `type PrPanelState` from `../../composables/usePrPanel` (existing; same injection pattern as `PrListSidebar.vue`, `PrDetailView.vue`, `PrCreateView.vue`).
  - Locale keys from Task 2: `branches.filter`, `branches.prLookupLoading`, `branches.prLookupNotFound`, `branches.prBadgeTitle`.
- Produces: no new exports — this is the leaf component consuming Task 1 + Task 2.

This task has no isolated unit test (the file has no existing test harness and `AGENTS.md`/`apps/desktop/CLAUDE.md` steer toward composable tests over heavy component mocks — the composable is already covered in Task 1). Verification is the manual QA pass in Task 4.

- [ ] **Step 1: Add the injected PR panel and the composable wiring**

In `apps/desktop/src/components/header/BranchSelector.vue`, update the `vue` import (line 27) to add `toRef`:

```typescript
import { ref, computed, inject, nextTick, onMounted, onUnmounted, watch, toRef, defineAsyncComponent, type Ref } from "vue";
```

Right after the existing imports (after the `BranchNameField` lazy-import block, before `const { t } = useI18n();`), add:

```typescript
import { PR_PANEL_KEY, type PrPanelState } from "../../composables/usePrPanel";
import { useBranchPrSearch } from "../../composables/useBranchPrSearch";
```

After `const { t } = useI18n();`, add the injection and composable wiring:

```typescript
const prPanel = inject<PrPanelState>(PR_PANEL_KEY)!;
const prSearch = useBranchPrSearch({
  cwd: toRef(props, "cwd"),
  filterText: branchFilter,
  prs: prPanel.prs,
  forge: prPanel.forge,
});
```

Note: `branchFilter` is declared further down in the file (`const branchFilter = ref("");` at line 111). Since `<script setup>` hoists `const` declarations are not hoisted in the JS sense, this wiring block must be placed **after** `const branchFilter = ref("");` — insert it immediately after that line instead of right after `const { t } = useI18n();`.

- [ ] **Step 2: Filter `pinnedBranches`, `localBranches`, `remoteBranches` by the resolved PR branch when searching by number**

Replace the `localBranches` computed:

```typescript
const localBranches = computed(() => {
  const archivedSet = new Set(archives.archived.value);
  const pinnedSet = new Set(pins.pinned.value);
  return props.branches
    .filter((b) => !b.isRemote)
    .filter((b) => b.isCurrent || !archivedSet.has(b.name))
    .filter((b) => !pinnedSet.has(b.name))
    .filter((b) =>
      prSearch.prNumberQuery.value !== null
        ? prSearch.matchesResolvedBranch(b.name, false)
        : !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()),
    )
    .sort(branchSort);
});
```

Replace the `remoteBranches` computed:

```typescript
const remoteBranches = computed(() =>
  props.branches
    .filter((b) => b.isRemote)
    .filter((b) =>
      prSearch.prNumberQuery.value !== null
        ? prSearch.matchesResolvedBranch(b.name, true)
        : !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()),
    )
    .sort(branchSort),
);
```

Replace the `pinnedBranches` computed:

```typescript
const pinnedBranches = computed(() => {
  const byName = new Map(props.branches.filter((b) => !b.isRemote).map((b) => [b.name, b]));
  return pins.pinned.value
    .map((name) => byName.get(name))
    .filter((b): b is GitBranch => !!b)
    .filter((b) =>
      prSearch.prNumberQuery.value !== null
        ? prSearch.matchesResolvedBranch(b.name, false)
        : !branchFilter.value || b.name.toLowerCase().includes(branchFilter.value.toLowerCase()),
    );
});
```

`archivedBranchList` is intentionally left unchanged — during a `#PR` query its existing substring filter (`b.name.toLowerCase().includes(branchFilter.value.toLowerCase())`) naturally never matches a literal `#1234` string, so archived branches simply drop out of view while searching by PR number, with no extra code needed (matches the spec's decision to skip PR matching for the archived section).

- [ ] **Step 3: Update the filter input placeholder**

The `<input v-model="branchFilter" ...>` already uses `:placeholder="t('branches.filter')"` — no template change needed here; Task 2's updated locale string is picked up automatically.

- [ ] **Step 4: Add loading/not-found states and gate the existing empty state**

Replace:

```html
        <div v-if="localBranches.length === 0 && remoteBranches.length === 0" class="bp-empty">
          <span class="muted">{{ t('branches.noBranch') }}</span>
        </div>
```

with:

```html
        <div v-if="prSearch.prNumberQuery.value !== null && prSearch.lookupLoading.value" class="bp-empty">
          <div class="bp-spinner"></div>
          <span class="muted">{{ t('branches.prLookupLoading', prSearch.prNumberQuery.value) }}</span>
        </div>
        <div
          v-else-if="prSearch.prNumberQuery.value !== null && pinnedBranches.length === 0 && localBranches.length === 0 && remoteBranches.length === 0"
          class="bp-empty"
        >
          <span class="muted">{{ t('branches.prLookupNotFound', prSearch.prNumberQuery.value) }}</span>
        </div>
        <div
          v-else-if="prSearch.prNumberQuery.value === null && localBranches.length === 0 && remoteBranches.length === 0"
          class="bp-empty"
        >
          <span class="muted">{{ t('branches.noBranch') }}</span>
        </div>
```

Add a stacking style for the loading variant right after the existing `.bp-empty` rule in the `<style scoped>` block:

```css
.bp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-7);
  font-size: var(--font-size-base);
}
.bp-empty:has(.bp-spinner) {
  flex-direction: column;
  gap: var(--space-3);
}
```

(The existing `.bp-empty` rule already exists near the end of the file — add the `.bp-empty:has(.bp-spinner)` rule directly below it rather than duplicating the base rule.)

- [ ] **Step 5: Add the PR badge in the Pinned section**

In the pinned-branches `<li>` (the one with `:key="`pin-${branch.name}`"`), insert the badge right after the branch-name span and before the ahead/behind meta span:

```html
              <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
              <span
                v-if="prSearch.prFor(branch.name, false)"
                class="bp-pr-badge"
                :title="t('branches.prBadgeTitle', prSearch.prFor(branch.name, false)!.number, prSearch.prFor(branch.name, false)!.title)"
              >#{{ prSearch.prFor(branch.name, false)!.number }}</span>
              <span v-if="branch.ahead > 0 || branch.behind > 0" class="bp-item-meta muted">
```

- [ ] **Step 6: Add the PR badge in the Local section**

In the local-branches `<li>` (the one with `:key="branch.name"` inside the `localBranches` loop), same insertion point:

```html
                <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
                <span
                  v-if="prSearch.prFor(branch.name, false)"
                  class="bp-pr-badge"
                  :title="t('branches.prBadgeTitle', prSearch.prFor(branch.name, false)!.number, prSearch.prFor(branch.name, false)!.title)"
                >#{{ prSearch.prFor(branch.name, false)!.number }}</span>
                <span v-if="branch.ahead > 0 || branch.behind > 0" class="bp-item-meta muted">
```

- [ ] **Step 7: Add the PR badge in the Remote section**

In the remote-branches `<li>` (inside the `remoteBranches` loop), insert right after the branch-name span:

```html
              <span class="bp-item-name mono" :title="branch.name"><span class="bp-item-name__text">{{ branch.name }}</span></span>
              <span
                v-if="prSearch.prFor(branch.name, true)"
                class="bp-pr-badge"
                :title="t('branches.prBadgeTitle', prSearch.prFor(branch.name, true)!.number, prSearch.prFor(branch.name, true)!.title)"
              >#{{ prSearch.prFor(branch.name, true)!.number }}</span>
```

- [ ] **Step 8: Style the badge**

Add to the `<style scoped>` block, near the other `.bp-item-*` rules:

```css
.bp-pr-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
}
```

- [ ] **Step 9: Type-check and unit-test the workspace**

Run: `cd apps/desktop && pnpm exec vue-tsc --noEmit`
Expected: no new type errors.

Run: `cd apps/desktop && pnpm vitest run`
Expected: full existing suite + Task 1's new tests all PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/components/header/BranchSelector.vue
git commit -m "feat(desktop): search the branch popover by #PR number with badges"
```

---

### Task 4: Manual verification pass

**Files:** none (verification only).

- [ ] **Step 1: Start the web dev server**

Run: `cd apps/desktop && pnpm dev:web`
Expected: Vite dev server starts on `localhost:1420` with the mock backend.

- [ ] **Step 2: Open a repo with a connected forge and at least one loaded PR**

In the running app, open a repo with a GitHub remote, open the PR sidebar at least once (so `usePrPanel`'s `prs` cache is populated), note one PR's number and head branch.

- [ ] **Step 3: Verify cache-hit search**

Open the branch popover, type `#<that PR's number>` into the filter box.
Expected: the branch list narrows immediately (no spinner) to that PR's head branch, and the row shows a `#<number>` badge.

- [ ] **Step 4: Verify badges appear without searching**

Clear the filter box.
Expected: any branch with a cached PR shows its `#<number>` badge in the Pinned/Local/Remote sections; branches without a PR show no badge.

- [ ] **Step 5: Verify fallback fetch for an unloaded PR**

Type `#<a PR number not in the currently loaded page>` (e.g. an old/high-numbered PR from before the cache's first page).
Expected: a brief "Looking up PR #…" spinner row appears, then either the matching branch renders, or — if that branch was deleted locally/remotely — "No branch found for PR #…".

- [ ] **Step 6: Verify a bogus PR number**

Type `#999999999` (a number that doesn't exist on the repo).
Expected: spinner briefly, then "No branch found for PR #999999999" — no console error/crash.

- [ ] **Step 7: Verify plain-text search still works**

Clear the filter, type a partial branch name (no `#`).
Expected: substring filtering behaves exactly as before this change.

- [ ] **Step 8: Verify partial PR numbers don't match**

Type `#9` when no PR numbered exactly `9` exists but a PR `#93` does.
Expected: no match for `#93` — confirms exact-match-only, not prefix matching.

---

## Self-Review Notes

- **Spec coverage:** cache-first + debounced fallback lookup (Task 1), exact-number matching (Task 1 test "partial PR-like text"), PR badges sourced only from the cache with no extra fetch (Task 1's `prFor` + Task 3 steps 5–7), loading/not-found/found UI states (Task 3 step 4), `origin/` prefix handling (Task 1 tests + Task 3's `isRemote` args), placeholder copy update (Task 2), i18n across all 5 locales (Task 2), no backend/Tauri changes (confirmed — nothing in this plan touches `src-tauri` or `backend.ts`).
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact command with expected output.
- **Type consistency:** `useBranchPrSearch` return type in Task 1 (`prNumberQuery`, `lookupLoading`, `prFor`, `matchesResolvedBranch`) is the exact set of names used in Task 3's template edits — no renamed fields between tasks.
